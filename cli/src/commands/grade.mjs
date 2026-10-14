// PXL Classroom CLI - `grade` command.
//
// Runs assignment.autograde tests locally against preserved archive SHAs and
// writes per-student results to grading/<assignment-id>/<login>.json (+
// summary.json) in the control repo. Execution stays off the platform on
// purpose; pick --runner=docker for untrusted student code.
//
// Where the assignment grades on GitHub Actions - checks defined here and run
// there, or a template's own grading workflow - nothing runs here: the scores
// GitHub recorded are read, as the page and the nightly read them, and whether
// that applies is `gradesInCi`'s answer, the one they ask. This refused every
// template-graded assignment, the cloud exams among them, while ARCHITECTURE
// said it read them (review 2026-10-15, P2-48).
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
import { CONTROL_REPO, getAssignment, getGradingSummary, getReport, listOverrides, unchangedSince } from "../lib/control-repo.mjs";
import { withConcurrency } from "../lib/worker-pool.mjs";
// The shape of grading/<id>/summary.json, shared with the Admin Panel.
import {
  gradedRowFromCheckRun,
  gradedRowFromLocalRun,
  gradedRowFromManualScore,
  buildGradingSummary,
} from "../../../lib/grading-summary.mjs";
import { decisionRecord, gradeDecisionFor } from "../../../lib/grade-override.mjs";
import { readRunScore } from "../../../lib/grade-dispatch.mjs";
import { readSubmissionMarker, submissionBranch, describeIgnoredHandIn } from "../../../lib/submission-marker.mjs";
import { FAILED_READ_VERDICTS, NO_SUBMISSION_REASON, archiveGradeQueue, failedKind, keepStoredOnFailedReads, mergeOneStudentRead, readScoreAtCommit as readScoreShared, resolveHandIn, teamOf } from "../../../lib/grade-cohort.mjs";
import { gradesInCi } from "../../../lib/autograde-source.mjs";
import { toRequest } from "../lib/gh-request.mjs";
import { archiveBranchName, resolveArchiveRepo } from "../../../lib/archive-repo.mjs";
import { normalizeLogin, sameLogin } from "../../../lib/github-login.mjs";
import { gradingSummaryPath } from "../../../lib/control-layout.mjs";
import { gitAuthEnv, gitRepoUrl } from "../../../lib/git-auth.mjs";

function runGit(args, cwd, env = process.env) {
  return new Promise((resolveFn, reject) => {
    const child = spawn("git", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (b) => (stdout += b.toString()));
    child.stderr.on("data", (b) => (stderr += b.toString()));
    child.on("close", (code) =>
      code === 0 ? resolveFn(stdout) : reject(new Error(`git ${args.join(" ")} exited ${code}: ${stderr.trim()}`)),
    );
    child.on("error", reject);
  });
}



