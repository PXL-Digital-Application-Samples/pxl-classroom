#!/usr/bin/env node
// Which student repositories exist in this organization with no record?
//
// The nightly's answer to lib/unrecorded-repos.mjs: list the organization,
// take the repositories an assignment's name pattern produces that no
// repository record or team manifest names, and keep the ones GitHub says were
// generated from that assignment's template. REPORT ONLY - it writes nothing
// to the control repo; the workflow posts what it prints as a notice and the
// lecturer presses Retry.
//
//   node scripts/find-unrecorded-repos.mjs <control-dir> <org>
//
// Env: GITHUB_TOKEN  - installation token that can read every repository's
//                      metadata in the organization
//      GITHUB_OUTPUT - `count`, `details`, `dedup`
//
// Exits 0 whatever it finds or fails to read: it is advisory, and it must not
// fail the collect leg it runs in. A listing that could not be read is said
// out loud and reported as NOT CHECKED, never as "none".

import { appendFile, readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { gh, ghAll } from "../lib/gh.mjs";
import { loadYaml } from "../lib/yaml.mjs";
import { ASSIGNMENTS_DIR, assignmentIdFromFile, repositoriesDir, teamsDir } from "../lib/control-layout.mjs";
import { copiedFrom, emptyLeftover, generatedFrom, lastPageFromLink, loginFromRepoName, splitByOpening, unrecordedCandidates, unrecordedNoticeLine } from "../lib/unrecorded-repos.mjs";
import { repoTouched } from "../lib/untouched-repo.mjs";
import { APP_SLUG } from "../lib/deployment.mjs";

/**
 * A repository's root commit on its default branch: the last page of its
 * commits at one per page. Null when it could not be read.
 */
async function rootCommit(owner, repo) {
  const first = await gh("GET", `/repos/${owner}/${repo}/commits?per_page=1`);
  if (!first.ok || !Array.isArray(first.data)) return null;
  const last = lastPageFromLink(first.headers?.get?.("link"));
  if (last === null) return first.data[0]?.sha ?? null;
  const page = await gh("GET", `/repos/${owner}/${repo}/commits?per_page=1&page=${last}`);
  return page.ok && Array.isArray(page.data) ? page.data[0]?.sha ?? null : null;
}

// One GET per candidate. A candidate is rare once repositories made before
// their assignment opened are left out (`splitByOpening`), so a cap this size
// is never the reason something goes unreported in practice - and when it is,
// it says so, and the oldest are the ones skipped.
const MAX_CONFIRMED = 50;

/**
 * Whether a team-shaped finding is a leftover nobody can open with nothing in
 * it (lib/unrecorded-repos.mjs `emptyLeftover`). Three reads; any that fails
 * keeps it reported.
 */
async function isEmptyLeftover(org, repo) {
  const get = (path) => gh("GET", path);
  const [collaborators, invitations] = await Promise.all([
    get(`/repos/${org}/${repo}/collaborators?affiliation=direct&per_page=1`),
    get(`/repos/${org}/${repo}/invitations?per_page=1`),
  ]);
  if (!emptyLeftover({ collaborators, invitations, touched: "untouched" })) return false;
  const touched = await repoTouched(get, `${org}/${repo}`, { appLogin: `${APP_SLUG}[bot]` }).catch(() => "unknown");
  return emptyLeftover({ collaborators, invitations, touched });
}

async function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  const text = String(value);
  if (!text.includes("\n")) return appendFile(file, `${name}=${text}\n`);
  const delimiter = `PXL_${createHash("sha256").update(text).digest("hex").slice(0, 16)}`;
  await appendFile(file, `${name}<<${delimiter}\n${text}\n${delimiter}\n`);
}

async function jsonFilesIn(dir) {
  const names = await readdir(dir).catch(() => []);
  const out = [];
  for (const name of names.filter((n) => n.endsWith(".json"))) {
    try {
      out.push(JSON.parse(await readFile(join(dir, name), "utf8")));
    } catch {
      // An unreadable record names nothing. Its repository is then a candidate,
      // which is the honest direction: it is reported, not silently trusted.
    }
  }
  return out;
}

