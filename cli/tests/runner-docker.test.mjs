import { test } from "node:test";
import assert from "node:assert/strict";
import cp from "node:child_process";
import { runDocker } from "../src/lib/runner-docker.mjs";
import events from "node:events";

test("runDocker applies strict sandboxing flags", async (t) => {
  let spawnArgs = [];
  
  t.mock.method(cp, "spawn", (cmd, args, opts) => {
    spawnArgs = args;
    const child = new events.EventEmitter();
    child.stdout = new events.EventEmitter();
    child.stderr = new events.EventEmitter();
    child.stdin = { write: () => {}, end: () => {} };
    child.kill = () => {};
    process.nextTick(() => child.emit("close", 0, null));
    return child;
  });

  const testConfig = { type: "run", command: "echo ok", timeout_s: 1 };
  await runDocker({ test: testConfig, workdir: "/fake/workdir" });

  assert.ok(spawnArgs.includes("--network=none"), "must disable network");
  assert.ok(spawnArgs.includes("--read-only"), "must mount rootfs read-only");
  assert.ok(spawnArgs.includes("--memory=512m"), "must set memory limit");
  assert.ok(spawnArgs.includes("--pids-limit=256"), "must set pids limit");
  assert.ok(spawnArgs.includes("--init"), "must run with init");
  
  const tmpfsIdx = spawnArgs.indexOf("--tmpfs");
  assert.ok(tmpfsIdx !== -1, "must mount tmpfs");
  assert.equal(spawnArgs[tmpfsIdx + 1], "/tmp:rw,size=64m", "tmpfs must be 64m");

  const bindMounts = spawnArgs.filter((a, i) => spawnArgs[i - 1] === "-v");
  assert.ok(bindMounts.includes("/fake/workdir:/workspace:ro"), "workspace must be mounted :ro");
});
