// PXL Classroom CLI - host runner.
//
// Executes a single test directly on the lecturer's machine via /bin/sh -c.
// No sandboxing. Use --runner=docker for untrusted student code.

import { spawn } from "node:child_process";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Spawn one process and settle exactly once.
 *
 * Exported for the tests: the interesting half of this file - that a timeout
 * always produces a result - is POSIX-shell-specific through runHost(), which
 * refuses to run on Windows at all. Driving runOnce directly with `node` as the
 * child exercises the settling logic on every platform.
 */
export function runOnce({ cmd, args, cwd, stdin = "", timeoutMs }) {
  return new Promise((resolveFn) => {
    // `detached` puts the child in its own PROCESS GROUP, so the timeout below
    // can kill everything it spawned. Without it, SIGKILL reached only /bin/sh
    // and any grandchild - `sleep 100 &`, a server the test forgot to stop -
    // survived, kept the inherited stdout pipe open, and `close` never fired.
    // A grading run then hung forever on the one test that had a timeout.
    const child = spawn(cmd, args, { cwd, stdio: ["pipe", "pipe", "pipe"], shell: false, detached: true });
    let stdout = "", stderr = "";
    let settled = false;
    let timedOut = false;
    const start = Date.now();

    const kill = () => {
      // Negative pid = the whole group. Falls back to the single process where
      // that is not supported, so a platform without process groups still gets
      // the old behaviour rather than an exception.
      try { process.kill(-child.pid, "SIGKILL"); }
      catch { try { child.kill("SIGKILL"); } catch { /* already gone */ } }
    };

    const t = setTimeout(() => {
      timedOut = true;
      kill();
      // `close` waits for every inherited pipe, which a surviving grandchild
      // holds open. `exit` is the process itself, so settle on the later of
      // "the shell is gone" and a short grace for output already in flight -
      // and never wait past it.
      setTimeout(() => finish(null), 250).unref?.();
    }, timeoutMs);

    // Recorded from `exit` rather than from the `close` signal: a student's
    // process killed by the OOM killer also reports SIGKILL, and calling that a
    // timeout tells the lecturer the wrong thing about the submission.
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      resolveFn({
        exit_code: code,
        timed_out: timedOut,
        duration_ms: Date.now() - start,
        stdout, stderr,
      });
    };

    child.stdout.on("data", (b) => (stdout += b.toString()));
    child.stderr.on("data", (b) => (stderr += b.toString()));
    if (stdin) { try { child.stdin.write(stdin); } catch { /* closed early */ } }
    try { child.stdin.end(); } catch { /* ok */ }
    child.on("close", (code) => finish(code));
    child.on("exit", (code) => {
      // Give the pipes a moment to flush; `close` settles first when it comes.
      setTimeout(() => finish(code), 50).unref?.();
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      resolveFn({ exit_code: null, timed_out: false, duration_ms: Date.now() - start, stdout, stderr: stderr + err.message });
    });
  });
}

function normalize(s) {
  return s.replace(/\r\n/g, "\n").replace(/\s+$/g, "");
}

export async function runHost({ test, workdir }) {
  if (process.platform === "win32") {
    throw new Error("host runner is POSIX-only - use --runner=docker on Windows");
  }
  const timeoutMs = (test.timeout_s ?? 30) * 1000;
  if (test.type === "run") {
    const res = await runOnce({ cmd: "/bin/sh", args: ["-c", test.command], cwd: workdir, timeoutMs });
    return { ...res, passed: res.exit_code === 0 && !res.timed_out };
  }
  if (test.type === "io") {
    const res = await runOnce({ cmd: "/bin/sh", args: ["-c", test.command], cwd: workdir, stdin: test.stdin ?? "", timeoutMs });
    const matched = normalize(res.stdout) === normalize(test.expected_stdout ?? "");
    return { ...res, passed: res.exit_code === 0 && !res.timed_out && matched };
  }
  if (test.type === "python") {
    const scratch = await mkdtemp(join(tmpdir(), "pxl-grade-py-"));
    const scriptPath = join(scratch, "t.py");
    try {
      await writeFile(scriptPath, test.script ?? "");
      const res = await runOnce({ cmd: "python3", args: [scriptPath], cwd: workdir, timeoutMs });
      return { ...res, passed: res.exit_code === 0 && !res.timed_out };
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
  return { exit_code: null, timed_out: false, duration_ms: 0, stdout: "", stderr: `unknown test type: ${test.type}`, passed: false };
}
