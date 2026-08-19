// PXL Classroom - CLI sync-starter command.
//
// Synchronizes latest template repository commits to student repositories
// using Smart Auto-Merge (clean merge to main) with safe Pull Request fallback on conflicts.

import { resolveOrg } from "../lib/org.mjs";
import { makeOctokit } from "../lib/octokit.mjs";
import { getAssignment, listRepoRecords } from "../lib/control-repo.mjs";
import { withConcurrency } from "../lib/worker-pool.mjs";

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

export function registerSyncStarterCommand(program) {
  program
    .command("sync-starter")
    .description("Synchronize starter code updates from template repository to student repositories")
    .option("--org <login>", "GitHub org login (defaults to last used)")
    .requiredOption("--assignment <id>", "Assignment ID")
    .option("--files <list>", "Comma-separated list of file paths to sync (defaults to all changed files)", "*")
    .option("--title <title>", "Custom PR / commit title")
    .option("--message <msg>", "Custom instructions or description")
    .option("--issue", "Create tracking issue in student repositories", true)
    .option("--no-issue", "Do not create tracking issues")
    .option("--dry-run", "Preview which student repos would auto-merge vs open a PR", false)
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

      // 1. Fetch latest template commit
      const { data: tplCommits } = await octokit.rest.repos.listCommits({
        owner: tplOwner,
        repo: tplRepo,
        per_page: 1,
      });

      if (!tplCommits || tplCommits.length === 0) {
        process.stderr.write(`No commits found on template repository ${tplOwner}/${tplRepo}.\n`);
        process.exit(1);
      }

      const latestCommit = tplCommits[0];
      const templateSha = latestCommit.sha;
      const commitHeadline = (latestCommit.commit?.message || "").split("\n")[0] || "Update starter code";
      process.stdout.write(`Target commit: ${templateSha.slice(0, 7)} - "${commitHeadline}"\n\n`);

      const records = await listRepoRecords(octokit, { org, assignmentId: opts.assignment });
      if (records.length === 0) {
        process.stdout.write(`No student repository records found for assignment ${opts.assignment}.\n`);
        return;
      }

      const syncTitle = opts.title || `Starter Code Update: ${commitHeadline}`;
      const syncBody = opts.message || [
        "### Starter Code Update",
        "",
        `Synchronized from template \`${tplOwner}/${tplRepo}\` (commit \`${templateSha.slice(0, 7)}\`).`,
        "",
        "- If merged automatically, run `git pull` locally.",
        "- If this is a Pull Request, review the changes and merge when ready.",
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

        if (opts.dryRun) {
          try {
            const { data: comp } = await octokit.rest.repos.compareCommitsWithBasehead({
              owner: org,
              repo: repoName,
              basehead: `${templateSha}...main`,
            });
            if (comp.status === "identical") {
              return { login, outcome: "skipped-up-to-date" };
            }
            if (comp.status === "behind") {
              return { login, outcome: "would-auto-merge" };
            }
            return { login, outcome: "would-open-pr" };
          } catch (err) {
            return { login, outcome: "error", error: err.message };
          }
        }

        // Live execution
        try {
          // Check if already up to date
          const { data: comp } = await octokit.rest.repos.compareCommitsWithBasehead({
            owner: org,
            repo: repoName,
            basehead: `${templateSha}...main`,
          });

          if (comp.status === "identical") {
            return { login, outcome: "skipped-up-to-date" };
          }

          // Try Smart Direct Merge
          try {
            const { data: mergeData } = await octokit.rest.repos.merge({
              owner: org,
              repo: repoName,
              base: "main",
              head: templateSha,
              commit_message: `Update starter code from template: ${commitHeadline}`,
            });

            if (opts.issue) {
              await octokit.rest.issues.create({
                owner: org,
                repo: repoName,
                title: `[Notice] Starter Code Updated: ${commitHeadline}`,
                body: `The starter code was updated from template commit \`${templateSha.slice(0, 7)}\`.\n\nRun \`git pull\` in your workspace to get the latest fixes.`,
              });
            }

            return { login, outcome: "auto-merged", sha: mergeData.sha };
          } catch (mergeErr) {
            if (mergeErr.status === 409) {
              // Fallback to PR branch
              const branchName = `starter-update-${Date.now().toString(36)}`;
              await octokit.rest.git.createRef({
                owner: org,
                repo: repoName,
                ref: `refs/heads/${branchName}`,
                sha: templateSha,
              });

              const { data: prData } = await octokit.rest.pulls.create({
                owner: org,
                repo: repoName,
                title: syncTitle,
                body: syncBody,
                head: branchName,
                base: "main",
              });

              if (opts.issue) {
                await octokit.rest.issues.create({
                  owner: org,
                  repo: repoName,
                  title: `[Action Required] Starter Code Update Available in PR #${prData.number}`,
                  body: `A starter code update is available in Pull Request [#${prData.number}](${prData.html_url}). Please review and merge it.`,
                });
              }

              return { login, outcome: "pr-opened", prNumber: prData.number, prUrl: prData.html_url };
            }
            throw mergeErr;
          }
        } catch (err) {
          return { login, outcome: "failed", error: err.message };
        }
      });

      process.stdout.write("\nResults:\n");
      for (const res of results) {
        if (!res) continue;
        if (res.outcome === "auto-merged" || res.outcome === "would-auto-merge") {
          autoMerged++;
          process.stdout.write(`  + ${pad(res.login, 20)} ${res.outcome === "would-auto-merge" ? "would auto-merge to main" : `auto-merged to main (${res.sha?.slice(0, 7)})`}\n`);
        } else if (res.outcome === "pr-opened" || res.outcome === "would-open-pr") {
          prOpened++;
          process.stdout.write(`  * ${pad(res.login, 20)} ${res.outcome === "would-open-pr" ? "would open PR" : `opened PR #${res.prNumber} (${res.prUrl})`}\n`);
        } else if (res.outcome?.startsWith("skipped")) {
          skipped++;
          process.stdout.write(`  · ${pad(res.login, 20)} ${res.outcome}\n`);
        } else {
          failed++;
          process.stdout.write(`  ! ${pad(res.login, 20)} failed: ${res.error}\n`);
        }
      }

      process.stdout.write(
        `\nSync Summary: ${autoMerged} auto-merged, ${prOpened} PRs opened, ${skipped} skipped, ${failed} failed.\n`
      );
    });
}
