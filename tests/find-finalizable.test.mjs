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

test("Deadline 26 h ago -> in-window (no 25h bound)", () => {
  const past = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString();
  const res = runFindFinalizable({
    "a4": `state: published\ndeadline_at: "${past}"`
  });
  assert.equal(res.finalizable.length, 1);
  assert.equal(res.finalizable[0].assignment_id, "a4");
});

test("lockdown-record.json exists -> skip (idempotency)", () => {
  const past = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const res = runFindFinalizable({
    "a5": `state: published\ndeadline_at: "${past}"`
  }, ["a5"]); // lockdowns contains a5
  assert.equal(res.finalizable.length, 0);
});

// --- retry on incomplete preservation ---------------------------------------
//
// Lockdown alone used to be the idempotency key, so a run that locked down and
// then failed in preserve was recorded as finished and never retried - the
// submissions were silently never archived.

/**
 * Builds a past-deadline assignment with a full lockdown record and an
 * optional preservation.json per student.
 *   students: [{ login, snapshot_sha, preserved }]
 */
function runWithLockdown(students, { attempts = 1, id = "exam" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pxl-ff-retry-"));
  const past = new Date(Date.now() - 30 * 60 * 1000).toISOString();

  mkdirSync(join(dir, "assignments"), { recursive: true });
  writeFileSync(join(dir, "assignments", `${id}.yml`), `state: published\ndeadline_at: "${past}"`);

  mkdirSync(join(dir, "lockdowns", id), { recursive: true });
  writeFileSync(
    join(dir, "lockdowns", id, "lockdown-record.json"),
    JSON.stringify({
      schema_version: 1,
      assignment_id: id,
      finalize_attempts: attempts,
      results: students.map((s) => ({
        github_login: s.login,
        repo_name: `TestOrg/${id}-${s.login}`,
        snapshot_sha: s.snapshot_sha === undefined ? "a".repeat(40) : s.snapshot_sha,
      })),
    }),
  );

  for (const s of students) {
    if (s.preserved === undefined) continue;
    const obsDir = join(dir, "observations", id, s.login);
    mkdirSync(obsDir, { recursive: true });
    writeFileSync(
      join(obsDir, "preservation.json"),
      JSON.stringify({ github_login: s.login, verified: s.preserved }),
    );
  }

  const res = spawnSync("node", [scriptPath, dir, "TestOrg"], { encoding: "utf8", cwd: dir });
  return { finalizable: JSON.parse(res.stdout.trim()), stderr: res.stderr };
}

test("all submissions preserved -> finalize is complete, not re-queued", () => {
  const res = runWithLockdown([
    { login: "alice", preserved: true },
    { login: "bob", preserved: true },
  ]);
  assert.equal(res.finalizable.length, 0);
});

test("preservation missing -> re-queued (the archive-push regression)", () => {
  // Exactly the 2026-07-30 failure: lockdown succeeded, preserve did not.
  const res = runWithLockdown([{ login: "tomccargo" }]);
  assert.equal(res.finalizable.length, 1);
  assert.equal(res.finalizable[0].assignment_id, "exam");
  assert.match(res.stderr, /preservation-incomplete/);
});

test("preservation present but unverified -> re-queued", () => {
  const res = runWithLockdown([{ login: "alice", preserved: false }]);
  assert.equal(res.finalizable.length, 1);
});

test("partial preservation -> re-queued", () => {
  const res = runWithLockdown([
    { login: "alice", preserved: true },
    { login: "bob" },
  ]);
  assert.equal(res.finalizable.length, 1);
});

test("student without a snapshot SHA cannot be preserved -> not re-queued", () => {
  // A lockdown error (e.g. repo gone) - retrying preserve can never fix it, so
  // it must not pin the assignment in a nightly retry loop.
  const res = runWithLockdown([{ login: "alice", snapshot_sha: null }]);
  assert.equal(res.finalizable.length, 0);
});

test("retry ceiling stops the loop", () => {
  const pending = [{ login: "alice" }];
  assert.equal(runWithLockdown(pending, { attempts: 1 }).finalizable.length, 1);
  assert.equal(runWithLockdown(pending, { attempts: 2 }).finalizable.length, 1);

  const exhausted = runWithLockdown(pending, { attempts: 3 });
  assert.equal(exhausted.finalizable.length, 0, "must stop at the ceiling");
  assert.match(exhausted.stderr, /not retrying/);
  assert.match(exhausted.stderr, /reset finalize_attempts/, "must say how to force a retry");
});

test("record without finalize_attempts (pre-upgrade) counts as attempt 1", () => {
  const dir = mkdtempSync(join(tmpdir(), "pxl-ff-legacy-"));
  const past = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  mkdirSync(join(dir, "assignments"), { recursive: true });
  writeFileSync(join(dir, "assignments", "a.yml"), `state: published\ndeadline_at: "${past}"`);
  mkdirSync(join(dir, "lockdowns", "a"), { recursive: true });
  writeFileSync(
    join(dir, "lockdowns", "a", "lockdown-record.json"),
    JSON.stringify({ results: [{ github_login: "alice", snapshot_sha: "b".repeat(40) }] }),
  );
  const res = spawnSync("node", [scriptPath, dir, "TestOrg"], { encoding: "utf8", cwd: dir });
  assert.equal(JSON.parse(res.stdout.trim()).length, 1, "legacy records still get retried");
});

test("unreadable lockdown record -> re-queued rather than assumed done", () => {
  const dir = mkdtempSync(join(tmpdir(), "pxl-ff-corrupt-"));
  const past = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  mkdirSync(join(dir, "assignments"), { recursive: true });
  writeFileSync(join(dir, "assignments", "a.yml"), `state: published\ndeadline_at: "${past}"`);
  mkdirSync(join(dir, "lockdowns", "a"), { recursive: true });
  writeFileSync(join(dir, "lockdowns", "a", "lockdown-record.json"), "{ not json");
  const res = spawnSync("node", [scriptPath, dir, "TestOrg"], { encoding: "utf8", cwd: dir });
  assert.equal(JSON.parse(res.stdout.trim()).length, 1);
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
