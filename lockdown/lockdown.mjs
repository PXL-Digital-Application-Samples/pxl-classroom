#!/usr/bin/env node
// PXL Classroom - deadline lock-down.
//
// Four phases, in this order, for the whole cohort:
//
//   0. PLAN    - who this run acts on, and who it deliberately leaves alone
//                (a granted extension still running defers that repository)
//   1. STOP    - stop writes to the submission ref. Time-critical.
//   2. RECORD  - repo object, pushed_at, HEAD, and the final observation
//   3. PRESERVE- preserve/preserve.mjs, a separate step in the workflow
//   4. DEMOTE  - collaborator -> pull, only when STOP did not already do it
//
// The order matters and it used to be the other way round. One loop read a
// student's HEAD and then demoted them, per student, so in a 200-student cohort
// student 1 was frozen at T+0s and student 200 minutes later - the demotion is
// a write against an ~80/min secondary limit. Two consequences nobody would
// choose: students at the end of the list got extra time, and the snapshot was
// not a consistent cut, because student 1's HEAD was read minutes before
// student 200's.
//
// Stopping first fixes both. Every HEAD in phase 2 is read after all writes
// stopped, so the cohort is cut at one instant, and phase 2 is safely
// re-runnable because the repositories cannot move any more.
//
// STOP is one function - applySubmissionLock() - because *how* it stops is a
// per-assignment decision. Today it demotes (`lock_method: "demotion"`), which
// is N calls; a repository ruleset flipped to `enforcement: active` is one call
// for the whole cohort and leaves the student their Actions, secrets and
// runners. The rest of the file does not care which ran.
//
// Continues on per-student errors. No npm dependencies (Node 18+ fetch).

import { appendFile, readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { loadYaml } from "../lib/yaml.mjs";
import { gh } from "../lib/gh.mjs";
import { effectiveDeadlineFor } from "../lib/effective-deadline.mjs";

const env = (k, d) => process.env[k] ?? d;
const cfg = {
  token: env("GITHUB_TOKEN"),
  org: env("ORG"),
  assignmentId: env("ASSIGNMENT_ID"),
  dataDir: env("DATA_DIR"),
  apiBase: env("GITHUB_API_URL", "https://api.github.com"),
  runUrl: `${env("GITHUB_SERVER_URL", "https://github.com")}/${env("GITHUB_REPOSITORY", "_")}` +
          `/actions/runs/${env("GITHUB_RUN_ID", "0")}`,
};

// --- Actions output / summary helpers ----------------------------------------
async function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `${name}=${value ?? ""}\n`);
}
async function summary(md) {
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, md + "\n");
}
const steps = [];
const log = (step, detail) => { steps.push({ step, ...detail }); console.log(`[${detail.ok === false ? "FAIL" : "ok"}] ${step}${detail.note ? ` - ${detail.note}` : ""}`); };

async function fail(category, note) {
  log(category, { ok: false, note });
  await setOutput("outcome", category);
  await summary(`### Lockdown FAILED: \`${category}\`\n\n${note ?? ""}`);
  process.exit(1);
}

// --- Strict input validation -------------------------------------------------
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/;
const PATH = /^[A-Za-z0-9._/\\:-]+$/;

function validate() {
  if (!cfg.token) return "GITHUB_TOKEN is required (App installation token)";
  if (!cfg.org || !NAME.test(cfg.org)) return `ORG="${cfg.org}" is not a valid GitHub name`;
  if (!cfg.assignmentId || !SLUG.test(cfg.assignmentId)) return `ASSIGNMENT_ID="${cfg.assignmentId}" is not a valid slug`;
  if (!cfg.dataDir || !PATH.test(cfg.dataDir)) return `DATA_DIR="${cfg.dataDir}" is not a valid path`;
  return null;
}

// --- Read assignment definition ----------------------------------------------
async function readAssignment() {
  for (const ext of ["yml", "yaml"]) {
    try {
      return await loadYaml(join(cfg.dataDir, "assignments", `${cfg.assignmentId}.${ext}`));
    } catch { /* try next extension */ }
  }
  try {
    const raw = await readFile(join(cfg.dataDir, "assignments", `${cfg.assignmentId}.json`), "utf8");
    return JSON.parse(raw);
  } catch { return null; }
}