// The archive repository and ref come off the report row, never from the
// assignment id: archives are per assignment now, and a cohort preserved before
// that change is in the org's old shared pxl-classroom-archive.
async function checkoutArchive({ org, assignmentId, login, teamSlug, archiveRepo, archiveRef, sha, token }) {
  const workdir = await mkdtemp(join(tmpdir(), `pxl-grade-${login}-`));
  const branch = archiveBranchName({ assignmentId, login, teamSlug, recordedRef: archiveRef });
  const repo = resolveArchiveRepo({ org, recorded: archiveRepo });
  // THE TOKEN IN THE FETCH'S ENVIRONMENT ONLY (lib/git-auth.mjs; review
  // 2026-10-14). In the remote URL it sat in this workdir's `.git/config`,
  // which is mounted into the Docker sandbox the student's code runs in.
  const authed = { ...process.env, ...gitAuthEnv(token), GIT_TERMINAL_PROMPT: "0" };
  try {
    await runGit(["init", "--quiet"], workdir);
    await runGit(["remote", "add", "origin", gitRepoUrl("https://github.com", ...repo.split("/"))], workdir);
    await runGit(["fetch", "--depth=1", "origin", branch], workdir, authed);
    await runGit(["checkout", "-q", "-B", branch, "FETCH_HEAD"], workdir);
    const head = (await runGit(["rev-parse", "HEAD"], workdir)).trim();
    if (sha && head !== sha) {
      throw new Error(`archive sha mismatch: expected ${sha}, got ${head}`);
    }
    return { workdir, sha: head, branch };
  } catch (e) {
    // The caller removes a workdir it was handed; one it never got is ours.
    await rm(workdir, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
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
    .description("Grade the cohort: read the scores GitHub Actions recorded, or run the assignment's checks on this machine.")
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
      // The assignment's hand-in marker, read once for the cohort. Null for
      // every assignment that does not declare one.
      const marker = readSubmissionMarker(assignment);
      const declared = assignment.autograde?.enabled === true;
      // On GitHub Actions: declared there, or the template's workflow grades -
      // the judge the page and the nightly ask (lib/autograde-source.mjs).
      const isGitHubActions = gradesInCi(assignment, { hasSubmissionMarker: Boolean(marker) });
      if (!declared && !isGitHubActions) {
        throw new Error(
          `Assignment ${opts.assignment} is not graded: it defines no checks of its own, and its template's grading workflow is not one it reads (template_grades).`,
        );
      }
      const tests = declared ? assignment.autograde.tests || [] : [];
      if (declared && tests.length === 0) throw new Error(`Assignment ${opts.assignment} has no autograde tests.`);
      // Pin assignment.id since some assignment YAMLs omit it (filename is the SOT)
      assignment.id = assignment.id || opts.assignment;

      const report = await getReport(octokit, { org, assignmentId: opts.assignment });
      // Read ALWAYS, not only under a cap: a lecturer's decision (a chosen
      // commit, a score by hand - lib/grade-override.mjs) lives here too, and a
      // CLI run that ignored one would overwrite it in the summary. Read BEFORE
      // choosing whom to grade: a score by hand needs no preserved submission
      // (an oral exam, no repository), and the summary this run writes
      // replaces the whole file - so a student it skipped lost their score
      // (review 2026-09-26). A read that fails throws and stops the run.
      const overrides = await listOverrides(octokit, { org, assignmentId: opts.assignment });
      const eligible = archiveGradeQueue(report.students, overrides);
      // `sameLogin`: --login is typed by a lecturer, and a casing difference read as
      // "No preserved submission for X" - for a student who has one.
      const queue = opts.login ? eligible.filter((s) => sameLogin(s.github_login, opts.login)) : eligible;
      if (queue.length === 0) {
        process.stdout.write(opts.login
          ? `No preserved submission for ${opts.login}.\n`
          : `No preserved submissions to grade.\n`);
        return;
      }

      const gradedBy = await authedLogin(octokit);
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
          `warning: --runner ${opts.runner} is ignored - this assignment grades on GitHub Actions, ` +
          `so grades come from the Checks API, not a local runner.\n`,
        );
      }
      process.stdout.write(
        `Grading ${queue.length} student(s) ` +
        `${declared ? `on ${tests.length} test(s)` : "from the template's grading workflow"} ` +
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
      // Students whose read FAILED in this run - nothing was learned about
      // them. Under --login their result on record stands (oneReadReplaces).
      const failedReads = new Set();
      const failedRead = (login) => failedReads.add(normalizeLogin(login));
      const teamResultsCache = new Map(); // team_slug -> result

      const markerBranch = submissionBranch(assignment);
      const totalFallback = tests.reduce((acc, t) => acc + (t.points || 0), 0);
      // (`overrides`, read above, also carries the hand-in allowances a cap
      // is raised by.)
      // The lib's `request(method, path)` shape, for the reads it does (GET only).
      const readPath = toRequest(octokit);
      const readRequest = async (_method, path) => {
        const res = await readPath(path);
        return { ...res, ok: res.status >= 200 && res.status < 300 };
      };

      // ONE commit's worth of reading, through the shared reader the page and
      // the nightly use (lib/grade-cohort.mjs `readScoreAtCommit`). The CLI
      // had its own copy, which answered a gone commit (422) and a deleted or
      // unreachable repository (404) with a thrown error where the shared one
      // names the student (review 2026-10-14, P2-9). Never a guessed score.
      const readScoreAtCommit = (s, sha) =>
        readScoreShared(readRequest, { repoFullName: s.repo_name, sha, marker, fallbackTotal: totalFallback });
      await withConcurrency(queue, Math.max(1, opts.concurrency), async (s) => {
        let result;
        // The check run this grade was read from, on the Actions path only.
        // Null on the local runners, where there is no check run to describe
        // and the summary row is legitimately sparser.
        let ciRow = null;
        // The hand-in count under a cap, carried to the summary row.
        let handIns = null;
        // The graded hand-in itself, for when GitHub recorded its push.
        let handIn = null;
        // A LECTURER'S DECISION FIRST, as every other grader does.
        const decision = gradeDecisionFor(s.github_login, { overrides, team: teamOf(s, eligible) });
        if (decision?.kind === "score") {
          process.stdout.write(`  = ${s.github_login}: ${decision.earned}/${decision.total} set by hand by @${decision.by} - not graded\n`);
          summary.graded.push(gradedRowFromManualScore({ login: s.github_login, decision }));
          return;
        }
        if (decision?.kind === "commit" && !isGitHubActions) {
          // The local runner grades the PRESERVED submission, checked out from
          // the archive at one commit. Grading something else here while the
          // lecturer chose ${sha} would be the opposite of their decision.
          const reason = `@${decision.by} chose commit ${decision.sha.slice(0, 7)}, and the local runner only grades the preserved submission - read that commit's result on the assignment page instead`;
          process.stderr.write(`  ! ${s.github_login}: ${reason}\n`);
          summary.failed.push({ login: s.github_login, reason, kind: "no-result" });
          return;
        }
        // NOTHING HANDED IN IS NOT A SCORE, asked where the shared grader asks
        // it (lib/grade-cohort.mjs `gradeStudent`): after a decision, and after
        // a hand-in marker, which decides by itself on the Actions path. The
        // CLI read the preserved commit regardless, and an untouched student's
        // preserved commit is the starter - whose grading run, or whose tests
        // on the local runner, gave them a score (review 2026-10-14, P2-1).
        if (!decision && s.submission_status === "no-submission" && !(isGitHubActions && marker)) {
          process.stdout.write(`  - ${s.github_login}: ${NO_SUBMISSION_REASON}\n`);
          summary.failed.push({ login: s.github_login, reason: NO_SUBMISSION_REASON, kind: "not-handed-in" });
          return;
        }
        if (s.team_slug && !decision && teamResultsCache.has(s.team_slug)) {
          // The WHOLE row the first member got: the check run it came from and
          // the hand-in count too. Only the result was cached, so a teammate's
          // summary row came out in the local-runner shape - no run, no link,
          // no count (third review, 2026-09-26).
          const cached = teamResultsCache.get(s.team_slug);
          result = {
            ...cached.result,
            github_login: s.github_login,
            graded_at: new Date().toISOString(),
          };
          ciRow = cached.ciRow;
          handIns = cached.handIns;
          handIn = cached.handIn;
        } else if (isGitHubActions) {
          try {
            // WITH A MARKER, THE HAND-IN COMMIT IS THE SUBMISSION - the
            // preserved head is not consulted at all. It used to be read first
            // and the hand-in used only as a fallback, which graded a hand-in
            // pushed AFTER the deadline whenever it was the student's last
            // commit: the fallback carried the deadline bound and the direct
            // read never did.
            let outcome;
            if (decision?.kind === "commit") {
              // The rules are the lecturer's to skip; the run is not. Graded by
              // "Grade this commit now": that run is the result, read through
              // the same lib function the page and the nightly use.
              if (decision.runId) {
                outcome = await readRunScore(readRequest, { repoFullName: s.repo_name, runId: decision.runId, sha: decision.sha, fallbackTotal: totalFallback });
              } else {
                outcome = await readScoreAtCommit(s, decision.sha);
              }
              if (outcome.verdict !== "graded") {
                outcome = { ...outcome, reason: `the commit @${decision.by} chose (${decision.sha.slice(0, 7)}) cannot be read: ${outcome.reason}` };
              }
            } else if (marker) {
              // The same decision the Admin Panel and the nightly make - which
              // hand-in counts, under the cap and this student's allowance -
              // from lib/grade-cohort.mjs rather than a third walk written here.
              const found = await resolveHandIn(toRequest(octokit), {
                row: s,
                marker,
                markerBranch,
                overrides,
                team: teamOf(s, eligible),
              });
              handIns = found.handIns;
              for (const item of handIns?.ignored || []) {
                process.stderr.write(`  - ${s.github_login}: ${describeIgnoredHandIn(item, { allowed: handIns.allowed })}\n`);
              }
              if (found.verdict !== "found") {
                const unread = FAILED_READ_VERDICTS.includes(found.verdict);
                if (unread) failedRead(s.github_login);
                // `!` is something to look at; an answer (not handed in, late,
                // still running) is `-`, as the no-submission line above.
                const mark = unread || (found.kind || "no-result") === "no-result" ? "!" : "-";
                process.stderr.write(`  ${mark} ${s.github_login}: ${found.reason}\n`);
                summary.failed.push({ login: s.github_login, reason: found.reason, kind: found.kind || "no-result", ...(handIns ? { hand_ins: handIns } : {}) });
                return;
              }
              handIn = found.commit;
              outcome = await readScoreAtCommit(s, found.commit.sha);
            } else {
              outcome = await readScoreAtCommit(s, s.preserved_sha);
            }

            if (outcome.verdict !== "graded") {
              if (FAILED_READ_VERDICTS.includes(outcome.verdict)) failedRead(s.github_login);
              process.stderr.write(`  ! ${s.github_login}: ${outcome.reason}\n`);
              summary.failed.push({ login: s.github_login, reason: outcome.reason, kind: outcome.kind || "no-result" });
              return;
            }

            const parsedScore = outcome.parsed;
            const earned = parsedScore.earned;
            const total = parsedScore.total > 0 ? parsedScore.total : totalFallback;
            const passed = parsedScore.passed;
            const summaryOutput = parsedScore.summaryText || "";
            // Carried to the summary row below. The Admin Panel has always
            // recorded the check run's conclusion, its URL and where the number
            // came from; this path recorded none of them, so the same file had
            // two shapes depending on which surface wrote it.
            ciRow = { parsed: parsedScore, run: outcome.run };

            result = {
              schema_version: 1,
              assignment_id: assignment.id,
              github_login: s.github_login,
              // The commit the grade was actually read at, which under a
              // hand-in marker is not always the preserved head. Still a commit
              // on the preserved branch - the hand-in is an ancestor of it -
              // so the field keeps meaning what it says.
              archive_sha: outcome.sha,
              archive_branch: archiveBranchName({
                assignmentId: opts.assignment,
                login: s.github_login,
                teamSlug: s.team_slug,
                recordedRef: s.archive_ref,
              }),
              graded_at: new Date().toISOString(),
              graded_by: gradedBy,
              runner: "github_actions",
              total_points: total,
              earned_points: earned,
              // ONE row, always, on the Actions path. This used to spread the
              // total across the configured tests proportionally - a student on
              // 12/20 was recorded as having scored 60% of the points on every
              // individual check, which is a number nobody measured and is
              // almost never what happened. A check run's annotations carry the
              // grand total and nothing else (lib/check-run-score.mjs), so a
              // per-test breakdown does not exist to report. For a real one,
              // grade locally with --runner docker.
              tests: [{
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
              teamResultsCache.set(s.team_slug, { result, ciRow, handIns, handIn });
            }
          } catch (err) {
            process.stderr.write(`  ! ${s.github_login}: checks API fetch failed - ${err.message}\n`);
            failedRead(s.github_login);
            summary.failed.push({ login: s.github_login, reason: `checks: ${err.message}`, kind: "no-result" });
            return;
          }
        } else {
          let archive;
          try {
            archive = await checkoutArchive({
              org, assignmentId: opts.assignment, login: s.github_login,
              teamSlug: s.team_slug, archiveRepo: s.archive_repo, archiveRef: s.archive_ref,
              sha: s.preserved_sha, token,
            });
          } catch (err) {
            process.stderr.write(`  ! ${s.github_login}: archive fetch failed - ${err.message}\n`);
            failedRead(s.github_login);
            summary.failed.push({ login: s.github_login, reason: `archive: ${err.message}`, kind: "no-result" });
            return;
          }
          try {
            result = await gradeOne({
              assignment, runner: opts.runner,
              login: s.github_login, sha: archive.sha, archive, gradedBy,
            });
            if (s.team_slug) {
              teamResultsCache.set(s.team_slug, { result, ciRow, handIns, handIn });
            }
          } catch (err) {
            process.stderr.write(`  ! ${s.github_login}: grading failed - ${err.message}\n`);
            failedRead(s.github_login);
            summary.failed.push({ login: s.github_login, reason: `grading: ${err.message}`, kind: "no-result" });
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
          // One builder, shared with the Admin Panel (lib/grading-summary.mjs).
          // This used to be a fourth hand-written row shape for the same file.
          summary.graded.push(
            ciRow
              ? gradedRowFromCheckRun({
                  login: s.github_login,
                  parsed: ciRow.parsed,
                  run: ciRow.run,
                  fallbackTotal: totalFallback,
                  gradedAt: result.graded_at,
                  handIns,
                  gradedSha: result.archive_sha ?? null,
                  decidedBy: decisionRecord(decision),
                  handIn,
                })
              : gradedRowFromLocalRun({
                  login: s.github_login,
                  earnedPoints: result.earned_points,
                  totalPoints: result.total_points,
                  gradedAt: result.graded_at,
                }),
          );
        } catch (err) {
          process.stderr.write(`  ! ${s.github_login}: ${err.message}\n`);
          failedRead(s.github_login);
          summary.failed.push({ login: s.github_login, reason: err.message, kind: "no-result" });
        }
      });

      if (!opts.dryRun) {
        // ONE STUDENT IS MERGED INTO THE SUMMARY ON RECORD (review 2026-10-14).
        // This wrote a summary of only that student, so `--login X` erased every
        // other score in the assignment - and on the Grading tab, where every
        // student is a row, they all turned "Not read yet". Merged against the
        // version read, and refused if another writer changed it meanwhile.
        // A whole-cohort run reads it too: a student whose read failed keeps
        // the row on record (lib/grade-cohort.mjs `keepStoredOnFailedReads`,
        // review 2026-10-14), as the page and the nightly do.
        const stored = await getGradingSummary(octokit, { org, assignmentId: opts.assignment });
        const kept = opts.login ? null : keepStoredOnFailedReads({ stored: stored?.doc ?? null, graded: summary.graded, failed: summary.failed, failedReads });
        const merged = opts.login
          ? mergeOneStudentRead({ stored: stored?.doc ?? null, read: summary, logins: queue.map((s) => s.github_login), failedReads })
          // Copies: the rows added below are not this run's failures, and the
          // exit code reads `summary.failed`.
          : { students: [...kept.graded], failed: [...kept.failed], unchanged: kept.kept };
        for (const login of merged.unchanged) {
          process.stdout.write(`  = ${login}: nothing new was read, so the result on record is unchanged\n`);
        }
        // EVERY STUDENT ON THE REPORT HAS A ROW (review 2026-10-14, R1-13).
        // This grader reads the archive, so a student with nothing preserved is
        // not in its queue, and the summary it writes replaces the whole file:
        // they were left out, and the page showed "Not read yet" beside a
        // student nothing would ever read. The row on record stays; without
        // one, a row saying why.
        // Whether a row was carried over from the summary read: then the write
        // depends on that version, as a kept row does (review 2026-10-14, P2-3).
        let carried = false;
        if (!opts.login) {
          const named = (rows, l) => (rows || []).some((r) => sameLogin(r?.login, l));
          for (const s of report.students || []) {
            const l = s?.github_login;
            if (!l || named(merged.students, l) || named(merged.failed, l)) continue;
            const storedGraded = (stored?.doc?.students || []).filter((r) => sameLogin(r?.login, l));
            const storedFailed = (stored?.doc?.failed || []).filter((r) => sameLogin(r?.login, l));
            if (storedGraded.length || storedFailed.length) {
              merged.students.push(...storedGraded);
              merged.failed.push(...storedFailed);
              carried = true;
              continue;
            }
            const nothing = s.submission_status === "no-submission";
            merged.failed.push({
              login: l,
              reason: nothing ? NO_SUBMISSION_REASON : "nothing was preserved for them at the deadline, and this grader reads the archive",
              kind: nothing ? "not-handed-in" : "no-result",
            });
          }
        }
        const summaryDoc = buildGradingSummary({
          assignmentId: opts.assignment,
          // One student merged in keeps who read the cohort, and how - as the
          // page's Read score again does (review 2026-10-14).
          gradedBy: opts.login && stored?.doc ? (stored.doc.graded_by ?? null) : gradedBy,
          runner: opts.login && stored?.doc?.runner ? stored.doc.runner : runnerName,
          students: merged.students,
          failed: merged.failed,
        });
        // Validated before it is committed, on BOTH sides. The Admin Panel has
        // checked this document since the schema existed and this side never
        // did - so the schema's own description ("TWO surfaces write this file
        // ... until this schema existed neither validated it") was true of one
        // of them for as long as it has been written down. A malformed summary
        // is not a loud failure anywhere else: the Assignment detail view joins
        // it onto the report by login, so a bad row shows up as a missing Score
        // column rather than as an error.
        const v = validateAgainst("grading-summary", summaryDoc);
        if (!v.valid) {
          // ajv returns error OBJECTS, not strings - `${e}` would print
          // "[object Object]" at the person who has to fix it.
          process.stderr.write(
            `\nthe grade summary came out malformed and was NOT written - nothing was overwritten:\n` +
              v.errors.map((e) => `  ${e.instancePath || "/"} ${e.message}\n`).join(""),
          );
          process.exit(1);
        }
        const summaryFile = gradingSummaryPath(opts.assignment);
        // Every student read again kept what was on record: there is nothing to write.
        if (opts.login && merged.unchanged.length === queue.length) {
          process.stdout.write(`\nNothing was written.\n`);
        } else await commitWithRebase(octokit, {
          owner: org, repo: CONTROL_REPO, branch: "main",
          message: `Grade ${opts.assignment}: summary (${summary.graded.length} graded, ${summary.failed.length} failed)`,
          changes: [{
            path: summaryFile,
            content: JSON.stringify(summaryDoc, null, 2) + "\n",
          }],
          // Every run that kept or carried a row from the version it read: a
          // whole-cohort run that kept nothing replaces the file by design.
          ...(opts.login || merged.unchanged.length || carried
            ? { precondition: unchangedSince(org, summaryFile, stored?.sha ?? null, "the grading summary was changed by someone else while this ran; run it again") }
            : {}),
        });
      }
      // "NO SCORE" IS SEVERAL ANSWERS (lib/grade-cohort.mjs FAILED_KINDS): not
      // handed in, late and still running each say what happened, and a cohort
      // where some students did nothing is not a run that failed. Non-zero only
      // for what needs a look - a read that failed, or a run with no result
      // (review 2026-10-15, P2-49). It exited 1 whenever anyone lacked a score.
      const toLookAt = summary.failed.filter((f) => failedReads.has(normalizeLogin(f.login)) || failedKind(f) === "no-result");
      process.stdout.write(
        `\n${summary.graded.length} graded, ${summary.failed.length} failed` +
        `${summary.failed.length ? ` (${toLookAt.length} to look at)` : ""}.\n`,
      );
      if (opts.dryRun) process.stdout.write(`(--dry-run; nothing committed.)\n`);
      if (toLookAt.length) process.exit(1);
    });
}
