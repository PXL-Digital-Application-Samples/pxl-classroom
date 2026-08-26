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
import { ensureSubmissionLock, resolveAppId } from "../lib/submission-lock.mjs";

const env = (k, d) => process.env[k] ?? d;
const cfg = {
  token: env("GITHUB_TOKEN"),
  org: env("ORG"),
  assignmentId: env("ASSIGNMENT_ID"),
  dataDir: env("DATA_DIR"),
  // Phase 1 and nothing else - what the deadline sentinel runs at the instant
  // itself. It must NOT write a lockdown record: find-finalizable.mjs treats the
  // record's existence as evidence a finalize happened, and one with no results
  // would strand the assignment unfinalized forever.
  stopOnly: env("STOP_ONLY", "0") === "1",
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

/**
 * When the deadline sentinel already stopped this cohort, and at what instant.
 *
 * The sentinel deliberately writes NO lockdown record - one with empty results
 * would strand the assignment forever - so the nightly that follows has no way
 * to know writes stopped hours ago and stamps `lockdown_at` with its own clock.
 * The record then claims the cohort was frozen at 00:00 for a 20:00 deadline,
 * and `uncertainty_seconds` reports four hours where the sentinel achieved
 * seconds. That number is the evidence a lecturer would cite in a dispute, and
 * it was understating the system against them.
 *
 * The timeline sits beside the record as `sentinel-<key>.json`. Only a sentinel
 * that actually reached its instant counts: `gave-up:runtime` means the nightly
 * really is what stopped the cohort.
 *
 * @returns an ISO instant, or null.
 */
async function readSentinelStop() {
  const dir = join(cfg.dataDir, "lockdowns", cfg.assignmentId);
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }

  let earliest = null;
  for (const name of names) {
    if (!/^sentinel-.*\.json$/.test(name)) continue;
    try {
      const doc = JSON.parse(await readFile(join(dir, name), "utf8"));
      if (doc?.outcome !== "fired" || !doc?.deadline_at) continue;
      const at = new Date(doc.deadline_at);
      if (Number.isNaN(at.getTime())) continue;
      // A cohort can be armed more than once - a deadline moved forward, say.
      // The earliest instant that actually fired is when writes first stopped.
      if (!earliest || at < earliest) earliest = at;
    } catch (e) {
      console.error(`Unreadable sentinel timeline ${name}: ${e.message}`);
    }
  }
  return earliest ? earliest.toISOString() : null;
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
 *
 * A student who already has a frozen snapshot is never deferred, whatever their
 * overrides say. Their submission has been taken; deferring them would rewrite
 * that result row with `snapshot_sha: null` and lose it, which is precisely what
 * freeze-on-retry exists to prevent. An extension granted after lockdown is too
 * late to un-take a submission - RUNBOOK §6.2a says so, and says what to do
 * instead.
 */
function planTargets(assignment, records, overrides, priorByLogin = new Map(), now = new Date()) {
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

    // Any member already holding a frozen snapshot means this repository's
    // submission is on record and must not be rewritten.
    const alreadyRecorded = members.some((m) => priorByLogin.get(m)?.snapshot_sha);

    const effective = effectiveDeadlineFor(assignment, login, { overrides, team: { members } });
    // Gated on `extended`, not on the deadline alone: a lecturer running a
    // lockdown early still locks the cohort, exactly as before. Only a granted,
    // still-running extension defers.
    if (!alreadyRecorded && effective.extended && effective.deadline > now) {
      deferrals.push({ ...target, effective });
    } else {
      targets.push(target);
    }
  }
  return { targets, deferrals };
}

