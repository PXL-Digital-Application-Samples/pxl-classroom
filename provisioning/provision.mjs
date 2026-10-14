#!/usr/bin/env node
// PXL Classroom - production provisioner.
//
// Creates a private org repo from a private template, grants a student a role
// (default admin), records the immutable repo ID, and is idempotent: a re-run
// reuses the existing repo instead of creating a duplicate.
//
// Auth: GITHUB_TOKEN must be a GitHub App INSTALLATION token (minted by the
// composite action via actions/create-github-app-token). Inputs come from env.
// Emits GitHub Actions outputs (repo_id, repo_url, repo_name, outcome) and a
// step summary. No npm dependencies (Node 18+ fetch).

import { appendFile, readFile, readdir, mkdtemp, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { gh } from "../lib/gh.mjs";
import { gitAuthEnv, gitRepoUrl } from "../lib/git-auth.mjs";
import { sameLogin } from "../lib/github-login.mjs";
import { APP_SLUG } from "../lib/deployment.mjs";
import { applyStudentPermission } from "../lib/permission-change.mjs";
import { GRADE_DISPATCH_INPUT, GRADE_RUN_NAME, gradeCheckoutStep, gradeDispatchTrigger } from "../lib/grade-dispatch.mjs";
import { parse, stringify as stringifyYaml } from "yaml";
import { PROVISIONABLE_BRANCH, resolveTemplatePin } from "../lib/template-source.mjs";
import { emptyFromCommits, mayStillBeFilling } from "../lib/existing-repo.mjs";
import { repoTouched } from "../lib/untouched-repo.mjs";
import { generatedFromTemplate } from "../lib/starter-sync-cohort.mjs";
// The branch grading reads from. One decision, one implementation - the
// generated workflow has to fire on the branch the reader walks.
import { submissionBranch } from "../lib/submission-marker.mjs";
import { deadlineVariableValue, writeDeadlineVariable } from "../lib/deadline-variable.mjs";

const env = (k, d) => process.env[k] ?? d;
const cfg = {
  token: env("GITHUB_TOKEN"),
  org: env("ORG"),
  templateOwner: env("TEMPLATE_OWNER"),
  templateRepo: env("TEMPLATE_REPO"),
  // "" means NOT PINNED, which every assignment predating the pin is. Parsed
  // to null rather than left as a string so the comparison below cannot be a
  // number-versus-string mismatch that reports every template as replaced.
  templateRepositoryId: /^\d+$/.test(env("TEMPLATE_REPOSITORY_ID", "")) ? Number(env("TEMPLATE_REPOSITORY_ID", "")) : null,
  targetRepo: env("TARGET_REPO"),
  assignmentId: env("ASSIGNMENT_ID"),
  studentLogin: env("STUDENT_LOGIN"),
  permission: env("STUDENT_PERMISSION", "admin"),
  isPrivate: env("PRIVATE", "true") !== "false",
  dryRun: env("DRY_RUN", "0") === "1",
  feedbackPr: env("FEEDBACK_PR", "false") === "true",
  baselineBranch: env("FEEDBACK_PR_BASELINE_BRANCH", "pxl-baseline"),
  previousRepo: env("PREVIOUS_REPO", ""),
  // Exactly "true", as for recreateEmpty below: accept.mjs removed the team the
  // student left, and its repository goes too if it STILL holds nothing
  // anybody pushed when this step gets to it.
  removePreviousRepo: env("REMOVE_PREVIOUS_REPO", "") === "true",
  // Exactly "true". Absent, empty or anything else keeps an existing
  // repository: the safe default is never to delete.
  recreateEmpty: env("RECREATE_EMPTY", "") === "true",
  // Exactly "true": the assignment's `template_full_history`. Anything else is
  // GitHub's template copy, which is what every assignment before it meant.
  fullHistory: env("TEMPLATE_FULL_HISTORY", "") === "true",
  apiBase: env("GITHUB_API_URL", "https://api.github.com"),
  serverUrl: env("GITHUB_SERVER_URL", "https://github.com"),
};

// --- Actions output / summary helpers --------------------------------------
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
  await summary(`### Provisioning FAILED: \`${category}\`\n\n${note ?? ""}`);
  process.exit(1);
}

// --- Strict input validation (security requirement) -------------------------
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;          // org / repo names
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;        // GitHub login
const PERMS = ["pull", "triage", "push", "maintain", "admin"];
const BRANCH = PROVISIONABLE_BRANCH;                         // baseline and copied default branch names

function validate() {
  if (!cfg.token) return "GITHUB_TOKEN is required (App installation token)";
  for (const [k, v] of [["ORG", cfg.org], ["TEMPLATE_OWNER", cfg.templateOwner], ["TEMPLATE_REPO", cfg.templateRepo], ["TARGET_REPO", cfg.targetRepo]]) {
    if (!v) return `${k} is required`;
    if (!NAME.test(v)) return `${k}="${v}" is not a valid GitHub name`;
  }
  if (!LOGIN.test(cfg.studentLogin || "")) return `STUDENT_LOGIN="${cfg.studentLogin}" is not a valid GitHub login`;
  if (!PERMS.includes(cfg.permission)) return `STUDENT_PERMISSION="${cfg.permission}" must be one of ${PERMS.join(", ")}`;
  if (cfg.feedbackPr && !BRANCH.test(cfg.baselineBranch)) return `FEEDBACK_PR_BASELINE_BRANCH="${cfg.baselineBranch}" is not a valid branch name`;
  return null;
}

// --- Feedback-PR: baseline branch + protection ------------------------------
//
// Creates a frozen branch (idempotent) pointing at the repo's default-branch
// HEAD and protects it against force-push/delete. The Feedback PR itself
// cannot be opened at provisioning time because main and the baseline point
// at the same SHA - GitHub returns 422 "No commits between …". The PR is
// `POST /repos/{tpl}/generate` RETURNS BEFORE THE REPOSITORY HAS ANY CONTENT.
//
// GitHub creates the repository object and populates it from the template
// asynchronously. Every write this file does afterwards was racing that, and
// the race has two losing outcomes - measured three times on
// pxl-classroom-testbed, 2026-09-08:
//
//   * the write lands first and becomes the repository's ROOT commit; the
//     population commit arrives a second later and its diff reads
//     `removed .github/workflows/autograding.yml`. The student has the starter
//     code and no grading workflow.
//   * the write lands first and population never comes at all. The student has
//     a grading workflow and NO STARTER CODE.
//
// Both reported `[ok] inject-autograding` and exited `created`, because the PUT
// itself succeeds either way - it is the repository that changes underneath it.
// The same race makes the "did the template already ship a grading workflow?"
// check answer `no` about a repository that has not been filled in yet.
//
// So: anything that writes to a freshly generated repository waits for it
// first. Only the writers call this, so an ordinary assignment - no autograde
// block, no feedback PR - pays nothing and its timing is unchanged.
let repoPopulated = false;
// How many 2-second checks a KEPT empty repository gets to fill (step 3):
// two minutes, inside the job's fifteen. `PXL_FILL_WAIT_CHECKS` exists for the
// unit test, which would otherwise wait the two minutes for a stub.
const FILL_WAIT_CHECKS = Number(process.env.PXL_FILL_WAIT_CHECKS) > 0 ? Number(process.env.PXL_FILL_WAIT_CHECKS) : 60;
// ...and the time between them. `PXL_FILL_WAIT_DELAY_MS` is for the test that
// runs the wait as provisioning computes it, unpinned (TA-3); no workflow sets it.
const FILL_WAIT_DELAY_MS = Number(process.env.PXL_FILL_WAIT_DELAY_MS) > 0 ? Number(process.env.PXL_FILL_WAIT_DELAY_MS) : 2000;
// The longest one git command of a full-history copy may take (clone, then
// push): four minutes each, so both together end inside the ten minutes
// `mayStillBeFilling` keeps a new repository from being removed by a retry.
// `PXL_GIT_STEP_MS` is for the tests, which stall a git server; no workflow sets it.
const GIT_STEP_MS = Number(process.env.PXL_GIT_STEP_MS) > 0 ? Number(process.env.PXL_GIT_STEP_MS) : 4 * 60 * 1000;

