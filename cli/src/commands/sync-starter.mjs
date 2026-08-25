// PXL Classroom - CLI sync-starter command.
//
// Copies the changes from ONE template commit into student repositories:
// straight onto `main` for every file the student has not touched, and onto a
// `starter-update-<ts>` branch with a pull request for the ones they have.
//
// The plan comes from lib/starter-sync.mjs, shared with scripts/sync-starter.mjs
// and the Admin Panel's pre-flight, so all three classify a student the same
// way. That module also records why this copies content instead of merging
// history: a repository created with `POST /generate` shares no objects with
// its template, so the old `POST /merges { head: templateSha }` was a 404 for
// every student this system provisions.

import { resolveOrg } from "../lib/org.mjs";
import { makeOctokit } from "../lib/octokit.mjs";
import { getAssignment, listRepoRecords } from "../lib/control-repo.mjs";
import { withConcurrency } from "../lib/worker-pool.mjs";
import { commitWithRebase } from "../lib/gittree.mjs";
import {
  changedPaths,
  resolveSelection,
  planStarterSync,
  outcomeFor,
} from "../../../lib/starter-sync.mjs";

const CONCURRENCY = 4;

function repoOnly(fullOrShort) {
  if (!fullOrShort) return "";
  const parts = fullOrShort.split("/");
  return parts[parts.length - 1];
}

function pad(str, len) {
  const s = String(str ?? "");
  return s.length >= len ? s : s + " ".repeat(len - s.length);
}

// path -> blob sha for a whole ref, in one request. Blob shas are content
// addresses, so comparing them compares content without fetching any file.
async function readTree(octokit, { owner, repo, ref }) {
  const { data } = await octokit.rest.git.getTree({
    owner,
    repo,
    tree_sha: ref,
    recursive: "1",
  });
  if (data.truncated) {
    throw new Error(`tree listing for ${owner}/${repo} was truncated - too many files to sync safely`);
  }
  const map = new Map();
  for (const entry of data.tree || []) {
    if (entry.type === "blob") map.set(entry.path, entry.sha);
  }
  return map;
}

