// PXL Classroom CLI — Docker sandbox runner.
//
// Each test runs in a fresh ephemeral container. Default image is debian:stable-slim
// for `run`/`io` and python:3.12-slim for `python`. Override via test.image (not
// schema-blessed; left intentionally informal because most courses settle on
// one image per assignment).
//
// The student's checkout is bind-mounted read-only at /workspace so a buggy or
// malicious test cannot mutate the lecturer's filesystem. --network=none is
// enforced so tests cannot exfiltrate or fetch dependencies during grading.

import { spawn } from "node:child_process";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

function imageFor(test) {
  if (test.image) return test.image;
  return test.type === "python" ? "python:3.12-slim" : "debian:stable-slim";
}

function dockerRun({ image, args, mounts, stdin = "", timeoutMs }) {
  return new Promise((resolveFn) => {
    const baseArgs = [
      "run", "--rm", "--init", "--network=none",
      "--read-only", "--tmpfs", "/tmp:rw,size=64m",
      "--memory=512m", "--pids-limit=256",
      "--workdir", "/workspace",
    ];
    for (const m of mounts) {
      baseArgs.push("-v", m);
    }
    const fullArgs = [...baseArgs, image, ...args];
    const child = spawn("docker", fullArgs, { stdio: ["pipe", "pipe", "pipe"] });
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