// --- Read repository records -------------------------------------------------
async function readRepoRecords() {
  const dir = join(cfg.dataDir, "repositories", cfg.assignmentId);
  let files;
  try { files = await readdir(dir); } catch { return []; }
  const records = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      records.push(JSON.parse(await readFile(join(dir, f), "utf8")));
    } catch (e) {
      log(`read ${f}`, { ok: false, note: e.message });
    }
  }
  return records;
}

// --- Read lecturer overrides -------------------------------------------------
//
// A granted extension is the only thing that can move a student's deadline, and
// until this was added lockdown never looked: an extended student was demoted to
// `pull` at the assignment's own deadline while report.mjs told the lecturer
// their extension was running. See lib/effective-deadline.mjs.
async function readOverrides() {
  const dir = join(cfg.dataDir, "overrides", cfg.assignmentId);
  let files;
  try { files = await readdir(dir); } catch { return []; }
  const docs = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      docs.push(JSON.parse(await readFile(join(dir, f), "utf8")));
    } catch (e) {
      // The student is locked at the assignment deadline if this file is the
      // one holding their extension, so it is logged as a failure line rather
      // than swallowed - it is the only trace a lecturer would have.
      log(`override ${f}`, { ok: false, note: e.message });
    }
  }
  return docs;
}