/**
 * How many 2-second checks a kept empty repository gets to fill. Another run's
 * GitHub copy fills in seconds, so two minutes; a full-history copy is a clone
 * and a push of up to `GIT_STEP_MS` each, so a teammate joining while the
 * first member's copy is running waits until that copy's own limit has passed
 * (counted from when the repository was created), not two minutes and a failure
 * telling them to come back (review 2026-10-14, AC7).
 *
 * @param {{ fullHistory: boolean, createdAt?: unknown, now?: Date, base?: number, stepMs?: number }} p
 */
export function fillWaitChecks({ fullHistory, createdAt, now = new Date(), base = FILL_WAIT_CHECKS, stepMs = GIT_STEP_MS }) {
  if (!fullHistory) return base;
  const created = typeof createdAt === "string" ? Date.parse(createdAt) : NaN;
  const limit = 2 * stepMs + 60 * 1000;
  const left = Number.isFinite(created) ? created + limit - now.getTime() : limit;
  return Math.max(base, Math.ceil(left / 2000));
}

async function ensureRepoPopulated({ attempts = 30, delayMs = 1000 } = {}) {
  if (repoPopulated) return true;
  for (let i = 0; i < attempts; i++) {
    const res = await gh("GET", `/repos/${cfg.org}/${cfg.targetRepo}/contents/`);
    // 404 is "this repository is empty" here, not "no such repository" - the
    // repository object exists, we created it. An empty ARRAY is the same
    // state through a different door.
    if (res.ok && Array.isArray(res.data) && res.data.length > 0) {
      repoPopulated = true;
      if (i > 0) log("await-template", { ok: true, note: `populated after ${i + 1} check(s)` });
      return true;
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

// opened lazily by `pxl-classroom feedback open` once the student has pushed.
/**
 * @param {{ default_branch?: string }} repo
 * @param {{ copiedTemplateBranches?: boolean }} [opts] this run copied every
 *   branch of the template into the repository (a full-history copy it made):
 *   a branch with the baseline's name is then the template's, never ours.
 */
/**
 * Whether a branch named like the feedback baseline in a copy this system
 * PUSHED (a full-history copy: GitHub's own copy names its template and takes
 * the default branch only) is the template's: the template has a branch of
 * that name at that commit. One an earlier run of ours made is not, and is
 * adopted. A template that cannot be read adopts nothing (P2-21).
 */
async function templateOwnsBranch(repo, branch, sha) {
  if (repo?.template_repository) return false;
  const tplRef = await gh("GET", `/repos/${cfg.templateOwner}/${cfg.templateRepo}/git/ref/heads/${branch}`);
  if (tplRef.status === 404) return false;
  if (!tplRef.ok) return true;
  return tplRef.data?.object?.sha === sha;
}

async function setupFeedbackBaseline(repo, { copiedTemplateBranches = false } = {}) {
  const branch = cfg.baselineBranch;
  const defaultBranch = repo.default_branch || "main";

  // Same race as the autograding injection: on a freshly generated repository
  // `refs/heads/<default>` does not exist yet, and a baseline branched from
  // nothing is a feedback PR the lecturer never gets. This one degrades rather
  // than failing the provisioning - the feedback PR is optional scaffolding and
  // the student's repository is already usable without it.
  if (!(await ensureRepoPopulated())) {
    log("feedback-baseline", { ok: false, note: `${cfg.targetRepo} is still empty after generate - no baseline` });
    return null;
  }

  const head = await gh("GET", `/repos/${cfg.org}/${cfg.targetRepo}/git/ref/heads/${defaultBranch}`);
  if (!head.ok) { log("feedback-baseline", { ok: false, note: `read ${defaultBranch} HTTP ${head.status}` }); return null; }
  const sha = head.data.object.sha;

  const exists = await gh("GET", `/repos/${cfg.org}/${cfg.targetRepo}/git/ref/heads/${branch}`);
  if (exists.status === 404) {
    const make = await gh("POST", `/repos/${cfg.org}/${cfg.targetRepo}/git/refs`, {
      ref: `refs/heads/${branch}`, sha,
    });
    if (!make.ok) { log("feedback-baseline", { ok: false, note: `create ${branch} HTTP ${make.status}` }); return null; }
    log("feedback-baseline", { ok: true, note: `created ${branch}@${sha.slice(0, 12)}` });
  } else if (exists.ok && (copiedTemplateBranches || (await templateOwnsBranch(repo, branch, exists.data?.object?.sha)))) {
    // The template's own branch, which the copy brought: adopted, it was
    // protected against the exercise that needs it, and every feedback PR
    // opened on day one with the template's difference as the student's work
    // (review 2026-10-14, S2). The publish preflight refuses such a template;
    // this is for one changed since. On a REUSED copy too (P2-21): a retry is
    // not this run's copy, but the branch still came from the template.
    log("feedback-baseline", { ok: false, note: `the template has its own ${branch} branch, which came with the copy - it is left as it is, and there is no feedback baseline` });
    return null;
  } else if (exists.ok) {
    log("feedback-baseline", { ok: true, note: `${branch} already exists @${exists.data.object.sha.slice(0, 12)}` });
  }

  // Protection: only the fields we care about; the App's admin role outranks
  // student admin so the student cannot force-push or delete the baseline.
  const prot = await gh("PUT", `/repos/${cfg.org}/${cfg.targetRepo}/branches/${encodeURIComponent(branch)}/protection`, {
    required_status_checks: null,
    enforce_admins: false,
    required_pull_request_reviews: null,
    restrictions: null,
    allow_force_pushes: false,
    allow_deletions: false,
  });
  if (!prot.ok) {
    log("feedback-baseline-protect", { ok: false, note: `protect HTTP ${prot.status} ${prot.data?.message ?? ""}` });
  } else {
    log("feedback-baseline-protect", { ok: true, note: `protected ${branch}` });
  }
  return sha;
}

/**
 * `timeout_s` seconds -> the MINUTES every classroom-resources grader wants.
 *
 * Their `action.yml` says so in as many words - "Duration (in minutes) before
 * the test is terminated" - and the schema field is seconds, capped at 600.
 * Handing the number straight over turned a 30-second test into a 30-MINUTE
 * one on Actions while both CLI runners still stopped it at 30 seconds: the
 * same test definition meaning two different things, and a student's runaway
 * loop billing the org sixty times what the lecturer asked for. Rounded UP so a
 * sub-minute limit stays a limit rather than becoming zero.
 */
/**
 * Why the full-history copy failed, in this system's words and never git's:
 * git's lines name branches and files of a template that may be private, and
 * the hub's run log is public (review 2026-10-14, AC12). Known causes are
 * named; anything else is the stage and git's exit code.
 *
 * @param {string} stage  which step failed, in words
 * @param {{ stderr?: unknown, message?: unknown, status?: number|null, signal?: string|null, code?: string }} err  execFileSync's error
 * @param {number} limitMs  the per-step time limit
 */
export function gitCopyFailure(stage, err, limitMs) {
  const text = `${err?.stderr ?? ""}\n${err?.message ?? ""}`;
  if (err?.code === "ETIMEDOUT" || err?.signal === "SIGTERM") {
    return `${stage} did not finish within ${Math.round(limitMs / 60000)} minutes`;
  }
  if (/Authentication failed|could not read Username|terminal prompts disabled|HTTP 40[13]|returned error: 40[13]/i.test(text)) {
    return `${stage} was refused by GitHub: PXL Classroom's access to that repository was not accepted`;
  }
  if (/GH001|exceeds GitHub's file size limit|large files detected/i.test(text)) {
    return `${stage} was refused by GitHub: a file in the template is larger than GitHub accepts`;
  }
  if (/refusing to allow .* to create or update workflow|workflows? .*permission/i.test(text)) {
    return `${stage} was refused by GitHub: it may not write a workflow file there`;
  }
  if (/GH013|protected branch|rule violations|pre-receive hook declined/i.test(text)) {
    return `${stage} was refused by GitHub: a rule on the repository rejected it`;
  }
  return `${stage} failed (git exited with code ${Number.isInteger(err?.status) ? err.status : "unknown"})`;
}

export function graderTimeoutMinutes(test) {
  const seconds = Number(test?.timeout_s);
  if (!Number.isFinite(seconds) || seconds <= 0) return 1;
  return Math.max(1, Math.ceil(seconds / 60));
}

// Built as an object and serialised by the YAML library, never by string
// concatenation.
//
// The previous version pasted lecturer-authored test config straight into a
// YAML template: `command: "${t.command}"`. A command containing a double quote
// - `grep "needle" file` - closed the string early and produced a workflow that
// does not parse, in EVERY student repository, discovered by the student when
// their grading run goes red. A colon in an id did the same to `- name:`. There
// is no escaping to get right if nothing is concatenated.
// `org` is retained for the signature every caller and test already uses; the
// workflow no longer depends on it. It was the owner of the reusable workflow
// the withdrawn `visibility: private` branch called - see below.
export function buildAutogradingWorkflow(assignment, org) {
  const shell = {
    name: "Autograding",
    // THE BRANCH IS THE ASSIGNMENT'S, not `main`. `submission_ref` is a real
    // field with a real default, and the READER already honours it -
    // `submissionBranch()` in lib/submission-marker.mjs is what grading walks.
    // Hardcoding `main` here meant an assignment collecting on any other branch
    // got a grading workflow that never fires on the branch being graded: no
    // check run at that commit, so the score read reports "no grading run" and
    // the assignment looks configured. Two halves of one fact, in two files,
    // with nothing deriving either from the other.
    on: { push: { branches: [submissionBranch(assignment)] }, ...gradeDispatchTrigger() },
    // A lecturer's "grade this commit now" (lib/grade-dispatch.mjs) runs on the
    // same branch ref as a push; its own group, so the two never cancel each
    // other - a student's next push must not kill the lecturer's run.
    "run-name": GRADE_RUN_NAME,
    // Pushes share one group, newest wins. Each DISPATCH is its own group: a
    // second one for the same commit (another lecturer, or the student) must
    // not cancel a run whose id a lecturer may already have recorded.
    concurrency: { group: `autograde-\${{ github.ref }}-\${{ inputs.${GRADE_DISPATCH_INPUT} && github.run_id || 'push' }}`, "cancel-in-progress": true },
  };

  // THERE IS ONE PATH, and there only ever was one that worked.
  //
  // `visibility: private` emitted `uses: <org>/<control repo>/.github/workflows/
  // grade.yml@main` - a reusable workflow in the per-org control repository.
  // Nothing in this repository has ever created that file, and nothing may:
  // §3.1 is that control repos hold data and contain no workflows, which is
  // what keeps the system upgradable in one place and participating-org Actions
  // budgets near zero. So the generated workflow named a file that cannot
  // exist, in every student repository, and GitHub refuses the run outright.
  //
  // It was also the DEFAULT the Admin Panel offered ("No - the checks stay in
  // the control repository and run from there"), which made it a control
  // describing behaviour the system does not have. The option is withdrawn
  // rather than built: building it would put a workflow in the control repo.
  //
  // `visibility` survives in the schema so a document carrying one still
  // validates, exactly as `acceptance_mode` does with its single implemented
  // value (§5.4), and nothing reads it any more.
  const tests = assignment?.autograde?.tests || [];
  if (tests.length === 0) {
    // Public visibility with no checks used to emit `run: npm test` - a
    // hardcoded guess at the student's toolchain, reported as this
    // assignment's grade in every repository. `tests` has `minItems: 1` and the
    // Admin Panel can no longer produce an enabled-but-empty configuration
    // (ARCHITECTURE §11.6), so this is now only reachable from a hand-written YAML
    // the schema would reject - and a guess was never a defensible default
    // there either. A job that does nothing is honest; a job that runs someone
    // else's test command and calls the result a grade is not.
    return stringifyYaml({
      ...shell,
      jobs: {
        grade: {
          "runs-on": "ubuntu-latest",
          "timeout-minutes": 10,
          steps: [
            {
              name: "No checks configured",
              run: "echo 'This assignment has autograding enabled but defines no checks.' >&2\nexit 1",
            },
          ],
        },
      },
    });
  }

  // v4 runs on Node 20, which GitHub has deprecated - every student's grading
  // run carried a warning annotation saying so, measured live 2026-08-26. A
  // FLOATING major here, unlike the hub's pinned SHAs: this workflow is written
  // into every student repository, so a pin freezes hundreds of copies at a
  // commit somebody has to remember to bump, and those repos hold no credential
  // beyond their own GITHUB_TOKEN. The classroom-resources graders below are
  // still v1 and still on Node 20 - upstream has published nothing newer, so
  // that warning is not ours to remove.
  // The commit a lecturer named on a dispatch, the pushed one otherwise.
  const steps = [gradeCheckoutStep()];
  const runnerIds = [];
  const env = {};

  for (const t of tests) {
    const runnerId = String(t.id || "test").toLowerCase().replace(/[^a-z0-9_-]/g, "-");
    runnerIds.push(runnerId);
    // THE REPORTER DERIVES THIS NAME; we do not get to choose it. Measured
    // against the published source of autograding-grading-reporter@v1:
    //
    //   process.env[`${runner.trim().toUpperCase()}_RESULTS`]
    //
    // The runner id is upper-cased and NOTHING ELSE - a hyphen stays a hyphen,
    // which is what GitHub Classroom's own generated workflows write
    // (`VPC-TEST_RESULTS` for a `vpc-test` runner, live in
    // PXL-2TIN-CloudEssentials-2627/template_proef_PE1).
    //
    // This used to fold `[^A-Z0-9_]` to `_`, defending against two ids
    // differing only by `-` vs `_`. That collision cannot exist: the schema's
    // id pattern is `^[a-z0-9][a-z0-9-]{0,63}$`, so an underscore never
    // arrives. What the defence actually did was rename the variable the
    // reporter looks up, so `process.env[...]` was `undefined` for every
    // hyphenated id - and a hyphen is the only separator the pattern allows.
    // `Buffer.from(undefined, "base64")` then threw, and the reporter's catch
    // block blamed the `runners` input: "must be a comma-separated list of
    // strings", which it was. Measured on the testbed 2026-09-08: every grader
    // step green, the whole grading job red, no score annotations at all.
    env[`${runnerId.toUpperCase()}_RESULTS`] = `\${{ steps.${runnerId}.outputs.result }}`;

    const common = { name: String(t.id ?? "test"), id: runnerId };
    if (t.type === "io") {
      steps.push({
        ...common,
        uses: "classroom-resources/autograding-io-grader@v1",
        with: {
          "test-name": String(t.id ?? "test"),
          command: t.command || "",
          input: t.stdin || "",
          "expected-output": t.expected_stdout || "",
          // `exact`, and it is the CLI runners' rule rather than a preference.
          // `runner-host.mjs` and `runner-docker.mjs` both compare
          // `normalize(stdout) === normalize(expected_stdout)` - equality after
          // trailing whitespace - and the grader trims its own output before
          // comparing, so `exact` is the same test on both paths. A substring
          // rule would not be, and this file's own §11.6 rule is that one test
          // definition means one thing.
          //
          // It was `included`, which autograding-io-grader@v1 DOCUMENTS in its
          // action.yml ("Supported values: `included`, `exact`, `regex`") and
          // its code REFUSES: `getInputs()` throws on anything outside
          // ['exact','contains','regex']. The throw lands in a catch that emits
          // a result with no `max_score` at all, so the reporter counted the
          // check as 0 out of **0** - the assignment's own total silently
          // shrank, ten points reported as seven, and the io check was marked
          // failed rather than errored. Measured on the testbed 2026-09-08.
          "comparison-method": "exact",
          timeout: graderTimeoutMinutes(t),
          "max-score": t.points || 1,
        },
      });
    } else if (t.type === "python") {
      // `script` is the ONLY field a python test reads, here and on both CLI
      // runners (`runner-host.mjs` and `runner-docker.mjs` each write it to
      // `t.py` and run `python3` over it). This used to emit
      // `t.command || "pytest"` and ignore `script` entirely - and the Admin
      // Panel only ever writes `script` - so the same test definition meant the
      // lecturer's script on the CLI and the student repo's own pytest suite on
      // Actions. The schema now requires `script` for `type: python`, so there
      // is no second field left to disagree about.
      //
      // The script reaches the file through `env:`, never through the run text.
      // Pasting it in is F15 again: the first quote in a lecturer's source
      // closes the string and every student's workflow stops parsing.
      const scriptPath = `.pxl-autograde/${runnerId}.py`;
      steps.push({
        name: `Write ${runnerId} script`,
        run: `mkdir -p .pxl-autograde\nprintf '%s' "$PXL_SCRIPT" > "$PXL_SCRIPT_PATH"\n`,
        env: { PXL_SCRIPT: String(t.script ?? ""), PXL_SCRIPT_PATH: scriptPath },
      });
      // THE COMMAND GRADER, NOT THE PYTHON ONE, and the difference is that this
      // one builds.
      //
      // `classroom-resources/autograding-python-grader@v1` is a Docker action
      // whose own Dockerfile runs `apt-get install jq` and fails with exit 100.
      // GitHub builds every Docker action in a job BEFORE running any step, so
      // it does not merely fail its own check - it takes the whole grading job
      // down and every other check with it, `io` and `run` included. Measured
      // 2026-09-09 on a live drill: three build attempts, all failed, every
      // step after `Set up job` skipped, no score for anybody. The same
      // assignment with the python step removed scored 6/6.
      //
      // Nothing is lost by the swap. We were already using the python grader as
      // a plain command runner: `setup-command` is empty (the CLI runners
      // install nothing before running the script, so neither does this, and
      // `setup_command` is not a schema field - `additionalProperties: false`
      // means it could never legitimately arrive), and `command` is the same
      // `python3 <script>` either way. The python grader adds nothing over the
      // command grader here except a container that will not build.
      steps.push({
        ...common,
        uses: "classroom-resources/autograding-command-grader@v1",
        with: {
          "test-name": String(t.id ?? "test"),
          command: `python3 ${scriptPath}`,
          timeout: graderTimeoutMinutes(t),
          "max-score": t.points || 1,
        },
      });
    } else {
      steps.push({
        ...common,
        uses: "classroom-resources/autograding-command-grader@v1",
        with: {
          "test-name": String(t.id ?? "test"),
          command: t.command || "exit 0",
          timeout: graderTimeoutMinutes(t),
          "max-score": t.points || 1,
        },
      });
    }
  }

  steps.push({
    name: "Autograding Reporter",
    uses: "classroom-resources/autograding-grading-reporter@v1",
    env,
    with: { runners: runnerIds.join(",") },
  });

  return stringifyYaml({
    ...shell,
    jobs: { grade: { "runs-on": "ubuntu-latest", "timeout-minutes": 10, steps } },
  });
}

// --- A template copied with every branch and its whole history -------------
//
// `generate` gives a repository one commit, and with `include_all_branches`
// one commit per branch with no history in common, so branches cannot be
// merged into each other. A git exercise with prepared branches to merge,
// rebase or repair cannot be built on that (asked 2026-10-14). With the
// assignment's `template_full_history` the repository is created EMPTY and
// the template is pushed into it whole: every branch and tag, every commit,
// the same SHAs. A fork would carry the same, and is not used: deleting a
// private template deletes every fork of it, and the forks inherit the
// template's team access.
//
// What the student's repository was given is recorded (`starter_sha`, read at
// the end, after anything this step adds), because "not started" can no longer
// mean "one commit": such a repository has the template's history from the
// first second.
async function createWithFullHistory(tpl) {
  const branch = tpl.data?.default_branch;
  if (!branch || !BRANCH.test(branch)) {
    await fail("fail:create", `${cfg.templateOwner}/${cfg.templateRepo} reports no usable default branch ("${branch ?? ""}")`);
  }
  const created = await gh("POST", `/orgs/${cfg.org}/repos`, { name: cfg.targetRepo, private: cfg.isPrivate, auto_init: false });
  if (!created.ok) await fail("fail:create", `create HTTP ${created.status} ${created.data?.message ?? ""}`);
  const repo = created.data;
  log("create", { ok: true, note: `id=${repo.id} ${repo.html_url} (empty, for the template's full history)` });
  // Said before the copy, for the reason the generate path says it at once: a
  // failure below leaves this repository behind, and its team must be told.
  await setOutput("repo_id", repo.id ?? "");
  await setOutput("repo_url", repo.html_url ?? "");
  await setOutput("repo_name", repo.full_name ?? "");

  const work = await mkdtemp(join(tmpdir(), "pxl-history-"));
  const bare = join(work, "template.git");
  const env = { ...process.env, ...gitAuthEnv(cfg.token, cfg.serverUrl), GIT_TERMINAL_PROMPT: "0" };
  // An argument array, never a shell string, and stdin closed so a missing
  // credential fails instead of waiting for a password nobody will type. And a
  // time limit (review 2026-10-14): a stalled clone or push otherwise ran to
  // the job's own timeout instead of failing as `fail:create`, and the clone
  // and the push together stay inside the ten minutes a retry leaves a new
  // repository alone for (`mayStillBeFilling`), so no retry removes one this
  // run is still pushing into.
  const git = (args, cwd) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: GIT_STEP_MS }).trim();
  let copyFailed = "";
  let pushed = null;
  let stage = "the clone of the template";
  try {
    // `--bare`, not `--mirror`: a mirror clone of a GitHub repository also
    // fetches refs/pull/*, which GitHub refuses on push. GitHub's own
    // "duplicating a repository" is exactly these two commands.
    git(["clone", "--bare", "--quiet", gitRepoUrl(cfg.serverUrl, cfg.templateOwner, cfg.templateRepo), bare], work);
    // `--atomic`: every branch or none. A copy cut off halfway would be a
    // repository with SOME of the exercise in it, which a retry reuses as it
    // is; an empty one it removes and copies again (step 3).
    stage = "the push into the student's repository";
    git(["push", "--mirror", "--atomic", "--quiet", gitRepoUrl(cfg.serverUrl, cfg.org, cfg.targetRepo)], bare);
    stage = "reading back what was pushed";
    // WHAT WAS PUSHED is what the repository was given, known here for certain
    // rather than read back afterwards: a read that failed three times left a
    // copy with no starting commit, which the report then read as GitHub's
    // copy - the template's commits as the student's (review 2026-10-14).
    const head = git(["rev-parse", `refs/heads/${branch}`], bare);
    pushed = { head, count: Number(git(["rev-list", "--count", head], bare)) };
    // A count, never the names: the hub's run log is public, and a private
    // template's branch names can say what the exercise is.
    const branches = git(["for-each-ref", "--format=%(refname:short)", "refs/heads"], bare).split("\n").filter(Boolean);
    log("copy-history", { ok: true, note: `${branches.length} branch(es) with their history` });
  } catch (e) {
    // What went wrong in OUR words, never git's (review 2026-10-14, AC12):
    // its lines name branches and files of a private template, and this log
    // is public. `gitCopyFailure` classifies; an unknown failure is its exit code.
    copyFailed = gitCopyFailure(stage, e, GIT_STEP_MS);
  } finally {
    // Before any failure is reported: fail() ends the process, finally or not.
    // Best effort (TA-3): a git the step limit killed can still hold the
    // directory for a moment, and the removal's error replaced the copy's own
    // failure with `fail:exception`. The runner is discarded after the job.
    await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  }
  if (copyFailed) {
    await fail(
      "fail:create",
      `${cfg.org}/${cfg.targetRepo} was created, but copying ${cfg.templateOwner}/${cfg.templateRepo} with its history ` +
        `into it failed: ${copyFailed}. Retry this student in ten minutes: an attempt then removes the empty repository and copies it again.`,
    );
  }

  // The first branch pushed into an empty repository becomes its default, and
  // a mirror push names them in no promised order. The template's is the one
  // every reader here uses (`submission_ref`, lib/template-source.mjs).
  const patch = await gh("PATCH", `/repos/${cfg.org}/${cfg.targetRepo}`, { default_branch: branch });
  if (!patch.ok) {
    await fail("fail:create", `${cfg.org}/${cfg.targetRepo} has the template's history, but its default branch could not be set to ${branch} (HTTP ${patch.status})`);
  }
  repoPopulated = true;
  // The repository as it is now: `created.data` was read while it was empty,
  // with the org's default branch name, and the feedback baseline reads it
  // (review 2026-10-14).
  return { repo: { ...repo, default_branch: branch }, pushed };
}

/** The commit `branch` points at now, or "" when it cannot be read (asked three times). */
async function branchHead(branch) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 1500));
    const res = await gh("GET", `/repos/${cfg.org}/${cfg.targetRepo}/branches/${encodeURIComponent(branch)}`);
    const sha = res.ok ? res.data?.commit?.sha : null;
    if (typeof sha === "string" && /^[0-9a-f]{40}$/.test(sha)) return sha;
  }
  return "";
}

