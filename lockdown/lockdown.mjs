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

import { appendFile, readFile, readdir, writeFile, mkdir, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { relockedRecordPath } from "../lib/control-layout.mjs";
import { relockHistoryDoc } from "../lib/repo-relock.mjs";
import { loadYaml } from "../lib/yaml.mjs";
import { gh } from "../lib/gh.mjs";
import { effectiveDeadlineFor } from "../lib/effective-deadline.mjs";
import { indexByLogin, normalizeLogin } from "../lib/github-login.mjs";
import { fetchOrgOwners, isKnownOwner } from "../lib/org-owners.mjs";
import { ensureSubmissionLock, ensureOrgSubmissionLock, resolveAppId } from "../lib/submission-lock.mjs";
import { orgStopIds, releaseStop } from "../lib/stop-release.mjs";
import { assignmentDeleted, readAssignmentNow } from "../lib/assignment-now.mjs";
import { contentsText } from "../lib/contents-text.mjs";
import { validateAgainst } from "../lib/validate.mjs";
import { usesOrgScope, lockScopeNote, takesAccessAtDeadline, demotesAfterStop } from "../lib/lock-scope.mjs";
import { sentinelMayHaveStopped, sentinelStopFor, sentinelStoppedAt } from "../lib/sentinel-window.mjs";
import { readSentinelTimelines as readSentinelTimelinesIn } from "../lib/sentinel-timelines.mjs";
import { preservesSnapshot } from "../lib/preservation-status.mjs";
import { lockHeld, lockedSinceReopen, reopenEndsAt } from "../lib/lock-rows.mjs";
import { applyStudentPermission, studentPresence } from "../lib/permission-change.mjs";
import { accountNow } from "../lib/login-rename.mjs";
import { starterFor } from "../lib/starter-commit.mjs";
import { headIsProvided } from "../lib/untouched-repo.mjs";
import { APP_SLUG, CONTROL_REPO } from "../lib/deployment.mjs";

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
// ASKED OF GITHUB WHEN IT PLANS, as the reopen records are (review 2026-10-16,
// R7-1): the checkout is minutes old by the time this acts, and a deadline the
// lecturer moved later in between was locked against - the whole cohort shut
// out under a deadline that was no longer in force. Only a read that fails
// falls back to the checkout.
async function readAssignment() {
  const fresh = await readAssignmentRemote();
  if (fresh) return fresh;
  return readAssignmentCheckout();
}

/**
 * The assignment as the control repository holds it now, or null when unread -
 * or DELETED when GitHub's listing no longer names it (R7-17): deleted while
 * this ran, which locked its students under an assignment nobody had any more
 * and made again the organization ruleset its delete removed.
 */
const DELETED = Symbol("deleted");
async function readAssignmentRemote() {
  const ask = { request: gh, org: cfg.org, controlRepo: CONTROL_REPO, assignmentId: cfg.assignmentId };
  const now = await readAssignmentNow(ask);
  if (now.status === "read") return now.assignment;
  if (now.status === "absent" && (await assignmentDeleted(ask))) return DELETED;
  return null;
}

async function readAssignmentCheckout() {
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

// --- Read team manifests -----------------------------------------------------
//
// WHO SHARES THIS REPOSITORY, and the only place that knows.
//
// `planTargets` used to read `rec.members` off the repository record, and NO
// WRITER HAS EVER SET IT: scripts/write-repository-record.mjs writes one file
// per LOGIN (`repositories/<id>/<login>.json`) carrying `team_slug` and no
// membership. So `members` always collapsed to `[login]`, the team's most
// generous extension never propagated, and RUNBOOK.md 3.2's promise - "an
// extension granted to one member applies to the whole team, because they share
// one repository" - was false. Under `lock_method: ruleset` that is not merely
// cosmetic: the ruleset is repo-scoped, so the team-mate WITHOUT an extension
// locked the repository the extended student was still working in.
//
// The manifests are the authority rather than a copy on the record, because
// membership changes after provisioning (a student switches team) and a
// snapshot taken at provisioning time would be stale for everyone who accepted
// before the last member joined.
//
// @returns {Map<string, string[]>} team slug (lowercased) -> members
async function readTeams() {
  const dir = join(cfg.dataDir, "teams", cfg.assignmentId);
  let files;
  try { files = await readdir(dir); } catch { return new Map(); }
  const bySlug = new Map();
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const team = JSON.parse(await readFile(join(dir, f), "utf8"));
      const slug = normalizeLogin(team?.team_slug);
      if (!slug) continue;
      bySlug.set(slug, (team.members || []).filter((m) => typeof m === "string" && m));
    } catch (e) {
      // An unreadable manifest means this repository's team is unknown, so an
      // extension granted to a team-mate cannot be seen. Said out loud rather
      // than swallowed: it is the difference between honouring a lecturer's
      // decision and locking a student out of time they were granted.
      log(`team ${f}`, { ok: false, note: e.message });
    }
  }
  return bySlug;
}

// --- Read lecturer overrides -------------------------------------------------
//
// A granted extension is the only thing that can move a student's deadline, and
// until this was added lockdown never looked: an extended student was demoted to
// `pull` at the assignment's own deadline while report.mjs told the lecturer
// their extension was running. See lib/effective-deadline.mjs.
//
// Asked of GitHub first (review 2026-10-16, R7-2): an extension granted while
// the finalize ran - the sentinel's stop dispatches it minutes after the
// deadline, exactly when a forgotten extra-time student is remembered - was not
// in the checkout. Overrides are only ever appended to, so where GitHub's
// listing cannot be read or says none, the checkout's are no less true.
async function readOverrides() {
  const fresh = await readOverridesRemote();
  if (fresh && fresh.length) return fresh;
  return readOverridesCheckout();
}

/** The override documents as the control repository holds them now, or null when unread. */
async function readOverridesRemote() {
  const at = `/repos/${cfg.org}/${CONTROL_REPO}/contents/overrides/${cfg.assignmentId}`;
  const listing = await gh("GET", at).catch(() => null);
  if (!listing?.ok || !Array.isArray(listing.data)) return null;
  const docs = [];
  for (const f of listing.data) {
    if (!String(f?.name ?? "").endsWith(".json")) continue;
    const file = await gh("GET", `${at}/${encodeURIComponent(f.name)}`).catch(() => null);
    try {
      if (!file?.ok) throw new Error(`HTTP ${file?.status ?? "no answer"}`);
      docs.push(JSON.parse(contentsText(file.data?.content ?? "")));
    } catch (e) {
      // This student's copy in the checkout, rather than none: an unread file
      // must not lock them out of time they were granted.
      try {
        docs.push(JSON.parse(await readFile(join(cfg.dataDir, "overrides", cfg.assignmentId, f.name), "utf8")));
        log(`override ${f.name}`, { ok: false, note: `${e.message} from GitHub - the checkout's copy is used` });
      } catch {
        log(`override ${f.name}`, { ok: false, note: e.message });
      }
    }
  }
  return docs;
}

async function readOverridesCheckout() {
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

// --- Repositories a lecturer deliberately reopened ----------------------------
//
// A finalize run is not once. `find-finalizable.mjs` re-queues an assignment
// while preservation is incomplete, and again when a DEFERRED EXTENSION EXPIRES
// - and `planTargets` builds its list from every record, so a second pass
// re-locks the whole cohort. Without this, reopening one student's repository
// (RUNBOOK §6.15) was undone by granting some OTHER student an extension: the
// nightly locked it again, said nothing, and left `unlocked/<login>.json`
// describing something that was no longer true. The two controls sit two
// sections apart in the same dialog.
//
// A reopen is a deliberate, reasoned, recorded act by a lecturer. It outranks a
// re-run of a deadline that has already passed, so the repository is skipped and
// counted rather than quietly re-frozen. Re-locking is possible - it is one
// flip - but it has to be asked for, not arrive as a side effect of somebody
// else's extension.
//
// An unreadable file here is treated as a reopen. That is the safe direction:
// failing to skip re-locks a student a lecturer deliberately let back in.
//
// ASKED OF GITHUB, NOT OF THE CHECKOUT (review 2026-10-15, R6-3). The checkout
// is taken before the cohort's collect, minutes earlier, so a Reopen clicked in
// between was re-locked and a Lock again clicked in between was undone - one
// order left a student able to push with no record, no Reopen and no Lock
// again to stop it. The control repository is read again here, at the moment
// lockdown plans; only a read that fails falls back to the checkout.
async function readReopened() {
  const fresh = await readReopenedRemote();
  if (fresh) return fresh;
  log("reopened", { ok: false, note: "could not read the reopen records from GitHub - using the checkout's" });
  return readReopenedCheckout();
}

/** The reopen records as the control repository holds them now, or null when unread. */
async function readReopenedRemote() {
  const at = `/repos/${cfg.org}/${CONTROL_REPO}/contents/lockdowns/${cfg.assignmentId}/unlocked`;
  const listing = await gh("GET", at).catch(() => null);
  if (listing?.status === 404) return new Map();
  if (!listing?.ok || !Array.isArray(listing.data)) return null;
  const byLogin = new Map();
  for (const f of listing.data) {
    if (!String(f?.name ?? "").endsWith(".json")) continue;
    const login = normalizeLogin(f.name.slice(0, -".json".length));
    if (!login) continue;
    const file = await gh("GET", `${at}/${encodeURIComponent(f.name)}`).catch(() => null);
    try {
      if (!file?.ok) throw new Error(`HTTP ${file?.status ?? "no answer"}`);
      byLogin.set(login, JSON.parse(contentsText(file.data?.content ?? "")));
    } catch (e) {
      log(`reopened ${f.name}`, { ok: false, note: `${e.message} - treating as reopened anyway` });
      byLogin.set(login, { reason: null });
    }
  }
  return byLogin;
}

async function readReopenedCheckout() {
  const dir = join(cfg.dataDir, "lockdowns", cfg.assignmentId, "unlocked");
  let files;
  try { files = await readdir(dir); } catch { return new Map(); }
  const byLogin = new Map();
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const login = normalizeLogin(f.slice(0, -".json".length));
    if (!login) continue;
    try {
      byLogin.set(login, JSON.parse(await readFile(join(dir, f), "utf8")));
    } catch (e) {
      log(`reopened ${f}`, { ok: false, note: `${e.message} - treating as reopened anyway` });
      byLogin.set(login, { reason: null });
    }
  }
  return byLogin;
}