async function main() {
  const [dataDir, org] = process.argv.slice(2);
  if (!dataDir || !org) {
    console.log("usage: find-unrecorded-repos.mjs <control-dir> <org>");
    await setOutput("count", 0);
    return;
  }

  const assignments = [];
  for (const file of await readdir(join(dataDir, ASSIGNMENTS_DIR)).catch(() => [])) {
    const id = assignmentIdFromFile(file);
    if (!id) continue;
    try {
      assignments.push({ ...(await loadYaml(join(dataDir, ASSIGNMENTS_DIR, file))), id });
    } catch {
      // An assignment that does not parse produces no pattern to match.
    }
  }

  const recorded = new Map();
  // Assignments that ever copied a template with its history: the setting, or
  // a record saying so (TA-7). Turned off later, the setting alone left a copy
  // made while it was on - whose record was lost - found by nothing.
  const everCopied = new Set();
  for (const a of assignments) {
    const records = await jsonFilesIn(join(dataDir, repositoriesDir(a.id)));
    const names = [...records, ...(await jsonFilesIn(join(dataDir, teamsDir(a.id))))].map((doc) => doc?.repo_name).filter(Boolean);
    recorded.set(a.id, names);
    if (a.template_full_history === true || records.some((r) => r?.full_history === true)) everCopied.add(a.id);
  }

  let repos;
  try {
    repos = await ghAll(`/orgs/${org}/repos?per_page=100&type=all`);
  } catch (e) {
    console.log(`::warning::Unrecorded-repository check DID NOT RUN for ${org}: the repository listing could not be read (${e.message}).`);
    await setOutput("count", 0);
    return;
  }

  const byId = new Map(assignments.map((a) => [a.id, a]));
  const createdAt = new Map(repos.filter((r) => r?.name).map((r) => [String(r.name).toLowerCase(), r.created_at]));
  const { current: candidates, older } = splitByOpening(
    unrecordedCandidates({ assignments, recorded, repoNames: repos.map((r) => r?.name) }),
    byId,
    createdAt,
  );
  const found = [];
  const leftovers = [];
  let unconfirmed = 0;
  // A template's root commit, read once per template (null: unread).
  const templateRoots = new Map();
  for (const c of candidates.slice(0, MAX_CONFIRMED)) {
    const a = byId.get(c.assignment_id);
    let verdict = generatedFrom(await gh("GET", `/repos/${org}/${c.repo}`), a?.template);
    // A full-history copy is pushed, so it names no template: asked by its
    // root commit instead (lib/unrecorded-repos.mjs `copiedFrom`).
    if (verdict === false && everCopied.has(c.assignment_id) && a?.template?.owner && a?.template?.repository) {
      const key = `${a.template.owner}/${a.template.repository}`;
      if (!templateRoots.has(key)) templateRoots.set(key, await rootCommit(a.template.owner, a.template.repository));
      verdict = copiedFrom(await rootCommit(org, c.repo), templateRoots.get(key));
    }
    if (verdict === true) {
      const login = loginFromRepoName(a.repository_name_pattern, c.repo);
      // A team-shaped name names no student; empty and closed to everybody,
      // it is a team's leftover, not a student off the list.
      if (!login && (await isEmptyLeftover(org, c.repo))) leftovers.push(c);
      else found.push({ ...c, login });
    } else if (verdict === null) unconfirmed++;
  }
  const skipped = Math.max(0, candidates.length - MAX_CONFIRMED);

  console.log(`${org}: ${repos.length} repositories, ${candidates.length} without a record by name made since their assignment opened (${older.length} older), ${found.length} generated from their assignment's template.`);
  if (unconfirmed) console.log(`${unconfirmed} candidate(s) could not be read and are not reported.`);
  if (leftovers.length) {
    console.log(`::notice::${leftovers.length} empty repositor${leftovers.length === 1 ? "y" : "ies"} in ${org} that nobody can open and nobody wrote in - left by a team everybody left. Not reported; safe to delete: ${leftovers.map((l) => l.repo).join(", ")}`);
  }
  if (skipped) console.log(`::warning::${skipped} more candidate(s) in ${org} were not looked at (limit ${MAX_CONFIRMED}).`);
  for (const f of found) console.log(`  ${f.assignment_id}: ${org}/${f.repo}${f.login ? ` (${f.login})` : ""}`);

  await setOutput("count", found.length);
  if (found.length === 0) return;

  // One line each, in the format the Organization page reads back to put a
  // Retry and the right advice beside it (lib/unrecorded-repos.mjs).
  const lines = found.map((f) => unrecordedNoticeLine(f));
  await setOutput(
    "details",
    `${found.length === 1 ? "A student repository exists" : `${found.length} student repositories exist`} that PXL Classroom has no record of. ` +
      `The student can work in it, but is missing from the student list and would be left out at the deadline.\n\n` +
      `${lines.join("\n")}\n\n` +
      `On the **Organization** page of PXL Classroom, **Retry** beside each one adds the student and keeps the repository and the work in it.`,
  );
  await setOutput("dedup", `unrecorded-${createHash("sha256").update(found.map((f) => f.repo.toLowerCase()).sort().join("\n")).digest("hex").slice(0, 16)}`);
}

main().catch(async (e) => {
  console.log(`::warning::Unrecorded-repository check DID NOT RUN: ${e.message}`);
  await setOutput("count", 0);
});
