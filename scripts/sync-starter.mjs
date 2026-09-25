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
import { CONTROL_REPO } from "../lib/deployment.mjs";
import {
  changedPaths,
  outcomeFor,
  summarize,
  syncMarker,
  findExistingSyncPr,
  readTemplateCommit,
  selectionIsAll,
} from "../lib/starter-sync.mjs";
import { listTemplateCommits, planStudent, rootTreeSha, treeReader } from "../lib/starter-sync-cohort.mjs";
import { issueAssignees, loginsByRepo } from "../lib/sync-issue.mjs";
import { sameLogin } from "../lib/github-login.mjs";

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
  // Blank syncs the template's newest commit.
  templateCommit: env("TEMPLATE_COMMIT", ""),
  // How long the sync may spend on students before it stops itself and says
  // where. Under the job's 45-minute timeout with room for the final record:
  // a job the timeout kills writes nothing afterwards.
  budgetMs: Number(env("SYNC_BUDGET_MS", "")) || 38 * 60_000,
};

// Progress is recorded every FLUSH_EVERY students or FLUSH_MS, whichever first.
const FLUSH_EVERY = 20;
const FLUSH_MS = 2 * 60_000;

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

// The transport lib/starter-sync-cohort.mjs reads through: gh() already
// answers `{ ok, status, headers, data }` and never throws.
const get = (path) => gh("GET", path, null, { token: cfg.token });
// A student's own tree, read once, refusing a truncated listing like the
// template's.
const readStudentTree = treeReader(get);

// Trees are read through lib/starter-sync-cohort.mjs `treeReader`, which
// refuses a truncated listing: every unlisted path would look absent, which
// reads as "the student deleted it" and would restore files nobody touched.

/**
 * Every sync record already written for this assignment, from the checkout. A
 * record that does not parse is skipped - it can only make a student start
 * EARLIER (from their generated commit), which sends more, never less.
 */
