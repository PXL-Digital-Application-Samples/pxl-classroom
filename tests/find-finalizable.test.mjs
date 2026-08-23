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

// --- deadline extensions -----------------------------------------------------
//
// lockdown.mjs leaves a student with a running extension alone and records
// `deferred_until` against them. Two things have to follow, or the extension is
// worse than useless: the assignment must come back once that instant passes,
// and it must stay "active" until then - activeCount == 0 is what disables
// daily-activity.yml, so a nightly that switches itself off while somebody is
// still working never observes their commits and never finalizes them.

/**
 * Past-deadline assignment whose lockdown record holds a mix of locked and
 * deferred students, plus the overrides that produced the deferrals.
 *   students: [{ login, snapshot_sha, preserved, deferred_until }]
 */
function runWithDeferrals(students, { id = "exam", attempts = 1, extensions = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pxl-ff-defer-"));
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
        snapshot_sha: s.deferred_until || s.snapshot_sha === null ? null : (s.snapshot_sha ?? "a".repeat(40)),
        deferred_until: s.deferred_until,
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

  if (extensions.length) {
    mkdirSync(join(dir, "overrides", id), { recursive: true });
    for (const e of extensions) {
      writeFileSync(
        join(dir, "overrides", id, `${e.login}.json`),
        JSON.stringify({
          schema_version: 1,
          assignment_id: id,
          github_login: e.login,
          overrides: [
            {
              type: "deadline_extension",
              value: e.value,
              reason: "medical extension",
              overridden_by: "admin-panel",
              overridden_at: new Date().toISOString(),
            },
          ],
        }),
      );
    }
  }

  const res = spawnSync("node", [scriptPath, dir, "TestOrg"], { encoding: "utf8", cwd: dir });
  let activeCount = 0;
  try {
    activeCount = JSON.parse(readFileSync(join(dir, "active-TestOrg.json"), "utf8")).active;
  } catch { /* not written */ }
  return { finalizable: JSON.parse(res.stdout.trim()), stderr: res.stderr, activeCount };
}

const IN_A_WEEK = () => new Date(Date.now() + 7 * 86400000).toISOString();
const AN_HOUR_AGO = () => new Date(Date.now() - 3600000).toISOString();

test("a running extension keeps the assignment active so the nightly stays on", () => {
  const res = runWithDeferrals(
    [{ login: "alice", preserved: true }, { login: "bob", deferred_until: IN_A_WEEK() }],
    { extensions: [{ login: "bob", value: IN_A_WEEK() }] },
  );
  assert.equal(res.activeCount, 1, "daily-activity must not disable itself mid-extension");
});

test("a still-running deferral is not re-queued yet", () => {
  const res = runWithDeferrals(
    [{ login: "alice", preserved: true }, { login: "bob", deferred_until: IN_A_WEEK() }],
    { extensions: [{ login: "bob", value: IN_A_WEEK() }] },
  );
  assert.equal(res.finalizable.length, 0, "bob is still working; nothing to do");
});

test("an expired deferral re-queues the assignment", () => {
  const res = runWithDeferrals(
    [{ login: "alice", preserved: true }, { login: "bob", deferred_until: AN_HOUR_AGO() }],
    { extensions: [{ login: "bob", value: AN_HOUR_AGO() }] },
  );
  assert.equal(res.finalizable.length, 1, "bob's extension is over - finalize him");
  assert.match(res.stderr, /extension-expired/);
});

test("an expired extension stops keeping the assignment active", () => {
  const res = runWithDeferrals(
    [{ login: "bob", deferred_until: AN_HOUR_AGO() }],
    { extensions: [{ login: "bob", value: AN_HOUR_AGO() }] },
  );
  assert.equal(res.activeCount, 0);
});

test("an expired deferral re-queues even at the retry ceiling", () => {
  // The ceiling exists to stop a permanently un-preservable repo burning a
  // matrix leg every night. Finalizing a student for the first time is new
  // work, not a retry, and it can only happen once per deferral.
  const res = runWithDeferrals(
    [{ login: "bob", deferred_until: AN_HOUR_AGO() }],
    { attempts: 3, extensions: [{ login: "bob", value: AN_HOUR_AGO() }] },
  );
  assert.equal(res.finalizable.length, 1);
  assert.match(res.stderr, /extension-expired/);
});

test("a deferral due exactly now is due", () => {
  const res = runWithDeferrals(
    [{ login: "bob", deferred_until: new Date(Date.now() - 1).toISOString() }],
    { extensions: [{ login: "bob", value: new Date(Date.now() - 1).toISOString() }] },
  );
  assert.equal(res.finalizable.length, 1);
});

test("a malformed deferred_until does not queue the assignment every night forever", () => {
  // An unparseable date compares false against everything, so it is never
  // "due" - which is the safe direction: a human sees an unfinalized
  // assignment rather than a matrix leg burning nightly.
  const res = runWithDeferrals([{ login: "bob", deferred_until: "next tuesday" }]);
  assert.equal(res.finalizable.length, 0);
});

test("a mixed record queues on the expired deferral even while another still runs", () => {
  const res = runWithDeferrals(
    [
      { login: "alice", preserved: true },
      { login: "bob", deferred_until: AN_HOUR_AGO() },
      { login: "carol", deferred_until: IN_A_WEEK() },
    ],
    { extensions: [{ login: "carol", value: IN_A_WEEK() }] },
  );
  assert.equal(res.finalizable.length, 1, "bob is due; carol is not, and waiting for her would strand him");
  assert.equal(res.activeCount, 1, "and carol keeps the nightly awake");
});

test("an expired deferral is reported before an incomplete preservation", () => {
  // Both are true at once here. The message a human reads should name the new
  // work, not the retry - they are different problems.
  const res = runWithDeferrals([
    { login: "alice" },
    { login: "bob", deferred_until: AN_HOUR_AGO() },
  ]);
  assert.equal(res.finalizable.length, 1);
  assert.match(res.stderr, /extension-expired/);
});

test("an unreadable override does not stop the assignment being counted", () => {
  const dir = mkdtempSync(join(tmpdir(), "pxl-ff-badoverride-"));
  const future = new Date(Date.now() + 86400000).toISOString();
  mkdirSync(join(dir, "assignments"), { recursive: true });
  writeFileSync(join(dir, "assignments", "a.yml"), `state: published\ndeadline_at: "${future}"`);
  mkdirSync(join(dir, "overrides", "a"), { recursive: true });
  writeFileSync(join(dir, "overrides", "a", "bob.json"), "{ not json");
  const res = spawnSync("node", [scriptPath, dir, "TestOrg"], { encoding: "utf8", cwd: dir });
  assert.equal(JSON.parse(res.stdout.trim()).length, 0);
  assert.match(res.stderr, /Unreadable override/);
  assert.equal(JSON.parse(readFileSync(join(dir, "active-TestOrg.json"), "utf8")).active, 1);
});

test("a deferred student who then failed to lock down does not loop forever", () => {
  // Second pass: the extension is over and the deferral was cleared, but the
  // repo could not be locked (deleted, say). No snapshot, no deferred_until -
  // retrying can never fix it, so it must not pin a nightly matrix leg.
  const res = runWithDeferrals([{ login: "bob", snapshot_sha: null }]);
  assert.equal(res.finalizable.length, 0);
});

test("draft and past-deadline not counted in activeCount, published and closed with future deadline counted", () => {
  const future = new Date(Date.now() + 86400000).toISOString();
  const past = new Date(Date.now() - 86400000).toISOString();
  const res = runFindFinalizable({
    "a6": `state: draft\ndeadline_at: "${future}"`,
    "a7": `state: closed\ndeadline_at: "${future}"`,
    "a8": `state: published\ndeadline_at: "${future}"`,
    "a9": `state: closed\ndeadline_at: "${past}"`
  });
  assert.equal(res.activeCount, 2); // a7 (closed with future deadline) + a8 (published with future deadline)
});