export function registerSyncStarterCommand(program) {
  program
    .command("sync-starter")
    .description("Copy the latest template commit's changes into student repositories")
    .option("--org <login>", "GitHub org login (defaults to last used)")
    .requiredOption("--assignment <id>", "Assignment ID")
    .option("--files <list>", "Comma-separated list of file paths to sync (defaults to all files the commit changed)", "*")
    .option("--title <title>", "Custom PR / commit title")
    .option("--message <msg>", "Custom instructions or description")
    .option("--issue", "Create tracking issue in student repositories", true)
    .option("--no-issue", "Do not create tracking issues")
    .option("--dry-run", "Preview which student repos would be updated in place vs get a PR", false)
    .action(async (opts) => {
      const org = resolveOrg(opts.org);
      const octokit = makeOctokit();

      const assignment = await getAssignment(octokit, { org, assignmentId: opts.assignment });
      const tplOwner = assignment.template?.owner || org;
      const tplRepo = assignment.template?.repository;

      if (!tplRepo) {
        process.stderr.write(`Assignment ${opts.assignment} has no template repository configured.\n`);
        process.exit(1);
      }

      process.stdout.write(`Template repository: ${tplOwner}/${tplRepo}\n`);

      // 1. The commit being synced, and the one before it.
      const { data: tplCommits } = await octokit.rest.repos.listCommits({
        owner: tplOwner,
        repo: tplRepo,
        per_page: 1,
      });

      if (!tplCommits || tplCommits.length === 0) {
        process.stderr.write(`No commits found on template repository ${tplOwner}/${tplRepo}.\n`);
        process.exit(1);
      }

      const templateSha = tplCommits[0].sha;
      const { data: detail } = await octokit.rest.repos.getCommit({
        owner: tplOwner,
        repo: tplRepo,
        ref: templateSha,
      });

      const commitHeadline = (detail.commit?.message || "").split("\n")[0] || "Update starter code";
      const parentSha = detail.parents?.[0]?.sha || null;
      process.stdout.write(`Target commit: ${templateSha.slice(0, 7)} - "${commitHeadline}"\n`);

      // GitHub returns at most 300 entries in `files`. A capped read may not
      // present itself as a whole one.
      if ((detail.files || []).length >= 300) {
        process.stderr.write(
          "Warning: this commit changed more than 300 files; GitHub lists only the first 300, and only those are synced.\n",
        );
      }

      const changed = changedPaths(detail.files);
      const requested = opts.files === "*" ? ["*"] : String(opts.files).split(",").map((f) => f.trim());
      const paths = resolveSelection(changed, requested);
      process.stdout.write(`${paths.length} of ${changed.length} changed file(s) selected.\n\n`);

      const headTree = await readTree(octokit, { owner: tplOwner, repo: tplRepo, ref: templateSha });
      const baseTree = parentSha
        ? await readTree(octokit, { owner: tplOwner, repo: tplRepo, ref: parentSha })
        : new Map();

      // Content fetched once per path, not once per student.
      const contentByPath = new Map();
      if (!opts.dryRun) {
        for (const path of paths) {
          const sha = headTree.get(path);
          if (!sha) continue; // deletion
          const { data: blob } = await octokit.rest.git.getBlob({ owner: tplOwner, repo: tplRepo, file_sha: sha });
          contentByPath.set(path, Buffer.from(blob.content || "", blob.encoding || "base64"));
        }
      }

      const records = await listRepoRecords(octokit, { org, assignmentId: opts.assignment });
      if (records.length === 0) {
        process.stdout.write(`No student repository records found for assignment ${opts.assignment}.\n`);
        return;
      }

      const syncTitle = opts.title || `Starter Code Update: ${commitHeadline}`;
      const syncBody = opts.message || [
        "### Starter Code Update",
        "",
        `A correction from the starter template \`${tplOwner}/${tplRepo}\` (commit \`${templateSha.slice(0, 7)}\`).`,
        "",
        "You changed these files, so they were not overwritten. Review the diff and merge when you are ready.",
      ].join("\n");

      process.stdout.write(`Processing ${records.length} student repositories (concurrency ${CONCURRENCY})...\n`);

      let autoMerged = 0;
      let prOpened = 0;
      let skipped = 0;
      let failed = 0;

      const results = await withConcurrency(records, CONCURRENCY, async (rec) => {
        const login = rec.doc.github_login;
        const repoName = repoOnly(rec.doc.repo_name);

        if (!repoName) {
          return { login, outcome: "skipped-no-repo" };
        }

        try {
          const studentTree = await readTree(octokit, { owner: org, repo: repoName, ref: "main" });
          const plan = planStarterSync({ headTree, baseTree, studentTree, paths });
          const outcome = outcomeFor(plan);

          if (opts.dryRun || outcome === "skipped-up-to-date") {
            // Dry-run is sacred: no API writes, no PRs, no commits. Everything
            // above this line is a read.
            return { login, outcome, plan, dryRun: opts.dryRun };
          }

          const toChanges = (entries) =>
            entries.map(({ path, action }) => ({
              path,
              content: action === "delete" ? null : contentByPath.get(path),
            }));

          const row = { login, outcome, plan };

          if (plan.clean.length > 0) {
            const commit = await commitWithRebase(octokit, {
              owner: org,
              repo: repoName,
              branch: "main",
              message: `Update starter code from template: ${commitHeadline}`,
              changes: toChanges(plan.clean),
            });
            row.sha = commit.commitSha;
          }

          if (plan.conflicts.length > 0) {
            const branchName = `starter-update-${Date.now().toString(36)}`;
            const { data: head } = await octokit.rest.git.getRef({ owner: org, repo: repoName, ref: "heads/main" });
            await octokit.rest.git.createRef({
              owner: org,
              repo: repoName,
              ref: `refs/heads/${branchName}`,
              sha: head.object.sha,
            });
            await commitWithRebase(octokit, {
              owner: org,
              repo: repoName,
              branch: branchName,
              message: `Starter code update: ${commitHeadline}`,
              changes: toChanges(plan.conflicts),
            });
            const { data: prData } = await octokit.rest.pulls.create({
              owner: org,
              repo: repoName,
              title: syncTitle,
              body: `${syncBody}\n\n> Files in this pull request: ${plan.conflicts.map((c) => `\`${c.path}\``).join(", ")}`,
              head: branchName,
              base: "main",
            });
            row.prNumber = prData.number;
            row.prUrl = prData.html_url;
          }

          if (opts.issue) {
            await octokit.rest.issues.create({
              owner: org,
              repo: repoName,
              title: plan.conflicts.length
                ? `[Action Required] Starter Code Update Available in PR #${row.prNumber}`
                : `[Notice] Starter Code Updated: ${commitHeadline}`,
              body: plan.conflicts.length
                ? `A starter code update is available in Pull Request [#${row.prNumber}](${row.prUrl}). Please review and merge it.`
                : `The starter code was updated from template commit \`${templateSha.slice(0, 7)}\`.\n\nRun \`git pull\` in your workspace to get it.`,
            });
          }

          return row;
        } catch (err) {
          return { login, outcome: "failed", error: err.message };
        }
      });

      process.stdout.write("\nResults:\n");
      for (const res of results) {
        if (!res) continue;
        const files = res.plan
          ? `${res.plan.clean.length} in place, ${res.plan.conflicts.length} in a PR`
          : "";
        if (res.outcome === "auto-merged" || res.outcome === "merged-and-pr") autoMerged++;
        if (res.outcome === "pr-opened" || res.outcome === "merged-and-pr") prOpened++;

        if (res.outcome === "failed") {
          failed++;
          process.stdout.write(`  ! ${pad(res.login, 20)} failed: ${res.error}\n`);
        } else if (res.outcome === "skipped-up-to-date" || res.outcome === "skipped-no-repo") {
          skipped++;
          process.stdout.write(`  · ${pad(res.login, 20)} ${res.outcome}\n`);
        } else if (res.dryRun) {
          process.stdout.write(`  ? ${pad(res.login, 20)} would ${res.outcome} (${files})\n`);
        } else {
          const pr = res.prNumber ? ` PR #${res.prNumber} (${res.prUrl})` : "";
          const sha = res.sha ? ` ${res.sha.slice(0, 7)}` : "";
          process.stdout.write(`  + ${pad(res.login, 20)} ${res.outcome}${sha}${pr} - ${files}\n`);
        }
      }

      process.stdout.write(
        `\nSync Summary: ${autoMerged} updated in place, ${prOpened} PRs opened, ${skipped} skipped, ${failed} failed.\n`
      );
    });
}
