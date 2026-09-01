#!/usr/bin/env node
// PXL Classroom - smart starter code synchronization.
//
// Copies the changes from ONE template commit into student repositories:
// straight onto `main` for every file the student has not touched, and onto a
// `starter-update-<ts>` branch with a pull request for the ones they have.
//
// It copies content and never merges history - see lib/starter-sync.mjs for
// what the merge-based implementation this replaced actually did to a
// repository created from a template, and which half of it was a 404.

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { gh, ghAll } from "../lib/gh.mjs";
import { loadYaml } from "../lib/yaml.mjs";
import { commitWithRebase } from "../lib/gittree.mjs";
import { validateAgainst } from "../lib/validate.mjs";
import {
  changedPaths,
  resolveSelection,
  planStarterSync,
  outcomeFor,
  summarize,
  syncMarker,
  findExistingSyncPr,
} from "../lib/starter-sync.mjs";

const env = (k, d) => process.env[k] ?? d;
const cfg = {
  token: env("GITHUB_TOKEN"),
  org: env("ORG"),
  assignmentId: env("ASSIGNMENT_ID"),
  dataDir: env("DATA_DIR", "."),
  selectedFiles: env("SELECTED_FILES", '["*"]'),
  prTitle: env("PR_TITLE", ""),
  prBody: env("PR_BODY", ""),
  createIssue: env("CREATE_ISSUE", "true") === "true",
  actor: env("ACTOR", "lecturer"),
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function generateSyncId() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const ts = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
  const rand = Math.random().toString(36).slice(2, 8);
  return `sync-${ts}-${rand}`;
}

// path -> blob sha for every file in a tree. `?recursive=1` is one request for
// the whole repository instead of one per directory, and the blob shas are all
// the comparison needs - no file content is fetched for any student.
async function readTree(repoFullName, ref) {
  const res = await gh("GET", `/repos/${repoFullName}/git/trees/${ref}?recursive=1`, null, { token: cfg.token });
  if (!res.ok) throw new Error(`could not read tree ${repoFullName}@${ref.slice(0, 7)} (HTTP ${res.status})`);
  // A tree over 100k entries comes back truncated. Saying so beats treating a
  // partial listing as the repository: every unlisted path would look absent,
  // which reads as "the student deleted it" and would restore files nobody
  // touched.
  if (res.data?.truncated) throw new Error(`tree listing for ${repoFullName} was truncated - too many files to sync safely`);
  const map = new Map();
  for (const entry of res.data?.tree || []) {
    if (entry.type === "blob") map.set(entry.path, entry.sha);
  }
  return map;
}

