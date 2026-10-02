#!/usr/bin/env node
// Acceptance attempts from the last day that got no answer - for the lecturer.
//
// Runs in the nightly's collect job beside find-unrecorded-repos.mjs, against
// the org's control-repo checkout. For each assignment still accepting, or
// closed today, it reads the broker's recent issues and asks
// lib/unanswered-attempts.mjs which got neither a label nor a recorded
// decision. REPORT ONLY, and advisory: every failure here says the check did
// not run and never fails the leg.
//
// Usage: find-unanswered-attempts.mjs <control-dir> <org>
// Outputs via GITHUB_OUTPUT: count, details, dedup

import { appendFile, readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { ghAll } from "../lib/gh.mjs";
import { loadYaml } from "../lib/yaml.mjs";
import { ASSIGNMENTS_DIR, acceptancesDir, assignmentIdFromFile } from "../lib/control-layout.mjs";
import { brokerRepoName } from "../lib/broker-repo.mjs";
import { UNANSWERED_WINDOW_MS, unansweredAttempts } from "../lib/unanswered-attempts.mjs";

async function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  const text = String(value);
  if (!text.includes("\n")) return appendFile(file, `${name}=${text}\n`);
  const delimiter = `PXL_${createHash("sha256").update(text).digest("hex").slice(0, 16)}`;
  await appendFile(file, `${name}<<${delimiter}\n${text}\n${delimiter}\n`);
}

/** Acceptance records for one assignment, keyed by lowercased login. */
async function acceptancesOf(dataDir, id) {
  const dir = join(dataDir, acceptancesDir(id));
  const map = new Map();
  for (const name of await readdir(dir).catch(() => [])) {
    if (!name.endsWith(".json")) continue;
    try {
      map.set(name.slice(0, -5).toLowerCase(), JSON.parse(await readFile(join(dir, name), "utf8")));
    } catch {
      // An unreadable record still says somebody decided something.
      map.set(name.slice(0, -5).toLowerCase(), {});
    }
  }
  return map;
}

// Where it stopped, in words a lecturer reads - never this file's stage names.
const STAGE_WORDS = {
  "not-started": "GitHub never started processing it",
  "not-delivered": "it could not be passed on to be processed",
  "no-answer": "it was passed on, but never processed",
  "not-finished": "it was accepted, but setting up the repository never finished",
};

async function main() {
  const [dataDir, org] = process.argv.slice(2);
  if (!dataDir || !org) {
    console.log("usage: find-unanswered-attempts.mjs <control-dir> <org>");
    await setOutput("count", 0);
    return;
  }

  const now = new Date();
  const since = new Date(now.getTime() - UNANSWERED_WINDOW_MS).toISOString();
  const found = [];
  let unread = 0;

  for (const file of await readdir(join(dataDir, ASSIGNMENTS_DIR)).catch(() => [])) {
    const id = assignmentIdFromFile(file);
    if (!id) continue;
    let assignment;
    try {
      assignment = { ...(await loadYaml(join(dataDir, ASSIGNMENTS_DIR, file))), id };
    } catch {
      continue;
    }
    if (assignment.state !== "published" && assignment.state !== "closed") continue;
    const broker = brokerRepoName({ assignment });
    if (!broker) continue;

    let issues;
    try {
      // `since` filters on the last UPDATE, which is never earlier than the
      // creation - so nothing created in the window is missed.
      issues = await ghAll(`/repos/${org}/${broker}/issues?state=all&since=${encodeURIComponent(since)}&per_page=100`);
    } catch (e) {
      console.log(`::warning::Could not read the attempts on ${org}/${broker} (${e.message}); not checked.`);
      unread++;
      continue;
    }
    const records = await acceptancesOf(dataDir, id);
    for (const a of unansweredAttempts({
      issues: issues.filter((i) => !i.pull_request),
      acceptanceOf: (login) => records.get(String(login).toLowerCase()) ?? null,
      now,
    })) {
      found.push({ ...a, assignment_id: id, broker, group: assignment.assignment_type === "group" });
    }
  }

  console.log(`${org}: ${found.length} unanswered acceptance attempt(s) in the last day.${unread ? ` ${unread} broker(s) could not be read.` : ""}`);
  for (const f of found) console.log(`  ${f.assignment_id}: @${f.login} ${org}/${f.broker}#${f.number} (${f.stage})`);

  await setOutput("count", found.length);
  if (found.length === 0) return;

  const lines = found.map((f) => {
    const when = f.created_at.slice(0, 16).replace("T", " ");
    const fix = f.group
      ? "ask them to open their invitation link and join their team again"
      : "press **Retry** for them on the assignment page, or ask them to open their invitation link again";
    return `- \`${f.login}\` tried to accept \`${f.assignment_id}\` at ${when} UTC, and ${STAGE_WORDS[f.stage]}. To fix: ${fix}.`;
  });
  await setOutput(
    "details",
    `${found.length === 1 ? "A student's acceptance" : `${found.length} acceptances`} got no answer, usually because GitHub had a problem at the time. ` +
      `Whatever ${found.length === 1 ? "it" : "each"} asked for - a repository, or a place in a team - did not happen.\n\n${lines.join("\n")}`,
  );
  await setOutput(
    "dedup",
    `unanswered-${createHash("sha256").update(found.map((f) => `${f.broker}#${f.number}`).sort().join("\n")).digest("hex").slice(0, 16)}`,
  );
}

main().catch(async (e) => {
  console.log(`::warning::Unanswered-attempt check DID NOT RUN: ${e.message}`);
  await setOutput("count", 0);
});