/**
 * END A REOPEN THE LOCK HAS TAKEN BACK (review 2026-10-16, R7-29), the way Lock
 * again ends one: every member's `unlocked/<login>.json` removed from the
 * checkout - the finalize commit carries the removal - and kept under
 * `relocked/<login>/<when>.json` with `relocked_by`, the one statement that the
 * student could push from the reopen to here. Left in place, every reader of
 * that file took the re-locked repository to be open: a permission change
 * undid the lock, a Retry or a Teams-tab move granted admin, and the dialog
 * offered Lock again over a locked repository. Also for a repository that is
 * gone, which nothing will lock again. An unreadable record is kept, and said.
 */
/** Who `relocked_by` names when the lock, not a lecturer, ended the reopen. */
const RELOCKED_BY_LOCKDOWN = "pxl-classroom[bot]";

async function endReopens(t, at) {
  const dir = join(cfg.dataDir, "lockdowns", cfg.assignmentId, "unlocked");
  let files;
  try { files = await readdir(dir); } catch { return; }
  const members = new Set((t.teamMembers?.length ? t.teamMembers : [t.login]).map(normalizeLogin).filter(Boolean));
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const login = f.slice(0, -".json".length);
    if (!members.has(normalizeLogin(login))) continue;
    let doc;
    try {
      doc = JSON.parse(await readFile(join(dir, f), "utf8"));
    } catch (e) {
      log(`reopen ${login}`, { ok: false, note: `${e.message} - the reopen record is kept; Lock again on their row ends it` });
      continue;
    }
    const kept = join(cfg.dataDir, relockedRecordPath(cfg.assignmentId, login, at));
    await mkdir(dirname(kept), { recursive: true });
    await writeFile(kept, JSON.stringify(relockHistoryDoc(doc, { by: RELOCKED_BY_LOCKDOWN, at }), null, 2) + "\n");
    await rm(join(dir, f), { force: true });
    log(`reopen ${login}`, { ok: true, note: `ended - locked again at ${at}, the deadline the reopen ran to` });
  }
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
/** Whether this student's snapshot - THIS one (R7-3) - is archived and verified, by the record in the checkout. */
function preservedOnRecord(login, snapshotSha) {
  if (!login) return false;
  try {
    return preservesSnapshot(JSON.parse(readFileSync(join(cfg.dataDir, "observations", cfg.assignmentId, login, "preservation.json"), "utf8")), snapshotSha);
  } catch {
    return false;
  }
}

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
 * PER STUDENT, FROM THEIR OWN DEADLINE (review 2026-10-16, R7-8): the stop
 * that held them is the earliest at or after the deadline in force for them
 * (`sentinelStopFor`). One at an earlier instant was for a deadline since moved
 * later, or one their extension ran past, and was let go. CONFIRMED stops
 * only: crediting the instant for a stop that failed understated how long
 * writes stayed open.
 *
 * @returns {Promise<(deadlineIso: string|null) => {at: string, sampled: Set<string>}|null>}
 */
async function readSentinelStops() {
  const timelines = await readSentinelTimelines();
  return (deadlineIso) => sentinelStopFor(timelines, deadlineIso, { confirmedOnly: true });
}

/** The earliest confirmed stop of the cohort, for the run log alone. */
async function readSentinelStop() {
  return sentinelStoppedAt(await readSentinelTimelines(), { confirmedOnly: true });
}

/**
 * Whether a sentinel fired on this assignment at all - a stop that failed
 * included, since it may have stopped some repositories before it did: then a
 * stop may hold a deferred student.
 */
async function sentinelEverStopped() {
  return sentinelMayHaveStopped(await readSentinelTimelines());
}

