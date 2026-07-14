// PXL Classroom CLI — `feedback` subcommand group.
//
// open  — for each provisioned student on an assignment, open a draft PR with
//         head = main, base = <baseline> (default "pxl-baseline"). Idempotent:
//         skips when a PR already exists on the record or on GitHub. Updates
//         the repository record with feedback_pr_number + feedback_pr_url.
// list  — print PR URLs + open review-comment counts for the assignment.
//
// PRs cannot be opened at provisioning time (main and baseline point at the
// same SHA — GitHub returns 422 "No commits between …"). This command is the
// designated lazy path: run it after the deadline (or whenever students have
// pushed at least one commit ahead of baseline).

import { Command } from "commander";
import { parse as yamlParse } from "yaml";
import { makeOctokit } from "../lib/octokit.mjs";
import { commitWithRebase } from "../lib/gittree.mjs";
import { loadConfig, saveConfig } from "../lib/config.mjs";
import { resolveOrg } from "../lib/org.mjs";
import { getAssignment, listRepoRecords } from "../lib/control-repo.mjs";

const CONTROL_REPO = "pxl-classroom-control";
const DEFAULT_BASELINE = "pxl-baseline";



function repoOnly(fullName) {
  return fullName.includes("/") ? fullName.split("/")[1] : fullName;
}

// Try to open a draft PR; return { number, url } on success, null when there
// are no commits between (the student hasn't pushed yet), throws otherwise.
async function openDraftPr(octokit, { org, repo, head, base, title, body }) {
  try {
    const res = await octokit.request("POST /repos/{owner}/{repo}/pulls", {
      owner: org, repo, title, head, base, body, draft: true,
    });
    return { number: res.data.number, url: res.data.html_url };
  } catch (err) {
    const message = err.response?.data?.message || err.message || "";
    const errors = err.response?.data?.errors || [];
    const errText = JSON.stringify(errors) + " " + message;
    if (err.status === 422 && /No commits between|no commits between|already exists/i.test(errText)) {
      // "already exists" → find it; "no commits between" → propagate as null
      if (/already exists/i.test(errText)) {
        const list = await octokit.request("GET /repos/{owner}/{repo}/pulls", {
          owner: org, repo, head: `${org}:${head}`, base, state: "open", per_page: 1,
        });
        const pr = list.data[0];
        return pr ? { number: pr.number, url: pr.html_url } : null;
      }
      return null;
    }
    throw err;
  }
}

async function countOpenReviewComments(octokit, { org, repo, number }) {
  try {
    const res = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}/comments", {
      owner: org, repo, pull_number: number, per_page: 1,
    });
    const link = res.headers?.link || "";
    const m = link.match(/[?&]page=(\d+)>; rel="last"/);
    if (m) return Number(m[1]);
    return Array.isArray(res.data) ? res.data.length : 0;
  } catch {
    return 0;
  }
}

