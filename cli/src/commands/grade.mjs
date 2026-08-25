// PXL Classroom CLI - `grade` command.
//
// Runs assignment.autograde tests locally against preserved archive SHAs and
// writes per-student results to grading/<assignment-id>/<login>.json (+
// summary.json) in the control repo. Execution stays off the platform on
// purpose; pick --runner=docker for untrusted student code.
//
// Idempotent and resumable: results are written one at a time; if you Ctrl-C
// halfway through, re-running picks up where you left off. The grader never
// touches the student's live repo - only archive branches.

import { rm, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline/promises";
import { spawn } from "node:child_process";
import { makeOctokit } from "../lib/octokit.mjs";
import { commitWithRebase } from "../lib/gittree.mjs";
import { validateAgainst } from "../lib/validate.mjs";
import { requireToken } from "../lib/auth.mjs";
import { runDocker } from "../lib/runner-docker.mjs";
import { runHost } from "../lib/runner-host.mjs";
import { resolveOrg } from "../lib/org.mjs";
import { getAssignment, getReport } from "../lib/control-repo.mjs";
import { withConcurrency } from "../lib/worker-pool.mjs";
import { parseCheckRunScore, pickAutogradeCheckRun } from "../../../lib/check-run-score.mjs";
import { fetchCheckRunAnnotations } from "../lib/check-run-annotations.mjs";

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



async function checkoutArchive({ org, assignmentId, login, teamSlug, sha, token }) {
  const workdir = await mkdtemp(join(tmpdir(), `pxl-grade-${login}-`));
  const branch = teamSlug ? `preserved/${assignmentId}/${teamSlug}` : `preserved/${assignmentId}/${login}`;
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

function parseConcurrency(val) {
  const parsed = parseInt(val, 10);
  if (isNaN(parsed) || parsed <= 0 || String(parsed) !== String(val)) {
    throw new Error("Concurrency must be a positive integer.");
  }
  return parsed;
}

export function registerGradeCommand(program) {
  program
    .command("grade")
    .description("Run the assignment.autograde tests against preserved submissions.")
    .option("--org <login>", "GitHub org login (defaults to last used)")
    .requiredOption("--assignment <id>", "Assignment ID")
    .option("--login <login>", "Grade one student only")
    .option("--runner <runner>", "docker | host (default docker)", "docker")
    .option("--concurrency <n>", "Parallel students", parseConcurrency, 2)
    .option("--dry-run", "Do not commit results back to the control repo", false)
    .option("--force-host", "Bypass security warning for host execution", false)
    .action(async (opts, command) => {
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
      const isGitHubActions = assignment.autograde?.execution_environment === "github_actions";
      const runnerName = isGitHubActions ? "github_actions" : opts.runner;

      if (opts.runner === "host" && !isGitHubActions && !opts.forceHost) {
        if (!process.stdin.isTTY) {
          process.stderr.write(
            `\nError: local host execution (--runner host) requires TTY confirmation or the --force-host bypass flag.\n`,
          );
          process.exit(1);
        }
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const answer = (await rl.question(
          `\nWARNING: Local host execution (--runner host) will execute arbitrary student code directly on your host machine without isolation. Continue? [y/N] `,
        )).trim().toLowerCase();
        rl.close();
        if (answer !== "y" && answer !== "yes") {
          process.stdout.write(`Aborted - nothing executed.\n`);
          return;
        }
      }
      if (isGitHubActions && command.getOptionValueSource("runner") === "cli") {
        process.stderr.write(
          `warning: --runner ${opts.runner} is ignored - this assignment's execution_environment ` +
          `is github_actions, so grades come from the Checks API, not a local runner.\n`,
        );
      }
      process.stdout.write(
        `Grading ${queue.length} student(s) on ${tests.length} test(s) ` +
        `via ${runnerName} runner (concurrency=${opts.concurrency}).\n`,
      );
      if (isGitHubActions) {
        process.stdout.write(
          `Note: github_actions grading extracts Points from the Actions check-run output or falls back to CI conclusion.\n`,
        );
      }

      // Sequential dispatch with a worker pool over students (per-test
      // parallelism would race on the same workdir).
      const summary = { graded: [], failed: [] };
      const teamResultsCache = new Map(); // team_slug -> result
      await withConcurrency(queue, Math.max(1, opts.concurrency), async (s) => {
        let result;
        if (s.team_slug && teamResultsCache.has(s.team_slug)) {
          const cached = teamResultsCache.get(s.team_slug);
          result = {
            ...cached,
            github_login: s.github_login,
            graded_at: new Date().toISOString(),
          };
        } else if (isGitHubActions) {
          try {
            // s.repo_name is already the full org/repo name.
            const checksReq = await octokit.request(`GET /repos/${s.repo_name}/commits/${s.preserved_sha}/check-runs`);
            const checkRuns = checksReq.data.check_runs || [];
            if (checkRuns.length === 0) {
              process.stderr.write(`  ! ${s.github_login}: no CI run at preserved SHA\n`);
              summary.failed.push({ login: s.github_login, reason: "no CI run at preserved SHA" });
              return;
            }
            const totalFallback = tests.reduce((acc, t) => acc + (t.points || 0), 0);
            const run = pickAutogradeCheckRun(checkRuns);
            // The score is in the annotations, not in `output.summary` - see
            // lib/check-run-score.mjs. Skipped when the run declares none, so
            // the ordinary case costs no extra request.
            const { annotations } = run?.output?.annotations_count
              ? await fetchCheckRunAnnotations(octokit, { repoFullName: s.repo_name, checkRunId: run.id })
              : { annotations: [] };
            const parsedScore = parseCheckRunScore(run, annotations, totalFallback);
            const earned = parsedScore.earned;
            const total = parsedScore.total > 0 ? parsedScore.total : totalFallback;
            const passed = parsedScore.passed;
            const summaryOutput = parsedScore.summaryText || "";
            
            result = {
              schema_version: 1,
              assignment_id: assignment.id,
              github_login: s.github_login,
              archive_sha: s.preserved_sha,
              archive_branch: `preserved/${opts.assignment}/${s.github_login}`,
              graded_at: new Date().toISOString(),
              graded_by: gradedBy,
              runner: "github_actions",
              total_points: total,
              earned_points: earned,
              tests: tests.length > 0 ? tests.map(t => ({
                id: t.id,
                passed: passed,
                points: t.points,
                earned: parsedScore.matched && totalFallback > 0 ? Math.round((t.points / totalFallback) * earned * 100) / 100 : (passed ? t.points : 0),
                duration_ms: 0,
                exit_code: passed ? 0 : 1,
                timed_out: false,
                stdout: summaryOutput,
                stderr: ""
              })) : [{
                id: "ci-autograding",
                passed: passed,
                points: total,
                earned: earned,
                duration_ms: 0,
                exit_code: passed ? 0 : 1,
                timed_out: false,
                stdout: summaryOutput,
                stderr: ""
              }]
            };
            if (s.team_slug) {
              teamResultsCache.set(s.team_slug, result);
            }
          } catch (err) {
            process.stderr.write(`  ! ${s.github_login}: checks API fetch failed - ${err.message}\n`);
            summary.failed.push({ login: s.github_login, reason: `checks: ${err.message}` });
            return;
          }
        } else {
          let archive;
          try {
            archive = await checkoutArchive({
              org, assignmentId: opts.assignment, login: s.github_login,
              teamSlug: s.team_slug, sha: s.preserved_sha, token,
            });
          } catch (err) {
            process.stderr.write(`  ! ${s.github_login}: archive fetch failed - ${err.message}\n`);
            summary.failed.push({ login: s.github_login, reason: `archive: ${err.message}` });
            return;
          }
          try {
            result = await gradeOne({
              assignment, runner: opts.runner,
              login: s.github_login, sha: archive.sha, archive, gradedBy,
            });
            if (s.team_slug) {
              teamResultsCache.set(s.team_slug, result);
            }
          } catch (err) {
            process.stderr.write(`  ! ${s.github_login}: grading failed - ${err.message}\n`);
            summary.failed.push({ login: s.github_login, reason: `grading: ${err.message}` });
            try { await rm(archive.workdir, { recursive: true, force: true }); } catch { /* best effort */ }
            return;
          } finally {
            try { await rm(archive.workdir, { recursive: true, force: true }); } catch { /* best effort */ }
          }
        }

        try {
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
        }
      });

      if (!opts.dryRun) {
        const summaryDoc = {
          schema_version: 1,
          assignment_id: opts.assignment,
          generated_at: new Date().toISOString(),
          graded_by: gradedBy,
          runner: runnerName,
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
