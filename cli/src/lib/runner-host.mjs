// PXL Classroom CLI — host runner.
//
// Executes a single test directly on the lecturer's machine via /bin/sh -c.
// No sandboxing. Use --runner=docker for untrusted student code.

import { spawn } from "node:child_process";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

function runOnce({ cmd, args, cwd, stdin = "", timeoutMs }) {
  return new Promise((resolveFn) => {
    const child = spawn(cmd, args, { cwd, stdio: ["pipe", "pipe", "pipe"], shell: false });
    let stdout = "", stderr = "";
    const start = Date.now();
    const t = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }, timeoutMs);
    child.stdout.on("data", (b) => (stdout += b.toString()));
    child.stderr.on("data", (b) => (stderr += b.toString()));
    if (stdin) { try { child.stdin.write(stdin); } catch { /* closed early */ } }
    try { child.stdin.end(); } catch { /* ok */ }
    child.on("close", (code, signal) => {
      clearTimeout(t);
      const timed_out = signal === "SIGKILL";
      resolveFn({
        exit_code: code,
        timed_out,
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

export async function runHost({ test, workdir }) {
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
