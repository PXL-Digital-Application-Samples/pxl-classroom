#!/usr/bin/env node
// A STOP THE MOVED DEADLINE NO LONGER WANTS (review 2026-10-16, R7-1).
//
// The Deadline Sentinel stops the cohort at the instant and dispatches the
// finalize, which writes the lock record. A lecturer who moves the deadline
// later in between saves, and the save publishes - but the finalize's queue
// reads the moved deadline and no longer queues anything, so nothing ever lets
// go of the stop: the whole cohort is refused every push until the new
// deadline, with no lock record, so Reopen refuses too.
//
// Run by publish-assignment.yml, which every save that moves a passed deadline
// into the future dispatches (lib/publish.js `saveReopens`), so it is retried
// by Republish and needs no new trigger. Two steps, so the release token is
// minted only when there is something to release:
//
//   check    reads the checkout: the deadline is ahead, there is no lock
//            record, and a sentinel fired. Writes `stale=true|false`.
//   release  every repository the records name, through lib/stop-release.mjs
//            (lockdown's own release for a student it defers). Exits 1 when a
//            stop could not be let go, so the publish says so.
//
// A lock record is NOT this script's: a cohort the finalize locked is
// reopened student by student (Reopen), and the editor says who stays locked.
//
// Env: ORG, ASSIGNMENT_ID, DATA_DIR (the control checkout), GITHUB_TOKEN
// (release), GITHUB_OUTPUT (check), GITHUB_STEP_SUMMARY.

import { existsSync } from "node:fs";
import { appendFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseYaml } from "../lib/yaml.mjs";
import { gh } from "../lib/gh.mjs";
import { assignmentPathsRead, lockdownRecordPath, lockdownsDir } from "../lib/control-layout.mjs";
import { deadlineAhead } from "../lib/assignment-now.mjs";
import { sentinelMayHaveStopped } from "../lib/sentinel-window.mjs";
import { readSentinelTimelines } from "../lib/sentinel-timelines.mjs";
import { orgStopIds, releaseStop } from "../lib/stop-release.mjs";
import { normalizeLogin } from "../lib/github-login.mjs";

/**
 * Whether a stop is left over from an instant that is no longer the deadline.
 *
 * @param {object} p
 * @param {any} p.assignment the document as committed
 * @param {boolean} p.lockRecordExists
 * @param {any[]} p.timelines lockdowns/<id>/sentinel-*.json
 * @param {number} [p.now]
 * @returns {{stale: boolean, why: string}}
 */
export function staleStop({ assignment, lockRecordExists, timelines, now = Date.now() }) {
  if (!deadlineAhead(assignment, now)) return { stale: false, why: "the deadline is not ahead" };
  if (lockRecordExists) return { stale: false, why: "the cohort was locked; Reopen gives a student more time" };
  if (!sentinelMayHaveStopped(timelines)) return { stale: false, why: "no sentinel stopped this assignment" };
  return { stale: true, why: `a sentinel stopped writes, and the deadline is now ${assignment.deadline_at}` };
}

/**
 * The repositories the records name, one entry per repository with every
 * login whose record names it (a team's members), read from the checkout.
 *
 * @returns {Promise<Array<{repo: string, repositoryId: number|null, members: string[]}>>}
 */
export async function recordedRepositories(dataDir, assignmentId) {
  const dir = join(dataDir, "repositories", assignmentId);
  const names = await readdir(dir).catch(() => []);
  const byRepo = new Map();
  for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
    let rec;
    try {
      rec = JSON.parse(await readFile(join(dir, name), "utf8"));
    } catch {
      console.log(`::warning::Unreadable repository record ${name} - its repository is not released.`);
      continue;
    }
    const repo = String(rec?.repo_name ?? "").split("/").pop();
    if (!repo) continue;
    const key = repo.toLowerCase();
    const entry = byRepo.get(key) ?? { repo, repositoryId: null, members: [] };
    if (Number.isInteger(rec?.repo_id)) entry.repositoryId = rec.repo_id;
    const login = normalizeLogin(rec?.github_login);
    // A team's repository is named by one record per member who accepted,
    // which is everyone with access through it.
    if (login && !entry.members.includes(login)) entry.members.push(login);
    byRepo.set(key, entry);
  }
  return [...byRepo.values()];
}

async function readCheckoutAssignment(dataDir, assignmentId) {
  for (const path of assignmentPathsRead(assignmentId)) {
    try {
      const text = await readFile(join(dataDir, path), "utf8");
      return path.endsWith(".json") ? JSON.parse(text) : parseYaml(text);
    } catch { /* the next spelling */ }
  }
  return null;
}

async function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

async function summary(text) {
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
}

export async function main(mode = process.argv[2]) {
  const org = process.env.ORG;
  const assignmentId = process.env.ASSIGNMENT_ID;
  const dataDir = process.env.DATA_DIR || ".";
  if (!org || !assignmentId || !["check", "release"].includes(mode)) {
    console.log("::error::Usage: ORG, ASSIGNMENT_ID and DATA_DIR set; node scripts/release-stale-stop.mjs check|release");
    return 1;
  }
  const assignment = await readCheckoutAssignment(dataDir, assignmentId);
  if (!assignment) {
    console.log(`::warning::Could not read ${assignmentId} - nothing is released.`);
    await setOutput("stale", "false");
    return 0;
  }
  const verdict = staleStop({
    assignment,
    lockRecordExists: existsSync(join(dataDir, lockdownRecordPath(assignmentId))),
    timelines: await readSentinelTimelines(join(dataDir, lockdownsDir(assignmentId))),
  });
  console.log(`[${verdict.stale ? "stale" : "ok"}] ${assignmentId}: ${verdict.why}`);
  if (mode === "check") {
    await setOutput("stale", verdict.stale ? "true" : "false");
    return 0;
  }
  if (!verdict.stale) return 0;

  const request = (method, path, body) => gh(method, path, body);
  const stop = await orgStopIds(request, { org, assignmentId });
  const failed = [];
  if (!stop.ok) failed.push(`the organization's stop could not be read: ${stop.reason}`);
  const permission = assignment.student_permission || "admin";
  let released = 0;
  for (const r of await recordedRepositories(dataDir, assignmentId)) {
    const steps = await releaseStop(request, {
      org, assignmentId, repo: r.repo, repositoryId: r.repositoryId, members: r.members, permission,
      orgIds: stop.ids, probeRepo: true,
    });
    for (const s of steps) {
      console.log(`${s.ok ? "[ok]" : "[fail]"} ${r.repo}: ${s.note}`);
      if (!s.ok) failed.push(`${r.repo}: ${s.note}`);
    }
    if (steps.length && steps.every((s) => s.ok)) released += 1;
  }
  await summary(`### Stop released\n\n${verdict.why}: ${released} repositor${released === 1 ? "y" : "ies"} let go` +
    (failed.length ? `, and ${failed.length} not:\n\n${failed.map((f) => `- ${f}`).join("\n")}` : "."));
  if (failed.length) {
    console.log(`::error::Published, but ${failed.length} stop(s) on ${assignmentId} could not be let go - those students still cannot push. Publish again to retry: ${failed.join("; ")}`);
    return 1;
  }
  console.log(`[ok] ${released} repositor${released === 1 ? "y" : "ies"} let go of the stop until ${assignment.deadline_at}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }, (e) => {
    console.log(`::error::Releasing the stop failed: ${e.message}`);
    process.exitCode = 1;
  });
}
