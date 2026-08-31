// PXL Classroom CLI - host-runner smoke tests.
//
// Skipped on Windows: the host runner spawns /bin/sh, which is POSIX-only.
// Most lecturers grade on macOS or a Linux box.

import { test } from "node:test";
import assert from "node:assert/strict";
import { platform } from "node:os";
import { runHost, runOnce } from "../src/lib/runner-host.mjs";

const skipPosix = platform() === "win32";

// --- settling, on every platform ---------------------------------------------
//
// runHost() is POSIX-only, so everything below the divider is skipped on
// Windows - which is where the hang this pair guards would have gone unnoticed
// longest. runOnce() is the part that decides WHETHER A RESULT ARRIVES AT ALL,
// and it is platform-independent, so it is driven directly with `node` as the
// child.

test("runOnce always settles, even when the child outlives its timeout", async () => {
  const started = Date.now();
  const res = await runOnce({
    cmd: process.execPath,
    args: ["-e", "setTimeout(() => {}, 30000)"],
    cwd: process.cwd(),
    timeoutMs: 500,
  });
  // The bug: `close` waits for every inherited stdio pipe, so a child that
  // survived the kill - or held a pipe open - left the promise pending and the
  // whole grading run hung on one test. `exit` plus a bounded grace settles it.
  assert.equal(res.timed_out, true);
  assert.ok(Date.now() - started < 10_000, `must not hang, took ${Date.now() - started}ms`);
});

test("runOnce reports a clean exit as neither timed out nor failed", async () => {
  const res = await runOnce({
    cmd: process.execPath,
    args: ["-e", "process.stdout.write('hi')"],
    cwd: process.cwd(),
    timeoutMs: 10_000,
  });
  assert.equal(res.exit_code, 0);
  assert.equal(res.timed_out, false);
  assert.equal(res.stdout.trim(), "hi");
});

test("runOnce resolves once, not once per event", async () => {
  // `close` and `exit` both fire for a normal child, and the timeout can fire
  // alongside them. A second resolve is silent in a Promise, so the guard is
  // checked by shape: one call, one result, and the fields agree.
  const res = await runOnce({
    cmd: process.execPath,
    args: ["-e", "process.exit(3)"],
    cwd: process.cwd(),
    timeoutMs: 10_000,
  });
  assert.equal(res.exit_code, 3);
  assert.equal(res.timed_out, false);
  assert.ok(Number.isFinite(res.duration_ms));
});

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

test("a background grandchild cannot outlive the timeout", { skip: skipPosix }, async () => {
  // SIGKILL used to reach /bin/sh alone, so anything the student's command left
  // running kept the inherited stdout pipe open - and `close` never fired. The
  // grading run hung forever on the one test that had a timeout. The child is
  // spawned into its own process group now and the group is killed.
  const started = Date.now();
  const res = await runHost({
    test: { type: "run", command: "sleep 30 & sleep 30", timeout_s: 1, points: 1 },
    workdir: process.cwd(),
  });
  assert.equal(res.timed_out, true);
  assert.equal(res.passed, false);
  assert.ok(Date.now() - started < 10_000, `runHost must return promptly, took ${Date.now() - started}ms`);
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
