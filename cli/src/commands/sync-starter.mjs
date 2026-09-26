// PXL Classroom - CLI sync-starter command.
//
// Sends each student repository what it is missing of the template, from the
// student's own starting point up to one template commit (the newest, or
// --commit): straight onto their submission branch for every file they have
// not touched, and onto a `starter-update-<ts>` branch with a pull request for
// the ones they have. It writes the same sync record the workflow does
// (lib/sync-record.mjs, `via: "cli"`), so a later sync knows what it delivered.
//
// The plan comes from lib/starter-sync.mjs, shared with scripts/sync-starter.mjs
// and the Admin Panel's pre-flight, so all three classify a student the same
// way. That module records what the old merge-based version actually did: the
// merge itself worked, but it carried the whole template tree and grafted its
// history, while the `compare` beside it was a 404 - so the up-to-date skip
// never fired and the pre-flight called every student a conflict.

import { resolveOrg } from "../lib/org.mjs";
import { makeOctokit } from "../lib/octokit.mjs";
import { CONTROL_REPO, getAssignment, listRepoRecords, listSyncRecords } from "../lib/control-repo.mjs";
import { validateAgainst } from "../lib/validate.mjs";
import { withConcurrency } from "../lib/worker-pool.mjs";
import { commitWithRebase } from "../lib/gittree.mjs";
import { toRequest } from "../lib/gh-request.mjs";
import { blobOf, listTemplateCommits, modeOf, planStudent, rootCommit, treeReader } from "../../../lib/starter-sync-cohort.mjs";
import { submissionBranch } from "../../../lib/submission-marker.mjs";
import { buildSyncRecord, generateSyncId, syncRow } from "../../../lib/sync-record.mjs";
import { sameLogin } from "../../../lib/github-login.mjs";
import { issueAssignees, loginsByRepo, oneRecordPerRepo } from "../../../lib/sync-issue.mjs";
import {
  changedPaths,
  outcomeFor,
  syncMarker,
  findExistingSyncPr,
  readTemplateCommit,
  selectionIsAll,
  startingPointFor,
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


export function registerSyncStarterCommand(program) {
  program
    .command("sync-starter")
    .description("Send each student repository what it is missing of the template, up to its newest commit (or --commit)")
    .option("--org <login>", "GitHub org login (defaults to last used)")
    .requiredOption("--assignment <id>", "Assignment ID")
    .option("--files <list>", "Comma-separated list of file paths to sync (defaults to every file each student is behind on)", "*")
    .option("--title <title>", "Custom PR / commit title")
    .option("--message <msg>", "Custom instructions or description")
    .option("--issue", "Create tracking issue in student repositories", true)
    .option("--no-issue", "Do not create tracking issues")
    .option("--dry-run", "Preview which student repos would be updated in place vs get a PR", false)
    .option("--commit <sha>", "Sync this template commit instead of the newest (7-40 hex characters)")
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
      // The submission branch - the template's default, and the only branch a
      // student repository gets - never a hard-coded `main`.
      const branch = submissionBranch(assignment);

      // 1. The commit being synced, and the one before it. The newest unless
      //    --commit names one (lib/starter-sync.mjs `readTemplateCommit`).
      const chosen = readTemplateCommit(opts.commit);
      if (chosen && typeof chosen === "object") {
        process.stderr.write(`${chosen.error}\n`);
        process.exit(1);
      }
      let requestedSha = chosen;
      if (!requestedSha) {
        const { data: tplCommits } = await octokit.rest.repos.listCommits({
          owner: tplOwner,
          repo: tplRepo,
          per_page: 1,
        });
        if (!tplCommits || tplCommits.length === 0) {
          process.stderr.write(`No commits found on template repository ${tplOwner}/${tplRepo}.\n`);
          process.exit(1);
        }
        requestedSha = tplCommits[0].sha;
      }

      let detail;
      try {
        ({ data: detail } = await octokit.rest.repos.getCommit({ owner: tplOwner, repo: tplRepo, ref: requestedSha }));
      } catch (e) {
        if (!chosen) throw e;
        process.stderr.write(`Template ${tplOwner}/${tplRepo} has no commit ${chosen} (HTTP ${e.status}).\n`);
        process.exit(1);
      }
      // The full sha whatever was typed: the PR marker and the record key on it.
      const templateSha = detail.sha;

      const commitHeadline = (detail.commit?.message || "").split("\n")[0] || "Update starter code";
      const parentSha = detail.parents?.[0]?.sha || null;
      process.stdout.write(`Target commit: ${templateSha.slice(0, 7)} - "${commitHeadline}"\n`);

      // Each student is sent what they are behind on, from their own starting
      // point (lib/starter-sync.mjs `startingPointFor`) - the same plan the
      // workflow and the Admin Panel make, from the same module.
      const newest = changedPaths(detail.files);
      const requested = opts.files === "*" ? ["*"] : String(opts.files).split(",").map((f) => f.trim());
      process.stdout.write(`This commit changed ${newest.length} file(s); each student is sent everything they are behind on.\n\n`);

      const templateFullName = `${tplOwner}/${tplRepo}`;
      const get = toRequest(octokit);
      const readTemplateTree = treeReader(get);
      const readStudentTree = treeReader(get);
      const headTree = await readTemplateTree(templateFullName, templateSha);
      const syncRecords = await listSyncRecords(octokit, { org, assignmentId: opts.assignment });
      const { commits: templateCommits, ok: listedOk, complete: listedComplete } = await listTemplateCommits(get, templateFullName);

      // Content fetched once per path, when the first student needs it.
      const contentByPath = new Map();
      const contentOf = async (path) => {
        if (!contentByPath.has(path)) {
          const { data: blob } = await octokit.rest.git.getBlob({ owner: tplOwner, repo: tplRepo, file_sha: blobOf(headTree.get(path)) });
          contentByPath.set(path, Buffer.from(blob.content || "", blob.encoding || "base64"));
        }
        return contentByPath.get(path);
      };

      const records = await listRepoRecords(octokit, { org, assignmentId: opts.assignment });
      const byRepo = loginsByRepo(records.map((r) => r.doc));
      if (records.length === 0) {
        process.stdout.write(`No student repository records found for assignment ${opts.assignment}.\n`);
        return;
      }

      const syncTitle = opts.title || `Starter Code Update: ${commitHeadline}`;
      const syncBody = opts.message || [
        "### Starter Code Update",
        "",
        `An update from the starter template \`${tplOwner}/${tplRepo}\` (commit \`${templateSha.slice(0, 7)}\`).`,
        "",
        "You changed these files, so they were not overwritten. Review the diff and merge when you are ready.",
      ].join("\n");

      // ONE REPOSITORY, ONE PLAN. A team is several records naming one
      // repository; planned concurrently, each member's worker read the open
      // pull requests before the other's existed and opened its own - and,
      // with issue assignment, emailed every member once per member. The
      // repository is planned once, through its first member; the issue is
      // still assigned to all of them (loginsByRepo).
      // Through the member whose start is BEST KNOWN: a reached sync record
      // (`synced`) outranks no record at all.
      const perRepo = oneRecordPerRepo(
        records,
        (rec) => repoOnly(rec.doc.repo_name),
        (rec) => (startingPointFor({ login: rec.doc.github_login, records: syncRecords }).source === "synced" ? 1 : 0),
      );
      const shared = records.length - perRepo.length;
      process.stdout.write(`Processing ${perRepo.length} student repositories (concurrency ${CONCURRENCY})${shared ? `; ${shared} team member(s) share one of them` : ""}...\n`);

      let autoMerged = 0;
      let prOpened = 0;
      let skipped = 0;
      let failed = 0;

      // THE SYNC RECORD, as the workflow writes it (lib/sync-record.mjs). The
      // CLI wrote none, so nothing could say what a CLI sync delivered: the
      // next sync started those students earlier, and a file it had delivered
      // and the student had since edited came back as a pull request offering
      // the version they already had (2026-09-27). Written at the START - and
      // if that write fails nothing is sent - and at the end. Never on a dry run.
      const recordPath = (id) => `syncs/${opts.assignment}/${id}.json`;
      const syncId = generateSyncId();
      const startedAt = new Date().toISOString();
      const appliedPaths = new Set();
      let syncedBy = "unknown";
      const recordOf = (status, rows) => buildSyncRecord({
        syncId, assignmentId: opts.assignment, startedAt, syncedBy, status, via: "cli",
        totalStudents: records.length, remaining: 0, templateRepo: templateFullName, templateSha,
        templateBaseSha: parentSha, appliedPaths, allFiles: selectionIsAll(requested),
        prTitle: syncTitle, prBody: syncBody, createdIssues: Boolean(opts.issue), results: rows,
      });
      const writeRecord = async (doc, message) => {
        const { valid, errors } = validateAgainst("sync-record", doc);
        if (!valid) throw new Error(`the sync record does not match its schema: ${JSON.stringify(errors?.slice(0, 3))}`);
        await commitWithRebase(octokit, {
          owner: org, repo: CONTROL_REPO, branch: "main", message,
          changes: [{ path: recordPath(syncId), content: JSON.stringify(doc, null, 2) + "\n" }],
        });
      };
      if (!opts.dryRun) {
        try {
          syncedBy = (await octokit.request("GET /user")).data.login || "unknown";
        } catch { /* recorded as unknown */ }
        try {
          await writeRecord(recordOf("running", []), `Start starter code sync for ${opts.assignment} (CLI)`);
        } catch (e) {
          process.stderr.write(`Nothing was sent: the start of this sync could not be recorded (${e.message}).\n`);
          process.exit(1);
        }
      }

      const results = await withConcurrency(perRepo, CONCURRENCY, async (rec) => {
        const login = rec.doc.github_login;
        const repoName = repoOnly(rec.doc.repo_name);
        const teamSlug = rec.doc.team_slug || null;

        if (!repoName) {
          return { login, teamSlug, repoFull: "unknown", outcome: "skipped-no-repo" };
        }

        const studentFullName = `${org}/${repoName}`;
        try {
          const studentTree = await readStudentTree(studentFullName, branch);
          const { from, source, plan, at } = await planStudent({
            login,
            studentRepo: studentFullName,
            studentTree,
            readTree: readTemplateTree,
            root: () => rootCommit(get, studentFullName, branch),
            templateFullName,
            headSha: templateSha,
            headTree,
            templateCommits,
            records: syncRecords,
            fallbackSha: parentSha,
            selected: requested,
            historyComplete: listedOk && listedComplete,
          });
          const outcome = outcomeFor(plan);

          const base = { login, teamSlug, repoFull: studentFullName, outcome, plan, from, source, at };
          if (opts.dryRun || outcome === "skipped-up-to-date") {
            // Dry-run is sacred: no API writes, no PRs, no commits. Everything
            // above this line is a read.
            return { ...base, dryRun: opts.dryRun };
          }

          const toChanges = async (entries) => {
            const out = [];
            for (const { path, action } of entries) {
              // With its mode: an executable stays executable, a symlink a link.
              out.push(action === "delete"
                ? { path, content: null }
                : { path, content: await contentOf(path), mode: modeOf(headTree.get(path)) });
            }
            return out;
          };

          const row = { ...base };

          if (plan.clean.length > 0) {
            const commit = await commitWithRebase(octokit, {
              owner: org,
              repo: repoName,
              branch,
              message: `Update starter code from template: ${commitHeadline}`,
              changes: await toChanges(plan.clean),
            });
            row.sha = commit.commitSha;
          }

          if (plan.conflicts.length > 0) {
            // Adopt the pull request a previous run of this same sync already
            // opened, rather than adding another. `paginate` walks the whole
            // list: one page of it is not the list, and a missed marker is a
            // duplicate PR rather than a visible error.
            const openPulls = await octokit.paginate(octokit.rest.pulls.list, {
              owner: org,
              repo: repoName,
              state: "open",
              per_page: 100,
            });
            const existing = findExistingSyncPr(openPulls, templateSha);
            if (existing) {
              row.prNumber = existing.number;
              row.prUrl = existing.html_url;
              row.prAdopted = true;
              return row;
            }

            const branchName = `starter-update-${Date.now().toString(36)}`;
            const { data: head } = await octokit.rest.git.getRef({ owner: org, repo: repoName, ref: `heads/${branch}` });
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
              changes: await toChanges(plan.conflicts),
            });
            const { data: prData } = await octokit.rest.pulls.create({
              owner: org,
              repo: repoName,
              title: syncTitle,
              body: `${syncBody}\n\n> Files in this pull request: ${plan.conflicts.map((c) => `\`${c.path}\``).join(", ")}\n\n${syncMarker(templateSha)}`,
              head: branchName,
              base: branch,
            });
            row.prNumber = prData.number;
            row.prUrl = prData.html_url;
          }

          // The NOTIFICATION failing is not the SYNC failing: by here the
          // commit and the pull request have landed. A thrown create (issues
          // disabled: 410) reported a synced student as failed (third review,
          // 2026-09-26); it is said as what it is, as the workflow does.
          if (opts.issue) try {
            const { data: issue } = await octokit.rest.issues.create({
              owner: org,
              repo: repoName,
              title: plan.conflicts.length
                ? `[Action Required] Starter Code Update Available in PR #${row.prNumber}`
                : `[Notice] Starter Code Updated: ${commitHeadline}`,
              body: plan.conflicts.length
                ? `A starter code update is available in Pull Request [#${row.prNumber}](${row.prUrl}). Please review and merge it.`
                : `The starter code was updated from template commit \`${templateSha.slice(0, 7)}\`.\n\nRun \`git pull\` in your workspace to get it.`,
            });
            // Assigned in a second call, so an account that cannot be assigned
            // never costs the issue. Assigned is emailed; watching is optional.
            const assignees = issueAssignees({ login, repoName: `${org}/${repoName}`, byRepo });
            if (assignees.length) {
              await octokit.rest.issues.addAssignees({ owner: org, repo: repoName, issue_number: issue.number, assignees })
                .catch((e) => process.stdout.write(`  ! ${login}: issue not assigned (${e.status || e.message})\n`));
            }
          } catch (e) {
            row.issueError = `HTTP ${e.status ?? "?"}${e.message ? `: ${e.message}` : ""}`;
          }

          return row;
        } catch (err) {
          return { login, teamSlug, repoFull: studentFullName, outcome: "failed", error: err.message };
        }
      });

      // The record's rows: every student, a team's members each under their
      // own login (the next sync reads each member's own start).
      if (!opts.dryRun) {
        const rowOf = (res) => {
          if (!res.plan) {
            return { github_login: res.login, repo_name: res.repoFull, ...(res.teamSlug ? { team_slug: res.teamSlug } : {}), outcome: res.outcome, ...(res.error ? { error: res.error } : {}) };
          }
          if (res.outcome !== "failed") for (const e of [...res.plan.clean, ...res.plan.conflicts]) appliedPaths.add(e.path);
          return {
            ...syncRow({ login: res.login, repoName: res.repoFull, teamSlug: res.teamSlug, outcome: res.outcome, from: res.from, source: res.source, at: res.at, plan: res.plan }),
            ...(res.sha ? { commit_sha: res.sha } : {}),
            ...(res.prNumber ? { pr_number: res.prNumber, pr_url: res.prUrl } : {}),
            ...(res.issueError ? { issue_error: res.issueError } : {}),
          };
        };
        const rows = [];
        for (const res of results.filter(Boolean)) {
          const row = rowOf(res);
          rows.push(row);
          const mates = records.filter((r) => !sameLogin(r.doc.github_login, res.login) &&
            repoOnly(r.doc.repo_name) && res.repoFull.toLowerCase() === `${org}/${repoOnly(r.doc.repo_name)}`.toLowerCase());
          for (const m of mates) rows.push({ ...row, github_login: m.doc.github_login, ...(m.doc.team_slug ? { team_slug: m.doc.team_slug } : {}) });
        }
        try {
          await writeRecord(recordOf("completed", rows), `Record starter code sync for ${opts.assignment} (CLI)`);
        } catch (e) {
          // The students were changed; say that the record of it is missing.
          process.stderr.write(`The sync ran, but its record could not be written (${e.message}): the next sync will not know what this one delivered.\n`);
          process.exitCode = 1;
        }
      }

      process.stdout.write("\nResults:\n");
      for (const res of results) {
        if (!res) continue;
        const files = res.plan
          ? `${res.plan.clean.length} in place, ${res.plan.conflicts.length} in a PR` +
            `${res.plan.kept?.length ? `, ${res.plan.kept.length} kept` : ""}` +
            (res.source === "first-commit"
              ? " - from their own first commit (created from a different template)"
              : res.source === "other-template"
                ? ` - from ${res.from.slice(0, 7)} of the template this assignment used before`
                : ` - from ${res.from ? res.from.slice(0, 7) : "nothing"}${res.source === "unknown" ? " (start unknown: this commit only)" : ""}`)
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
          const pr = res.prNumber
            ? ` PR #${res.prNumber}${res.prAdopted ? " (already open)" : ""} (${res.prUrl})`
            : "";
          const sha = res.sha ? ` ${res.sha.slice(0, 7)}` : "";
          process.stdout.write(`  + ${pad(res.login, 20)} ${res.outcome}${sha}${pr} - ${files}\n`);
          if (res.issueError) process.stdout.write(`    (the notification issue could not be created: ${res.issueError} - they have not been told)\n`);
        }
      }

      process.stdout.write(
        `\nSync Summary: ${autoMerged} updated in place, ${prOpened} PRs opened, ${skipped} skipped, ${failed} failed.\n`
      );
    });
}