/**
 * A reused full-history copy that nobody but PXL Classroom has pushed to.
 *
 * Its starting commit is recorded only by the run that copied it, so a run
 * that failed after the copy - the grant, the default branch, the record push -
 * left a repository whose retry recorded nothing, and the report counted the
 * template's commits as the student's (review 2026-10-14). The repository's
 * own push log says whether anyone else has pushed: when only the App has, its
 * head IS what it was given. Anything else - a person's push, a log that could
 * not be read or did not fit one page - recovers nothing, never a guess.
 */
async function onlyAppPushed() {
  const res = await gh("GET", `/repos/${cfg.org}/${cfg.targetRepo}/activity?per_page=100`);
  if (!res.ok || !Array.isArray(res.data) || res.data.length === 0 || res.data.length >= 100) return false;
  return res.data.every((a) => sameLogin(a?.actor?.login, `${APP_SLUG}[bot]`));
}

/**
 * How many commits `sha` has behind it, counted as the collector counts a
 * branch (collect/collect.mjs: one per page, the `last` link's page number),
 * so the report can subtract the one from the other. "" when unread.
 */
async function commitCountAt(sha) {
  const res = await gh("GET", `/repos/${cfg.org}/${cfg.targetRepo}/commits?sha=${sha}&per_page=1`);
  if (!res.ok || !Array.isArray(res.data) || res.data.length === 0) return "";
  const last = String(res.headers?.get?.("link") || "").match(/<[^>]*[?&]page=(\d+)[^>]*>;\s*rel="last"/);
  return last ? last[1] : String(res.data.length);
}

