// PXL Classroom CLI — `grade` command.
//
// Runs assignment.autograde tests locally against preserved archive SHAs and
// writes per-student results to grading/<assignment-id>/<login>.json (+
// summary.json) in the control repo. Execution stays off the platform on
// purpose; pick --runner=docker for untrusted student code.
//
// Idempotent and resumable: results are written one at a time; if you Ctrl-C
// halfway through, re-running picks up where you left off. The grader never
// touches the student's live repo — only archive branches.

import { Command } from "commander";
import { mkdir, writeFile, rm, mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { parse as yamlParse } from "yaml";
import { makeOctokit } from "../lib/octokit.mjs";
import { commitWithRebase } from "../lib/gittree.mjs";
import { validateAgainst } from "../lib/validate.mjs";
import { loadConfig, saveConfig } from "../lib/config.mjs";
import { requireToken } from "../lib/auth.mjs";
import { runDocker } from "../lib/runner-docker.mjs";
import { runHost } from "../lib/runner-host.mjs";
import { resolveOrg } from "../lib/org.mjs";
import { getAssignment, getReport } from "../lib/control-repo.mjs";

const CONTROL_REPO = "pxl-classroom-control";
const ARCHIVE_REPO = "pxl-classroom-archive";



function runGit(args, cwd) {
  return new Promise((resolveFn, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (b) => (stdout += b.toString()));
    child.stderr.on("data", (b) => (stderr += b.toString()));
    child.on("close", (code) =>
      code === 0 ? resolveFn(stdout) : reject(new Error(`git ${args.join(" ")} exited ${code}: ${stderr.trim()}`)),
    );
    child.on("error", reject);
  });
}



async function checkoutArchive({ org, assignmentId, login, sha, token }) {
  const workdir = await mkdtemp(join(tmpdir(), `pxl-grade-${login}-`));
  const branch = `preserved/${assignmentId}/${login}`;
  const url = `https://x-access-token:${token}@github.com/${org}/${ARCHIVE_REPO}.git`;
  await runGit(["init", "--quiet"], workdir);
  await runGit(["remote", "add", "origin", url], workdir);
  await runGit(["fetch", "--depth=1", "origin", branch], workdir);
  await runGit(["checkout", "-q", "-B", branch, "FETCH_HEAD"], workdir);
  const head = (await runGit(["rev-parse", "HEAD"], workdir)).trim();
  if (sha && head !== sha) {
    throw new Error(`archive sha mismatch: expected ${sha}, got ${head}`);
  }
  return { workdir, sha: head, branch };
}

async function gradeOne({ assignment, runner, login, sha, archive, gradedBy }) {
  const results = [];
  let earned = 0, total = 0;
  for (const test of assignment.autograde.tests) {
    total += test.points;
    let raw;
    if (runner === "docker") raw = await runDocker({ test, workdir: archive.workdir });
    else raw = await runHost({ test, workdir: archive.workdir });
    const earnedHere = raw.passed ? test.points : 0;
    earned += earnedHere;
    results.push({
      id: test.id,
      passed: raw.passed,
      points: test.points,
      earned: earnedHere,
      duration_ms: raw.duration_ms,
      exit_code: raw.exit_code,
      timed_out: raw.timed_out === true,
      stdout: clip(raw.stdout, 4096),
      stderr: clip(raw.stderr, 4096),
    });
  }
  return {
    schema_version: 1,
    assignment_id: assignment.id,
    github_login: login,
    archive_sha: sha,
    archive_branch: archive.branch,
    graded_at: new Date().toISOString(),
    graded_by: gradedBy,
    runner,
    total_points: total,
    earned_points: earned,
    tests: results,
  };
}

function clip(s, max) {
  if (!s) return "";
  return s.length <= max ? s : s.slice(0, max) + `\n…[truncated ${s.length - max} bytes]`;
}

async function authedLogin(octokit) {
  try {
    const res = await octokit.request("GET /user");
    return res.data.login;
  } catch {
    return "unknown";
  }
}

