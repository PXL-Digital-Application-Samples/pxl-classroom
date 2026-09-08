#!/usr/bin/env node
// PXL Classroom - move a cohort's deadline lock from per-repository rulesets to
// one organization ruleset.
//
// ORDER IS THE SAFETY PROPERTY, and it is create-then-delete:
//
//   1. read the lockdown record and take the repository ids it locked
//   2. create the ORGANIZATION ruleset, active
//   3. VERIFY it reads back active over those ids
//   4. only then disable the per-repository rulesets
//
// Never the reverse. Deleting first leaves a window with no lock on a cohort
// whose deadline has passed, and the whole point of the exercise is a lock a
// student cannot reach. Same rule publish-assignment.yml follows with the
// broker secret: push the new workflow BEFORE removing the old credential.
//
// The per-repository rulesets are DISABLED, never deleted, exactly as
// lib/repo-unlock.mjs disables rather than deletes: a ruleset re-created later
// without the App in `bypass_actors` locks this system out of the repository
// along with the student, and `enforcement` is a flag that can be flipped back.
//
// --dry-run reports what it would do and writes nothing, anywhere.

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { gh } from "../lib/gh.mjs";
import {
  ensureOrgSubmissionLock,
  findOrgSubmissionLock,
  targetedRepositoryIds,
  releaseSubmissionLock,
  resolveAppId,
} from "../lib/submission-lock.mjs";
import { loadYaml } from "../lib/yaml.mjs";
import { assignmentPath, lockdownRecordPath } from "../lib/control-layout.mjs";

const env = (k, d) => process.env[k] ?? d;
const cfg = {
  org: env("ORG"),
  dataDir: env("DATA_DIR", "control"),
  assignmentId: env("ASSIGNMENT_ID", ""),
  dryRun: env("DRY_RUN", "1") !== "0",
};

const log = (ok, step, note) => console.log(`[${ok ? "ok" : "FAIL"}] ${step}${note ? ` - ${note}` : ""}`);

/** Assignments with a lockdown record, or the single one that was asked for. */
async function assignmentsToConsider() {
  if (cfg.assignmentId) return [cfg.assignmentId];
  try {
    const dirs = await readdir(join(cfg.dataDir, "lockdowns"), { withFileTypes: true });
    return dirs.filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; }
}

async function migrateOne(assignmentId, appId) {
  const record = await readJson(join(cfg.dataDir, lockdownRecordPath(assignmentId)));
  if (!record) return log(true, assignmentId, "no lockdown record - nothing has been locked");

  const rows = Array.isArray(record.results) ? record.results : [];
  // Only rows an actual repository ruleset holds. A demotion has a different
  // inverse and moving it would silently change what the student lost;
  // `org-ruleset` rows are already migrated.
  const locked = rows.filter((r) => r.lock_method === "ruleset" && Number.isInteger(r.repo_id));
  if (locked.length === 0) {
    const methods = [...new Set(rows.map((r) => r.lock_method ?? "none"))].join(", ") || "none";
    return log(true, assignmentId, `no repository-ruleset rows to migrate (methods: ${methods})`);
  }

  // One row per LOGIN over a shared repository, so a five-person team appears
  // five times and must be locked once.
  const ids = [...new Set(locked.map((r) => r.repo_id))];
  const repos = [...new Set(locked.map((r) => r.repo_name).filter(Boolean))];

  const assignment = await loadYaml(join(cfg.dataDir, assignmentPath(assignmentId))).catch(() => null);
  const submissionRef = assignment?.submission_ref || "refs/heads/main";

  if (cfg.dryRun) {
    return log(true, assignmentId,
      `DRY RUN - would cover ${ids.length} repositor${ids.length === 1 ? "y" : "ies"} on ${submissionRef} ` +
      `and then disable ${repos.length} repository ruleset(s)`);
  }

  // 2. Create the organization ruleset, ACTIVE.
  const made = await ensureOrgSubmissionLock(gh, {
    org: cfg.org, assignmentId, submissionRef, appId, repositoryIds: ids, enforcement: "active",
  });
  if (!made.ok) return log(false, assignmentId, `${made.reason} - nothing was changed`);
  if (made.dropped?.length) {
    log(true, assignmentId, `${made.dropped.length} repositor${made.dropped.length === 1 ? "y" : "ies"} no longer exist and were dropped`);
  }

  // 3. VERIFY before removing anything. `ensureOrgSubmissionLock` already reads
  //    the result back, but this is the step that licenses a delete, so it is
  //    re-read from GitHub rather than inferred from the call that made it.
  const check = await findOrgSubmissionLock(gh, { org: cfg.org, assignmentId });
  const covered = check.ok && check.ruleset ? targetedRepositoryIds(check.ruleset) : [];
  const active = check.ok && check.ruleset?.enforcement === "active";
  const missing = ids.filter((id) => !covered.includes(id) && !(made.dropped ?? []).includes(id));
  if (!active || missing.length) {
    return log(false, assignmentId,
      `the organization ruleset does not hold this cohort yet (active=${active}, ${missing.length} uncovered) - ` +
      `the repository rulesets were LEFT IN PLACE`);
  }
  log(true, assignmentId, `organization ruleset ${check.ruleset.id} active over ${covered.length} repositor${covered.length === 1 ? "y" : "ies"}`);

  // 4. Only now, and disabled rather than deleted.
  let released = 0;
  for (const full of repos) {
    const [, name] = String(full).split("/");
    if (!name) continue;
    const res = await releaseSubmissionLock(gh, { org: cfg.org, repo: name });
    if (res.ok) { released++; continue; }
    // `absent` is fine: the student may have deleted it, which is the hole this
    // migration exists to close.
    if (res.action === "absent") continue;
    log(false, `${assignmentId}/${name}`, `could not disable the repository ruleset: ${res.reason}`);
  }
  log(true, assignmentId, `disabled ${released} repository ruleset(s); the organization one is now the lock`);
}

async function main() {
  if (!cfg.org) { console.error("ORG is required"); process.exit(1); }
  if (!process.env.GITHUB_TOKEN) { console.error("GITHUB_TOKEN is required"); process.exit(1); }

  // DRY RUN IS SACRED, and that means no calls at all - not "no writes". The
  // App id is only needed to build a ruleset, so resolving it up front would
  // make a report-only run depend on the network and fail where there is none.
  let appId = null;
  if (!cfg.dryRun) {
    appId = await resolveAppId(gh, { appId: process.env.PXL_APP_ID });
    if (!appId) {
      console.error("could not resolve the App id - a ruleset the App cannot bypass would lock the system out");
      process.exit(1);
    }
  }

  const ids = await assignmentsToConsider();
  if (ids.length === 0) return log(true, cfg.org, "no lockdown records - nothing to migrate");
  console.log(`${cfg.dryRun ? "DRY RUN: " : ""}${cfg.org}: considering ${ids.length} assignment(s)\n`);
  for (const id of ids) await migrateOne(id, appId);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