export function registerFeedbackCommand(program) {
  const feedback = new Command("feedback").description(
    "Manage Feedback PRs on student repos (head=main, base=<baseline>).",
  );

  feedback
    .command("open")
    .description("Open draft Feedback PRs for an assignment (idempotent).")
    .option("--org <login>", "GitHub org login (defaults to last used)")
    .requiredOption("--assignment <id>", "Assignment ID")
    .option("--login <login>", "Open for one student only")
    .option("--dry-run", "Preview which PRs would be opened — no PRs are created, no records committed", false)
    .action(async (opts) => {
      const org = resolveOrg(opts.org);
      const octokit = makeOctokit();

      const assignment = await getAssignment(octokit, { org, assignmentId: opts.assignment });
      if (assignment.feedback_pr !== true) {
        process.stdout.write(`Assignment ${opts.assignment} does not have feedback_pr enabled in its YAML.\n`);
        process.exit(1);
      }
      const baseline = assignment.feedback_pr_baseline_branch || DEFAULT_BASELINE;
      const title = `${assignment.title || opts.assignment} — Feedback`;
      const body = [
        "PXL Classroom feedback thread.",
        "",
        `Head: \`main\` · Base: \`${baseline}\` (frozen at provisioning).`,
        "",
        "Lecturers leave inline review comments here; the student keeps pushing to `main`.",
        "The baseline branch is protected against force-push and delete.",
      ].join("\n");

      const records = await listRepoRecords(octokit, { org, assignmentId: opts.assignment });
      const targets = opts.login ? records.filter((r) => r.doc.github_login === opts.login) : records;
      if (targets.length === 0) {
        process.stdout.write(`No repository records to act on.\n`);
        return;
      }

      let opened = 0, existing = 0, pending = 0, failed = 0;
      for (const rec of targets) {
        const { github_login: login, repo_name } = rec.doc;
        const repo = repoOnly(repo_name);
        const recHasPr = Number.isInteger(rec.doc.feedback_pr_number);
        if (recHasPr) { existing++; continue; }

        // Dry-run must have zero side effects: no PR creation, no record
        // updates — just report what a real run would attempt.
        if (opts.dryRun) {
          opened++;
          process.stdout.write(`  + ${login}: would open draft PR on ${org}/${repo} (main → ${baseline})\n`);
          continue;
        }

        let outcome;
        try {
          outcome = await openDraftPr(octokit, { org, repo, head: "main", base: baseline, title, body });
        } catch (err) {
          process.stderr.write(`  ! ${login}: ${err.message}\n`);
          failed++;
          continue;
        }
        if (!outcome) {
          pending++;
          process.stdout.write(`  · ${login}: skipped (no commits between main and ${baseline} yet)\n`);
          continue;
        }
        opened++;
        process.stdout.write(`  + ${login}: PR #${outcome.number} ${outcome.url}\n`);

        const updated = { ...rec.doc, feedback_pr_number: outcome.number, feedback_pr_url: outcome.url };
        await commitWithRebase(octokit, {
          owner: org, repo: CONTROL_REPO, branch: "main",
          message: `Record feedback PR #${outcome.number} for ${login} on ${opts.assignment}`,
          changes: [{ path: rec.path, content: JSON.stringify(updated, null, 2) + "\n" }],
        });
      }

      if (opts.dryRun) {
        process.stdout.write(
          `\n${opened} would be opened, ${existing} already on record.\n` +
          `(--dry-run; no PRs were created, no records updated. Students with no commits ` +
          `ahead of ${baseline} would be skipped by a real run.)\n`,
        );
      } else {
        process.stdout.write(
          `\n${opened} opened, ${existing} already on record, ${pending} pending (no commits yet), ${failed} failed.\n`,
        );
        // Non-zero on partial failure, same contract as `grade` and `download`.
        if (failed > 0) process.exit(1);
      }
    });

  feedback
    .command("list")
    .description("List Feedback PRs for an assignment with open review-comment counts.")
    .option("--org <login>", "GitHub org login (defaults to last used)")
    .requiredOption("--assignment <id>", "Assignment ID")
    .action(async (opts) => {
      const org = resolveOrg(opts.org);
      const octokit = makeOctokit();

      const records = await listRepoRecords(octokit, { org, assignmentId: opts.assignment });
      if (records.length === 0) {
        process.stdout.write(`No repository records for ${opts.assignment}.\n`);
        return;
      }

      const withPr = records.filter((r) => Number.isInteger(r.doc.feedback_pr_number));
      const widths = {
        login: Math.max(8, ...records.map((r) => r.doc.github_login.length)),
        pr: 6, comments: 8,
      };
      const pad = (s, n) => String(s ?? "").padEnd(n);
      process.stdout.write(
        `${pad("login", widths.login)}  ${pad("PR#", widths.pr)}  ${pad("comments", widths.comments)}  url\n` +
        `${"-".repeat(widths.login + widths.pr + widths.comments + 30)}\n`,
      );
      for (const rec of records) {
        const login = rec.doc.github_login;
        const num = rec.doc.feedback_pr_number;
        if (!Number.isInteger(num)) {
          process.stdout.write(`${pad(login, widths.login)}  ${pad("—", widths.pr)}  ${pad("—", widths.comments)}  (no PR opened)\n`);
          continue;
        }
        const repo = repoOnly(rec.doc.repo_name);
        const count = await countOpenReviewComments(octokit, { org, repo, number: num });
        process.stdout.write(
          `${pad(login, widths.login)}  ${pad(`#${num}`, widths.pr)}  ${pad(count, widths.comments)}  ${rec.doc.feedback_pr_url || ""}\n`,
        );
      }
      process.stdout.write(`\n${withPr.length} of ${records.length} students have a Feedback PR.\n`);
    });

  program.addCommand(feedback);
}