async function injectAutogradingWorkflow(assignment) {
  // The repository has to be filled in before either half of this is sound:
  // the check below reads an empty repository as "the template shipped no
  // grading workflow", and the write below becomes a root commit the
  // population then deletes. Failing is the right outcome rather than
  // injecting anyway - `retry-acceptance` repairs it, and a missing grading
  // workflow is invisible in a way a red provisioning run is not.
  if (!(await ensureRepoPopulated())) {
    await fail(
      "fail:template-not-populated",
      `${cfg.org}/${cfg.targetRepo} was created from the template but is still empty, so the ` +
        `autograding workflow cannot be added without racing GitHub's own population of it. ` +
        `Re-run Retry acceptance for this student.`,
    );
  }

  // Check if template repository already supplied an autograding workflow
  const checkAutograde = await gh("GET", `/repos/${cfg.org}/${cfg.targetRepo}/contents/.github/workflows/autograding.yml`);
  const checkClassroom = await gh("GET", `/repos/${cfg.org}/${cfg.targetRepo}/contents/.github/workflows/classroom.yml`);
  if (checkAutograde.status === 200 || checkClassroom.status === 200) {
    log("inject-autograding", { ok: true, note: "workflow already present from template - skipping injection" });
    return null;
  }

  const content = buildAutogradingWorkflow(assignment, cfg.org);
  const b64 = Buffer.from(content).toString("base64");
  const res = await gh("PUT", `/repos/${cfg.org}/${cfg.targetRepo}/contents/.github/workflows/autograding.yml`, {
    // `[skip ci]`: the workflow ran on this, its own commit, in every student
    // repository - a run per acceptance, and a red cross on a student's first
    // commit before they had done anything, since the checks fail on the
    // starter (seen live, drill-20261014-2211). GitHub skips push-triggered
    // runs for it; a lecturer's dispatch still runs.
    message: "Add autograding workflow [skip ci]",
    content: b64
  });
  // A FAILED WRITE FAILS THE RUN, for the reason above (TA-9, review
  // 2026-10-14): it logged and reported the acceptance done, so that student
  // was never graded and nothing anywhere was red. The grant has happened, so
  // the record is still written (`granted`), and Retry adds the workflow.
  if (!res.ok) {
    await fail(
      "fail:grading-workflow",
      `${cfg.org}/${cfg.targetRepo} was created and the student has it, but the grading workflow could not be added ` +
        `(HTTP ${res.status}), so their work would not be graded. Re-run Retry acceptance for this student.`,
    );
  }
  log("inject-autograding", { ok: true, note: "injected .github/workflows/autograding.yml" });
  // The commit it made, on the default branch (the PUT names no other).
  const sha = res.data?.commit?.sha;
  return typeof sha === "string" && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

/** The JSON files of one control-repository directory, parsed; none when it is absent. */
async function controlJson(dir) {
  const out = [];
  for (const name of await readdir(dir).catch(() => [])) {
    if (!name.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(await readFile(join(dir, name), "utf-8")));
    } catch {
      // A file that cannot be parsed extends nobody here; the lock reads it too.
    }
  }
  return out;
}