async function main() {
  if (!cfg.token) throw new Error("GITHUB_TOKEN is required");
  if (!cfg.org) throw new Error("ORG is required");
  if (!cfg.assignmentId) throw new Error("ASSIGNMENT_ID is required");

  let requestedFiles = ["*"];
  try {
    const parsed = JSON.parse(cfg.selectedFiles);
    if (Array.isArray(parsed) && parsed.length > 0) requestedFiles = parsed;
  } catch {
    requestedFiles = ["*"];
  }

  // 1. Read assignment YAML.
  //
  // `loadYaml` takes a PATH and is async. This passed it the file's text and
  // did not await it, so `assignment` was a Promise, `assignment.template` was
  // undefined, and the script died on the line below with "Assignment has no
  // template repository configured" - for every assignment, always. Found by
  // running it: nothing had, because the workflow could not mint a token in
  // the first place.
  const asgnPath = join(cfg.dataDir, "assignments", `${cfg.assignmentId}.yml`);
  const assignment = await loadYaml(asgnPath);

  const tplOwner = assignment.template?.owner || cfg.org;
  const tplRepo = assignment.template?.repository;
  if (!tplRepo) throw new Error("Assignment has no template repository configured");

  const templateFullName = `${tplOwner}/${tplRepo}`;
  console.log(`[sync] Template repository: ${templateFullName}`);

  // 2. The commit being synced, and the one before it.
  const tplCommits = await gh("GET", `/repos/${templateFullName}/commits?per_page=1`, null, { token: cfg.token });
  if (!tplCommits.ok || !tplCommits.data?.[0]) {
    throw new Error(`Could not fetch commits from template ${templateFullName} (HTTP ${tplCommits.status})`);
  }

  const templateSha = tplCommits.data[0].sha;
  const detail = await gh("GET", `/repos/${templateFullName}/commits/${templateSha}`, null, { token: cfg.token });
  if (!detail.ok) throw new Error(`Could not read template commit ${templateSha.slice(0, 7)} (HTTP ${detail.status})`);

  const commitMsgTitle = (detail.data.commit?.message || "").split("\n")[0] || "Update starter code";
  const parentSha = detail.data.parents?.[0]?.sha || null;
  console.log(`[sync] Target template commit: ${templateSha.slice(0, 7)} - "${commitMsgTitle}"`);

  // GitHub returns at most 300 entries in `files`. A capped read may not
  // present itself as a whole one.
  if ((detail.data.files || []).length >= 300) {
    console.log("[warn] this commit changed more than 300 files; GitHub lists only the first 300, and only those are synced.");
  }

  const changed = changedPaths(detail.data.files);
  const paths = resolveSelection(changed, requestedFiles);
  if (paths.length === 0) {
    console.log("[sync] The selected files are not part of this commit - nothing to sync.");
  }
  console.log(`[sync] ${paths.length} of ${changed.length} changed file(s) selected.`);

  const headTree = await readTree(templateFullName, templateSha);
  // A root commit has no parent: every path in it is new, so an empty base
  // makes "the student never touched it" mean "the student does not have it".
  const baseTree = parentSha ? await readTree(templateFullName, parentSha) : new Map();

  // Content is fetched ONCE per path here, not once per student.
  const contentByPath = new Map();
  for (const path of paths) {
    const sha = headTree.get(path);
    if (!sha) continue; // deletion - nothing to fetch
    const blob = await gh("GET", `/repos/${templateFullName}/git/blobs/${sha}`, null, { token: cfg.token });
    if (!blob.ok) throw new Error(`could not read ${path} from the template (HTTP ${blob.status})`);
    // Kept as a Buffer so binary starter files (images, fixtures, archives)
    // survive; gittree base64-encodes a Buffer unchanged.
    contentByPath.set(path, Buffer.from(blob.data.content || "", blob.data.encoding || "base64"));
  }

  const syncTitle = cfg.prTitle || `Starter Code Update: ${commitMsgTitle}`;
  const syncBody = cfg.prBody || [
    "### Starter Code Update",
    "",
    `A correction from the starter template (\`${templateFullName}\`) is available.`,
    "",
    `- **Commit:** \`${templateSha.slice(0, 7)}\` - ${commitMsgTitle}`,
    "",
    "You changed these files, so they were not overwritten. Review the diff and merge when you are ready.",
  ].join("\n");

  // 3. Read student repository records
  const reposDir = join(cfg.dataDir, "repositories", cfg.assignmentId);
  let repoFiles = [];
  try {
    repoFiles = (await readdir(reposDir)).filter((f) => f.endsWith(".json"));
  } catch {
    console.log(`[sync] No repositories directory for ${cfg.assignmentId}`);
  }

  const syncId = generateSyncId();
  const results = [];

  for (const file of repoFiles) {
    // OUTSIDE the per-student try below, which is what made it fatal: one
    // unreadable repository record threw out of main(), so the run stopped
    // partway and the sync record was never written - after some students had
    // already had a commit pushed to their main and a pull request opened. The
    // one document that says which students got the correction is exactly what
    // was lost. accept.mjs guards the same file type for the same reason.
    let rec;
    try {
      rec = JSON.parse(await readFile(join(reposDir, file), "utf8"));
    } catch (err) {
      // The record is named <login>.json, so the filename still identifies the
      // student even when its contents do not.
      const named = file.replace(/\.json$/, "");
      console.log(`[fail] ${named}: repository record is unreadable - ${err.message}`);
      results.push({
        github_login: named,
        repo_name: "unknown",
        outcome: "failed",
        error: `repository record unreadable: ${err.message}`,
      });
      continue;
    }
    const login = rec.github_login;
    const teamSlug = rec.team_slug;
    const repoNameFull = rec.repo_name;
    const repoName = repoNameFull?.split("/")[1] || repoNameFull;

    if (!repoName) {
      results.push({ github_login: login, team_slug: teamSlug, repo_name: "unknown", outcome: "skipped-no-repo" });
      continue;
    }

    const studentFullName = `${cfg.org}/${repoName}`;
    const row = { github_login: login, repo_name: studentFullName };
    if (teamSlug) row.team_slug = teamSlug;

    try {
      const studentTree = await readTree(studentFullName, "main");
      const plan = planStarterSync({ headTree, baseTree, studentTree, paths });
      const outcome = outcomeFor(plan);
      row.outcome = outcome;
      row.files_merged = plan.clean.length;
      row.files_conflicted = plan.conflicts.length;

      if (outcome === "skipped-up-to-date") {
        console.log(`[skip] ${login}: already has every selected change`);
        results.push(row);
        await sleep(200);
        continue;
      }

      const toChanges = (entries) =>
        entries.map(({ path, action }) => ({
          path,
          content: action === "delete" ? null : contentByPath.get(path),
        }));

      // 3a. Files the student never touched go straight onto main.
      if (plan.clean.length > 0) {
        const commit = await commitWithRebase({
          token: cfg.token,
          owner: cfg.org,
          repo: repoName,
          branch: "main",
          message: `Update starter code from template: ${commitMsgTitle}`,
          changes: toChanges(plan.clean),
        });
        row.commit_sha = commit.commitSha;
        console.log(`[auto-merged] ${login}: ${plan.clean.length} file(s) -> ${commit.commitSha.slice(0, 7)}`);
      }

      // 3b. Files they did touch go onto a branch off THEIR OWN main, so no
      //     foreign SHA is ever involved, and are offered as a pull request.
      if (plan.conflicts.length > 0) {
        // Adopt the pull request a previous run of this same sync already
        // opened. Re-running is the first thing a lecturer does when a sync
        // looks like it did nothing, and without this each run adds another.
        const openPulls = await ghAll(`/repos/${studentFullName}/pulls?state=open&per_page=100`, { token: cfg.token });
        const existing = findExistingSyncPr(openPulls, templateSha);
        if (existing) {
          row.pr_number = existing.number;
          row.pr_url = existing.html_url;
          console.log(`[pr-exists] ${login}: #${existing.number} already open for this update`);
          results.push(row);
          await sleep(300);
          continue;
        }

        const branchName = `starter-update-${Date.now().toString(36)}`;
        const head = await gh("GET", `/repos/${studentFullName}/git/ref/heads/main`, null, { token: cfg.token });
        if (!head.ok) throw new Error(`could not read main (HTTP ${head.status})`);

        const ref = await gh("POST", `/repos/${studentFullName}/git/refs`, {
          ref: `refs/heads/${branchName}`,
          sha: head.data.object.sha,
        }, { token: cfg.token });
        if (!ref.ok) throw new Error(`could not create ${branchName} (HTTP ${ref.status})`);

        await commitWithRebase({
          token: cfg.token,
          owner: cfg.org,
          repo: repoName,
          branch: branchName,
          message: `Starter code update: ${commitMsgTitle}`,
          changes: toChanges(plan.conflicts),
        });

        const prRes = await gh("POST", `/repos/${studentFullName}/pulls`, {
          title: syncTitle,
          body: `${syncBody}\n\n> Files in this pull request: ${plan.conflicts.map((c) => `\`${c.path}\``).join(", ")}\n\n${syncMarker(templateSha)}`,
          head: branchName,
          base: "main",
        }, { token: cfg.token });
        if (!prRes.ok) throw new Error(`could not open the sync PR (HTTP ${prRes.status}): ${prRes.data?.message || ""}`);

        row.pr_number = prRes.data.number;
        row.pr_url = prRes.data.html_url;
        console.log(`[pr-opened] ${login}: #${prRes.data.number} for ${plan.conflicts.length} file(s) (${prRes.data.html_url})`);
      }

      if (cfg.createIssue) {
        const body = plan.conflicts.length
          ? `A starter code update is available in Pull Request [#${row.pr_number}](${row.pr_url}). Please review and merge it.`
          : "The starter code in this repository was updated with the latest template changes.\n\nRun `git pull` in your workspace to get them.";
        const issueRes = await gh("POST", `/repos/${studentFullName}/issues`, {
          title: plan.conflicts.length
            ? `[Action Required] Starter Code Update Available in PR #${row.pr_number}`
            : `[Notice] Starter Code Updated: ${commitMsgTitle}`,
          body,
        }, { token: cfg.token });
        if (issueRes.ok) {
          row.issue_number = issueRes.data.number;
          row.issue_url = issueRes.data.html_url;
        } else {
          // The issue IS the notification - without it a student is not told a
          // pull request is waiting for them. Failing it silently left the row
          // reading like a clean sync with no issue number, and the record is
          // what a lecturer reads to see who still needs a second look.
          row.issue_error = `HTTP ${issueRes.status}${issueRes.data?.message ? `: ${issueRes.data.message}` : ""}`;
          console.log(`[warn] ${login}: the notification issue could not be created (${row.issue_error}) - they have not been told`);
        }
      }

      results.push(row);
    } catch (err) {
      console.log(`[fail] ${login}: ${err.message}`);
      results.push({ ...row, outcome: "failed", error: err.message });
    }

    // Rate-limit throttle
    await sleep(300);
  }

  // 4. Write sync record
  const syncRecord = {
    schema_version: 1,
    sync_id: syncId,
    assignment_id: cfg.assignmentId,
    synced_at: new Date().toISOString(),
    synced_by: cfg.actor,
    template_repo: templateFullName,
    template_sha: templateSha,
    ...(parentSha ? { template_base_sha: parentSha } : {}),
    // The paths actually applied, not the raw request. `["*"]` used to be
    // recorded verbatim while the operation merged the whole template tree
    // regardless of what was ticked.
    selected_files: paths,
    pr_title: syncTitle,
    pr_body: syncBody,
    created_issues: cfg.createIssue,
    summary: summarize(results),
    results,
  };

  // Validate before writing. The sync record is what a lecturer reads to see
  // which students got the correction and which need a second look, so a
  // document the backend cannot read back is worse than no record.
  {
    const { valid, errors } = validateAgainst("sync-record", syncRecord);
    if (!valid) {
      throw new Error(
        "sync record does not match sync-record.schema.json: " +
          errors.slice(0, 4).map((e) => `${e.instancePath || "/"} ${e.message}`).join("; ")
      );
    }
  }

  const syncDir = join(cfg.dataDir, "syncs", cfg.assignmentId);
  await mkdir(syncDir, { recursive: true });
  await writeFile(join(syncDir, `${syncId}.json`), JSON.stringify(syncRecord, null, 2) + "\n");

  const s = syncRecord.summary;
  console.log(`\nSync complete (${syncId}): ${s.auto_merged} updated in place, ${s.pr_opened} pull request(s), ${s.skipped} skipped, ${s.failed} failed.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