// Which timelines count, and the earliest - a cohort can be armed more than
// once, and the earliest instant that actually fired is when writes first
// stopped - is lib/sentinel-window.mjs `sentinelStoppedAt`, the judge the
// Admin Panel's permission plan asks too.
async function readSentinelTimelines() {
  return readSentinelTimelinesIn(join(cfg.dataDir, "lockdowns", cfg.assignmentId), {
    onUnreadable: (name, e) => console.error(`Unreadable sentinel timeline ${name}: ${e.message}`),
  });
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
 * late to un-take a submission - RUNBOOK.md §3.3 says so, and says what to do
 * instead.
 *
 * `members` and `teamMembers` are DIFFERENT SETS and must stay so:
 *
 *   members     - the logins THIS record covers. One per repository record, so
 *                 a five-person team is five targets and each demotes one
 *                 person. Folding the whole team in here would demote every
 *                 member once per member: 25 calls where 5 will do, against an
 *                 ~80/min secondary limit, at the deadline.
 *   teamMembers - everyone sharing the repository, from the manifests. Only the
 *                 deadline is computed over this, because a repository is one
 *                 object and the most generous extension on it governs.
 */
function planTargets(assignment, records, overrides, priorByLogin = new Map(), now = new Date(), teamsBySlug = new Map(), reopened = new Map()) {
  const targets = [];
  const deferrals = [];
  const reopenedTargets = [];

  for (const rec of records) {
    const login = rec.github_login;
    const members = Array.isArray(rec.members) && rec.members.length ? rec.members : (login ? [login] : []);
    const teamMembers = [
      ...new Set([...members, ...(teamsBySlug.get(normalizeLogin(rec.team_slug)) || [])]),
    ];
    const target = {
      rec,
      login,
      members,
      teamMembers,
      // What the repository was given, read across every record naming it
      // (lib/starter-commit.mjs): the snapshot that is still it is no hand-in.
      starterSha: starterFor(rec, records).sha,
      repoName: rec.repo_name?.split("/")?.[1] ?? rec.repo_name,
      displayKey: rec.team_slug ? `${rec.team_slug} (${members.join(",")})` : login,
    };

    // Any member already holding a frozen snapshot means this repository's
    // submission is on record and must not be rewritten.
    // ...taken in any form (`lockTaken`, R7-24): a snapshot alone left a
    // student locked with nothing handed in deferrable, so a later stop
    // released them while the record still said locked.
    const priors = teamMembers.map((m) => priorByLogin.get(normalizeLogin(m))).filter(Boolean);
    // ...or held by a lecturer's Lock again with no snapshot yet (`lockHeld`,
    // R7-30): deferred, the next pass took them out of the stop just put back.
    const alreadyRecorded = priors.some(lockHeld);

    const effective = effectiveDeadlineFor(assignment, login, { overrides, team: { members: teamMembers } });

    // A repository a lecturer deliberately reopened is not re-locked by a
    // later pass. Matched over teamMembers, not the record's login: a group
    // repository is ONE object with one lock on it, so reopening it for any
    // member reopened it for the team, and re-locking it would shut out
    // everybody on the strength of somebody else's expired extension.
    // Asked BEFORE the deferral below, so a reopened student's deferral keeps
    // the reopen it came from (R7-3).
    const reopenedFor = teamMembers.map((m) => normalizeLogin(m)).find((m) => reopened.has(m));
    if (reopenedFor) {
      const record = reopened.get(reopenedFor);
      // A REOPEN WITH TIME ON IT ENDS AT THAT TIME (review 2026-10-16, R7-3).
      // Reopened after the deadline was moved later, or with an extension
      // granted, the student was given until a deadline that is AFTER the
      // reopen - and was then open for good, never locked, archived or graded
      // on what they did with it. Until that deadline they are deferred like
      // anyone with time left (the queue comes back at `deferred_until`); once
      // it has passed they are locked again with a fresh snapshot, unless a
      // lock made after the reopen already holds them. A reopen with no such
      // time - made after the deadline in force - stays open, as it always has:
      // Lock again is the way back.
      const ends = reopenEndsAt(record, effective.deadline);
      if (ends) {
        // LOCKED AGAIN SINCE THE REOPEN, asked first (R7-24): from then on it
        // is a lock like any other - frozen, and more time granted after it
        // does not release it, as for anyone else locked.
        if (priors.some((p) => lockedSinceReopen(p, record))) {
          targets.push(target);
          continue;
        }
        const reopen = { reopenedFor, record };
        if (ends > now) {
          deferrals.push({ ...target, effective, reopen });
          continue;
        }
        targets.push({ ...target, relock: { ...reopen, until: ends.toISOString() } });
        continue;
      }
      reopenedTargets.push({ ...target, reopenedFor, record });
      continue;
    }

    // ANY DEADLINE STILL AHEAD DEFERS (review 2026-10-16, R7-1): a granted
    // extension, and the assignment's own deadline moved later after the stop.
    // Gated on `extended` alone, a deadline moved out while the finalize ran
    // locked the whole cohort under a deadline no longer in force. Nothing runs
    // this before a deadline on purpose: the sentinel fires at the instant, the
    // finalize and "Lock everyone out now" after it.
    if (!alreadyRecorded && effective.deadline > now) {
      deferrals.push({ ...target, effective });
      continue;
    }

    targets.push(target);
  }
  return { targets, deferrals, reopenedTargets };
}

/**
 * LET GO OF A STOP THE DEADLINE IN FORCE NO LONGER WANTS (review 2026-10-16,
 * R7-1 and R7-2). The sentinel stops the whole cohort at the instant and the
 * finalize follows minutes later; an extension granted in between, or the
 * deadline moved later, defers those students here - but the stop on them
 * stayed: the organization ruleset only ever gains ids (`keepCurrent`), so the
 * student's page counted down to a deadline while every push was refused, and
 * with no lock on their row Reopen refused too.
 *
 * A deferred target has no lock on record (planTargets: `lockHeld`), so
 * whatever holds it now is a stop for an instant that is no longer theirs: its
 * id comes out of the organization ruleset, a repository ruleset of this
 * system is switched off, and a member left at read while the assignment gives
 * more gets that back - never re-invited, `onlyIfPresent`. Each one is what
 * Reopen's own inverse does, and each is idempotent. At their deadline the
 * queue comes back for them (`deferred_until`) and locks them.
 *
 * NOT A REOPEN'S DEFERRAL (R7-30): Reopen already let go of that student, so
 * whatever holds them now is a Lock again a lecturer clicked since - released
 * here, it was undone by the same pass.
 *
 * Returns what could not be let go: a student left stopped through the time
 * they were given is an error of the run, never a line in its log (R7-32).
 *
 * @returns {Promise<string[]>}
 */
async function releaseDeferredStops(deferrals, assignment, { probeRepos = false } = {}) {
  // ...unless this run locked them itself, then asked again (R7-31).
  const toRelease = deferrals.filter((d) => !d.reopen || d.lockedThisRun);
  // Nothing can hold them unless a sentinel stopped this assignment or this
  // run locked them: a pass never locks a deferred student, nor a reopened one.
  if (!toRelease.length || !(probeRepos || toRelease.some((d) => d.lockedThisRun))) return [];
  const failed = [];
  const request = (method, path, body) => gh(method, path, body);
  const stop = await orgStopIds(request, { org: cfg.org, assignmentId: cfg.assignmentId });
  if (!stop.ok) {
    log("release", { ok: false, note: `the organization's stop could not be read (${stop.reason}) - deferred students may still be in it` });
    failed.push(`the organization's stop could not be read (${stop.reason})`);
  }
  // One repository once, however many of its members' records deferred it.
  const seen = new Set();
  for (const d of toRelease) {
    const key = String(d.repoName ?? "").toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    // A repository ruleset or a demotion on a deferred student is a sentinel's
    // stop, or this run's own when it asked again before writing (R7-31):
    // without either, nothing is asked of their repository.
    const steps = await releaseStop(request, {
      org: cfg.org, assignmentId: cfg.assignmentId, repo: d.repoName, repositoryId: d.rec?.repo_id,
      members: d.teamMembers.length ? d.teamMembers : d.members, permission: assignment.student_permission || "admin",
      orgIds: stop.ids, probeRepo: probeRepos || Boolean(d.lockedThisRun),
    });
    for (const s of steps) {
      log(`release ${d.displayKey}`, { ok: s.ok, note: `${s.note} - their deadline ${d.effective.deadline.toISOString()} is still ahead` });
      if (!s.ok) failed.push(`${d.displayKey}: ${s.note}`);
    }
  }
  return failed;
}

// --- Phase 1: STOP -----------------------------------------------------------
/** Phase 4, and the fallback for a ruleset that could not be applied. */
/**
 * Whether GitHub says this repository no longer exists, asked after a lock on
 * it failed. A 404 is that only where the App sees every repository of the
 * organization: under "Only select repositories" one outside the selection
 * answers 404 as well, and calling it gone would excuse it from the deadline
 * in silence, so there it stays a missed stop (review 2026-10-14, P2-26). By
 * id, which a rename keeps.
 */
let installationSeesAll = null;
async function confirmedGone(t) {
  const id = t.rec?.repo_id;
  const res = await gh("GET", id ? `/repositories/${id}` : `/repos/${cfg.org}/${t.repoName}`);
  if (res.status !== 404) return false;
  if (installationSeesAll === null) {
    const inst = await gh("GET", "/installation/repositories?per_page=1");
    installationSeesAll = inst.ok && inst.data?.repository_selection === "all";
  }
  return installationSeesAll;
}

/**
 * Who a stored member is now, from their acceptance record's id.
 * `known` is false only where there was an id to ask about and GitHub did not
 * answer: then a name nobody holds may still be a student with push access.
 * A deleted account, or a name with no record behind it (a typo in a seeded team),
 * has nothing to take away.
 */
async function accountLoginNow(stored) {
  let id = null;
  try {
    id = JSON.parse(await readFile(join(cfg.dataDir, "acceptances", cfg.assignmentId, `${stored}.json`), "utf8"))?.github_id;
  } catch {
    return { login: stored, known: true };
  }
  const now = await accountNow((method, path) => gh(method, path), id);
  if (now.login && now.login !== stored) log(`demote ${stored}`, { ok: true, note: `this account is @${now.login} now` });
  return { login: now.login ?? stored, known: now.login !== null || now.deleted };
}

async function demote(t) {
  let allLocked = true;
  // "read" is the value that MEANS LOCKED, so it cannot be the starting
  // assumption. The PUT-failure branch below `continue`s without verifying
  // anything, and leaving `permAfter` at "read" wrote `permission_after: "read"`
  // into the record beside `verified: false` - a row asserting the student was
  // demoted, from a call that failed. Unreadable is not evidence: it stays null
  // until a verification actually answers.
  let permAfter = null;
  for (const stored of t.members) {
    // THE ACCOUNT, NOT THE NAME ON THE RECORD. A student who renamed since the
    // nightly last followed it still has their access, and GitHub answers the old
    // login with 404 (lib/login-rename.mjs). Asked at the moment it acts; the
    // record keeps the login it has, which the next nightly moves.
    const account = await accountLoginNow(stored);
    const m = account.login;
    // Through the one writer that knows a PENDING INVITATION is not changed by
    // granting again (lib/permission-change.mjs, measured): a 201 answers with
    // the SAME invitation at the OLD permission, and reading that as success
    // left a student who had not accepted yet free to accept after the
    // deadline and push (third review, 2026-09-26). The invitation itself is
    // lowered to read, and the answer checked.
    // ONLY WHO STILL HAS ACCESS (review 2026-10-14, LD8). A PUT on somebody
    // who is neither a collaborator nor invited SENDS an invitation - an
    // email, and read access a lecturer took away, or that a team switch
    // removed, handed back. Somebody with no access is as stopped as it gets.
    // Only a definite "gone" skips: an unreadable answer demotes as before,
    // because at the deadline the lock outranks a stray invitation.
    const presence = await studentPresence((method, path, body) => gh(method, path, body), { repo: `${cfg.org}/${t.repoName}`, login: m });
    if (presence === "gone" || (presence === "no-account" && account.known)) {
      log(`demote ${m}`, { ok: true, note: "no longer has access - nothing to take away, not re-invited" });
      permAfter = permAfter ?? "none";
      continue;
    }
    const res = await applyStudentPermission((method, path, body) => gh(method, path, body), { repo: `${cfg.org}/${t.repoName}`, login: m, permission: "pull" });
    if (!res.ok) {
      log(`demote ${m}`, { ok: false, note: res.status ? `HTTP ${res.status}` : res.message });
      allLocked = false;
      permAfter = `error-${res.status || "invitation"}`;
      continue;
    }
    if (res.via === "invitation") {
      // Not a collaborator yet, so the permission read below says `none`. The
      // invitation now grants read, and accepting it gives exactly that.
      permAfter = "read";
      continue;
    }
    const verify = await gh("GET", `/repos/${cfg.org}/${t.repoName}/collaborators/${m}/permission`);
    const userPerm = verify.ok ? verify.data.permission : `error-${verify.status}`;
    // Recorded whatever it says: "read" here is a verified fact, not a default.
    permAfter = userPerm;
    if (userPerm !== "read") allLocked = false;
  }
  return { locked: allLocked, permissionAfter: permAfter };
}

/** "1 by org-ruleset, 1 gone, 1 NOT locked": what phase 1 did, per repository. */
function stopTally(byRepo) {
  const counts = new Map();
  for (const s of byRepo.values()) {
    const key = s.gone ? "gone" : s.locked ? `by ${s.method}` : s.method === "none" ? "not locked (nothing stops it)" : "NOT locked";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].map(([k, n]) => `${n} ${k}`).join(", ") || "no repositories";
}

/**
 * Stop writes to the submission ref for every target. This is the only
 * time-critical phase, and the only one that must happen *at* the deadline.
 *
 * `method` decides how, and it is the only place in the file that knows:
 *
 *   "org-ruleset" - one organization ruleset over the cohort's repository ids,
 *                degrading per repository to "ruleset" below.
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
async function applySubmissionLock({ targets, method, submissionRef, appId, priorByLogin, stopFor, deadlineFor }) {
  const lockedAt = new Date().toISOString();
  const byRepo = new Map();
  let orgRulesetId = null;

  // ONE CALL FOR THE WHOLE COHORT, tried first and degrading rather than
  // failing. The id list is the targets' own repository ids - derived from the
  // same plan that decided who is locked, so a deferred student and a
  // reopened repository are absent by construction rather than by a loop
  // remembering to skip them.
  //
  // A target with no `repo_id` is NOT silently omitted: an id missing from the
  // list is a student nothing locks and nothing reports, which is the failure
  // this whole file exists to prevent. Those fall through to the per-repository
  // path below and are recorded as `ruleset`, which `lock_method` per row
  // already supports.
  const orgTargets = method === "org-ruleset" ? targets.filter((t) => Number.isInteger(t.rec?.repo_id)) : [];
  const orgCovered = new Set();
  const orgGone = new Set();
  if (method === "org-ruleset") {
    const missingId = targets.filter((t) => !Number.isInteger(t.rec?.repo_id));
    if (missingId.length) {
      log("org-lock", { ok: false, note:
        `${missingId.length} record(s) carry no repo_id and fall back to a repository ruleset: ` +
        missingId.map((t) => t.displayKey).join(", ") });
    }
    if (orgTargets.length) {
      const res = await ensureOrgSubmissionLock(gh, {
        org: cfg.org,
        assignmentId: cfg.assignmentId,
        submissionRef,
        appId,
        repositoryIds: orgTargets.map((t) => t.rec.repo_id),
        enforcement: "active",
        // Never take out what the ruleset locks: a Lock again clicked while
        // this run planned is in it and not in the plan (R6-3).
        keepCurrent: true,
      });
      if (res.ok) {
        orgRulesetId = res.rulesetId;
        // `dropped` is a repository GitHub says no longer exists. There is
        // nothing to lock for that student, but somebody has to be told - a
        // silently unlocked row is indistinguishable from a locked one.
        const dropped = new Set(res.dropped ?? []);
        for (const t of orgTargets) {
          if (dropped.has(t.rec.repo_id)) continue;
          orgCovered.add(t);
        }
        log("org-lock", { ok: true, note:
          `${res.action} ruleset ${res.rulesetId} over ${orgCovered.size} repositor${orgCovered.size === 1 ? "y" : "ies"}` +
          (dropped.size ? ` (${dropped.size} no longer exist)` : "") });
        // Gone only as the other paths call it (`confirmedGone`, P2-26): under
        // "Only select repositories" a repository the App was not given is a
        // 404 too, and calling it gone excused it from the deadline. One that
        // is not confirmed takes the per-repository path below, which says it
        // was not stopped (TV-7, 2026-10-15).
        for (const t of orgTargets) {
          if (!dropped.has(t.rec.repo_id) || !(await confirmedGone(t))) continue;
          orgGone.add(t);
          log(`org-lock ${t.displayKey}`, { ok: false, note: "repository no longer exists - nothing to lock" });
        }
      } else {
        // Degrade to the repository-scoped path rather than to no lock at all,
        // exactly as a failed repository ruleset degrades to a demotion. What
        // GitHub said no longer exists stays gone on that path too, confirmed
        // the same way.
        for (const t of orgTargets) if ((res.dropped ?? []).includes(t.rec.repo_id) && (await confirmedGone(t))) orgGone.add(t);
        log("org-lock", { ok: false, note: `${res.reason} - falling back to repository rulesets` });
        // Named here as on the success path: a gone repository takes no step
        // below, so this is the only line that says what became of it.
        for (const t of orgGone) {
          log(`org-lock ${t.displayKey}`, { ok: false, note: "repository no longer exists - nothing to lock" });
        }
      }
    }
  }

  for (const t of targets) {
    // Frozen on retry: lockdown_at is a historical fact about when this student
    // stopped being able to push, not about when this run happened.
    const priorRec = priorByLogin.get(normalizeLogin(t.login));
    // A row whose snapshot could not be read was LOCKED all the same, at its
    // own time (review 2026-10-14, P2-31): the pass that reads it again kept
    // its own clock, which overstated how long the student could push.
    // ...and so was one a pass found had nothing handed in (TL-4), and one a
    // lecturer locked again (`lockHeld`, R7-30): at the Lock again.
    let lockdownAt = lockHeld(priorRec) ? (priorRec.lockdown_at ?? lockedAt) : lockedAt;

    // The sentinel already stopped this cohort at the deadline instant, hours
    // before this run. Crediting it is what keeps `uncertainty_seconds` honest.
    //
    // Per target, NOT for the whole cohort: a student whose extension was still
    // running when the sentinel fired was deferred then and is only being
    // stopped now, so the sentinel's instant is not their history. Their own
    // effective deadline picks the stop that held them (`stopFor`, R7-8): the
    // earliest at or after it, so a second sentinel at their extended
    // deadline, or at a deadline moved later, is credited too.
    // A row an earlier pass or a lecturer locked keeps its own lock time
    // (R7-22): a later stop must never move it.
    const heldBy = !lockHeld(priorRec) ? stopFor?.(deadlineFor?.(t) ?? null) : null;
    if (heldBy) lockdownAt = heldBy.at;

    if (method === "none") {
      byRepo.set(t, { locked: false, permissionAfter: null, lockdownAt: null, method: "none" });
      continue;
    }

    // GONE: GitHub said, creating the organization ruleset, that this
    // repository no longer exists. Nothing to lock, and not a lock that failed:
    // retried as a repository ruleset and a demotion it answered 404 twice, and
    // the stop-only run counted it as missed, which marked the sentinel's stop
    // FAILED for every assignment at that instant (review 2026-10-14, LD5).
    if (orgGone.has(t)) {
      byRepo.set(t, { locked: false, gone: true, permissionAfter: null, lockdownAt: null, method: "none" });
      continue;
    }

    // Already stopped by the one organization-scoped call. Nothing further to
    // do for this repository, and the row records WHICH lock holds it so
    // lib/repo-unlock.mjs applies the matching inverse - removing one id from
    // the organization ruleset, not flipping a repository one that is not
    // there.
    if (orgCovered.has(t)) {
      log(`stop ${t.displayKey}`, { ok: true, note: `organization ruleset ${orgRulesetId}` });
      byRepo.set(t, { locked: true, permissionAfter: null, lockdownAt, method: "org-ruleset", rulesetId: orgRulesetId });
      continue;
    }

    // GONE on the other paths too (review 2026-10-14, P2-26): only the
    // organization ruleset's own answer marked a deleted repository, so on the
    // repository-ruleset and demotion paths it failed both, counted as missed,
    // and failed the sentinel's stop for every assignment at that instant.
    // Asked only once the lock has failed, so a healthy cohort costs nothing.
    const goneRow = { locked: false, gone: true, permissionAfter: null, lockdownAt: null, method: "none" };
    try {
      if (method === "ruleset" || method === "org-ruleset") {
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
      if (!out.locked && (await confirmedGone(t))) {
        log(`stop ${t.displayKey}`, { ok: true, note: "the repository no longer exists - nothing to lock" });
        byRepo.set(t, goneRow);
        continue;
      }
      byRepo.set(t, { ...out, lockdownAt, method: "demotion" });
    } catch (e) {
      if (await confirmedGone(t).catch(() => false)) {
        log(`stop ${t.displayKey}`, { ok: true, note: "the repository no longer exists - nothing to lock" });
        byRepo.set(t, goneRow);
        continue;
      }
      log(`stop ${t.displayKey}`, { ok: false, note: e.message });
      byRepo.set(t, { locked: false, permissionAfter: "exception", lockdownAt, method });
    }
  }

  // What HAPPENED, by the lock that holds each repository: the planned method
  // over every target read as success after the organization ruleset had
  // failed and fallen back (review 2026-10-14, TL-2).
  log("phase 1 - stop", {
    ok: ![...byRepo.values()].some((s) => !s.locked && !s.gone && s.method !== "none"),
    note: `${method} planned at ${lockedAt}: ${stopTally(byRepo)}`,
  });
  return { method, lockedAt, byRepo, orgRulesetId };
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
 * Confirmed against a live repository (ARCHITECTURE §11.2.2): `until` filters on
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
/**
 * Is this commit still only what the repository was given (lib/untouched-repo.mjs
 * `headIsProvided`)? The recorded start, GitHub's generated commit, or either
 * with only PXL Classroom's own commits on top - the grading workflow
 * provisioning added before starts were recorded made an untouched repository
 * two commits, which was archived as the student's work (R6-9). A read that
 * failed on the way is not "at the start": the commit is archived as before.
 */
async function providedOnly(t, row) {
  const verdict = await headIsProvided((p) => gh("GET", p), `${cfg.org}/${t.repoName}`, row, {
    starterSha: t.starterSha ?? null,
    appLogin: `${APP_SLUG}[bot]`,
  }).catch(() => null);
  return verdict === true;
}

async function submissionAsOf({ repoName, branch, deadline }) {
  const q = `sha=${encodeURIComponent(branch)}&until=${encodeURIComponent(deadline)}&per_page=1`;
  const res = await gh("GET", `/repos/${cfg.org}/${repoName}/commits?${q}`);
  if (!res.ok) return { ok: false, sha: null, row: null, reason: `commits?until HTTP ${res.status}` };
  const row = Array.isArray(res.data) && res.data.length ? res.data[0] : null;
  return { ok: true, sha: row?.sha ?? null, row, reason: null };
}

async function recordCohortState({ targets, submissionRef, priorByLogin, prior, deadlineFor, stopDeadlineFor = null, stopFor = () => null }) {
  const byRepo = new Map();

  // A group assignment has one repository record PER MEMBER, all naming the
  // same repository, so a five-person team fetched the same object five times.
  // Phase 1 already stopped the writes, so re-reading cannot tell us anything
  // new - it only spends calls against an ~80/min secondary limit at the one
  // moment the whole cohort is being processed at once.
  const repoCache = new Map();
  const fetchRepo = async (name) => {
    if (!repoCache.has(name)) repoCache.set(name, await gh("GET", `/repos/${cfg.org}/${name}`));
    return repoCache.get(name);
  };

  for (const t of targets) {
    try {
      const repoRes = await fetchRepo(t.repoName);
      if (!repoRes.ok) {
        log(`record ${t.login}`, { ok: false, note: `repo HTTP ${repoRes.status}` });
        // A 404 is a repository that is gone; anything else is a read that
        // failed this pass and is recorded as such, so the next pass reads it
        // again (review 2026-10-14) rather than the student dropping out.
        byRepo.set(t, { ok: false, gone: repoRes.status === 404, reason: `repo HTTP ${repoRes.status}` });
        continue;
      }
      const branch = submissionRef.startsWith("refs/heads/")
        ? submissionRef.slice("refs/heads/".length)
        : repoRes.data.default_branch;

      // Frozen on retry: never re-snapshot a student who was already locked
      // down, or a late commit would replace their on-time submission.
      const priorRec = priorByLogin.get(normalizeLogin(t.login));
      const frozen = !!priorRec?.snapshot_sha;
      const pushedAt = repoRes.data.pushed_at ?? null;
      // WHETHER THE SENTINEL'S STOP COVERED THIS REPOSITORY AT ALL (review
      // 2026-10-14, P2-27): one a lecturer's Retry provisioned after the stop
      // was locked by nothing until this run, so its HEAD can hold later
      // pushes, and the stop's instant is not when it was locked.
      const createdAt = repoRes.data.created_at ?? null;
      // ...and only one the stop was WATCHING (R6-25): created before it is
      // not covered by it, when its record arrived after. The stop that held
      // THIS student, from their deadline in force (R7-8).
      const deadline = deadlineFor?.(t) ?? null;
      // The stop that held THEM, under every late policy (R7-41): `deadline`
      // is null outside `block` (no late work is cut), and the cohort's
      // earliest stop then disagreed with the one the lock step credited.
      const heldBy = stopFor(stopDeadlineFor?.(t) ?? deadline);
      const existedAtStop = !heldBy || (
        (!createdAt || new Date(createdAt) <= new Date(heldBy.at)) &&
        heldBy.sampled.has(String(t.repoName).toLowerCase())
      );
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
        // THE SENTINEL'S CONFIRMED STOP MADE HEAD THE DEADLINE STATE (review
        // 2026-10-14, LD4). `pushed_at` moves for a push to any branch or tag -
        // a full-history copy's prepared branches stay open - and rebuilding
        // from committer dates then dropped an on-time commit whose clock ran
        // fast, although the lock proves it was pushed in time. The same
        // per-student test that credits the stop (applySubmissionLock).
        // ...and only for a repository that EXISTED at the stop (P2-27, above).
        // A stop AT their own deadline (R7-22). `stopFor` finds the earliest at
        // or after it, and an extension's sentinel is a later stop on the
        // cohort: a student whose own stop failed or never ran was credited
        // with it, and HEAD - pushes after their deadline included - became
        // their submission. A later stop is when they were stopped; it is not
        // the state at their deadline, which is rebuilt as of it.
        const stoppedAtDeadline = Boolean(heldBy) && existedAtStop &&
          (!deadline || Date.parse(heldBy.at) === Date.parse(deadline));
        const pushedLate = deadline && pushedAt && new Date(pushedAt) > new Date(deadline) && !stoppedAtDeadline;

        if (pushedLate) {
          const asOf = await submissionAsOf({ repoName: t.repoName, branch, deadline });
          if (asOf.ok) {
            // NOTHING BUT THE STARTING POINT BY THE DEADLINE IS NO SUBMISSION
            // (review 2026-10-14, A7). What a repository was given always
            // predates the deadline, so a student who pushed only after it
            // reconstructed to the starter, which was archived as their work
            // and read On time. The recorded start, or GitHub's generated
            // first commit where none was recorded.
            const atStart = Boolean(asOf.sha) && (await providedOnly(t, asOf.row ?? { sha: asOf.sha }));
            snapshotSha = atStart ? null : asOf.sha;
            reconstructed = true;
            noSubmission = snapshotSha === null;
            log(`record ${t.login}`, {
              ok: true,
              note: snapshotSha
                ? `pushed at ${pushedAt}, after the deadline - submission reconstructed as of ${deadline} (${snapshotSha.slice(0, 12)})`
                : atStart
                  ? `pushed at ${pushedAt}; by ${deadline} ${branch} held only what the repository was given - no submission`
                  : `pushed at ${pushedAt}; nothing on ${branch} was committed before ${deadline} - no submission`,
            });
          } else {
            // Falling back to HEAD here would silently record post-deadline
            // work as the submission. Better to record nothing and say why.
            log(`record ${t.login}`, { ok: false, note: asOf.reason });
            byRepo.set(t, { ok: false, gone: false, reason: asOf.reason, repoId: repoRes.data.id, pushedAt });
            continue;
          }
        } else {
          const commitRes = await gh("GET", `/repos/${cfg.org}/${t.repoName}/commits/${branch}`);
          // A FAILED READ IS NOT "NO SNAPSHOT" (review 2026-10-14). It was
          // recorded as `snapshot_sha: null` with ok - a 502 at the deadline,
          // when the whole cohort is read at once, and that student was never
          // preserved and never retried. Recorded as unread, and read again.
          if (!commitRes.ok || typeof commitRes.data?.sha !== "string") {
            const reason = `commit HTTP ${commitRes.status}`;
            log(`record ${t.login}`, { ok: false, note: `${reason} - read again on the next pass` });
            byRepo.set(t, { ok: false, gone: false, reason, repoId: repoRes.data.id, pushedAt });
            continue;
          }
          // STILL AT ITS STARTING POINT IS NO SUBMISSION on this path too
          // (review 2026-10-14, TL-4): the rebuilt path above says so, and a
          // student who never pushed was archived here as their own work with
          // the starter in it. One rule for both, so a push after the deadline
          // is not what decides whether nothing was handed in.
          const atStart = await providedOnly(t, commitRes.data);
          snapshotSha = atStart ? null : commitRes.data.sha;
          noSubmission = Boolean(atStart);
          if (atStart) log(`record ${t.login}`, { ok: true, note: `${branch} holds only what the repository was given - no submission` });
        }
      }

      // Write the final observation (only for a fresh snapshot - re-recording a
      // frozen one would fabricate a second observation of the same fact).
      // Where they went is kept: a student this run defers after asking again
      // (R7-31) must not be left an observation that reads as their lock.
      const obsWritten = [];
      if (snapshotSha && !frozen) {
        const now = new Date().toISOString();
        const safeTs = now.replace(/[:.]/g, "-");
        for (const m of t.members) {
          // No `team_slug`. observation.schema.json's snapshot variant is
          // `additionalProperties: false` and carries no such field, so every
          // GROUP assignment was writing an observation that fails its own
          // schema. Nothing read it either: report.mjs resolves a student's team
          // from the team manifests, falling back to the acceptance record, and
          // the lockdown record below already stores team_slug per student -
          // the authoritative per-run copy, which preserve.mjs reads. Written
          // once, read nowhere, forbidden by the contract: the earned_points
          // shape again.
          const observation = {
            schema_version: 1,
            assignment_id: cfg.assignmentId,
            github_login: m,
            repo_id: repoRes.data.id,
            observed_at: now,
            ref: submissionRef,
            sha: snapshotSha,
            observer_run: cfg.runUrl,
            collection_type: "lockdown",
          };
          // Validate before writing. This is inside the per-target try, so an
          // unwritable observation fails THAT student and the cohort's finalize
          // carries on - a malformed document must never stop every other
          // student being frozen and preserved.
          const check = validateAgainst("observation", observation);
          if (!check.valid) {
            throw new Error(
              `observation for ${m} does not match observation.schema.json: ` +
                check.errors.slice(0, 3).map((e) => `${e.instancePath || "/"} ${e.message}`).join("; ")
            );
          }
          const obsDir = join(cfg.dataDir, "observations", cfg.assignmentId, m);
          await mkdir(obsDir, { recursive: true });
          await writeFile(join(obsDir, `${safeTs}.json`), JSON.stringify(observation, null, 2) + "\n");
          obsWritten.push(join(obsDir, `${safeTs}.json`));
        }
      }

      byRepo.set(t, {
        obsWritten,
        ok: true,
        repoId: repoRes.data.id,
        branch,
        snapshotSha,
        frozen,
        reconstructed,
        noSubmission,
        pushedAt,
        existedAtStop,
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
  if (assignment === DELETED) {
    // Nothing locked, nothing written: the delete took its records and its
    // organization ruleset, and the finalize commit leaves it deleted (R7-17).
    log("assignment", { ok: true, note: `${cfg.assignmentId} was deleted while this ran - nothing is locked` });
    await setOutput("outcome", "deleted");
    await setOutput("locked_count", 0);
    await setOutput("error_count", 0);
    await summary(`### Lockdown: \`deleted\`\n\n${cfg.assignmentId} was deleted while this ran, so nothing was locked.\n`);
    return;
  }
  if (!assignment) await fail("fail:assignment", `no assignment file for "${cfg.assignmentId}"`);
  const submissionRef = assignment.submission_ref || "refs/heads/main";
  // `let`: asked again before the record is written (R7-31).
  let deadlineAt = assignment.deadline_at || null;
  log("assignment", { ok: true, note: `deadline_at=${deadlineAt} submission_ref=${submissionRef}` });

  // Prior lockdown (retry path) - frozen snapshots, keyed by login. Keyed
  // case-insensitively because GitHub logins are: a record written under one
  // spelling must still be found under the other, or freeze-on-retry silently
  // stops freezing and a late commit replaces the on-time submission.
  const prior = await readPriorLockdown();
  const priorByLogin = indexByLogin(prior?.results || []);
  // THE CEILING COUNTS RETRIES OF FAILED WORK, not passes (review 2026-10-14).
  // Every pass incremented it - one for each expired extension, a lecturer's
  // "Lock everyone out now", a "Try again" - so two extensions expiring on two
  // nights spent the three attempts, and a preservation that failed on the
  // third was never retried. A pass is a retry when the record it follows
  // still owed something: a snapshot not yet archived, or one not yet read.
  const retrying = Boolean(prior) && (prior.results || []).some(
    (r) => r?.snapshot_unread || (r?.snapshot_sha && !r?.reopened_at && !preservedOnRecord(r.github_login, r.snapshot_sha)),
  );
  const attempt = prior ? (prior.finalize_attempts ?? 1) + (retrying ? 1 : 0) : 1;
  if (prior) {
    log("prior-lockdown", {
      ok: true,
      note: `${retrying ? `retry #${attempt}` : `pass after attempt #${attempt} (nothing owed was retried)`} - reusing ${priorByLogin.size} frozen snapshot(s)`,
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

  // Who shares a repository. Empty on an individual assignment, and that is the
  // whole answer there - every record is its own repository.
  const teamsBySlug = await readTeams();
  if (teamsBySlug.size) {
    log("teams", { ok: true, note: `${teamsBySlug.size} team manifest(s) - extensions apply per repository` });
  }

  // Repositories a lecturer deliberately reopened. Read before planning,
  // because "excluded from the target list" has to mean the same thing here as
  // it does for a deferral: never stopped, never demoted, never touched.
  const reopened = await readReopened();
  if (reopened.size) {
    log("reopened", { ok: true, note: `${reopened.size} repositor(y|ies) reopened by a lecturer - not re-locked` });
  }

  // --- Phase 0: plan ---------------------------------------------------------
  const { targets, deferrals, reopenedTargets } = planTargets(
    assignment, records, overrides, priorByLogin, new Date(), teamsBySlug, reopened,
  );
  for (const r of reopenedTargets) {
    log(`lockdown ${r.displayKey}`, {
      ok: true,
      note: `left open - reopened by ${r.record?.unlocked_by || "a lecturer"}` +
        (r.record?.reason ? ` (${r.record.reason})` : ""),
    });
  }
  for (const d of deferrals) {
    log(`lockdown ${d.displayKey}`, {
      ok: true,
      note: d.reopen
        ? `left open until ${d.effective.deadline.toISOString()} - reopened by ${d.reopen.record?.unlocked_by || "a lecturer"}, locked again then`
        : d.effective.extended
        ? `deferred - extension granted to ${d.effective.grantedTo} runs to ${d.effective.deadline.toISOString()}`
        : `deferred - the deadline is now ${d.effective.deadline.toISOString()}, still ahead`,
    });
  }
  // LOCKED AGAIN, WITH WHAT THEY DID SINCE (R7-3): the row the reopen left -
  // its old snapshot carried for the record - is not this lock's history, so
  // it is not frozen over: a fresh snapshot is taken, at this lock's time.
  for (const t of targets.filter((x) => x.relock)) {
    for (const m of t.members) priorByLogin.delete(normalizeLogin(m));
    log(`lockdown ${t.displayKey}`, { ok: true, note: `locked again - reopened at ${t.relock.record?.unlocked_at}, and their deadline ${t.relock.until} has passed` });
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
  // silently stop freezing live cohorts. lib/lock-scope.mjs owns that default.
  const blockLate = assignment.late_policy === "block";
  const demoteToo = takesAccessAtDeadline(assignment);
  log("policy", { ok: true, note: `late_policy=${assignment.late_policy ?? "report"} lock_down_enabled=${demoteToo}` });

  // A ruleset the App cannot bypass would lock the system out of the repository
  // too, and there is no way back except deleting it - so an unresolvable App id
  // means demotion, not a ruleset.
  let appId = null;
  if (blockLate && targets.length) {
    appId = await resolveAppId(gh, { appId: process.env.PXL_APP_ID });
    if (!appId) log("app-id", { ok: false, note: "could not resolve the App id - the lock falls back to demotion" });
  }

  // ORG SCOPE IS OPT-IN, and deliberately not the default while it is new. A
  // repository ruleset lives in the student's own repository and they are its
  // admin, so they can delete it; an organization ruleset lists as
  // `source_type: "Organization"` and they cannot. It is also ONE call for the
  // whole cohort rather than two per repository, which is what matters at the
  // instant a sentinel fires.
  //
  // lib/lock-scope.mjs decides, and says why in a sentence the run log carries.
  // ABSENT NOW MEANS ORGANIZATION SCOPE: the configuration this is for is "the
  // deadline is final and the student keeps their toolchain", which is exactly
  // the case where they are still admin of the repository holding the ruleset
  // that stops them. `false` opts out and is preserved through a save.
  const orgScope = usesOrgScope(assignment, blockLate);
  log("lock scope", { ok: true, note: lockScopeNote(assignment, blockLate) });

  let lockMethod = "none";
  if (targets.length) {
    if (blockLate) lockMethod = appId ? (orgScope ? "org-ruleset" : "ruleset") : "demotion";
    else if (demoteToo) lockMethod = "demotion";
  }

  // Every comparison against "the deadline" is the deadline for THAT student
  // (lib/effective-deadline.mjs). Hoisted above the lock because the lock now
  // needs it too, to tell a student the sentinel stopped from one it deferred.
  // teamMembers, not members: a repository is one object, so the most generous
  // extension anywhere on the team is the deadline it is reconstructed against.
  const deadlineFor = (t) =>
    effectiveDeadlineFor(assignment, t.login, { overrides, team: { members: t.teamMembers } })
      .deadline?.toISOString() ?? null;

  // Null unless a sentinel actually reached this assignment's instant. Read
  // even under STOP_ONLY: a second sentinel armed by an overlapping firing must
  // not restamp the first one's work with its own clock.
  // Which stop held each student is asked per student (`stopFor`, R7-8).
  const sentinelStoppedAt = await readSentinelStop();
  const stopFor = await readSentinelStops();
  if (sentinelStoppedAt) {
    log("sentinel", { ok: true, note: `writes already stopped at ${sentinelStoppedAt} - crediting each student with the stop at or after their own deadline` });
  }

  const lock = await applySubmissionLock({
    targets, method: lockMethod, submissionRef, appId, priorByLogin,
    stopFor, deadlineFor,
  });

  // What the sentinel stopped for a deadline no longer in force is let go here
  // (R7-1, R7-2): a student whose deadline is still ahead may push until then.
  const releaseFailed = await releaseDeferredStops(deferrals, assignment, { probeRepos: deferrals.length > 0 && (await sentinelEverStopped()) });

  // Stop-only: the sentinel's job is the instant, not the bookkeeping. The
  // ordinary finalize follows minutes later and does phases 2-4 unhurried,
  // against repositories that can no longer move - and applySubmissionLock is
  // idempotent, so it will report the lock `unchanged` rather than redo it.
  if (cfg.stopOnly) {
    const stopped = [...lock.byRepo.values()].filter((s) => s.locked).length;
    // A MISSED STOP FAILS THE RUN. The workflow reads only this exit code:
    // "Record whether the stop held" writes `stop: done` on success, a queued
    // duplicate sentinel then re-stops nobody (stoppedByAnotherSentinel), and
    // the nightly credits the instant as the lock time of students who could
    // still push. Every per-repository failure is caught above, so this used to
    // exit 0 whatever happened (review of v1.5.0).
    //
    // The same exemption the full run makes, for the same reason: an
    // organization OWNER cannot be demoted by anything, so failing on them
    // would turn every deadline red on an org where a lecturer accepted their
    // own assignment. An unreadable owner list excuses nobody.
    // A repository that no longer exists is not a missed stop (LD5).
    const missed = targets.filter((t) => {
      const s = lock.byRepo.get(t);
      return s && !s.locked && !s.gone && lock.method !== "none";
    });
    const gone = targets.filter((t) => lock.byRepo.get(t)?.gone).length;
    let unstoppable = missed;
    if (missed.length) {
      const { owners } = await fetchOrgOwners(gh, cfg.org);
      const loginsOfTarget = (t) => (t.teamMembers?.length ? t.teamMembers : [t.login]).filter(Boolean);
      unstoppable = missed.filter((t) => !loginsOfTarget(t).some((l) => isKnownOwner(owners, l)));
    }
    await setOutput("locked_count", stopped);
    await setOutput("error_count", unstoppable.length + releaseFailed.length);
    await setOutput("deferred_count", deferrals.length);
    await setOutput("lock_method", lock.method);
    await setOutput("outcome", "stopped");
    await summary(
      `### Deadline stop: \`${lock.method}\` at ${lock.lockedAt}\n\n` +
      `**${stopped}/${targets.length}** repositories stopped` +
      (gone ? `, **${gone}** no longer exist${gone === 1 ? "s" : ""}` : "") +
      (deferrals.length ? `, **${deferrals.length}** deferred (their deadline is still ahead)` : "") +
      `. No record written - the finalize run does phases 2-4.\n` +
      (releaseFailed.length ? `\n**Not let go of the stop, though their deadline is ahead:** ${releaseFailed.join("; ")}\n` : "")
    );
    if (unstoppable.length) {
      log("stop-only", {
        ok: false,
        note: `${stopped}/${targets.length} stopped - NOT stopped: ${unstoppable.map((t) => t.displayKey).join(", ")}`,
      });
      process.exit(1);
    }
    // A student whose deadline is ahead and who is still stopped cannot push
    // through the time they were given (R7-32). Said as an error, NOT as this
    // run's exit: the exit code is the stop's own verdict (`stop: done`), and
    // a failed one withdraws the stop's credit from the whole cohort. The
    // finalize minutes later lets go again, and fails its leg if it cannot.
    if (releaseFailed.length) {
      log("stop-only", { ok: false, note: `stopped, but NOT let go: ${releaseFailed.join("; ")}` });
      console.log(`::error::Students whose deadline is still ahead were not let go of the stop, so they cannot push: ${releaseFailed.join("; ")}. The finalize tries again.`);
    }
    log("stop-only", { ok: true, note: `${stopped}/${targets.length} stopped${gone ? `, ${gone} no longer exist${gone === 1 ? "s" : ""}` : ""}; no lockdown record written` });
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
    // The stop that held each student, and which repositories it was
    // watching (R6-25, R7-8) - asked of their own deadline under every policy.
    stopDeadlineFor: deadlineFor,
    stopFor,
  });

  // --- Phase 4: DEMOTE -------------------------------------------------------
  // Only when phase 1 did not already do it. Runs after the recording, so the
  // snapshot is taken while the student still has whatever access they had.
  //
  // Asked per repository, of whatever rung actually held it. This compared the
  // RUN's method with "ruleset", so when organization scope became the default
  // under `block` nothing was demoted any more and nothing said so.
  // lib/lock-scope.mjs decides.
  const demoted = new Set();
  const toDemote = targets.filter((t) => demotesAfterStop(assignment, lock.byRepo.get(t)?.method));
  if (toDemote.length) {
    const notDemoted = [];
    for (const t of toDemote) {
      const out = await demote(t);
      if (out.locked) demoted.add(t);
      else notDemoted.push({ t, out });
    }
    // An organization owner keeps admin on every repository whatever their
    // collaborator grant says - said, so a lecturer reading the run does not
    // chase it (seen on a real deadline, 2026-10-15). The owners are asked
    // only when a demotion did not hold; the ruleset that stopped them still
    // holds the branch.
    const ownerList = notDemoted.length ? (await fetchOrgOwners(gh, cfg.org)).owners : null;
    for (const { t, out } of notDemoted) {
      const owner = (t.teamMembers?.length ? t.teamMembers : [t.login]).filter((l) => l && isKnownOwner(ownerList, l));
      log(`demote ${t.displayKey}`, {
        ok: false,
        note: `permission after=${out.permissionAfter}${owner.length ? ` - ${owner.join(", ")} owns the organization, so GitHub keeps them admin` : ""}`,
      });
    }
    log("phase 4 - demote", { ok: true, note: `${demoted.size}/${toDemote.length} demoted to pull` });
  }

  // --- Who could not be frozen because they own the organization -------------
  //
  // An organization OWNER keeps admin on every repository in it, so demoting
  // their collaborator grant to `pull` changes nothing - GitHub grants the
  // highest applicable permission. Nothing lockdown can do will freeze them.
  //
  // Treating that as an error failed the whole leg, which SKIPPED preservation
  // for the entire cohort: one unfreezable account meant nobody's work was
  // archived that night, three nights running, and then find-finalizable gave
  // up at its ceiling and the assignment never finalized at all. Observed on
  // PXL-2TIN-DevOps-2627/test-opdracht, 2026-09-03.
  //
  // And it is not an exotic case. Owning the course organization is what MAKES
  // somebody a lecturer here, and accepting your own assignment is the only way
  // to see what a student sees - so the people most likely to trip this are the
  // ones running the course.
  //
  // lib/audit.mjs has said as much for months: of exactly these accounts, "no
  // branch of it is ever a failure ... in practice every owner in an acceptance
  // list is staff". The audit called it benign while lockdown called it fatal.
  //
  // Fetched only when something actually failed to lock, so a healthy cohort
  // costs no extra requests.
  // A repository that no longer exists is not one that failed to lock (LD5).
  const unlocked = targets.filter((t) => {
    const s = lock.byRepo.get(t);
    return s && !s.locked && !s.gone && lock.method !== "none";
  });
  let owners = null;
  let ownersComplete = true;
  if (unlocked.length > 0) {
    const fetched = await fetchOrgOwners(gh, cfg.org);
    owners = fetched.owners;
    ownersComplete = fetched.complete;
    if (owners === null) {
      // Unreadable is not evidence. Without the list nothing is provably an
      // owner, so every failure below stays a failure - which is the safe
      // direction: it refuses to excuse a student from the deadline on a read
      // that did not happen.
      log("org owners", { ok: false, note: "owner list unreadable - no student will be excused from the freeze" });
    } else {
      log("org owners", {
        ok: true,
        note: `${owners.length} owner(s)${ownersComplete ? "" : " (truncated read)"}`,
      });
    }
  }

  /** Every login behind a target - a team repo has several. */
  const loginsOf = (t) => (t.teamMembers?.length ? t.teamMembers : [t.login]).filter(Boolean);

  // --- ASKED AGAIN BEFORE IT IS WRITTEN (review 2026-10-16, R7-31) ----------
  //
  // The plan above is what GitHub said when this run read it, and the lock
  // took the minutes since. The record is written now and committed straight
  // after (daily-activity.yml), so a deadline moved later or an extension
  // granted in those minutes was published over no lock record: the publish
  // let go of the stop, and this record would then have said locked under a
  // deadline no longer in force. So the deadline and the extensions are read
  // again, and a student THIS run locked whose deadline in force is now ahead
  // is deferred like any other - and let go of what this run put on them, the
  // repository's own ruleset and a demotion included. A student an earlier pass
  // or a lecturer locked is not touched (`lockHeld`): Reopen is how they get
  // time. A read that fails keeps the plan, and says so.
  const movedKeys = new Set();
  if (targets.length) {
    const fresh = await readAssignmentRemote();
    if (fresh && fresh !== DELETED) {
      const replan = planTargets(fresh, records, await readOverrides(), priorByLogin, new Date(), teamsBySlug, reopened);
      const nowDeferred = new Map(replan.deferrals.map((d) => [String(d.repoName).toLowerCase(), d]));
      const moved = targets.filter((t) => nowDeferred.has(String(t.repoName).toLowerCase()));
      if (moved.length) {
        deadlineAt = fresh.deadline_at || deadlineAt;
        const movedDeferrals = [];
        for (const t of moved) {
          const key = String(t.repoName).toLowerCase();
          movedKeys.add(key);
          movedDeferrals.push({ ...nowDeferred.get(key), lockedThisRun: true });
          // Its lock observation is not their lock any more.
          for (const path of recorded.get(t)?.obsWritten ?? []) await rm(path, { force: true });
          log(`lockdown ${t.displayKey}`, { ok: true, note: `deferred after all - their deadline is now ${nowDeferred.get(key).effective.deadline.toISOString()}, changed while this ran; let go of this run's lock` });
        }
        for (let i = targets.length - 1; i >= 0; i--) if (movedKeys.has(String(targets[i].repoName).toLowerCase())) targets.splice(i, 1);
        deferrals.push(...movedDeferrals);
        releaseFailed.push(...(await releaseDeferredStops(movedDeferrals, fresh, { probeRepos: true })));
      }
    } else {
      log("asked again", { ok: false, note: "the assignment could not be read again before writing the record - the plan stands" });
    }
  }

  // --- Assemble the record ---------------------------------------------------
  let lockedCount = 0;
  let recordedCount = 0;
  let errorCount = 0;
  let unfreezableCount = 0;
  let noSubmissionCount = 0;
  let goneCount = 0;
  let maxUncertainty = 0;
  const rows = [];
  const lockdownResults = [];

  // A REOPENED STUDENT KEEPS A ROW, the way a deferred one always has.
  //
  // They used to be dropped entirely: the run counted them in `reopened_count`
  // and then wrote nothing about them, so the record - the document a grade
  // dispute is read from - lost the fact that they had ever been locked, what
  // their snapshot was, and when. The only surviving statement was
  // `unlocked/<login>.json`, which no reader of this file joins.
  //
  // `lock_method: null`, because nothing is holding this repository now. That
  // is what stops `unlockability` offering to reopen an open repository, and
  // `reopened_at` beside it is what lets it say so rather than "the record does
  // not say how this was locked".
  for (const r of reopenedTargets) {
    // The record's OWN members, as for a deferral: every member of a team has
    // a record and each is a reopened target, so their teamMembers wrote the
    // whole team once per member - N x N rows, preserved N x N times (review
    // 2026-10-14, A15).
    for (const m of r.members?.length ? r.members : [r.login]) {
      lockdownResults.push({
        github_login: m,
        team_slug: r.rec?.team_slug || undefined,
        repo_name: `${cfg.org}/${r.repoName}`,
        repo_id: r.rec?.repo_id ?? null,
        // Carried from the reopen record so the report's preservation join and
        // any later reader still know what was frozen for this student.
        snapshot_sha: r.record?.snapshot_sha ?? null,
        snapshot_ref: submissionRef,
        lockdown_at: null,
        lock_method: null,
        reopened_at: r.record?.unlocked_at ?? null,
        permission_after: null,
        verified: false,
        uncertainty_seconds: null,
      });
    }
  }

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
        deferred_reason: d.reopen ? `reopened by ${d.reopen.record?.unlocked_by || "a lecturer"} until their deadline` : d.effective.reason,
        // Reopened, with time on it (R7-3): open now, locked at `deferred_until`.
        ...(d.reopen ? { reopened_at: d.reopen.record?.unlocked_at ?? null } : {}),
        permission_after: null,
        verified: false,
        uncertainty_seconds: null,
      });
    }
  }

  for (const t of targets) {
    const state = recorded.get(t);
    const stop = lock.byRepo.get(t);

    // A repository that is GONE produces no result row: preserve iterates the
    // results, and a row it can never preserve would turn every subsequent
    // night amber for a repository that no longer exists. One that could not
    // be READ this pass gets a row saying so (`snapshot_unread`): it is
    // locked, Reopen can act on it, and find-finalizable queues the next pass
    // to read it again (review 2026-10-14 - it used to vanish from the record).
    if (!state?.ok) {
      // GONE, as the stop confirmed it (P2-26: a 404 by id where the
      // installation sees every repository), and read gone again here: a
      // student who deleted their own repository before the deadline has
      // nothing to lock or preserve. Counted as an error, it made a finalize
      // that locked everybody else `partial` (TV-7, live 2026-10-15). A 404
      // the stop did not confirm is still an error.
      if (state?.gone && stop?.gone) {
        goneCount++;
        rows.push(`| ${t.displayKey} | - | - | gone - the repository no longer exists |`);
        // DELETED AFTER IT WAS LOCKED (review 2026-10-15, R6-30): the row of
        // what was frozen is history, and the record is rewritten whole, so a
        // later pass dropped it. Kept as it was where the submission is in the
        // archive - preservation skips what it already holds. One never
        // preserved stays out: nothing can preserve it now.
        for (const m of t.members) {
          const prior = priorByLogin.get(normalizeLogin(m));
          if (prior?.snapshot_sha && preservedOnRecord(m, prior.snapshot_sha)) lockdownResults.push(prior);
        }
        continue;
      }
      errorCount++;
      rows.push(`| ${t.displayKey} | - | - | error${state?.reason ? `: ${state.reason}` : ""} |`);
      if (state && !state.gone) {
        for (const m of t.members) {
          lockdownResults.push({
            github_login: m,
            team_slug: t.rec.team_slug || undefined,
            repo_name: `${cfg.org}/${t.repoName}`,
            repo_id: state.repoId ?? t.rec.repo_id ?? null,
            snapshot_sha: null,
            snapshot_ref: submissionRef,
            snapshot_unread: state.reason,
            pushed_at: state.pushedAt ?? null,
            lockdown_at: stop?.lockdownAt ?? null,
            lock_method: stop?.method ?? null,
            permission_after: null,
            // WHAT THE STOP DID, not what the read did (review 2026-10-15,
            // R6-24): the snapshot is what failed, and the lock may well hold.
            // Written false, Reopen said the run had not locked it - while the
            // reason to refuse is the snapshot nobody has archived.
            verified: Boolean(stop?.locked),
            uncertainty_seconds: null,
          });
        }
      }
      continue;
    }

    // Not the stop's instant for a repository made after it (P2-27): that
    // repository was locked by this run.
    const heldBy = stopFor(deadlineFor(t));
    const lockdownAt = state.existedAtStop === false && heldBy && stop.lockdownAt === heldBy.at
      ? lock.lockedAt
      : stop.lockdownAt;
    // How long after THIS STUDENT'S deadline they could still push - not after
    // the assignment's. Measured against `deadline_at`, a student locked at the
    // nightly after a seven-day extension expired was reported with seven days
    // of uncertainty, on the one number a lecturer would cite in a dispute.
    // `deadlineFor` is the same answer phases 1 and 2 already used.
    //
    // AGAINST THE DEADLINE THE ROW WAS LOCKED UNDER (review 2026-10-16, R7-8).
    // A row an earlier pass locked keeps its lock time, so measured against a
    // deadline moved later since, or an extension granted after the lock, it
    // went negative by days. It keeps the figure that pass measured. And never
    // below zero: locked before their deadline is no time at all.
    const ownDeadline = deadlineFor(t) ?? deadlineAt;
    const priorRow = priorByLogin.get(normalizeLogin(t.login));
    let uncertaintySec = null;
    if (lockHeld(priorRow) && lockdownAt === priorRow.lockdown_at && Number.isFinite(priorRow.uncertainty_seconds)) {
      uncertaintySec = Math.max(0, priorRow.uncertainty_seconds);
    } else if (ownDeadline && lockdownAt) {
      uncertaintySec = Math.max(0, Math.round((new Date(lockdownAt) - new Date(ownDeadline)) / 1000));
    }
    if (uncertaintySec !== null && uncertaintySec > maxUncertainty) maxUncertainty = uncertaintySec;

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
        // Why this one was not frozen, when it was not. Recorded rather than
        // inferred from permission_after: "admin" is also what a transient
        // failure leaves behind, and a grade dispute should not turn on
        // somebody re-deriving the difference months later.
        unfreezable_reason:
          !stop.locked && loginsOf(t).some((l) => isKnownOwner(owners, l))
            ? "org-owner"
            : undefined,
        uncertainty_seconds: uncertaintySec,
        // Locked again after a reopen that gave them time (R7-3): when that
        // reopen was. Carried by every later pass, so the grader at the
        // deadline knows this snapshot is new since a lecturer read the scores.
        relocked_after: t.relock?.record?.unlocked_at ?? priorByLogin.get(normalizeLogin(m))?.relocked_after ?? undefined,
      });
    }

    const sha12 = (state.snapshotSha || "-").slice(0, 12);
    // Named per rung: this used to know "ruleset" and "demotion" only, so a
    // repository held by the organization ruleset was summarised as not locked.
    const how = ({ "org-ruleset": "organization ruleset", ruleset: "ruleset", demotion: "pull" }[stop.method] ?? "not locked") +
      (demoted.has(t) ? " + pull" : "");
    if (state.noSubmission) noSubmissionCount++;
    if (stop.locked || lock.method === "none") {
      if (stop.locked) lockedCount++;
      // Under "Nothing is locked" a recorded student is what success is (R6-29).
      else recordedCount++;
      log(`lockdown ${t.displayKey}`, { ok: true, note: `${state.branch}@${sha12} -> ${how} (${uncertaintySec ?? "?"}s)` });
      rows.push(`| ${t.displayKey} | \`${sha12}\` | ${uncertaintySec ?? "-"}s | ${state.noSubmission ? "no submission" : `[OK] ${how}`} |`);
    } else if (loginsOf(t).some((l) => isKnownOwner(owners, l))) {
      // A terminal outcome, not an error - and reported, never silent. A real
      // student who owns the organization is exempt from the freeze whatever
      // this code does, so the honest response is to say so where a lecturer
      // will read it, not to fail the cohort and hide it in a log.
      unfreezableCount++;
      const who = loginsOf(t).filter((l) => isKnownOwner(owners, l)).join(", ");
      log(`lockdown ${t.displayKey}`, {
        ok: true,
        note: `NOT FROZEN - ${who} owns ${cfg.org}, so admin cannot be removed. Change their role to Member to freeze them.`,
      });
      rows.push(`| ${t.displayKey} | \`${sha12}\` | ${uncertaintySec ?? "-"}s | **not frozen - org owner** |`);
    } else {
      errorCount++;
      log(`lockdown ${t.displayKey}`, { ok: false, note: `not locked (${stop.method}), permission after=${stop.permissionAfter}` });
      rows.push(`| ${t.displayKey} | \`${sha12}\` | ${uncertaintySec ?? "-"}s | perm=${stop.permissionAfter} |`);
    }
  }

  // A reopen this run locked again is ended (R7-29), and one whose repository
  // is gone, which nothing will lock again. At the lock time on its row.
  for (const t of targets.filter((x) => x.relock)) {
    const stop = lock.byRepo.get(t);
    const state = recorded.get(t);
    if (!(stop?.locked || stop?.gone || state?.gone)) continue;
    const row = lockdownResults.find((r) => normalizeLogin(r.github_login) === normalizeLogin(t.login));
    await endReopens(t, row?.lockdown_at ?? new Date().toISOString());
  }

  // A stop not let go, though their deadline is ahead (R7-32): an error of the
  // run, named, and the leg fails below so the lecturer is told.
  for (const f of releaseFailed) rows.push(`| ${f.split(":")[0]} | - | - | **still stopped, deadline ahead** |`);
  errorCount += releaseFailed.length;

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
    // The organization ruleset covering this cohort, when there is one. A
    // convenience for reading it back, never the lookup key: the sentinel's
    // STOP_ONLY path writes no record at all, so findOrgSubmissionLock resolves
    // by name and this only saves a call afterwards.
    ...(lock.orgRulesetId ? { org_ruleset_id: lock.orgRulesetId } : {}),
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
    // Deliberately reopened by a lecturer and therefore not re-locked. Counted
    // apart from deferrals and errors because it is neither: nothing failed,
    // and nobody was granted more time - a decision was already made and this
    // run honoured it.
    reopened_count: reopenedTargets.length,
    // Accounts that own the organization, and therefore keep admin whatever
    // this run does. Counted separately from errors because they are not one -
    // nothing can freeze them - and separately from locks because they were NOT
    // frozen. Each carries `unfreezable_reason` in `results`.
    unfreezable_count: unfreezableCount,
    // Deleted before the lock: neither a lock nor an error, and no row.
    gone_count: goneCount,
    max_uncertainty_seconds: maxUncertainty,
    results: lockdownResults,
  };
  await writeFile(join(lockdownDir, "lockdown-record.json"), JSON.stringify(lockdownRecord, null, 2) + "\n");

  // Outputs & summary.
  // A deferral is neither a lock nor an error: the student was granted more
  // time and the system honoured it. Counting it as either would paint the
  // nightly amber for doing the right thing.
  // A success is a student locked, or under "Nothing is locked" one recorded:
  // there nobody is ever locked, so one unreadable repository read as every
  // student failing and failed the whole finalize (review 2026-10-15, R6-29).
  const outcome = errorCount === 0 ? "locked" : lockedCount + recordedCount > 0 ? "partial" : "fail:all-errors";
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
    (deferrals.length ? `, **${deferrals.length}** deferred (their deadline is still ahead)` : "") +
    (noSubmissionCount ? `, **${noSubmissionCount}** with no submission before the deadline` : "") +
    (unfreezableCount ? `, **${unfreezableCount}** NOT FROZEN (organization owner - change their role to Member to freeze them)` : "") +
    (goneCount ? `, **${goneCount}** deleted before the lock` : "") +
    `. Max uncertainty: **${maxUncertainty}s**.\n`
  );
  await setOutput("unfreezable_count", unfreezableCount);
  await setOutput("reopened_count", reopenedTargets.length);
  log("done", { ok: errorCount === 0, note: `${outcome} (${lockedCount} locked, ${deferrals.length} deferred, ${noSubmissionCount} no-submission, ${unfreezableCount} unfreezable, ${goneCount} gone, ${errorCount} err, ${maxUncertainty}s max uncertainty)` });
  // The record is written, and every step after this one runs whatever this
  // exit says; failing is what files the notice for the lecturer (R7-32).
  if (releaseFailed.length) {
    console.log(`::error::Students whose deadline is still ahead could not be let go of the stop, so they cannot push: ${releaseFailed.join("; ")}. Run the finalize again to retry.`);
    process.exit(1);
  }
  process.exit(outcome.startsWith("fail:") ? 1 : 0);
}

main().catch(async (e) => { await fail("fail:exception", e.message); });