async function readSyncRecords(dir) {
  let names = [];
  try {
    names = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    try {
      out.push(JSON.parse(await readFile(join(dir, name), "utf8")));
    } catch {
      console.log(`[warn] sync record ${name} is unreadable and is not used as a starting point`);
    }
  }
  return out;
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

  // 2. The commit being synced, and the one before it. The newest, unless the
  //    lecturer named one (lib/starter-sync.mjs `readTemplateCommit` says why).
  const chosen = readTemplateCommit(cfg.templateCommit);
  if (chosen && typeof chosen === "object") throw new Error(chosen.error);

  let requestedSha = chosen;
  if (!requestedSha) {
    const tplCommits = await gh("GET", `/repos/${templateFullName}/commits?per_page=1`, null, { token: cfg.token });
    if (!tplCommits.ok || !tplCommits.data?.[0]) {
      throw new Error(`Could not fetch commits from template ${templateFullName} (HTTP ${tplCommits.status})`);
    }
    requestedSha = tplCommits.data[0].sha;
  }

  const detail = await gh("GET", `/repos/${templateFullName}/commits/${requestedSha}`, null, { token: cfg.token });
  if (!detail.ok) {
    throw new Error(
      chosen
        ? `Template ${templateFullName} has no commit ${chosen} (HTTP ${detail.status}) - check the sha on the template's commit list`
        : `Could not read template commit ${requestedSha.slice(0, 7)} (HTTP ${detail.status})`,
    );
  }
  // The FULL sha from here on, whatever length was typed: the pull request
  // marker and the record key on it.
  const templateSha = detail.data.sha;
  if (chosen) console.log(`[sync] Syncing the named commit ${templateSha.slice(0, 7)}, not the newest.`);

  const commitMsgTitle = (detail.data.commit?.message || "").split("\n")[0] || "Update starter code";
  const parentSha = detail.data.parents?.[0]?.sha || null;
  console.log(`[sync] Target template commit: ${templateSha.slice(0, 7)} - "${commitMsgTitle}"`);

  // EACH STUDENT IS SENT WHAT THEY ARE MISSING, from the template commit they
  // are known to be at up to this one - not what this one commit changed
  // (lib/starter-sync.mjs `startingPointFor`). The commit's own file list is
  // only what the log reports as "this commit"; the plan is built from trees.
  const newest = changedPaths(detail.data.files);
  console.log(`[sync] This commit changed ${newest.length} file(s); each student is sent everything they are behind on.`);
  const allFiles = selectionIsAll(requestedFiles);
  if (!allFiles) console.log(`[sync] Selection: ${JSON.stringify(requestedFiles)}`);

  const readTemplateTree = treeReader(get);
  const headTree = await readTemplateTree(templateFullName, templateSha);

  // Where students start: sync records first (read from this checkout), then
  // the template commit whose tree their first commit carries. One listing of
  // the template's commits serves the whole cohort.
  const records = await readSyncRecords(join(cfg.dataDir, "syncs", cfg.assignmentId));
  const listed = await listTemplateCommits(get, templateFullName);
  if (!listed.ok) {
    console.log(`[warn] could not list the template's commits (HTTP ${listed.status}) - a student with no sync record starts from this commit's parent`);
  } else if (!listed.complete) {
    console.log("[warn] the template has more than 1,000 commits; an older starting point may not be found");
  }
  const templateCommits = listed.commits;

  // Content is fetched ONCE per path, when the first student needs it.
  const contentByPath = new Map();
  const contentOf = async (path) => {
    if (!contentByPath.has(path)) {
      const sha = headTree.get(path);
      const blob = await gh("GET", `/repos/${templateFullName}/git/blobs/${sha}`, null, { token: cfg.token });
      if (!blob.ok) throw new Error(`could not read ${path} from the template (HTTP ${blob.status})`);
      // Kept as a Buffer so binary starter files (images, fixtures, archives)
      // survive; gittree base64-encodes a Buffer unchanged.
      contentByPath.set(path, Buffer.from(blob.data.content || "", blob.data.encoding || "base64"));
    }
    return contentByPath.get(path);
  };
  // Every path any student was planned a change for - the record's
  // `selected_files`, which says what was applied rather than what was offered.
  const appliedPaths = new Set();

  const syncTitle = cfg.prTitle || `Starter Code Update: ${commitMsgTitle}`;
  const syncBody = cfg.prBody || [
    "### Starter Code Update",
    "",
    // "An update", not "a correction": the same sync ships a new lab each
    // week on a semester-long assignment, where nothing was wrong.
    `An update from the starter template (\`${templateFullName}\`) is available.`,
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
  // Who shares each repository, for assigning its tracking issue: a group
  // repository has a record per member. Read once, up front; a record that
  // cannot be read here fails in the loop below, where it is reported.
  const byRepo = loginsByRepo(await Promise.all(
    repoFiles.map((f) => readFile(join(reposDir, f), "utf8").then(JSON.parse).catch(() => null)),
  ));

  const syncId = generateSyncId();
  const results = [];
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const runId = Number(process.env.GITHUB_RUN_ID) || null;
  const runUrl = runId && process.env.GITHUB_REPOSITORY
    ? `${process.env.GITHUB_SERVER_URL || "https://github.com"}/${process.env.GITHUB_REPOSITORY}/actions/runs/${runId}`
    : null;

  // THE RECORD IS WRITTEN WHEN THE RUN STARTS, AS IT GOES, AND WHEN IT ENDS.
  // It used to be written once, at the end, by a later step - so a run the
  // timeout stopped left no record at all of the students it had already
  // changed, and nothing on screen could say a sync was running, had stopped,
  // or how far it got (.NET Advanced, 2026-09-25).
  const buildRecord = (status, remaining) => ({
    schema_version: 1,
    sync_id: syncId,
    assignment_id: cfg.assignmentId,
    synced_at: startedAt,
    synced_by: cfg.actor,
    status,
    ...(runId ? { run_id: runId } : {}),
    ...(runUrl ? { run_url: runUrl } : {}),
    started_at: startedAt,
    ...(status === "running" ? {} : { finished_at: new Date().toISOString() }),
    total_students: repoFiles.length,
    ...(status === "running" ? {} : { remaining }),
    template_repo: templateFullName,
    template_sha: templateSha,
    ...(parentSha ? { template_base_sha: parentSha } : {}),
    // The paths actually applied to anyone, not the raw request. `["*"]` used
    // to be recorded verbatim while the operation merged the whole template
    // tree regardless of what was ticked.
    selected_files: [...appliedPaths].sort(),
    // What makes this record evidence of where each student now is
    // (lib/starter-sync.mjs `startingPointFor`): ranges were per student, and
    // nothing in them was left out on purpose. A partial record is evidence
    // too - for exactly the students in `results`.
    per_student_range: true,
    all_files: allFiles,
    pr_title: syncTitle,
    pr_body: syncBody,
    created_issues: cfg.createIssue,
    summary: summarize(results),
    results,
  });

  const recordPath = `syncs/${cfg.assignmentId}/${syncId}.json`;
  const writeRecord = async (doc, message) => {
    // Validated before every write: this is what a lecturer reads to see who
    // got the change, and a document the backend cannot read back is worse
    // than none.
    const { valid, errors } = validateAgainst("sync-record", doc);
    if (!valid) {
      throw new Error(
        "sync record does not match sync-record.schema.json: " +
          errors.slice(0, 4).map((e) => `${e.instancePath || "/"} ${e.message}`).join("; "),
      );
    }
    const body = JSON.stringify(doc, null, 2) + "\n";
    await commitWithRebase({
      token: cfg.token,
      apiBase: process.env.GITHUB_API_URL || undefined,
      owner: cfg.org,
      repo: CONTROL_REPO,
      branch: "main",
      message,
      changes: [{ path: recordPath, content: body }],
    });
    // And in this checkout, where later steps and the tests read it.
    await mkdir(join(cfg.dataDir, "syncs", cfg.assignmentId), { recursive: true });
    await writeFile(join(cfg.dataDir, recordPath), body);
  };

  // Nothing is sent unless the start can be recorded: a sync nobody can see
  // is the thing this record exists to end.
  await writeRecord(buildRecord("running"), `Start starter code sync for ${cfg.assignmentId}`);
  console.log(`[sync] Recorded the start as ${recordPath}${runUrl ? ` (${runUrl})` : ""}`);

  // Progress, so a run that dies mid-cohort still says who it reached. Best
  // effort: a failed progress write is logged and the sync goes on - the
  // students matter more than the tally, and the final write is not optional.
  // Counted in FINISHED students (`results`), checked before each next one.
  let lastFlush = Date.now();
  let flushedAt = 0;
  const maybeFlush = async () => {
    const done = results.length;
    if (done === flushedAt) return;
    if (done - flushedAt < FLUSH_EVERY && Date.now() - lastFlush < FLUSH_MS) return;
    try {
      await writeRecord(buildRecord("running"), `Starter code sync progress for ${cfg.assignmentId}`);
    } catch (err) {
      console.log(`[warn] could not record progress: ${err.message}`);
    }
    lastFlush = Date.now();
    flushedAt = done;
  };

  let remaining = 0;
  for (const [index, file] of repoFiles.entries()) {
    // The sync stops ITSELF before the job's timeout does, so that it can say
    // where it stopped: a job the timeout kills writes nothing afterwards.
    if (Date.now() - t0 > cfg.budgetMs) {
      remaining = repoFiles.length - index;
      console.log(`[stop] time budget reached with ${remaining} student(s) not yet reached - run the sync again to finish them`);
      break;
    }
    await maybeFlush();
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
      const studentTree = await readStudentTree(studentFullName, "main");
      const { from, source, plan } = await planStudent({
        login,
        studentRepo: studentFullName,
        studentTree,
        readTree: readTemplateTree,
        root: () => rootTreeSha(get, studentFullName, "main"),
        templateFullName,
        headSha: templateSha,
        headTree,
        templateCommits,
        records,
        fallbackSha: parentSha,
        selected: requestedFiles,
      });
      const outcome = outcomeFor(plan);
      row.outcome = outcome;
      row.from_sha = from || null;
      row.from_source = source;
      row.files_merged = plan.clean.length;
      row.files_conflicted = plan.conflicts.length;
      if (plan.kept.length) row.files_kept = plan.kept.length;
      for (const e of [...plan.clean, ...plan.conflicts]) appliedPaths.add(e.path);
      const fromNote =
        source === "first-commit"
          ? "from their own first commit - created from a different template"
          : `from ${from ? from.slice(0, 7) : "nothing"}${source === "unknown" ? ", start unknown - this commit only" : ""}`;

      if (outcome === "skipped-up-to-date") {
        console.log(
          plan.kept.length
            ? `[skip] ${login}: already has every change (${fromNote}; ${plan.kept.length} added file(s) already theirs, left alone)`
            : `[skip] ${login}: already has every change (${fromNote})`,
        );
        results.push(row);
        await sleep(200);
        continue;
      }

      const toChanges = async (entries) => {
        const out = [];
        for (const { path, action } of entries) {
          out.push({ path, content: action === "delete" ? null : await contentOf(path) });
        }
        return out;
      };

      // 3a. Files the student never touched go straight onto main.
      if (plan.clean.length > 0) {
        const commit = await commitWithRebase({
          token: cfg.token,
          apiBase: process.env.GITHUB_API_URL || undefined,
          owner: cfg.org,
          repo: repoName,
          branch: "main",
          message: `Update starter code from template: ${commitMsgTitle}`,
          changes: await toChanges(plan.clean),
        });
        row.commit_sha = commit.commitSha;
        console.log(`[auto-merged] ${login}: ${plan.clean.length} file(s) -> ${commit.commitSha.slice(0, 7)} (${fromNote})`);
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
          apiBase: process.env.GITHUB_API_URL || undefined,
          owner: cfg.org,
          repo: repoName,
          branch: branchName,
          message: `Starter code update: ${commitMsgTitle}`,
          changes: await toChanges(plan.conflicts),
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
          // A SECOND call, so an account that cannot be assigned (removed from
          // the repository, renamed) can never cost the issue itself. What
          // GitHub answers with is who was actually assigned - that, not the
          // list asked for, is what the record keeps.
          const wanted = issueAssignees({ login, repoName: studentFullName, byRepo });
          if (wanted.length) {
            const assignRes = await gh("POST", `/repos/${studentFullName}/issues/${row.issue_number}/assignees`, { assignees: wanted }, { token: cfg.token });
            if (assignRes.ok) {
              row.issue_assignees = (assignRes.data?.assignees || []).map((a) => a.login);
              const missed = wanted.filter((w) => !row.issue_assignees.some((a) => sameLogin(a, w)));
              if (missed.length) console.log(`[warn] ${login}: could not assign ${missed.join(", ")} - they are emailed only if they watch the repository`);
            } else {
              row.issue_assignees = [];
              console.log(`[warn] ${login}: the issue could not be assigned (HTTP ${assignRes.status}) - they are emailed only if they watch the repository`);
            }
          }
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

  // 4. The final record. NOT best effort: this is the one that says the run
  //    finished and how, and a run whose final record did not land goes red.
  const status = remaining > 0 ? "stopped" : "completed";
  const syncRecord = buildRecord(status, remaining);
  await writeRecord(
    syncRecord,
    status === "stopped"
      ? `Starter code sync for ${cfg.assignmentId} stopped with ${remaining} student(s) to go`
      : `Record starter code sync for ${cfg.assignmentId}`,
  );

  const s = syncRecord.summary;
  console.log(
    `\nSync ${status} (${syncId}): ${s.auto_merged} updated in place, ${s.pr_opened} pull request(s), ` +
      `${s.skipped} skipped, ${s.failed} failed${remaining ? `, ${remaining} not reached - run it again` : ""}.`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