// --- Read a previous lockdown record (retry path) ----------------------------
//
// A finalize run can be retried - e.g. preservation failed and find-finalizable
// re-queued the assignment. On a retry the deadline snapshot MUST NOT be taken
// again: the student's HEAD may have moved on since (late pushes still land
// until the demotion propagates, and a lecturer can grant an extension), and
// re-snapshotting would silently replace the on-time submission with a later
// commit. Prior snapshots are therefore frozen and reused verbatim.
//
// Stop-first makes that hazard structural rather than incidental - after phase 1
// nothing can move - but the freeze stays as belt and braces.
async function readPriorLockdown() {
  try {
    const raw = await readFile(
      join(cfg.dataDir, "lockdowns", cfg.assignmentId, "lockdown-record.json"),
      "utf8"
    );
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// --- Phase 0: plan -----------------------------------------------------------
/**
 * Split the cohort into repositories this run acts on and repositories it
 * deliberately leaves alone.
 *
 * A group shares one repository, so the most generous extension among its
 * members governs the repo - locking it at anyone else's deadline locks out the
 * student who was granted the time.
 *
 * Deferral is decided once, here, so "excluded from the target list" means the
 * same thing to the stop as it does to the recording: a deferred repository is
 * never fetched, never observed, and never has a permission touched.
 */
function planTargets(assignment, records, overrides, now = new Date()) {
  const targets = [];
  const deferrals = [];

  for (const rec of records) {
    const login = rec.github_login;
    const members = Array.isArray(rec.members) && rec.members.length ? rec.members : (login ? [login] : []);
    const target = {
      rec,
      login,
      members,
      repoName: rec.repo_name?.split("/")?.[1] ?? rec.repo_name,
      displayKey: rec.team_slug ? `${rec.team_slug} (${members.join(",")})` : login,
    };

    const effective = effectiveDeadlineFor(assignment, login, { overrides, team: { members } });
    // Gated on `extended`, not on the deadline alone: a lecturer running a
    // lockdown early still locks the cohort, exactly as before. Only a granted,
    // still-running extension defers.
    if (effective.extended && effective.deadline > now) {
      deferrals.push({ ...target, effective });
    } else {
      targets.push(target);
    }
  }
  return { targets, deferrals };
}

// --- Phase 1: STOP -----------------------------------------------------------
/**
 * Stop writes to the submission ref for every target. This is the only
 * time-critical phase, and the only one that must happen *at* the deadline.
 *
 * `method` decides how:
 *   "demotion" - collaborator -> pull, one call per member, verified after.
 *                Takes everything, not just push: Actions, secrets,
 *                environments, runners, settings.
 *   "none"     - nothing is stopped. The recording phases still run, so the
 *                report still reflects reality; it just carries no guarantee.
 *
 * Idempotent either way: re-running re-locks anyone who regained write access.
 * Returns per-target outcomes plus the instant the phase fired.
 */
async function applySubmissionLock({ targets, method, priorByLogin }) {
  const lockedAt = new Date().toISOString();
  const byRepo = new Map();

  for (const t of targets) {
    // Frozen on retry: lockdown_at is a historical fact about when this student
    // stopped being able to push, not about when this run happened.
    const priorRec = priorByLogin.get(t.login);
    const lockdownAt = priorRec?.snapshot_sha ? (priorRec.lockdown_at ?? lockedAt) : lockedAt;

    if (method === "none") {
      byRepo.set(t, { locked: false, permissionAfter: null, lockdownAt: null, skipped: true });
      continue;
    }

    let allLocked = true;
    let permAfter = "read";
    try {
      for (const m of t.members) {
        const demote = await gh("PUT", `/repos/${cfg.org}/${t.repoName}/collaborators/${m}`, { permission: "pull" });
        if (!(demote.status === 204 || demote.status === 201)) {
          log(`stop ${m}`, { ok: false, note: `demote HTTP ${demote.status}` });
          allLocked = false;
          continue;
        }
        const verify = await gh("GET", `/repos/${cfg.org}/${t.repoName}/collaborators/${m}/permission`);
        const userPerm = verify.ok ? verify.data.permission : `error-${verify.status}`;
        if (userPerm !== "read") {
          allLocked = false;
          permAfter = userPerm;
        }
      }
    } catch (e) {
      log(`stop ${t.displayKey}`, { ok: false, note: e.message });
      allLocked = false;
      permAfter = "exception";
    }
    byRepo.set(t, { locked: allLocked, permissionAfter: permAfter, lockdownAt });
  }

  log("phase 1 - stop", {
    ok: true,
    note: `${method} applied to ${targets.length} repository/repositories at ${lockedAt}`,
  });
  return { method, lockedAt, byRepo };
}

// --- Phase 2: RECORD ---------------------------------------------------------
/**
 * Read what the cohort looks like now that it cannot change, and write the final
 * observation. Nothing here races anything: phase 1 already stopped the writes.
 *
 * `pushed_at` comes off the repository object this already fetches, at no extra
 * cost. It is GitHub's own server-side timestamp - a student cannot set it - so
 * it is the one piece of evidence in the record that survives an argument about
 * commit dates.
 */
async function recordCohortState({ targets, submissionRef, priorByLogin, prior }) {
  const byRepo = new Map();

  for (const t of targets) {
    try {
      const repoRes = await gh("GET", `/repos/${cfg.org}/${t.repoName}`);
      if (!repoRes.ok) {
        log(`record ${t.login}`, { ok: false, note: `repo HTTP ${repoRes.status}` });
        byRepo.set(t, { ok: false, reason: `repo HTTP ${repoRes.status}` });
        continue;
      }
      const branch = submissionRef.startsWith("refs/heads/")
        ? submissionRef.slice("refs/heads/".length)
        : repoRes.data.default_branch;

      // Frozen on retry: never re-snapshot a student who was already locked
      // down, or a late commit would replace their on-time submission.
      const priorRec = priorByLogin.get(t.login);
      const frozen = !!priorRec?.snapshot_sha;
      let snapshotSha;
      if (frozen) {
        snapshotSha = priorRec.snapshot_sha;
        log(`record ${t.login}`, {
          ok: true,
          note: `snapshot frozen from attempt #${prior?.finalize_attempts ?? 1} (${snapshotSha.slice(0, 12)})`,
        });
      } else {
        const commitRes = await gh("GET", `/repos/${cfg.org}/${t.repoName}/commits/${branch}`);
        snapshotSha = commitRes.ok ? commitRes.data.sha : null;
      }

      // Write the final observation (only for a fresh snapshot - re-recording a
      // frozen one would fabricate a second observation of the same fact)
      if (snapshotSha && !frozen) {
        const now = new Date().toISOString();
        const safeTs = now.replace(/[:.]/g, "-");
        for (const m of t.members) {
          const observation = {
            schema_version: 1,
            assignment_id: cfg.assignmentId,
            github_login: m,
            team_slug: t.rec.team_slug || undefined,
            repo_id: repoRes.data.id,
            observed_at: now,
            ref: submissionRef,
            sha: snapshotSha,
            observer_run: cfg.runUrl,
            collection_type: "lockdown",
          };
          const obsDir = join(cfg.dataDir, "observations", cfg.assignmentId, m);
          await mkdir(obsDir, { recursive: true });
          await writeFile(join(obsDir, `${safeTs}.json`), JSON.stringify(observation, null, 2) + "\n");
        }
      }

      byRepo.set(t, {
        ok: true,
        repoId: repoRes.data.id,
        branch,
        snapshotSha,
        frozen,
        pushedAt: repoRes.data.pushed_at ?? null,
      });
    } catch (e) {
      log(`record ${t.login || t.rec.team_slug}`, { ok: false, note: e.message });
      byRepo.set(t, { ok: false, reason: e.message });
    }
  }
  return byRepo;
}

// --- Main --------------------------------------------------------------------
async function main() {
  const bad = validate();
  if (bad) await fail("fail:validation", bad);

  // Auth check
  const ping = await gh("GET", "/rate_limit");
  if (!ping.ok) await fail("fail:auth", `token rejected (HTTP ${ping.status})`);
  log("auth", { ok: true, note: "installation token accepted" });

  // Read assignment
  const assignment = await readAssignment();
  if (!assignment) await fail("fail:assignment", `no assignment file for "${cfg.assignmentId}"`);
  const submissionRef = assignment.submission_ref || "refs/heads/main";
  const deadlineAt = assignment.deadline_at || null;
  log("assignment", { ok: true, note: `deadline_at=${deadlineAt} submission_ref=${submissionRef}` });

  // Prior lockdown (retry path) - frozen snapshots, keyed by login
  const prior = await readPriorLockdown();
  const priorByLogin = new Map(
    (prior?.results || []).filter((r) => r.github_login).map((r) => [r.github_login, r])
  );
  const attempt = (prior?.finalize_attempts ?? 0) + 1;
  if (prior) {
    log("prior-lockdown", {
      ok: true,
      note: `retry #${attempt} - reusing ${priorByLogin.size} frozen snapshot(s)`,
    });
  }

  // Lecturer overrides - who has been granted more time
  const overrides = await readOverrides();
  if (overrides.length) {
    log("overrides", { ok: true, note: `${overrides.length} override document(s)` });
  }

  // Repo records. Zero students is a valid population - the phases below no-op
  // and the record is still written, which preserve needs in order to report
  // "no students to preserve" instead of fail:no-lockdowns.
  const records = await readRepoRecords();
  log("repo-records", { ok: true, note: records.length ? `${records.length} student(s)` : "no repository records - nothing to lock down" });

  // --- Phase 0: plan ---------------------------------------------------------
  const { targets, deferrals } = planTargets(assignment, records, overrides);
  for (const d of deferrals) {
    log(`lockdown ${d.displayKey}`, {
      ok: true,
      note: `deferred - extension granted to ${d.effective.grantedTo} runs to ${d.effective.deadline.toISOString()}`,
    });
  }

  // --- Phase 1: STOP ---------------------------------------------------------
  // "demotion" is the only method implemented today; it is what the record's
  // lock_method reports, so a report can say which guarantee applied.
  const lockMethod = targets.length ? "demotion" : "none";
  const lock = await applySubmissionLock({ targets, method: lockMethod, priorByLogin });

  // --- Phase 2: RECORD -------------------------------------------------------
  const recorded = await recordCohortState({ targets, submissionRef, priorByLogin, prior });

  // --- Assemble the record ---------------------------------------------------
  let lockedCount = 0;
  let errorCount = 0;
  let maxUncertainty = 0;
  const rows = [];
  const lockdownResults = [];

  for (const d of deferrals) {
    const deferredUntil = d.effective.deadline.toISOString();
    rows.push(`| ${d.displayKey} | - | - | deferred to ${deferredUntil} |`);
    for (const m of d.members) {
      lockdownResults.push({
        github_login: m,
        team_slug: d.rec.team_slug || undefined,
        repo_name: `${cfg.org}/${d.repoName}`,
        repo_id: d.rec.repo_id ?? null,
        snapshot_sha: null,
        snapshot_ref: submissionRef,
        lockdown_at: null,
        deferred_until: deferredUntil,
        deferred_reason: d.effective.reason,
        permission_after: null,
        verified: false,
        uncertainty_seconds: null,
      });
    }
  }

  for (const t of targets) {
    const state = recorded.get(t);
    const stop = lock.byRepo.get(t);

    // A repository that could not be read produces no result row, exactly as
    // before: preserve iterates the results, and a row it can never preserve
    // would turn every subsequent night amber for a repo that is simply gone.
    if (!state?.ok) {
      errorCount++;
      rows.push(`| ${t.displayKey} | - | - | error |`);
      continue;
    }

    const lockdownAt = stop.lockdownAt;
    let uncertaintySec = null;
    if (deadlineAt && lockdownAt) {
      uncertaintySec = Math.round((new Date(lockdownAt) - new Date(deadlineAt)) / 1000);
      if (Math.abs(uncertaintySec) > maxUncertainty) maxUncertainty = Math.abs(uncertaintySec);
    }

    for (const m of t.members) {
      lockdownResults.push({
        github_login: m,
        team_slug: t.rec.team_slug || undefined,
        repo_name: `${cfg.org}/${t.repoName}`,
        repo_id: state.repoId,
        snapshot_sha: state.snapshotSha,
        snapshot_ref: submissionRef,
        // GitHub's own server-side timestamp for the last push to any ref.
        // Unlike a commit date, a student cannot set it.
        pushed_at: state.pushedAt,
        lockdown_at: lockdownAt,
        lock_method: lock.method,
        permission_after: stop.permissionAfter,
        verified: stop.locked,
        uncertainty_seconds: uncertaintySec,
      });
    }

    const sha12 = (state.snapshotSha || "-").slice(0, 12);
    if (stop.locked) {
      lockedCount++;
      log(`lockdown ${t.displayKey}`, { ok: true, note: `${state.branch}@${sha12} -> pull (${uncertaintySec ?? "?"}s)` });
      rows.push(`| ${t.displayKey} | \`${sha12}\` | ${uncertaintySec ?? "-"}s | [OK] locked |`);
    } else {
      errorCount++;
      log(`lockdown ${t.displayKey}`, { ok: false, note: `permission after=${stop.permissionAfter}, expected read` });
      rows.push(`| ${t.displayKey} | \`${sha12}\` | ${uncertaintySec ?? "-"}s | perm=${stop.permissionAfter} |`);
    }
  }

  // Write lockdown record
  const lockdownDir = join(cfg.dataDir, "lockdowns", cfg.assignmentId);
  await mkdir(lockdownDir, { recursive: true });
  const lockdownRecord = {
    schema_version: 1,
    assignment_id: cfg.assignmentId,
    deadline_at: deadlineAt,
    executed_at: new Date().toISOString(),
    // First finalize is attempt 1. find-finalizable re-queues this assignment
    // while preservation is incomplete, and stops once the ceiling is hit so a
    // permanently un-preservable repo cannot burn a matrix leg every night.
    finalize_attempts: attempt,
    first_finalized_at: prior?.first_finalized_at || new Date().toISOString(),
    observer_run: cfg.runUrl,
    // When phase 1 fired and what it did, so a report can say which guarantee
    // applied rather than implying one.
    locked_at: lock.lockedAt,
    lock_method: lock.method,
    locked_count: lockedCount,
    error_count: errorCount,
    // Students left alone because a granted extension is still running. They
    // carry `deferred_until` in `results`; find-finalizable.mjs re-queues the
    // assignment once that instant passes.
    deferred_count: deferrals.length,
    max_uncertainty_seconds: maxUncertainty,
    results: lockdownResults,
  };
  await writeFile(join(lockdownDir, "lockdown-record.json"), JSON.stringify(lockdownRecord, null, 2) + "\n");

  // Outputs & summary.
  // A deferral is neither a lock nor an error: the student was granted more
  // time and the system honoured it. Counting it as either would paint the
  // nightly amber for doing the right thing.
  const outcome = errorCount === 0 ? "locked" : lockedCount > 0 ? "partial" : "fail:all-errors";
  await setOutput("locked_count", lockedCount);
  await setOutput("error_count", errorCount);
  await setOutput("deferred_count", deferrals.length);
  await setOutput("lock_method", lock.method);
  await setOutput("uncertainty_seconds", maxUncertainty);
  await setOutput("outcome", outcome);
  await summary(
    `### Lockdown: \`${outcome}\` (stopped by \`${lock.method}\` at ${lock.lockedAt})\n\n` +
    `| student | SHA | uncertainty | status |\n|---|---|---|---|\n` +
    rows.join("\n") + "\n\n" +
    `**${lockedCount}** locked, **${errorCount}** errors` +
    (deferrals.length ? `, **${deferrals.length}** deferred (extension still running)` : "") +
    `. Max uncertainty: **${maxUncertainty}s**.\n`
  );
  log("done", { ok: errorCount === 0, note: `${outcome} (${lockedCount} locked, ${deferrals.length} deferred, ${errorCount} err, ${maxUncertainty}s max uncertainty)` });
  process.exit(outcome.startsWith("fail:") ? 1 : 0);
}

main().catch(async (e) => { await fail("fail:exception", e.message); });
