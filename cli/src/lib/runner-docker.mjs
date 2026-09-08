// PXL Classroom CLI - Docker sandbox runner.
//
// Each test runs in a fresh ephemeral container. Default image is debian:stable-slim
// for `run`/`io` and python:3.12-slim for `python`. Override via test.image (not
// schema-blessed; left intentionally informal because most courses settle on
// one image per assignment).
//
// The student's checkout is bind-mounted read-only at /workspace so a buggy or
// malicious test cannot mutate the lecturer's filesystem. --network=none is
// enforced so tests cannot exfiltrate or fetch dependencies during grading.

import cp from "node:child_process";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

function imageFor(test) {
  if (test.image) return test.image;
  return test.type === "python" ? "python:3.12-slim" : "debian:stable-slim";
}

/**
 * The full `docker` argv for one test, exported so it can be checked without a
 * daemon - the flags here are the sandbox, and a missing one is silent.
 *
 * `-i` IS LOAD-BEARING AND WAS MISSING. Without it docker does not attach the
 * container's stdin, so everything written to `child.stdin` is discarded and
 * the program under test reads EOF immediately. Every `type: io` check was
 * therefore graded against EMPTY INPUT while the Node side believed it had
 * supplied some - measured 2026-09-08:
 *
 *   printf 'Ada\n' | docker run --rm      … python3 -c "print(repr(input()))"  ->  ''
 *   printf 'Ada\n' | docker run --rm -i   … python3 -c "print(repr(input()))"  ->  'Ada\n'
 *
 * It fails quietly in both directions. The drill's `greets-by-name` check
 * passed on GitHub Actions and failed here, comparing the greeting for an empty
 * name against the one for "Ada" - and a program that ignores its input, or an
 * expected value that happens to match the empty-input output, PASSES for a
 * reason nobody measured.
 *
 * Unconditional rather than only when there is stdin: `dockerRun` always closes
 * the stream, so a check with no input gets EOF either way and there is no
 * second code path to keep in step.
 */
export function dockerArgs({ image, args, mounts }) {
  const baseArgs = [
    "run", "--rm", "-i", "--init", "--network=none",
    "--read-only", "--tmpfs", "/tmp:rw,size=64m",
    "--memory=512m", "--pids-limit=256",
    "--workdir", "/workspace",
  ];
  for (const m of mounts) {
    baseArgs.push("-v", m);
  }
  return [...baseArgs, image, ...args];
}

function dockerRun({ image, args, mounts, stdin = "", timeoutMs }) {
  return new Promise((resolveFn) => {
    const fullArgs = dockerArgs({ image, args, mounts });
    const child = cp.spawn("docker", fullArgs, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const start = Date.now();
    const t = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* gone */ }
    }, timeoutMs + 5000); // give docker a small grace beyond the test budget
    child.stdout.on("data", (b) => (stdout += b.toString()));
    child.stderr.on("data", (b) => (stderr += b.toString()));
    if (stdin) { try { child.stdin.write(stdin); } catch { /* closed */ } }
    try { child.stdin.end(); } catch { /* ok */ }
    child.on("close", (code, signal) => {
      clearTimeout(t);
      resolveFn({
        exit_code: code,
        timed_out: signal === "SIGKILL",
        duration_ms: Date.now() - start,
        stdout, stderr,
      });
    });
    child.on("error", (err) => {
      clearTimeout(t);
      resolveFn({ exit_code: null, timed_out: false, duration_ms: Date.now() - start, stdout, stderr: stderr + err.message });
    });
  });
}

function normalize(s) {
  return s.replace(/\r\n/g, "\n").replace(/\s+$/g, "");
}

export async function runDocker({ test, workdir }) {
  const timeoutMs = (test.timeout_s ?? 30) * 1000;
  const image = imageFor(test);
  const mounts = [`${workdir}:/workspace:ro`];

  if (test.type === "run") {
    const res = await dockerRun({
      image, mounts, timeoutMs,
      args: ["/bin/sh", "-c", `timeout ${Number(test.timeout_s ?? 30)}s sh -c ${shQuote(test.command)}`],
    });
    return { ...res, passed: res.exit_code === 0 && !res.timed_out };
  }
  if (test.type === "io") {
    const res = await dockerRun({
      image, mounts, timeoutMs, stdin: test.stdin ?? "",
      args: ["/bin/sh", "-c", `timeout ${Number(test.timeout_s ?? 30)}s sh -c ${shQuote(test.command)}`],
    });
    const matched = normalize(res.stdout) === normalize(test.expected_stdout ?? "");
    return { ...res, passed: res.exit_code === 0 && !res.timed_out && matched };
  }
  if (test.type === "python") {
    const scratch = await mkdtemp(join(tmpdir(), "pxl-grade-py-"));
    const scriptPath = join(scratch, "t.py");
    try {
      await writeFile(scriptPath, test.script ?? "");
      const res = await dockerRun({
        image,
        mounts: [...mounts, `${scriptPath}:/t.py:ro`],
        timeoutMs,
        args: ["python3", "/t.py"],
      });
      return { ...res, passed: res.exit_code === 0 && !res.timed_out };
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
  return { exit_code: null, timed_out: false, duration_ms: 0, stdout: "", stderr: `unknown test type: ${test.type}`, passed: false };
}

function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}
