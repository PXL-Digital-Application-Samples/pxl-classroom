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

  return { status: res.status, finalizable, activeCount, dir, stderr: res.stderr };
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
function runWithLockdown(students, { attempts = 1, id = "exam", unread = false } = {}) {
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
        ...(unread ? { snapshot_unread: "commit HTTP 502" } : {}),
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
  return {
    finalizable: JSON.parse(res.stdout.trim()),
    stderr: res.stderr,
    active: JSON.parse(readFileSync(join(dir, "active-TestOrg.json"), "utf8")).active,
  };
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
  // TL-9: and it no longer keeps the nightly on - the night after the ceiling
  // it can switch itself off, where owed work under it kept it running.
  assert.equal(exhausted.active, 0, "nothing more is owed that a pass would do");
  assert.equal(runWithLockdown(pending, { attempts: 2 }).active, 1, "under the ceiling, owed work keeps it on");
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
function runWithDeferrals(students, { id = "exam", attempts = 1, extensions = [], deadline = null, reopens = [], teams = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pxl-ff-defer-"));
  const past = deadline ?? new Date(Date.now() - 30 * 60 * 1000).toISOString();
  if (reopens.length) {
    mkdirSync(join(dir, "lockdowns", id, "unlocked"), { recursive: true });
    for (const r of reopens) {
      writeFileSync(join(dir, "lockdowns", id, "unlocked", `${r.login}.json`),
        r.raw ?? JSON.stringify({ github_login: r.login, unlocked_at: r.unlocked_at, unlocked_by: "lecturer", reason: "let back in" }));
    }
  }
  if (teams.length) {
    mkdirSync(join(dir, "teams", id), { recursive: true });
    for (const t of teams) writeFileSync(join(dir, "teams", id, `${t.slug}.json`), JSON.stringify({ team_slug: t.slug, members: t.members }));
  }

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
        reopened_at: s.reopened_at,
        lockdown_at: s.lockdown_at,
      })),
    }),
  );

  for (const s of students) {
    if (s.preserved === undefined) continue;
    const obsDir = join(dir, "observations", id, s.login);
    mkdirSync(obsDir, { recursive: true });
    writeFileSync(
      join(obsDir, "preservation.json"),
      JSON.stringify({ github_login: s.login, verified: s.preserved, ...(s.preservedSha ? { source_sha: s.preservedSha } : {}) }),
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

// R7-3 (review 2026-10-16): a reopen with time on it is a deferral to that
// time, and the queue comes back for it like any other.
test("R7-3: a student reopened until a deadline that has passed re-queues the assignment, and the log says so", () => {
  const res = runWithDeferrals([{ login: "bob", deferred_until: AN_HOUR_AGO(), reopened_at: new Date(Date.now() - 86400_000).toISOString() }]);
  assert.equal(res.finalizable.length, 1, "locked again at the deadline the reopen ends at");
  assert.match(res.stderr, /1 of them reopened until it/);
});

// R7-20 (review 2026-10-16): a reopen with time on it that no pass deferred -
// the reopen came after the lock, the time ran out before the next pass - is
// owed its re-lock all the same.
const HOURS_AGO = (h) => new Date(Date.now() - h * 3600_000).toISOString();

test("R7-20: a student reopened with an extension that has since run out re-queues the assignment", () => {
  const res = runWithDeferrals(
    [{ login: "bob", preserved: true, lockdown_at: HOURS_AGO(4.5) }],
    { deadline: HOURS_AGO(5), reopens: [{ login: "bob", unlocked_at: HOURS_AGO(4) }], extensions: [{ login: "bob", value: HOURS_AGO(1) }] },
  );
  assert.equal(res.finalizable.length, 1, "locked, archived and graded again at the end of the extension");
  assert.match(res.stderr, /reopen-ended \(1 student/);
});

test("R7-20: one locked again since the reopen is owed nothing more", () => {
  const res = runWithDeferrals(
    [{ login: "bob", preserved: true, preservedSha: "a".repeat(40), lockdown_at: HOURS_AGO(0.9) }],
    { deadline: HOURS_AGO(5), reopens: [{ login: "bob", unlocked_at: HOURS_AGO(4) }], extensions: [{ login: "bob", value: HOURS_AGO(1) }] },
  );
  assert.equal(res.finalizable.length, 0, "the re-lock happened; the next pass would loop");
});

test("R7-20: a reopen made after the deadline in force has no end and queues nothing", () => {
  const res = runWithDeferrals(
    [{ login: "bob", preserved: true, lockdown_at: HOURS_AGO(4.5) }],
    { deadline: HOURS_AGO(5), reopens: [{ login: "bob", unlocked_at: HOURS_AGO(4) }] },
  );
  assert.equal(res.finalizable.length, 0, "open until Lock again, as it always was");
});

test("R7-20: a reopen whose time is still running queues nothing yet and keeps the nightly on", () => {
  const res = runWithDeferrals(
    [{ login: "bob", preserved: true, lockdown_at: HOURS_AGO(4.5) }],
    { deadline: HOURS_AGO(5), reopens: [{ login: "bob", unlocked_at: HOURS_AGO(4) }], extensions: [{ login: "bob", value: IN_A_WEEK() }] },
  );
  assert.equal(res.finalizable.length, 0);
  assert.equal(res.activeCount, 1, "the nightly comes back at the extension's end");
});

test("R7-20: a teammate's extension is the repository's, so a reopened member's time ends with it", () => {
  const students = [{ login: "alice", preserved: true, lockdown_at: HOURS_AGO(4.5) }, { login: "bob", preserved: true, lockdown_at: HOURS_AGO(4.5) }];
  const opts = { deadline: HOURS_AGO(5), reopens: [{ login: "alice", unlocked_at: HOURS_AGO(4) }], extensions: [{ login: "bob", value: HOURS_AGO(1) }] };
  assert.equal(runWithDeferrals(students, { ...opts, teams: [{ slug: "team-a", members: ["alice", "bob"] }] }).finalizable.length, 1, "one repository, one lock");
  assert.equal(runWithDeferrals(students, opts).finalizable.length, 0, "not teammates: alice's own deadline is before her reopen");
});

test("R7-20: an unreadable reopen record has no end, as lockdown reads it", () => {
  const res = runWithDeferrals(
    [{ login: "bob", preserved: true, lockdown_at: HOURS_AGO(4.5) }],
    { deadline: HOURS_AGO(5), reopens: [{ login: "bob", raw: "{not json" }], extensions: [{ login: "bob", value: HOURS_AGO(1) }] },
  );
  assert.equal(res.finalizable.length, 0);
});

test("R7-3: a snapshot whose archive is the FIRST one's is owed a preservation", () => {
  const res = runWithDeferrals([{ login: "bob", snapshot_sha: "b".repeat(40), preserved: true, preservedSha: "a".repeat(40) }]);
  assert.equal(res.finalizable.length, 1, "the archive holds the first lock's snapshot, not this one");
  assert.match(res.stderr, /preservation-incomplete/);
  const done = runWithDeferrals([{ login: "bob", snapshot_sha: "b".repeat(40), preserved: true, preservedSha: "b".repeat(40) }]);
  assert.equal(done.finalizable.length, 0, "this one archived: nothing owed");
});

test("an expired extension stops keeping the assignment active", () => {
  const res = runWithDeferrals(
    [{ login: "bob", deferred_until: AN_HOUR_AGO() }],
    { extensions: [{ login: "bob", value: AN_HOUR_AGO() }] },
  );
  // Not as a running extension any more - only as tonight's owed pass for
  // bob, queued below; the night after, nothing is owed and it counts 0.
  assert.equal(res.finalizable.length, 1);
  assert.equal(res.activeCount, 1, "the owed pass, and nothing else");
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
  assert.equal(res.activeCount, 2, "carol's running extension keeps the nightly awake, and so does bob's owed pass");
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
  // a7 and a8 (a future deadline), and a9: past its deadline and not finalized
  // yet, so it is queued tonight - and owed work keeps the nightly on.
  assert.equal(res.activeCount, 3);
  assert.deepEqual(res.finalizable.map((f) => f.assignment_id), ["a9"]);
});

test("owed work keeps the nightly on: a partly failed preservation is retried, not switched off after", () => {
  // Review 2026-10-14: `partial` exits 0, the last active deadline was past,
  // the count was 0, and the nightly disabled itself with a retry owed.
  const dir = mkdtempSync(join(tmpdir(), "pxl-ff-owed-"));
  const past = new Date(Date.now() - 3600_000).toISOString();
  mkdirSync(join(dir, "assignments"), { recursive: true });
  writeFileSync(join(dir, "assignments", "exam.yml"), `state: closed\ndeadline_at: "${past}"`);
  mkdirSync(join(dir, "lockdowns", "exam"), { recursive: true });
  writeFileSync(join(dir, "lockdowns", "exam", "lockdown-record.json"), JSON.stringify({
    schema_version: 1, assignment_id: "exam", finalize_attempts: 1,
    results: [{ github_login: "alice", snapshot_sha: "a".repeat(40) }],
  }));
  spawnSync("node", [scriptPath, dir, "TestOrg"], { encoding: "utf8", cwd: dir });
  assert.equal(JSON.parse(readFileSync(join(dir, "active-TestOrg.json"), "utf8")).active, 1);
});

test("a snapshot that could not be read is read again on the next pass, under the ceiling", () => {
  // Review 2026-10-14: a 502 at the deadline left `snapshot_sha: null`, and
  // the student was never preserved and never retried.
  const res = runWithLockdown([{ login: "alice", snapshot_sha: null }], { unread: true });
  assert.equal(res.finalizable.length, 1);
  assert.equal(runWithLockdown([{ login: "alice", snapshot_sha: null }], { unread: true, attempts: 3 }).finalizable.length, 0, "the ceiling still holds");
});

test("archived or back to draft AFTER students accepted is still finalized at the deadline; with nobody accepted it is not", () => {
  // Review 2026-10-14: archived before the nightly, an exam was never locked,
  // archived, or its broker closed.
  const past = new Date(Date.now() - 3600_000).toISOString();
  for (const state of ["archived", "draft"]) {
    const dir = mkdtempSync(join(tmpdir(), "pxl-ff-archived-"));
    mkdirSync(join(dir, "assignments"), { recursive: true });
    writeFileSync(join(dir, "assignments", "exam.yml"), `state: ${state}\ndeadline_at: "${past}"`);
    const run = () => JSON.parse(spawnSync("node", [scriptPath, dir, "TestOrg"], { encoding: "utf8", cwd: dir }).stdout.trim());
    // Nothing to finalize. An archived one was published, so its broker is
    // owed a close and nothing else (R7-11, tests/close-only.test.mjs); this
    // draft never went live, so it has no broker.
    assert.deepEqual(run(), state === "archived" ? [{ org: "TestOrg", assignment_id: "exam", close_only: true }] : [], `${state} with nobody accepted: no finalize`);
    mkdirSync(join(dir, "repositories", "exam"), { recursive: true });
    writeFileSync(join(dir, "repositories", "exam", "alice.json"), "{}");
    assert.deepEqual(run(), [{ org: "TestOrg", assignment_id: "exam" }], `${state} with a repository: finalized, whole`);
  }
});

test("R6-5: a repository created after the lock, for a student the lock record has no row for, is owed a pass", () => {
  const past = new Date(Date.now() - 86400_000).toISOString();
  const lockedAt = new Date(Date.now() - 3600_000).toISOString();
  const run = ({ created, row }) => {
    const dir = mkdtempSync(join(tmpdir(), "pxl-ff-late-join-"));
    mkdirSync(join(dir, "assignments"), { recursive: true });
    writeFileSync(join(dir, "assignments", "exam.yml"), `state: published\ndeadline_at: "${past}"`);
    mkdirSync(join(dir, "repositories", "exam"), { recursive: true });
    writeFileSync(join(dir, "repositories", "exam", "ann.json"), JSON.stringify({ github_login: "ann", repo_name: "TestOrg/exam-ann", created_at: created }));
    mkdirSync(join(dir, "lockdowns", "exam"), { recursive: true });
    writeFileSync(join(dir, "lockdowns", "exam", "lockdown-record.json"), JSON.stringify({
      locked_at: lockedAt, results: row ? [{ github_login: "Ann", snapshot_sha: "a".repeat(40), verified: true }] : [],
    }));
    // Preserved and the broker closed, so nothing else is owed.
    mkdirSync(join(dir, "observations", "exam", "ann"), { recursive: true });
    writeFileSync(join(dir, "observations", "exam", "ann", "preservation.json"), JSON.stringify({ verified: true }));
    writeFileSync(join(dir, "lockdowns", "exam", "broker-closed.json"), JSON.stringify({ closed: true, key_removed: true }));
    const res = spawnSync("node", [scriptPath, dir, "TestOrg"], { encoding: "utf8", cwd: dir });
    return { queued: JSON.parse(res.stdout.trim()).map((f) => f.assignment_id), stderr: res.stderr };
  };
  const after = new Date(Date.now() - 600_000).toISOString();
  const late = run({ created: after, row: false });
  assert.deepEqual(late.queued, ["exam"], late.stderr);
  assert.match(late.stderr, /joined-after-lock \(1 student/);
  // Before the lock and still no row: a repository the lock found gone, not new work.
  assert.deepEqual(run({ created: new Date(Date.now() - 7200_000).toISOString(), row: false }).queued, []);
  // A Retry of a student the lock holds rewrites a record that has a row.
  assert.deepEqual(run({ created: after, row: true }).queued, []);
});

test("R6-4: an archived or draft assignment whose deadline passed before the widening is NOT finalized now, students or not", () => {
  // P2-25 widened the finalize with no cutoff, so last year's archived courses
  // - students in them, never locked because archived - would be locked out of
  // the blue at the next nightly (review 2026-10-15).
  for (const state of ["archived", "draft"]) {
    const dir = mkdtempSync(join(tmpdir(), "pxl-ff-old-archived-"));
    mkdirSync(join(dir, "assignments"), { recursive: true });
    writeFileSync(join(dir, "assignments", "old.yml"), `state: ${state}\ndeadline_at: "2025-06-20T10:00:00Z"`);
    mkdirSync(join(dir, "repositories", "old"), { recursive: true });
    writeFileSync(join(dir, "repositories", "old", "alice.json"), "{}");
    const run = JSON.parse(spawnSync("node", [scriptPath, dir, "TestOrg"], { encoding: "utf8", cwd: dir }).stdout.trim());
    assert.deepEqual(run, [], `${state}, deadline 2025: left alone`);
  }
  // A published one from then still is, as it always was.
  const dir = mkdtempSync(join(tmpdir(), "pxl-ff-old-published-"));
  mkdirSync(join(dir, "assignments"), { recursive: true });
  writeFileSync(join(dir, "assignments", "old.yml"), `state: published\ndeadline_at: "2025-06-20T10:00:00Z"`);
  assert.deepEqual(JSON.parse(spawnSync("node", [scriptPath, dir, "TestOrg"], { encoding: "utf8", cwd: dir }).stdout.trim()).map((f) => f.assignment_id), ["old"]);
});

test("P2-34: a broker the finalize left open is owed a pass, up to the ceiling; one closed, or finished before the record existed, is not", () => {
  const past = new Date(Date.now() - 3600_000).toISOString();
  const run = (lockedAt, closed) => {
    const dir = mkdtempSync(join(tmpdir(), "pxl-ff-broker-"));
    mkdirSync(join(dir, "assignments"), { recursive: true });
    writeFileSync(join(dir, "assignments", "exam.yml"), `state: closed\ndeadline_at: "${past}"`);
    mkdirSync(join(dir, "lockdowns", "exam"), { recursive: true });
    writeFileSync(join(dir, "lockdowns", "exam", "lockdown-record.json"), JSON.stringify({ locked_at: lockedAt, results: [] }));
    if (closed) writeFileSync(join(dir, "lockdowns", "exam", "broker-closed.json"), JSON.stringify(closed));
    const res = spawnSync("node", [scriptPath, dir, "TestOrg"], { encoding: "utf8", cwd: dir });
    return { queued: JSON.parse(res.stdout.trim()).map((f) => f.assignment_id), stderr: res.stderr };
  };
  const now = new Date().toISOString();
  const open = run(now, { closed: false, key_removed: false, attempts: 1 });
  assert.deepEqual(open.queued, ["exam"], `left open: tried again (${open.stderr})`);
  assert.match(run(now, { closed: true, key_removed: false, attempts: 2 }).stderr, /broker-not-closed \(attempt 3\)/, "the key still on it counts too");
  assert.deepEqual(run(now, { closed: true, key_removed: true, attempts: 2 }).queued, [], "done");
  const atCeiling = run(now, { closed: false, key_removed: false, attempts: 3 });
  assert.deepEqual(atCeiling.queued, [], "not for ever");
  assert.match(atCeiling.stderr, /still not closed after 3 attempts/);
  assert.deepEqual(run("2026-10-16T09:00:00Z", null).queued, ["exam"], "locked since the record exists, and none written: owed");
  assert.deepEqual(run("2026-09-01T00:00:00Z", null).queued, [], "finished before the record existed: not re-run for it");
});

test("P2-25: archived or back to draft BEFORE its deadline with students in it keeps the nightly on; with nobody in it, it does not", () => {
  // Review 2026-10-14: the finalize queue asked "published, closed, or has
  // repositories", the active count only "published or closed" - so an exam
  // archived before its deadline was not active, the nightly could switch
  // itself off, and the deadline it would have locked never came.
  const future = new Date(Date.now() + 2 * 3600_000).toISOString();
  for (const state of ["archived", "draft"]) {
    const dir = mkdtempSync(join(tmpdir(), "pxl-ff-archived-early-"));
    mkdirSync(join(dir, "assignments"), { recursive: true });
    writeFileSync(join(dir, "assignments", "exam.yml"), `state: ${state}\ndeadline_at: "${future}"`);
    const active = () => {
      spawnSync("node", [scriptPath, dir, "TestOrg"], { encoding: "utf8", cwd: dir });
      return JSON.parse(readFileSync(join(dir, "active-TestOrg.json"), "utf8")).active;
    };
    assert.equal(active(), 0, `${state}, nobody accepted: nothing keeps the nightly on`);
    mkdirSync(join(dir, "repositories", "exam"), { recursive: true });
    writeFileSync(join(dir, "repositories", "exam", "alice.json"), "{}");
    assert.equal(active(), 1, `${state} with a student's repository: active until its deadline`);
  }
});

// --- activeCount is what switches the nightly off -----------------------------
//
// daily-activity.yml disables itself when `active` reaches 0, and that cron is
// what enforces every deadline. The count used to be computed inside a silent
// `catch(e) {}`, so an assignment whose YAML would not parse was simply not
// counted - and one unreadable file could switch the nightly off. Unreadable is
// not evidence that nothing is active. Being wrong the other way costs one cron
// firing that finds nothing to do.

test("an unreadable assignment counts as active rather than switching the nightly off", () => {
  const res = runFindFinalizable({
    // Valid YAML scalars where a mapping is required: loadYaml resolves it and
    // the shape blows up downstream, which is the ordinary way a hand-edited
    // file fails.
    broken: ": : not: valid: yaml: [",
  });
  assert.equal(
    res.activeCount,
    1,
    "an assignment we could not read must not be counted as 'nothing is active'",
  );
  assert.match(res.stderr ?? "", /unreadable/i, "and it must say so rather than failing silently");
});

test("a readable, finished assignment still counts as inactive", () => {
  // The other half: the fallback above must not make everything look active for
  // ever, or the nightly never switches off and the minimal-minutes design goes
  // with it.
  const past = new Date(Date.now() - 48 * 3600_000).toISOString();
  // Finalized (a lockdown record that owes nothing): nothing keeps it on.
  const res = runFindFinalizable({ done: `state: published\ndeadline_at: "${past}"\n` }, ["done"]);
  assert.equal(res.activeCount, 0, "a finalized assignment past its deadline is not active");
});
