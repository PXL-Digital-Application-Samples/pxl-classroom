#!/usr/bin/env node
// PXL Classroom - submission preservation.
//
// Preserves a candidate SHA from each student's repo into an instructor-controlled
// archive repo, verifies the hash, and records the result.
//
// Uses child_process.execSync for git operations (authenticated via the App
// installation token). No npm dependencies (Node 18+ fetch).

import { appendFile, readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { gh } from "../lib/gh.mjs";
import { archiveRepoName } from "../lib/archive-repo.mjs";

const env = (k, d) => process.env[k] ?? d;
const cfg = {
  token: env("GITHUB_TOKEN"),
  org: env("ORG"),
  assignmentId: env("ASSIGNMENT_ID"),
  dataDir: env("DATA_DIR"),
  // Per assignment, not per org. Resolved in validate(), once ASSIGNMENT_ID has
  // been checked - archiveRepoName returns null for an id it cannot use, and a
  // preservation must fail loudly rather than land somewhere unexpected.
  archiveRepo: null,
  apiBase: env("GITHUB_API_URL", "https://api.github.com"),
  serverUrl: env("GITHUB_SERVER_URL", "https://github.com"),
  runUrl: `${env("GITHUB_SERVER_URL", "https://github.com")}/${env("GITHUB_REPOSITORY", "_")}` +
          `/actions/runs/${env("GITHUB_RUN_ID", "0")}`,
};

// --- Actions output / summary helpers ----------------------------------------
async function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `${name}=${value ?? ""}\n`);
}
async function summary(md) {
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, md + "\n");
}
const steps = [];
const log = (step, detail) => { steps.push({ step, ...detail }); console.log(`[${detail.ok === false ? "FAIL" : "ok"}] ${step}${detail.note ? ` - ${detail.note}` : ""}`); };

async function fail(category, note) {
  log(category, { ok: false, note });
  await setOutput("outcome", category);
  await summary(`### Preserve FAILED: \`${category}\`\n\n${note ?? ""}`);
  process.exit(1);
}

// --- Strict input validation -------------------------------------------------
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/;
const PATH = /^[A-Za-z0-9._/\\:-]+$/;
// A team slug or a GitHub login - whichever names the preserved branch. Both
// shapes are already enforced at acceptance; this is the read-back check, for
// values arriving from a record a human may have edited.
const REF_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function validate() {
  if (!cfg.token) return "GITHUB_TOKEN is required (App installation token)";
  if (!cfg.org || !NAME.test(cfg.org)) return `ORG="${cfg.org}" is not a valid GitHub name`;
  if (!cfg.assignmentId || !SLUG.test(cfg.assignmentId)) return `ASSIGNMENT_ID="${cfg.assignmentId}" is not a valid slug`;
  if (!cfg.dataDir || !PATH.test(cfg.dataDir)) return `DATA_DIR="${cfg.dataDir}" is not a valid path`;
  cfg.archiveRepo = archiveRepoName(cfg.assignmentId);
  if (!cfg.archiveRepo) return `ASSIGNMENT_ID="${cfg.assignmentId}" does not yield a usable archive repository name`;
  return null;
}

