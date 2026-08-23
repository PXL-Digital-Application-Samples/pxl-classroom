#!/usr/bin/env node
// PXL Classroom - deadline lock-down.
//
// Based on spikes/04-deadline/deadline.mjs. For each managed repository:
//   0. Skips it entirely if a granted extension is still running (deferred)
//   1. Takes a final snapshot of the submission ref
//   2. Demotes the student from current permission to "pull" (read-only)
//   3. Verifies the demotion
//   4. Records lockdown time and uncertainty interval (lockdown_at − deadline_at)
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

// --- Main --------------------------------------------------------------------
async function main() {
  const bad = validate();
  if (bad) await fail("fail:validation", bad);

  // 1. Auth check
  const ping = await gh("GET", "/rate_limit");
  if (!ping.ok) await fail("fail:auth", `token rejected (HTTP ${ping.status})`);
  log("auth", { ok: true, note: "installation token accepted" });

  // 2. Read assignment
  const assignment = await readAssignment();
  if (!assignment) await fail("fail:assignment", `no assignment file for "${cfg.assignmentId}"`);
  const submissionRef = assignment.submission_ref || "refs/heads/main";
  const deadlineAt = assignment.deadline_at || null;
  log("assignment", { ok: true, note: `deadline_at=${deadlineAt} submission_ref=${submissionRef}` });

  // 2b. Prior lockdown (retry path) - frozen snapshots, keyed by login
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

  // 2c. Lecturer overrides - who has been granted more time
  const overrides = await readOverrides();
  if (overrides.length) {
    log("overrides", { ok: true, note: `${overrides.length} override document(s)` });
  }

  // 3. Read repo records
  const records = await readRepoRecords();
  // Zero students is a valid population - the loop below no-ops and step 5
  // still writes an empty lockdown-record.json, which preserve needs in order
  // to report "no students to preserve" instead of fail:no-lockdowns.
  log("repo-records", { ok: true, note: records.length ? `${records.length} student(s)` : "no repository records - nothing to lock down" });

  // 4. Lockdown each repo
  let lockedCount = 0;
  let errorCount = 0;
  let deferredCount = 0;
  let maxUncertainty = 0;
  const rows = [];
  const lockdownResults = [];

  for (const rec of records) {
    const login = rec.github_login;
    const repoName = rec.repo_name?.split("/")?.[1] ?? rec.repo_name;
    try {
      // 4a0. Has this student been granted more time?
      //
      // A group shares one repository, so the most generous extension among its
      // members governs the repo - locking it at anyone else's deadline locks
      // out the student who was granted the time.
      //
      // The check comes before every read and every write: a deferred student is
      // not in the target list at all, so no observation is fabricated, no
      // permission is touched, and no API call is spent on them. The assignment
      // re-queues once the extension expires (find-finalizable.mjs reads
      // deferred_until), and until then it counts as active so the nightly does
      // not disable itself and stop observing their work.
      const members = Array.isArray(rec.members) && rec.members.length ? rec.members : (login ? [login] : []);
      const displayKey = rec.team_slug ? `${rec.team_slug} (${members.join(",")})` : login;
      const effective = effectiveDeadlineFor(assignment, login, {
        overrides,
        team: { members },
      });
      // Gated on `extended`, not on the deadline alone: a lecturer running a
      // lockdown early still locks the cohort, exactly as before. Only a
      // granted, still-running extension defers.
      if (effective.extended && effective.deadline > new Date()) {
        const deferredUntil = effective.deadline.toISOString();
        deferredCount++;
        log(`lockdown ${displayKey}`, {
          ok: true,
          note: `deferred - extension granted to ${effective.grantedTo} runs to ${deferredUntil}`,
        });
        rows.push(`| ${displayKey} | - | - | deferred to ${deferredUntil} |`);
        for (const m of members) {
          lockdownResults.push({
            github_login: m,
            team_slug: rec.team_slug || undefined,
            repo_name: `${cfg.org}/${repoName}`,
            repo_id: rec.repo_id ?? null,
            snapshot_sha: null,
            snapshot_ref: submissionRef,
            lockdown_at: null,
            deferred_until: deferredUntil,
            deferred_reason: effective.reason,
            permission_after: null,
            verified: false,
            uncertainty_seconds: null,
          });
        }
        continue;
      }

      // 4a. Final snapshot
      const repoRes = await gh("GET", `/repos/${cfg.org}/${repoName}`);
      if (!repoRes.ok) {
        log(`lockdown ${login}`, { ok: false, note: `repo HTTP ${repoRes.status}` });
        errorCount++;
        rows.push(`| ${login} | - | - | error |`);
        continue;
      }
      const branch = submissionRef.startsWith("refs/heads/")
        ? submissionRef.slice("refs/heads/".length)
        : repoRes.data.default_branch;

      // Frozen on retry: never re-snapshot a student who was already locked
      // down, or a late commit would replace their on-time submission.
      const priorRec = priorByLogin.get(login);
      const frozen = !!priorRec?.snapshot_sha;
      let snapshotSha;
      if (frozen) {
        snapshotSha = priorRec.snapshot_sha;
        log(`lockdown ${login}`, {
          ok: true,
          note: `snapshot frozen from attempt #${prior.finalize_attempts ?? 1} (${snapshotSha.slice(0, 12)})`,
        });
      } else {
        const commitRes = await gh("GET", `/repos/${cfg.org}/${repoName}/commits/${branch}`);
        snapshotSha = commitRes.ok ? commitRes.data.sha : null;
      }

      // Write the final observation (only for a fresh snapshot - re-recording a
      // frozen one would fabricate a second observation of the same fact)
      if (snapshotSha && !frozen) {
        const now = new Date().toISOString();
        const safeTs = now.replace(/[:.]/g, "-");
        for (const m of members) {
          const observation = {
            schema_version: 1,
            assignment_id: cfg.assignmentId,
            github_login: m,
            team_slug: rec.team_slug || undefined,
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

      // 4b. Demote student(s) to pull (read-only). Re-run on a retry too: it is
      // idempotent and re-locks anyone who regained write access since.
      const lockdownAt = frozen ? priorRec.lockdown_at : new Date().toISOString();
      let allLocked = true;
      let permAfter = "read";

      for (const m of members) {
        const demote = await gh("PUT", `/repos/${cfg.org}/${repoName}/collaborators/${m}`, { permission: "pull" });
        if (!(demote.status === 204 || demote.status === 201)) {
          log(`lockdown ${m}`, { ok: false, note: `demote HTTP ${demote.status}` });
          allLocked = false;
          continue;
        }

        // 4c. Verify demotion
        const verify = await gh("GET", `/repos/${cfg.org}/${repoName}/collaborators/${m}/permission`);
        const userPerm = verify.ok ? verify.data.permission : `error-${verify.status}`;
        if (userPerm !== "read") {
          allLocked = false;
          permAfter = userPerm;
        }
      }

      // 4d. Uncertainty interval
      let uncertaintySec = null;
      if (deadlineAt) {
        const ms = new Date(lockdownAt) - new Date(deadlineAt);
        uncertaintySec = Math.round(ms / 1000);
        if (Math.abs(uncertaintySec) > maxUncertainty) maxUncertainty = Math.abs(uncertaintySec);
      }

      // Record lockdown result per member
      for (const m of members) {
        lockdownResults.push({
          github_login: m,
          team_slug: rec.team_slug || undefined,
          repo_name: `${cfg.org}/${repoName}`,
          repo_id: repoRes.data.id,
          snapshot_sha: snapshotSha,
          snapshot_ref: submissionRef,
          lockdown_at: lockdownAt,
          permission_after: permAfter,
          verified: allLocked,
          uncertainty_seconds: uncertaintySec,
        });
      }

      if (allLocked) {
        lockedCount++;
        log(`lockdown ${displayKey}`, { ok: true, note: `${branch}@${(snapshotSha || "?").slice(0, 12)} -> pull (${uncertaintySec ?? "?"}s)` });
        rows.push(`| ${displayKey} | \`${(snapshotSha || "-").slice(0, 12)}\` | ${uncertaintySec ?? "-"}s | [OK] locked |`);
      } else {
        errorCount++;
        log(`lockdown ${displayKey}`, { ok: false, note: `permission after=${permAfter}, expected read` });
        rows.push(`| ${displayKey} | \`${(snapshotSha || "-").slice(0, 12)}\` | ${uncertaintySec ?? "-"}s | perm=${permAfter} |`);
      }
    } catch (e) {
      log(`lockdown ${login || rec.team_slug}`, { ok: false, note: e.message });
      errorCount++;
      rows.push(`| ${login} | - | - | exception |`);
    }
  }

  // 5. Write lockdown record
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
    locked_count: lockedCount,
    error_count: errorCount,
    // Students left alone because a granted extension is still running. They
    // carry `deferred_until` in `results`; find-finalizable.mjs re-queues the
    // assignment once that instant passes.
    deferred_count: deferredCount,
    max_uncertainty_seconds: maxUncertainty,
    results: lockdownResults,
  };
  await writeFile(join(lockdownDir, "lockdown-record.json"), JSON.stringify(lockdownRecord, null, 2) + "\n");

  // 6. Outputs & summary
  // A deferral is neither a lock nor an error: the student was granted more
  // time and the system honoured it. Counting it as either would paint the
  // nightly amber for doing the right thing.
  const outcome = errorCount === 0 ? "locked" : lockedCount > 0 ? "partial" : "fail:all-errors";
  await setOutput("locked_count", lockedCount);
  await setOutput("error_count", errorCount);
  await setOutput("deferred_count", deferredCount);
  await setOutput("uncertainty_seconds", maxUncertainty);
  await setOutput("outcome", outcome);
  await summary(
    `### Lockdown: \`${outcome}\`\n\n` +
    `| student | SHA | uncertainty | status |\n|---|---|---|---|\n` +
    rows.join("\n") + "\n\n" +
    `**${lockedCount}** locked, **${errorCount}** errors` +
    (deferredCount ? `, **${deferredCount}** deferred (extension still running)` : "") +
    `. Max uncertainty: **${maxUncertainty}s**.\n`
  );
  log("done", { ok: errorCount === 0, note: `${outcome} (${lockedCount} locked, ${deferredCount} deferred, ${errorCount} err, ${maxUncertainty}s max uncertainty)` });
  process.exit(outcome.startsWith("fail:") ? 1 : 0);
}

main().catch(async (e) => { await fail("fail:exception", e.message); });
