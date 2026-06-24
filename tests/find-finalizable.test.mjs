import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(here, "..", "scripts", "find-finalizable.mjs");

function runFindFinalizable(assignments = {}, lockdowns = []) {
  const dir = mkdtempSync(join(tmpdir(), "pxl-ff-test-"));
  
  if (Object.keys(assignments).length > 0) {
    mkdirSync(join(dir, "assignments"), { recursive: true });
    for (const [id, data] of Object.entries(assignments)) {
      writeFileSync(join(dir, "assignments", `${id}.yml`), data);
    }
  }

  if (lockdowns.length > 0) {
    for (const id of lockdowns) {
      mkdirSync(join(dir, "lockdowns", id), { recursive: true });
      writeFileSync(join(dir, "lockdowns", id, "lockdown-record.json"), "{}");
    }
  }

  const res = spawnSync("node", [scriptPath, dir, "TestOrg"], {
    encoding: "utf8",
    cwd: dir
  });

  const finalizable = JSON.parse(res.stdout.trim());
  let activeCount = 0;
  try {
    const activeCountJson = JSON.parse(readFileSync(join(dir, "active-TestOrg.json"), "utf8"));
    activeCount = activeCountJson.active;
  } catch (e) {}

  return { status: res.status, finalizable, activeCount, dir };
}

test("Deadline 30 min ago -> in-window", () => {
  const past = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const res = runFindFinalizable({
    "a1": `state: published\ndeadline_at: "${past}"`
  });
  assert.equal(res.finalizable.length, 1);
  assert.equal(res.finalizable[0].assignment_id, "a1");
});

test("Deadline 90 min ago -> in-window (regression)", () => {
  const past = new Date(Date.now() - 90 * 60 * 1000).toISOString();
  const res = runFindFinalizable({
    "a2": `state: published\ndeadline_at: "${past}"`
  });
  assert.equal(res.finalizable.length, 1);
  assert.equal(res.finalizable[0].assignment_id, "a2");
});

test("Deadline 24 h ago -> in-window", () => {
  const past = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const res = runFindFinalizable({
    "a3": `state: published\ndeadline_at: "${past}"`
  });
  assert.equal(res.finalizable.length, 1);
  assert.equal(res.finalizable[0].assignment_id, "a3");
});

test("Deadline 26 h ago -> out-of-window", () => {
  const past = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString();
  const res = runFindFinalizable({
    "a4": `state: published\ndeadline_at: "${past}"`
  });
  assert.equal(res.finalizable.length, 0);
});

test("lockdown-record.json exists -> skip (idempotency)", () => {
  const past = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const res = runFindFinalizable({
    "a5": `state: published\ndeadline_at: "${past}"`
  }, ["a5"]); // lockdowns contains a5
  assert.equal(res.finalizable.length, 0);
});

test("state != 'published' -> not counted in activeCount", () => {
  const future = new Date(Date.now() + 86400000).toISOString();
  const res = runFindFinalizable({
    "a6": `state: draft\ndeadline_at: "${future}"`,
    "a7": `state: closed\ndeadline_at: "${future}"`,
    "a8": `state: published\ndeadline_at: "${future}"`
  });
  assert.equal(res.activeCount, 1); // only a8
});