// --- Git helpers (execSync, authenticated via token) -------------------------
// The credential never appears in an argument, a log line, or an error message.
//
// This used to build `https://x-access-token:<token>@github.com/...` into the
// command string and then `console.log` it - on the hub, which is a PUBLIC
// repository whose run logs anyone can read. Actions masks values registered
// with core.setSecret, and create-github-app-token does register the minted
// token, so it rendered as `***`. That is one line of defence for a credential
// that mints installation tokens for every participating org, and it only holds
// as long as nobody changes how the token is obtained.
//
// http.extraheader keeps it in the process environment instead. execSync's
// error message quotes the command, so a failed push now quotes a plain URL.
function gitEnv() {
  const basic = Buffer.from(`x-access-token:${cfg.token}`).toString("base64");
  return {
    ...process.env,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.${new URL(cfg.serverUrl).origin}/.extraheader`,
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
}

/**
 * Run git with an ARGUMENT ARRAY, never a command string.
 *
 * This was `execSync(\`git ${args}\`)`, so every value interpolated into that
 * string reached a shell: `snapshot_sha`, the repository name and the team slug
 * or login the preserved ref is built from, all read straight out of
 * `lockdowns/<id>/lockdown-record.json` and none of them shape-checked -
 * validate() covers ORG, ASSIGNMENT_ID and DATA_DIR only. That record is not a
 * hostile input, but it is a HAND-EDITED one: RUNBOOK.md §3.3 tells a lecturer
 * to delete a student's entry from it, and the loop below already anticipates
 * "a hand-edited record, a half-written one". A stray quote there turned into a
 * baffling shell error; a stray `$(...)` into something worse.
 *
 * execFileSync removes the shell from the path entirely, which is the same
 * reasoning CLAUDE.md applies to `${{ }}` in workflow YAML: the question is
 * never "is this attacker-reachable", it is "is this a literal I wrote".
 */
function git(args, opts = {}) {
  console.log(`$ git ${args.join(" ")}`);
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    ...opts,
    env: { ...gitEnv(), ...(opts.env || {}) },
  }).trim();
}

function repoUrl(repo) {
  return `${new URL(cfg.serverUrl).origin}/${cfg.org}/${repo}.git`;
}

// --- Main --------------------------------------------------------------------
async function main() {
  const bad = validate();
  if (bad) await fail("fail:validation", bad);

  // 1. Auth check
  const ping = await gh("GET", "/rate_limit");
  if (!ping.ok) await fail("fail:auth", `token rejected (HTTP ${ping.status})`);
  log("auth", { ok: true, note: "installation token accepted" });

  // 2. Ensure archive repo exists (create if missing)
  //
  // One archive per assignment, created on its first preservation. The archive
  // used to be a single per-org repository that only ever grew - see
  // lib/archive-repo.mjs for the numbers. Per assignment it dies with the
  // cohort: retiring a course year is its student repos and its archive, and
  // nothing else is in the blast radius.
  const arcCheck = await gh("GET", `/repos/${cfg.org}/${cfg.archiveRepo}`);
  if (arcCheck.status === 404) {
    const create = await gh("POST", `/orgs/${cfg.org}/repos`, {
      name: cfg.archiveRepo,
      private: true,
      description: `PXL Classroom preservation archive for ${cfg.assignmentId}. Delete with the assignment's student repositories.`,
      auto_init: true,
    });
    if (!create.ok) await fail("fail:create-archive", `create archive HTTP ${create.status} ${create.data?.message ?? ""}`);
    log("archive-repo", { ok: true, note: `created id=${create.data.id}` });
  } else if (!arcCheck.ok) {
    await fail("fail:archive-repo", `archive repo HTTP ${arcCheck.status}`);
  } else {
    log("archive-repo", { ok: true, note: `exists id=${arcCheck.data.id}` });
  }

  // 3. Read lockdown record
  let lockdownRecord;
  try {
    const raw = await readFile(join(cfg.dataDir, "lockdowns", cfg.assignmentId, "lockdown-record.json"), "utf8");
    lockdownRecord = JSON.parse(raw);
  } catch (err) {
    await fail("fail:no-lockdowns", `Could not read lockdown-record.json: ${err.message}`);
  }

  const results = lockdownRecord.results || [];
  if (results.length === 0) {
    log("preserve", { ok: true, note: "no students to preserve" });
    await setOutput("outcome", "preserved");
    process.exit(0);
  }

  let preservedCount = 0;
  let errorCount = 0;
  let noSubmissionCount = 0;
  const rows = [];

  for (const rec of results) {
    const login = rec.github_login;
    const sourceSha = rec.snapshot_sha;

    // A student whose deadline extension is still running was skipped by
    // lockdown by design, so they have no snapshot yet. That is the system
    // honouring a lecturer's decision, not a failure - counting it as one turns
    // the whole cohort's nightly amber every night until the extension expires.
    // find-finalizable.mjs re-queues the assignment once it does.
    if (!sourceSha && rec.deferred_until) {
      log(`preserve ${login}`, { ok: true, note: `deferred - extension runs to ${rec.deferred_until}` });
      rows.push(`| ${login} | - | deferred to ${rec.deferred_until} |`);
      continue;
    }

    // Under `late_policy: block`, a student who only pushed after the deadline
    // has nothing to preserve. That is the policy working, not a failure - one
    // slacker used to turn the run `partial` and the nightly amber for the
    // whole cohort. CLAUDE.md's "an empty population is not a failure" one
    // level down: it covered zero records, not zero submissions.
    if (!sourceSha && rec.no_submission) {
      noSubmissionCount++;
      log(`preserve ${login}`, { ok: true, note: "no submission before the deadline - nothing to preserve" });
      rows.push(`| ${login} | - | no submission |`);
      continue;
    }

    if (!sourceSha) {
      log(`preserve ${login}`, { ok: false, note: "no snapshot_sha" });
      errorCount++;
      rows.push(`| ${login} | - | skipped (no SHA) |`);
      continue;
    }

    // ONE BAD ROW MUST NOT FAIL THE WHOLE COHORT.
    //
    // `rec.repo_name.split("/")` used to run at the top of this loop, before
    // every guard above it. A row without a repo name - a hand-edited record, a
    // half-written one, a shape a future lockdown forgets to fill - threw a
    // TypeError straight out of the loop into `fail:exception`, so nobody's
    // submission was archived because one row was malformed. Preservation is
    // the safety net the whole deadline flow rests on; it does not get to fail
    // collectively over a single record. collect.mjs already reads the same
    // field defensively, which is what made this look like an oversight rather
    // than a decision.
    //
    // An error rather than a skip, deliberately: `login` is how
    // find-finalizable.mjs matches a pending submission, so a row missing it is
    // invisible to the retry logic and would otherwise leave the assignment
    // looking finished. The run says `partial` and a human sees the row.
    const sourceRepo = rec.repo_name?.split("/")?.[1] ?? rec.repo_name;
    if (!login || !sourceRepo) {
      const missing = [!login && "github_login", !sourceRepo && "repo_name"].filter(Boolean).join(" and ");
      log(`preserve ${login ?? "(no login)"}`, { ok: false, note: `lockdown record row has no ${missing}` });
      errorCount++;
      rows.push(`| ${login ?? "(no login)"} | \`${String(sourceSha).slice(0, 12)}\` | fail: record row has no ${missing} |`);
      continue;
    }

    // SHAPE-CHECK EVERY VALUE THAT BECOMES A GIT ARGUMENT OR A REF.
    //
    // validate() covers ORG, ASSIGNMENT_ID and DATA_DIR; these three come out of
    // `lockdowns/<id>/lockdown-record.json`, which the loop above already treats
    // as possibly hand-written - and RUNBOOK.md §3.3 tells a lecturer to edit
    // it. A malformed sha or slug is one bad row, not a reason to fail the
    // cohort, so it is reported the same way a missing field is.
    const targetRefKey = rec.team_slug || login;
    const shapeProblem =
      !/^[0-9a-f]{7,40}$/i.test(String(sourceSha)) ? `snapshot_sha "${sourceSha}" is not a git object id`
      : !NAME.test(String(sourceRepo)) ? `repo_name "${rec.repo_name}" is not a valid repository name`
      : !REF_KEY.test(String(targetRefKey)) ? `"${targetRefKey}" is not a valid team slug or login`
      : null;
    if (shapeProblem) {
      log(`preserve ${login}`, { ok: false, note: shapeProblem });
      errorCount++;
      rows.push(`| ${login} | \`${String(sourceSha).slice(0, 12)}\` | fail: ${shapeProblem} |`);
      continue;
    }
    const workDir = await mkdtemp(join(tmpdir(), `pxl-preserve-${targetRefKey}-`));
    const presRef = `refs/heads/preserved/${cfg.assignmentId}/${targetRefKey}`;
    let verified = false;

    try {
      const srcUrl = repoUrl(sourceRepo);
      const arcUrl = repoUrl(cfg.archiveRepo);
      const cloneDir = join(workDir, "src");

      await mkdir(cloneDir);
      git(["init", "--bare"], { cwd: cloneDir });
      // Full fetch, NOT --depth=1. A shallow fetch grafts away the commit's
      // ancestors, so the pack we then push references objects the archive
      // does not have and the remote rejects it with
      //   "remote unpack failed: index-pack failed".
      // That only bites once a student has more than the initial template
      // commit, which is why shallow appeared to work at first.
      git(["fetch", "--no-tags", srcUrl, sourceSha], { cwd: cloneDir });

      try {
        git(["cat-file", "-e", sourceSha], { cwd: cloneDir });
      } catch {
        throw new Error(`SHA ${sourceSha} not found in ${cfg.org}/${sourceRepo}`);
      }

      // NOT --force. An organization is entitled to forbid force-push with a
      // ruleset - PXL-Systems-Expert carries Classroom50 rulesets that do - and
      // a rejected push here fails preservation for every student, which is the
      // safety net the whole deadline flow rests on. The broker publish was
      // fixed for exactly this in ec896c8; this was the sibling it missed.
      //
      // Nothing is lost by dropping it: refs/heads/preserved/<id>/<login|team>
      // is fresh per student, and lockdown.mjs freezes snapshot_sha across
      // retries, so a retry pushes the same SHA to the same ref. A genuine
      // non-fast-forward here means the archive holds something we did not put
      // there, and overwriting it silently is the wrong answer.
      git(["push", "--quiet", arcUrl, `${sourceSha}:${presRef}`], { cwd: cloneDir });

      const lsOut = git(["ls-remote", arcUrl, presRef], { cwd: cloneDir });
      const remoteSha = lsOut.split(/\s/)[0] || "";
      verified = remoteSha === sourceSha;
      
      if (!verified) throw new Error("remote SHA mismatch after push");

      // Record preservation status
      const preservation = {
        schema_version: 1,
        assignment_id: cfg.assignmentId,
        github_login: login,
        team_slug: rec.team_slug || undefined,
        source_repo: `${cfg.org}/${sourceRepo}`,
        source_repo_id: rec.repo_id,
        source_sha: sourceSha,
        archive_repo: `${cfg.org}/${cfg.archiveRepo}`,
        preserved_ref: presRef,
        verified,
        preserved_at: new Date().toISOString(),
        observer_run: cfg.runUrl,
      };
      const presDir = join(cfg.dataDir, "observations", cfg.assignmentId, login);
      await mkdir(presDir, { recursive: true });
      await writeFile(join(presDir, "preservation.json"), JSON.stringify(preservation, null, 2) + "\n");

      preservedCount++;
      log(`preserve ${login}`, { ok: true, note: `preserved ${sourceSha.slice(0, 12)} -> ${presRef}` });
      rows.push(`| ${login} | \`${sourceSha.slice(0, 12)}\` | [OK] preserved |`);
    } catch (e) {
      log(`preserve ${login}`, { ok: false, note: e.message });
      errorCount++;
      rows.push(`| ${login} | \`${sourceSha.slice(0, 12)}\` | fail: ${e.message} |`);
    } finally {
      try { await rm(workDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }

  // 4. Outputs & summary
  const outcome = errorCount === 0 ? "preserved" : preservedCount > 0 ? "partial" : "fail:all-errors";
  await setOutput("outcome", outcome);
  await setOutput("preserved_count", preservedCount);
  await setOutput("no_submission_count", noSubmissionCount);
  await setOutput("error_count", errorCount);
  await summary(
    `### Preserve: \`${outcome}\`\n\n` +
    `| student | SHA | status |\n|---|---|---|\n` +
    rows.join("\n") + "\n\n" +
    `**${preservedCount}** preserved` +
    (noSubmissionCount ? `, **${noSubmissionCount}** with no submission` : "") +
    `, **${errorCount}** errors.\n`
  );
  log("done", { ok: errorCount === 0, note: `${outcome} (${preservedCount} preserved, ${noSubmissionCount} no-submission, ${errorCount} err)` });
  process.exit(outcome.startsWith("fail:") ? 1 : 0);
}

main().catch(async (e) => { await fail("fail:exception", e.message); });
