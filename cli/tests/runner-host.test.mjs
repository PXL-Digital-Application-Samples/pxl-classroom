// PXL Classroom CLI — host-runner smoke tests.
//
// Skipped on Windows: the host runner spawns /bin/sh, which is POSIX-only.
// Most lecturers grade on macOS or a Linux box.

import { test } from "node:test";
import assert from "node:assert/strict";
import { platform } from "node:os";
import { runHost } from "../src/lib/runner-host.mjs";

const skipPosix = platform() === "win32";

test("type=run passes when the command exits 0", { skip: skipPosix }, async () => {
  const res = await runHost({ test: { type: "run", command: "true", timeout_s: 5, points: 1 }, workdir: process.cwd() });
  assert.equal(res.passed, true);
  assert.equal(res.exit_code, 0);
  assert.equal(res.timed_out, false);
});

test("type=run fails when the command exits non-zero", { skip: skipPosix }, async () => {
  const res = await runHost({ test: { type: "run", command: "false", timeout_s: 5, points: 1 }, workdir: process.cwd() });
  assert.equal(res.passed, false);
  assert.notEqual(res.exit_code, 0);
});

test("type=run reports timed_out when wall-clock exceeded", { skip: skipPosix }, async () => {
  const res = await runHost({ test: { type: "run", command: "sleep 5", timeout_s: 1, points: 1 }, workdir: process.cwd() });
  assert.equal(res.passed, false);
  assert.equal(res.timed_out, true);
});

test("type=io passes when stdout matches after normalization", { skip: skipPosix }, async () => {
  const res = await runHost({
    test: { type: "io", command: "cat", stdin: "hello\n", expected_stdout: "hello", timeout_s: 5, points: 1 },
    workdir: process.cwd(),
  });
  assert.equal(res.passed, true);
});

test("type=io fails when stdout differs", { skip: skipPosix }, async () => {
  const res = await runHost({
    test: { type: "io", command: "echo nope", expected_stdout: "yes", timeout_s: 5, points: 1 },
    workdir: process.cwd(),
  });
  assert.equal(res.passed, false);
});