// --- Phase 1: STOP -----------------------------------------------------------
/** Phase 4, and the fallback for a ruleset that could not be applied. */
async function demote(t) {
  let allLocked = true;
  let permAfter = "read";
  for (const m of t.members) {
    const res = await gh("PUT", `/repos/${cfg.org}/${t.repoName}/collaborators/${m}`, { permission: "pull" });
    if (!(res.status === 204 || res.status === 201)) {
      log(`demote ${m}`, { ok: false, note: `HTTP ${res.status}` });
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
  return { locked: allLocked, permissionAfter: permAfter };
}

/**
 * Stop writes to the submission ref for every target. This is the only
 * time-critical phase, and the only one that must happen *at* the deadline.
 *
 * `method` decides how, and it is the only place in the file that knows:
 *
 *   "ruleset"  - flip a repository ruleset to `enforcement: active`. Blocks
 *                push, force-push and deletion of the submission ref and takes
 *                nothing else: the student keeps their Actions, secrets,
 *                environments and runners, which on this course is the subject
 *                matter. Falls back to a demotion per repository when the
 *                ruleset cannot be applied, so a failure degrades to the old
 *                behaviour rather than to no lock at all.
 *   "demotion" - collaborator -> pull, one call per member, verified after.
 *                Takes everything, not just push.
 *   "none"     - nothing is stopped. The recording phases still run, so the
 *                report still reflects reality; it just carries no guarantee.
 *
 * Idempotent in every mode: re-running re-locks anyone who regained access.
 * Returns per-target outcomes plus the instant the phase fired.
 */
async function applySubmissionLock({ targets, method, submissionRef, appId, priorByLogin, sentinelStoppedAt, deadlineFor }) {
  const lockedAt = new Date().toISOString();
  const byRepo = new Map();

  for (const t of targets) {
    // Frozen on retry: lockdown_at is a historical fact about when this student
    // stopped being able to push, not about when this run happened.
    const priorRec = priorByLogin.get(t.login);
    let lockdownAt = priorRec?.snapshot_sha ? (priorRec.lockdown_at ?? lockedAt) : lockedAt;

    // The sentinel already stopped this cohort at the deadline instant, hours
    // before this run. Crediting it is what keeps `uncertainty_seconds` honest.
    //
    // Per target, NOT for the whole cohort: a student whose extension was still
    // running when the sentinel fired was deferred then and is only being
    // stopped now, so the sentinel's instant is not their history. Their own
    // effective deadline is the discriminator - it is later than the instant
    // precisely when they were deferred past it.
    if (!priorRec?.snapshot_sha && sentinelStoppedAt) {
      const own = deadlineFor?.(t);
      const stoppedThen = !own || new Date(own) <= new Date(sentinelStoppedAt);
      if (stoppedThen) lockdownAt = sentinelStoppedAt;
    }

    if (method === "none") {
      byRepo.set(t, { locked: false, permissionAfter: null, lockdownAt: null, method: "none" });
      continue;
    }

    try {
      if (method === "ruleset") {
        const res = await ensureSubmissionLock(gh, {
          org: cfg.org,
          repo: t.repoName,
          submissionRef,
          appId,
          enforcement: "active",
        });
        if (res.ok) {
          log(`stop ${t.displayKey}`, { ok: true, note: `ruleset ${res.action} on ${submissionRef}` });
          byRepo.set(t, { locked: true, permissionAfter: null, lockdownAt, method: "ruleset", rulesetId: res.rulesetId });
          continue;
        }
        // Degrade to the old behaviour rather than to no lock at all.
        log(`stop ${t.displayKey}`, { ok: false, note: `ruleset failed (${res.reason}) - falling back to demotion` });
      }

      const out = await demote(t);
      byRepo.set(t, { ...out, lockdownAt, method: "demotion" });
    } catch (e) {
      log(`stop ${t.displayKey}`, { ok: false, note: e.message });
      byRepo.set(t, { locked: false, permissionAfter: "exception", lockdownAt, method });
    }
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
/**
 * The submission when writes were NOT stopped at the deadline: the last commit
 * whose committer date is at or before it.
 *
 * Confirmed against a live repository (UX_PLAN §10 risk 3): `until` filters on
 * the **committer** date alone. A commit authored before the deadline but
 * committed after it is excluded; one authored after but committed before is
 * returned. That matches `git log --until`.
 *
 * Both dates are client-supplied - the confirmation itself was produced by
 * setting `GIT_COMMITTER_DATE` - so this reconstructs the deadline state
 * honestly in the ordinary case and is **not** tamper-proof in the adversarial
 * one. Only a lock that fired at the deadline is.
 *
 * An empty list is not an error: it means everything on this branch was
 * committed after the deadline, so under `block` there is no submission.
 */
async function submissionAsOf({ repoName, branch, deadline }) {
  const q = `sha=${encodeURIComponent(branch)}&until=${encodeURIComponent(deadline)}&per_page=1`;
  const res = await gh("GET", `/repos/${cfg.org}/${repoName}/commits?${q}`);
  if (!res.ok) return { ok: false, sha: null, reason: `commits?until HTTP ${res.status}` };
  const sha = Array.isArray(res.data) && res.data.length ? res.data[0].sha : null;
  return { ok: true, sha, reason: null };
}

async function recordCohortState({ targets, submissionRef, priorByLogin, prior, deadlineFor }) {
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
      const pushedAt = repoRes.data.pushed_at ?? null;
      let snapshotSha;
      let reconstructed = false;
      let noSubmission = false;

      if (frozen) {
        snapshotSha = priorRec.snapshot_sha;
        log(`record ${t.login}`, {
          ok: true,
          note: `snapshot frozen from attempt #${prior?.finalize_attempts ?? 1} (${snapshotSha.slice(0, 12)})`,
        });
      } else {
        // If the lock fired at the deadline, HEAD *is* the deadline state and
        // nothing further is needed. Without a sentinel it fires at the
        // nightly, hours later, so anything pushed in between is on HEAD and
        // has to be filtered out - but only when a push actually happened
        // after the deadline. `pushed_at` is GitHub's own timestamp and it is
        // already in hand, so the usual case costs no extra call.
        const deadline = deadlineFor?.(t) ?? null;
        const pushedLate = deadline && pushedAt && new Date(pushedAt) > new Date(deadline);

        if (pushedLate) {
          const asOf = await submissionAsOf({ repoName: t.repoName, branch, deadline });
          if (asOf.ok) {
            snapshotSha = asOf.sha;
            reconstructed = true;
            noSubmission = asOf.sha === null;
            log(`record ${t.login}`, {
              ok: true,
              note: asOf.sha
                ? `pushed at ${pushedAt}, after the deadline - submission reconstructed as of ${deadline} (${asOf.sha.slice(0, 12)})`
                : `pushed at ${pushedAt}; nothing on ${branch} was committed before ${deadline} - no submission`,
            });
          } else {
            // Falling back to HEAD here would silently record post-deadline
            // work as the submission. Better to record nothing and say why.
            log(`record ${t.login}`, { ok: false, note: asOf.reason });
            byRepo.set(t, { ok: false, reason: asOf.reason });
            continue;
          }
        } else {
          const commitRes = await gh("GET", `/repos/${cfg.org}/${t.repoName}/commits/${branch}`);
          snapshotSha = commitRes.ok ? commitRes.data.sha : null;
        }
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
        reconstructed,
        noSubmission,
        pushedAt,
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
  const { targets, deferrals } = planTargets(assignment, records, overrides, priorByLogin);
  for (const d of deferrals) {
    log(`lockdown ${d.displayKey}`, {
      ok: true,
      note: `deferred - extension granted to ${d.effective.grantedTo} runs to ${d.effective.deadline.toISOString()}`,
    });
  }

  // --- Phase 1: STOP ---------------------------------------------------------
  //
  // Two independent per-assignment decisions, and neither used to be read at
  // all - lockdown demoted every student on every assignment regardless:
  //
  //   late_policy: "block"     stop writes to the submission ref at the
  //                            deadline. A ruleset does that and leaves the
  //                            student their Actions, secrets and runners.
  //   lock_down_enabled: true  take admin away as well (Phase 4). Independent,
  //                            because "they cannot push any more" and "they
  //                            cannot re-run a workflow any more" are different
  //                            decisions with different costs.
  //
  // `lock_down_enabled` defaults to TRUE for an assignment that does not carry
  // it. That is deliberate: every assignment created before this shipped was
  // demoted at the deadline, and inferring "no lock" from a missing field would
  // silently stop freezing live cohorts.
  const blockLate = assignment.late_policy === "block";
  const demoteToo = assignment.lock_down_enabled ?? true;
  log("policy", { ok: true, note: `late_policy=${assignment.late_policy ?? "report"} lock_down_enabled=${demoteToo}` });

  // A ruleset the App cannot bypass would lock the system out of the repository
  // too, and there is no way back except deleting it - so an unresolvable App id
  // means demotion, not a ruleset.
  let appId = null;
  if (blockLate && targets.length) {
    appId = await resolveAppId(gh, { appId: process.env.PXL_APP_ID });
    if (!appId) log("app-id", { ok: false, note: "could not resolve the App id - the lock falls back to demotion" });
  }

  let lockMethod = "none";
  if (targets.length) {
    if (blockLate) lockMethod = appId ? "ruleset" : "demotion";
    else if (demoteToo) lockMethod = "demotion";
  }

  // Every comparison against "the deadline" is the deadline for THAT student
  // (lib/effective-deadline.mjs). Hoisted above the lock because the lock now
  // needs it too, to tell a student the sentinel stopped from one it deferred.
  const deadlineFor = (t) =>
    effectiveDeadlineFor(assignment, t.login, { overrides, team: { members: t.members } })
      .deadline?.toISOString() ?? null;

  // Null unless a sentinel actually reached this assignment's instant. Read
  // even under STOP_ONLY: a second sentinel armed by an overlapping firing must
  // not restamp the first one's work with its own clock.
  const sentinelStoppedAt = await readSentinelStop();
  if (sentinelStoppedAt) {
    log("sentinel", { ok: true, note: `writes already stopped at ${sentinelStoppedAt} - crediting it` });
  }

  const lock = await applySubmissionLock({
    targets, method: lockMethod, submissionRef, appId, priorByLogin,
    sentinelStoppedAt, deadlineFor,
  });

  // Stop-only: the sentinel's job is the instant, not the bookkeeping. The
  // ordinary finalize follows minutes later and does phases 2-4 unhurried,
  // against repositories that can no longer move - and applySubmissionLock is
  // idempotent, so it will report the lock `unchanged` rather than redo it.
  if (cfg.stopOnly) {
    const stopped = [...lock.byRepo.values()].filter((s) => s.locked).length;
    await setOutput("locked_count", stopped);
    await setOutput("error_count", targets.length - stopped);
    await setOutput("deferred_count", deferrals.length);
    await setOutput("lock_method", lock.method);
    await setOutput("outcome", "stopped");
    await summary(
      `### Deadline stop: \`${lock.method}\` at ${lock.lockedAt}\n\n` +
      `**${stopped}/${targets.length}** repositories stopped` +
      (deferrals.length ? `, **${deferrals.length}** deferred (extension still running)` : "") +
      `. No record written - the finalize run does phases 2-4.\n`
    );
    log("stop-only", { ok: true, note: `${stopped}/${targets.length} stopped; no lockdown record written` });
    process.exit(0);
  }

  // --- Phase 2: RECORD -------------------------------------------------------
  //
  // The deadline to reconstruct against is the student's own, so an extension
  // that has already run out still widens their window to the granted instant
  // rather than the assignment's. `deadlineFor` is defined above Phase 1, which
  // needs the same per-student answer.
  const recorded = await recordCohortState({
    targets, submissionRef, priorByLogin, prior,
    // Only `block` discards late work. Under `report` a late commit is part of
    // the submission and the report flags it - filtering it out here would
    // discard exactly what the policy says to keep.
    deadlineFor: blockLate ? deadlineFor : null,
  });

  // --- Phase 4: DEMOTE -------------------------------------------------------
  // Only when phase 1 did not already do it. Runs after the recording, so the
  // snapshot is taken while the student still has whatever access they had.
  const demoted = new Set();
  if (demoteToo && lock.method === "ruleset") {
    for (const t of targets) {
      const out = await demote(t);
      if (out.locked) demoted.add(t);
      else log(`demote ${t.displayKey}`, { ok: false, note: `permission after=${out.permissionAfter}` });
    }
    log("phase 4 - demote", { ok: true, note: `${demoted.size}/${targets.length} demoted to pull` });
  }

  // --- Assemble the record ---------------------------------------------------
  let lockedCount = 0;
  let errorCount = 0;
  let noSubmissionCount = 0;
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
        // What actually stopped this repository, which is not always what the
        // run set out to do: a ruleset that could not be applied degrades to a
        // demotion for that repository alone.
        lock_method: stop.method,
        // The submission was rebuilt with ?until= rather than read off HEAD,
        // because a push landed after the deadline. Committer-date based, and
        // that date is client-supplied - see submissionAsOf().
        reconstructed: state.reconstructed || undefined,
        // Under `block`, nothing on the branch was committed before the
        // deadline. An outcome, not an error - preserve skips it as such.
        no_submission: state.noSubmission || undefined,
        demoted: demoted.has(t) || undefined,
        permission_after: stop.permissionAfter,
        verified: stop.locked,
        uncertainty_seconds: uncertaintySec,
      });
    }

    const sha12 = (state.snapshotSha || "-").slice(0, 12);
    const how = stop.method === "ruleset" ? "ruleset" : stop.method === "demotion" ? "pull" : "not locked";
    if (state.noSubmission) noSubmissionCount++;
    if (stop.locked || lock.method === "none") {
      if (stop.locked) lockedCount++;
      log(`lockdown ${t.displayKey}`, { ok: true, note: `${state.branch}@${sha12} -> ${how} (${uncertaintySec ?? "?"}s)` });
      rows.push(`| ${t.displayKey} | \`${sha12}\` | ${uncertaintySec ?? "-"}s | ${state.noSubmission ? "no submission" : `[OK] ${how}`} |`);
    } else {
      errorCount++;
      log(`lockdown ${t.displayKey}`, { ok: false, note: `not locked (${stop.method}), permission after=${stop.permissionAfter}` });
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
    late_policy: assignment.late_policy ?? "report",
    locked_count: lockedCount,
    error_count: errorCount,
    // Students whose branch held nothing committed before their deadline. Under
    // `block` that is an outcome, not a failure.
    no_submission_count: noSubmissionCount,
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
  await setOutput("no_submission_count", noSubmissionCount);
  await setOutput("lock_method", lock.method);
  await setOutput("uncertainty_seconds", maxUncertainty);
  await setOutput("outcome", outcome);
  await summary(
    `### Lockdown: \`${outcome}\` (stopped by \`${lock.method}\` at ${lock.lockedAt})\n\n` +
    `| student | SHA | uncertainty | status |\n|---|---|---|---|\n` +
    rows.join("\n") + "\n\n" +
    `**${lockedCount}** locked, **${errorCount}** errors` +
    (deferrals.length ? `, **${deferrals.length}** deferred (extension still running)` : "") +
    (noSubmissionCount ? `, **${noSubmissionCount}** with no submission before the deadline` : "") +
    `. Max uncertainty: **${maxUncertainty}s**.\n`
  );
  log("done", { ok: errorCount === 0, note: `${outcome} (${lockedCount} locked, ${deferrals.length} deferred, ${noSubmissionCount} no-submission, ${errorCount} err, ${maxUncertainty}s max uncertainty)` });
  process.exit(outcome.startsWith("fail:") ? 1 : 0);
}

main().catch(async (e) => { await fail("fail:exception", e.message); });