async function writeOwnDeadline() {
  try {
    const overrides = await controlJson(`control/overrides/${cfg.assignmentId}`);
    if (!overrides.length) return; // Nobody on this assignment has an extension.
    const assignment = parse(await readFile(`control/assignments/${cfg.assignmentId}.yml`, "utf-8"));
    // A team repository carries its most generous member's (lib/effective-deadline.mjs).
    const team = (await controlJson(`control/teams/${cfg.assignmentId}`))
      .find((t) => (t?.members || []).some((m) => sameLogin(m, cfg.studentLogin)));
    const value = deadlineVariableValue(assignment, cfg.studentLogin, { overrides, team: team ? { members: team.members } : undefined });
    if (!value) return;
    const res = await writeDeadlineVariable((method, path, body) => gh(method, path, body), {
      repoFullName: `${cfg.org}/${cfg.targetRepo}`, value,
    });
    if (!res.ok) log("own-deadline", { ok: false, note: `the repository's deadline variable could not be written (HTTP ${res.status})` });
  } catch (e) {
    log("own-deadline", { ok: false, note: `the repository's deadline variable could not be written: ${e.message}` });
  }
}

async function main() {
  const bad = validate();
  if (bad) await fail("fail:validation", bad);

  // 1. Token live (App installation tokens have no /user; /rate_limit works).
  const ping = await gh("GET", "/rate_limit");
  if (!ping.ok) await fail("fail:auth", `token rejected (HTTP ${ping.status})`);
  log("auth", { ok: true, note: "installation token accepted" });

  // 2. Validate template.
  const tpl = await gh("GET", `/repos/${cfg.templateOwner}/${cfg.templateRepo}`);
  if (!tpl.ok) await fail("fail:template-missing", `template ${cfg.templateOwner}/${cfg.templateRepo} HTTP ${tpl.status}`);
  if (!tpl.data.is_template) await fail("fail:not-a-template", `${cfg.templateOwner}/${cfg.templateRepo} is not a template repository`);

  // IS THIS STILL THE SAME REPOSITORY? `owner/repo` is a name, and a name can
  // come to mean something else: the template deleted and recreated, or
  // transferred away and the name taken. A rename is NOT that - GitHub
  // redirects a renamed repository and the id is unchanged - which is exactly
  // why the pin is on the id and not on the name.
  //
  // Checked HERE and not only at publish, because publishing does not happen
  // again while a cohort is accepting. Without this, students who accepted on
  // Monday and students accepting on Friday would start from different code
  // and nothing would ever say so. Refusing is the lesser harm: the lecturer
  // gets a provisioning-failed notice naming both ids, and can decide.
  //
  // An empty pin is "not pinned" - every assignment written before pinning
  // existed has none - and must never be read as an id of 0.
  const pin = resolveTemplatePin({
    storedTemplate: {
      owner: cfg.templateOwner,
      repository: cfg.templateRepo,
      ...(cfg.templateRepositoryId === null ? {} : { repository_id: cfg.templateRepositoryId }),
    },
    owner: cfg.templateOwner,
    repo: cfg.templateRepo,
    probedId: tpl.data.id,
  });
  if (!pin.ok) {
    await fail(
      "fail:template-replaced",
      `${cfg.templateOwner}/${cfg.templateRepo} is repository ${pin.probedId}, but this assignment ` +
        `was created from ${pin.storedId}. It was deleted and recreated, or transferred and the name ` +
        `reused. Students who accepted earlier started from the old one.`,
    );
  }
  log("template", {
    ok: true,
    note: `private=${tpl.data.private} is_template=true id=${tpl.data.id}${pin.pinned ? " (pinned)" : ""}`,
  });

  // 3. Idempotency: existing repo?
  const existing = await gh("GET", `/repos/${cfg.org}/${cfg.targetRepo}`);
  let alreadyExists = existing.status === 200;

  // OUR OWN EMPTY LEFTOVER IS NOT A REUSE. A `generate` that fails after
  // GitHub created the repository leaves it behind with no commit in it, and
  // reusing that handed the student a repository with no starter code,
  // reported `reused` (lib/existing-repo.mjs `emptyFromCommits`). It is
  // removed and generated again.
  //
  // ONLY WHEN ACCEPTANCE SAYS IT IS OURS (`recreate-empty`, from
  // `leftoverOfOwnAttempt`): this student accepted this assignment before, and
  // not by reusing a repository it did not make. EMPTY ALONE IS NOT ENOUGH - a
  // student can create an empty repository and then accept, and the
  // assignment's "give them the existing repository" promises they keep it.
  // The first version removed every empty one and would have deleted theirs.
  //
  // And only on GitHub's own "Git Repository is empty": an unreadable answer
  // is not evidence, and that repository is reused exactly as before.
  //
  // AND NEVER ONE THAT MAY STILL BE FILLING. A repository GitHub generated a
  // moment ago is empty until the template's contents arrive, and nothing
  // queues acceptances any more, so a teammate's run - or this student's own
  // second attempt - can meet the first run's repository in that window
  // (lib/existing-repo.mjs `mayStillBeFilling`). Removing it there deletes a
  // repository another run is about to hand out. It is reused instead, and the
  // writers below wait for it to fill.
  const stillFilling = alreadyExists ? mayStillBeFilling(existing.data?.created_at) : null;
  if (alreadyExists && cfg.recreateEmpty) {
    const empty = emptyFromCommits(await gh("GET", `/repos/${cfg.org}/${cfg.targetRepo}/commits?per_page=1`));
    if (empty === true && stillFilling !== false) {
      log("idempotency", {
        ok: true,
        note:
          `exists id=${existing.data.id} and is EMPTY, but ` +
          (stillFilling ? "was created less than ten minutes ago" : "its age could not be read") +
          ` - another run may still be filling it, so it is kept. A later attempt removes it if it is still empty.`,
      });
      // KEPT, SO IT HAS TO FILL BEFORE IT IS HANDED OUT. Only the writers below
      // waited, so an assignment with no autograding and no feedback PR handed
      // out whatever was there: a `generate` that failed after GitHub created
      // the repository, retried inside the ten minutes, was reported `reused`
      // with no starter code (review 2026-10-06). Another run's repository
      // fills in seconds; a leftover never does, and says so.
      // A pinned count (the unit tests) is taken as it is.
      const attempts = process.env.PXL_FILL_WAIT_CHECKS
        ? FILL_WAIT_CHECKS
        : fillWaitChecks({ fullHistory: cfg.fullHistory, createdAt: existing.data?.created_at });
      if (!cfg.dryRun && !(await ensureRepoPopulated({ attempts, delayMs: FILL_WAIT_DELAY_MS }))) {
        await fail(
          "fail:create",
          `${cfg.org}/${cfg.targetRepo} exists and is still empty: an earlier attempt left it, or GitHub has not ` +
            `finished copying the template into it. Retry this student in ten minutes - an attempt then removes it ` +
            `and creates it again.`,
        );
      }
    } else if (empty === true && cfg.dryRun) {
      log("idempotency", { ok: true, note: `exists id=${existing.data.id} and is EMPTY - a real run would remove it and create it again` });
    } else if (empty === true) {
      const del = await gh("DELETE", `/repos/${cfg.org}/${cfg.targetRepo}`);
      if (!del.ok && del.status !== 404) {
        await fail(
          "fail:create",
          `${cfg.org}/${cfg.targetRepo} exists and is empty (an earlier attempt left it), and it could not be ` +
            `removed (HTTP ${del.status}). Delete that repository, then retry this student.`,
        );
      }
      log("idempotency", { ok: true, note: `exists id=${existing.data.id} but is EMPTY - removed, creating it again` });
      alreadyExists = false;
    }
  }
  log("idempotency", { ok: existing.status === 200 || existing.status === 404, note: alreadyExists ? `exists id=${existing.data.id} - reuse` : "absent - create" });
  // Nothing is populating a repository we did not just generate, so the writers
  // below have nothing to wait for. Waiting anyway would fail a legitimate
  // reuse of a repository a student has emptied out. EXCEPT one generated
  // minutes ago, by another run that may still be filling it - the writers
  // wait for that one exactly as they wait for their own.
  if (alreadyExists) repoPopulated = stillFilling !== true;

  // 4. Create from template (skip if exists / dry-run).
  let repo = alreadyExists ? existing.data : null;
  // Set by the grant below. Stays false through dry-run and through every
  // failure path, so the caller can only ever be told about an invitation that
  // GitHub actually reported creating.
  let grantInvited = false;
  // What THIS run pushed when it copied the template with its history - the
  // one case whose starting commit is known for certain (step 7). A reuse
  // made nothing.
  let copiedHistory = null;
  if (!alreadyExists && !cfg.dryRun && cfg.fullHistory) {
    ({ repo, pushed: copiedHistory } = await createWithFullHistory(tpl));
  } else if (!alreadyExists && !cfg.dryRun) {
    const gen = await gh("POST", `/repos/${cfg.templateOwner}/${cfg.templateRepo}/generate`, {
      owner: cfg.org, name: cfg.targetRepo, private: cfg.isPrivate, include_all_branches: false,
    });
    if (!gen.ok) await fail("fail:create", `generate HTTP ${gen.status} ${gen.data?.message ?? ""}`);
    repo = gen.data;
    log("create", { ok: true, note: `id=${repo.id} ${repo.html_url}` });
  }

  // A FULL-HISTORY COPY AN EARLIER RUN MADE, reused: its starting commit is
  // recovered at step 7 when nobody but the App has pushed to it. Decided HERE,
  // with its default branch repaired here, because steps 5.5 and 6 write to
  // the default branch: a copy whose first run died before its PATCH had an
  // arbitrary prepared branch as default, so the grading workflow and the
  // feedback baseline went there and `main` got neither (review 2026-10-14).
  // And only a copy this system PUSHED: GitHub's own copy names its template
  // (`template_repository`), a pushed one does not, so a GitHub copy of an
  // assignment whose setting was ticked later is never taken for one. NOT
  // only while the setting is on (review 2026-10-14, F4b): a copy made while
  // it was, whose run failed, and retried after it was turned off, recorded
  // nothing - and is still a full-history copy. Nobody but the App having
  // pushed is what makes it certain, whatever the setting says now.
  let recoverHistoryCopy = false;
  if (alreadyExists && !cfg.dryRun && repo && !repo.template_repository) {
    recoverHistoryCopy = await onlyAppPushed();
    const branch = tpl.data?.default_branch;
    if (recoverHistoryCopy && branch && BRANCH.test(branch) && repo.default_branch !== branch) {
      const patch = await gh("PATCH", `/repos/${cfg.org}/${cfg.targetRepo}`, { default_branch: branch });
      log("default-branch", { ok: patch.ok, note: patch.ok ? `set to ${branch}, as the template's` : `could not be set to ${branch} (HTTP ${patch.status})` });
      if (patch.ok) repo = { ...repo, default_branch: branch };
    }
  }

  // Said AS SOON AS the repository exists, not only at the end. Every failure
  // below (the grant, an empty template) leaves a repository behind, and a team
  // manifest that is never told about it makes accept.mjs refuse the next
  // teammate as `rejected:repo-exists` over their own team's repository. The
  // success path writes the same three values again; the last write wins.
  if (repo && !cfg.dryRun) {
    await setOutput("repo_id", repo.id ?? "");
    await setOutput("repo_url", repo.html_url ?? "");
    await setOutput("repo_name", repo.full_name ?? "");
  }

  // 5. Grant the student their role (skip in dry-run).
  if (!cfg.dryRun) {
    // Through the shared helper, because a plain PUT to a student who still
    // has an invitation answers 201 with THAT invitation at its OLD
    // permission (measured 2026-09-26): a retry after the lecturer changed
    // Student permission would leave them on the old one, reporting success.
    const add = await applyStudentPermission(
      (method, path, body) => gh(method, path, body),
      { repo: `${cfg.org}/${cfg.targetRepo}`, login: cfg.studentLogin, permission: cfg.permission },
    );
    if (!add.ok) await fail("fail:grant", `grant HTTP ${add.status} ${add.message ?? ""}`);
    log("grant", { ok: true, note: add.via === "invitation" ? `invitation (${cfg.permission})` : `already a collaborator (${cfg.permission})` });
    // SAID NOW, before anything below can fail (review 2026-10-14, LD5): the
    // student holds this repository from here on, and a failure after this
    // wrote only the team's record (or, alone, nothing), so lockdown - which
    // works from the students' records - never locked it.
    await setOutput("granted", "true");

    // 201 means GitHub SENT AN INVITATION, and this is the only place in the
    // system that knows. The student's browser cannot find out: measured
    // 2026-09-03, `GET /user/repository_invitations` answers `200 []` to the
    // very account the invitation is addressed to, and
    // `GET /user/memberships/orgs/{org}` answers 403 to the same token, so
    // neither the invitation nor the org membership that would imply it is
    // visible from the page. See frontend/src/lib/invitation-evidence.js.
    //
    // Published only for 201. A 204 says the student was added directly, which
    // means they are already a collaborator or an org member - and the broker
    // repository this ends up on is PUBLIC, so saying so would put "this
    // account is an org member" in front of anyone who looks. Absence stays
    // "unknown", which is the rule the page already follows, and a 204 needs no
    // help anyway: the repository is immediately readable and the page moves to
    // `provisioned` on its own.
    grantInvited = add.via === "invitation";

    // 5.1 If student switched teams, remove collaborator access and cancel pending invitations on previous repository
    if (cfg.previousRepo && cfg.previousRepo !== cfg.targetRepo) {
      const prevRepoName = cfg.previousRepo.split("/").pop();
      const remove = await gh("DELETE", `/repos/${cfg.org}/${prevRepoName}/collaborators/${cfg.studentLogin}`);
      log("remove-old-collab", { ok: remove.ok || remove.status === 404, note: `removed from ${prevRepoName} (HTTP ${remove.status})` });

      // Also clean up any pending invitations for this student on the old repo
      try {
        const invRes = await gh("GET", `/repos/${cfg.org}/${prevRepoName}/invitations`);
        if (invRes.ok && Array.isArray(invRes.data)) {
          const pendingInv = invRes.data.find((inv) => inv.invitee?.login?.toLowerCase() === cfg.studentLogin.toLowerCase());
          if (pendingInv) {
            const cancelRes = await gh("DELETE", `/repos/${cfg.org}/${prevRepoName}/invitations/${pendingInv.id}`);
            log("cancel-old-invitation", { ok: cancelRes.ok || cancelRes.status === 404, note: `cancelled invitation #${pendingInv.id} on ${prevRepoName}` });
          }
        }
      } catch (e) {
        log("cancel-old-invitation", { ok: false, note: `non-critical invitation check error: ${e.message}` });
      }

      // 5.2 The team they left was empty and held nothing anybody pushed, so
      // accept.mjs removed it; its repository goes too. Asked AGAIN here,
      // because seconds have passed since that decision: anything pushed in
      // between is kept, and the nightly reports it as a repository nobody
      // recorded rather than this step deleting work. Never fails the
      // acceptance - the student is in their new team either way.
      if (cfg.removePreviousRepo) {
        const full = `${cfg.org}/${prevRepoName}`;
        try {
          // NO AGE GUARD HERE, on purpose (review 2026-10-14). A switch made
          // straight after the first acceptance can meet a run still writing to
          // this repository, and deleting it fails that run's last steps with a
          // notice - while keeping it, the manifest already removed by the
          // decision, leaves a repository no record names: the typo team
          // switched away from within minutes is exactly the case this exists for.
          const state = await repoTouched((path) => gh("GET", path), full);
          if (state === "untouched") {
            const del = await gh("DELETE", `/repos/${full}`);
            log("remove-old-repo", { ok: del.ok || del.status === 404, note: `deleted ${prevRepoName}: its team was left empty and nothing was pushed to it (HTTP ${del.status})` });
          } else {
            const why = { absent: "already gone", touched: "something was pushed to it since" }[state] || "could not read it";
            log("remove-old-repo", { ok: true, note: `kept ${prevRepoName}: ${why}` });
          }
        } catch (e) {
          log("remove-old-repo", { ok: false, note: `kept ${prevRepoName}: ${e.message}` });
        }
      }
    }
  }

  // 5.5 Inject Autograding workflow if github_actions
  // The commit it made on the default branch, if it made one - part of what a
  // full-history copy is given (step 7).
  let injectedSha = null;
  if (!cfg.dryRun && repo && cfg.assignmentId) {
    try {
      const yamlStr = await readFile(`control/assignments/${cfg.assignmentId}.yml`, "utf-8");
      const assignment = parse(yamlStr);
      if (assignment?.autograde?.enabled && assignment.autograde.execution_environment === "github_actions") {
        injectedSha = await injectAutogradingWorkflow(assignment);
      }
    } catch (e) {
      log("inject-autograding", { ok: false, note: `failed to read assignment config: ${e.message}` });
    }
  }

  // 5.6 The student's own deadline, where an extension makes it later than the
  // assignment's (lib/deadline-variable.mjs): their page reads it from this
  // repository, the control repository being private to staff. An extension
  // granted before they accepted reached nothing else. Best effort - the lock
  // and grading read the override itself - and the run log is public, so it
  // says nothing on success and nothing about the student's dates on failure.
  if (!cfg.dryRun && repo && cfg.assignmentId) await writeOwnDeadline();

  // 6. Optional Feedback-PR scaffold: baseline branch + protection. PR open
  //    is deferred to `pxl-classroom feedback open` once student commits land.
  let baselineSha = "";
  if (cfg.feedbackPr && !cfg.dryRun && repo) {
    baselineSha = (await setupFeedbackBaseline(repo, { copiedTemplateBranches: cfg.fullHistory && !alreadyExists })) || "";
  }

  // 7. What a repository copied with its history was given: its default
  // branch as it stands after every write above (an injected grading workflow
  // is a commit too), and how many commits that is. The report reads "not
  // started" as "still at this commit" and counts the student's commits from
  // this number (lib/starter-commit.mjs), since such a repository never has
  // just one. For the copy this run made, from what it pushed and the one
  // commit it added since - known, never read back. Unread is left empty -
  // the report then counts every commit - rather than guessed.
  let starterSha = "";
  let starterCount = "";
  if (copiedHistory) {
    starterSha = injectedSha || copiedHistory.head;
    starterCount = String(copiedHistory.count + (injectedSha ? 1 : 0));
    log("starter", { ok: true, note: `starts at ${starterSha.slice(0, 12)} (${starterCount} commits)` });
  } else if (!alreadyExists && injectedSha) {
    // GITHUB'S COPY THAT THIS RUN COMMITTED TO (review 2026-10-14): the
    // generated commit plus the grading workflow is two commits from the
    // first second, and "one commit is the start" read every student who did
    // nothing as handed in, on time - and graded the workflow's own run.
    // What it was given is the commit this run made, and its count is read
    // (GitHub's copy is one commit, but that is GitHub's to say).
    starterSha = injectedSha;
    starterCount = await commitCountAt(injectedSha);
    log("starter", starterCount
      ? { ok: true, note: `starts at ${starterSha.slice(0, 12)} (${starterCount} commits, the grading workflow included)` }
      : { ok: false, note: `starts at ${starterSha.slice(0, 12)}; its commit count could not be read` });
  } else if (alreadyExists && injectedSha && repo?.template_repository) {
    // GITHUB'S COPY WHOSE FIRST RUN FAILED BEFORE THE WORKFLOW WAS ADDED
    // (review 2026-10-14, P2-20). This retry added it, and only a first run's
    // start was recorded, so the student read two commits, "On time", with
    // nothing done. Its start too - but only where the commit under it is the
    // one GitHub generated: on top of a student's push it is not what they
    // were given, and nothing is recorded rather than a guess.
    const at = await gh("GET", `/repos/${cfg.org}/${cfg.targetRepo}/commits/${injectedSha}`);
    const parentSha = at.ok && Array.isArray(at.data?.parents) && at.data.parents.length === 1 ? at.data.parents[0].sha : null;
    const parent = parentSha ? await gh("GET", `/repos/${cfg.org}/${cfg.targetRepo}/commits/${parentSha}`) : null;
    if (parent?.ok && generatedFromTemplate(parent.data)) {
      starterSha = injectedSha;
      starterCount = await commitCountAt(injectedSha);
      log("starter", { ok: true, note: `the grading workflow was added on this retry, over GitHub's copy: starts at ${starterSha.slice(0, 12)}${starterCount ? ` (${starterCount} commits)` : ""}` });
    } else {
      log("starter", { ok: true, note: "the grading workflow was added over commits that are not GitHub's copy alone, so no start is recorded" });
    }
  } else if (recoverHistoryCopy) {
    // A copy an earlier run made and nobody but the App has pushed to since:
    // what it was given is its head, after every write above - the App's own
    // grading workflow included, which a first run that failed to add it did
    // not have. The record writer takes this over the one on record.
    const branch = tpl.data?.default_branch;
    starterSha = branch ? await branchHead(branch) : "";
    if (starterSha) starterCount = await commitCountAt(starterSha);
    log("starter", starterSha
      ? { ok: true, note: `only PXL Classroom has pushed to it: starts at ${starterSha.slice(0, 12)}${starterCount ? ` (${starterCount} commits)` : ""}` }
      : { ok: false, note: "the starting commit could not be read, so it is not recorded" });
  }

  const outcome = cfg.dryRun ? "dry-run:ok" : alreadyExists ? "reused" : "created";
  await setOutput("starter_sha", starterSha);
  await setOutput("starter_commit_count", starterCount);
  // Which kind of start, said by the run that made it (review 2026-10-14):
  // read from the assignment at record time, a setting toggled in between
  // stamped the wrong kind.
  await setOutput("full_history", starterSha && (copiedHistory || recoverHistoryCopy) ? "true" : "false");
  await setOutput("repo_id", repo?.id ?? "");
  await setOutput("repo_url", repo?.html_url ?? "");
  await setOutput("repo_name", repo?.full_name ?? "");
  await setOutput("outcome", outcome);
  await setOutput("baseline_sha", baselineSha);
  await setOutput("invited", grantInvited ? "true" : "false");
  await summary(
    `### Provisioning: \`${outcome}\`\n\n` +
    `| field | value |\n|---|---|\n` +
    `| repo | ${repo?.full_name ?? "(dry-run)"} |\n| id | ${repo?.id ?? "-"} |\n` +
    `| student | ${cfg.studentLogin} (${cfg.permission}) |\n| template | ${cfg.templateOwner}/${cfg.templateRepo} |\n`
  );
  log("done", { ok: true, note: outcome });
  process.exit(0);
}

const isMain = process.argv[1] && (resolve(process.argv[1]) === fileURLToPath(import.meta.url) || resolve(process.argv[1]).endsWith("provision.mjs"));
if (isMain) {
  main().catch(async (e) => { await fail("fail:exception", e.message); });
}