export function registerGradeCommand(program) {
  program
    .command("grade")
    .description("Run the assignment.autograde tests against preserved submissions.")
    .option("--org <login>", "GitHub org login (defaults to last used)")
    .requiredOption("--assignment <id>", "Assignment ID")
    .option("--login <login>", "Grade one student only")
    .option("--runner <runner>", "docker | host (default docker)", "docker")
    .option("--concurrency <n>", "Parallel students", (v) => Number(v), 2)
    .option("--dry-run", "Do not commit results back to the control repo", false)
    .action(async (opts) => {
      const org = resolveOrg(opts.org);
      const octokit = makeOctokit();
      const token = requireToken().access_token;

      if (!["docker", "host"].includes(opts.runner)) {
        throw new Error(`--runner must be 'docker' or 'host', got '${opts.runner}'`);
      }

      const assignment = await getAssignment(octokit, { org, assignmentId: opts.assignment });
      if (assignment.autograde?.enabled !== true) {
        throw new Error(`Assignment ${opts.assignment} does not have autograde.enabled in its YAML.`);
      }
      const tests = assignment.autograde.tests || [];
      if (tests.length === 0) throw new Error(`Assignment ${opts.assignment} has no autograde tests.`);
      // Pin assignment.id since some assignment YAMLs omit it (filename is the SOT)
      assignment.id = assignment.id || opts.assignment;

      const report = await getReport(octokit, { org, assignmentId: opts.assignment });
      const eligible = (report.students || []).filter(
        (s) => s.preservation_status === "preserved" && s.preserved_sha && s.github_login,
      );
      const queue = opts.login ? eligible.filter((s) => s.github_login === opts.login) : eligible;
      if (queue.length === 0) {
        process.stdout.write(opts.login
          ? `No preserved submission for ${opts.login}.\n`
          : `No preserved submissions to grade.\n`);
        return;
      }

      const gradedBy = await authedLogin(octokit);
      process.stdout.write(
        `Grading ${queue.length} student(s) on ${tests.length} test(s) ` +
        `via ${opts.runner} runner (concurrency=${opts.concurrency}).\n`,
      );

      // Sequential dispatch with a worker pool over students (per-test
      // parallelism would race on the same workdir).
      let cursor = 0;
      const summary = { graded: [], failed: [] };
      const worker = async () => {
        while (cursor < queue.length) {
          const s = queue[cursor++];
          let archive;
          try {
            archive = await checkoutArchive({
              org, assignmentId: opts.assignment, login: s.github_login,
              sha: s.preserved_sha, token,
            });
          } catch (err) {
            process.stderr.write(`  ! ${s.github_login}: archive fetch failed — ${err.message}\n`);
            summary.failed.push({ login: s.github_login, reason: `archive: ${err.message}` });
            continue;
          }
          try {
            const result = await gradeOne({
              assignment, runner: opts.runner,
              login: s.github_login, sha: archive.sha, archive, gradedBy,
            });
            const v = validateAgainst("grading-result", result);
            if (!v.valid) {
              throw new Error("grading result failed schema: " + JSON.stringify(v.errors));
            }
            process.stdout.write(
              `  + ${s.github_login}: ${result.earned_points}/${result.total_points} ` +
              `(${result.tests.filter((t) => t.passed).length}/${result.tests.length} tests)\n`,
            );
            if (!opts.dryRun) {
              await commitWithRebase(octokit, {
                owner: org, repo: CONTROL_REPO, branch: "main",
                message: `Grade ${s.github_login} on ${opts.assignment} (${result.earned_points}/${result.total_points})`,
                changes: [{
                  path: `grading/${opts.assignment}/${s.github_login}.json`,
                  content: JSON.stringify(result, null, 2) + "\n",
                }],
              });
            }
            summary.graded.push({
              login: s.github_login,
              earned_points: result.earned_points,
              total_points: result.total_points,
              graded_at: result.graded_at,
            });
          } catch (err) {
            process.stderr.write(`  ! ${s.github_login}: ${err.message}\n`);
            summary.failed.push({ login: s.github_login, reason: err.message });
          } finally {
            try { await rm(archive.workdir, { recursive: true, force: true }); } catch { /* best effort */ }
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(opts.concurrency, queue.length) }, worker));

      if (!opts.dryRun) {
        const summaryDoc = {
          schema_version: 1,
          assignment_id: opts.assignment,
          generated_at: new Date().toISOString(),
          graded_by: gradedBy,
          runner: opts.runner,
          students: summary.graded,
          failed: summary.failed,
        };
        await commitWithRebase(octokit, {
          owner: org, repo: CONTROL_REPO, branch: "main",
          message: `Grade ${opts.assignment}: summary (${summary.graded.length} graded, ${summary.failed.length} failed)`,
          changes: [{
            path: `grading/${opts.assignment}/summary.json`,
            content: JSON.stringify(summaryDoc, null, 2) + "\n",
          }],
        });
      }
      process.stdout.write(`\n${summary.graded.length} graded, ${summary.failed.length} failed.\n`);
      if (opts.dryRun) process.stdout.write(`(--dry-run; nothing committed.)\n`);
      if (summary.failed.length) process.exit(1);
    });
}
