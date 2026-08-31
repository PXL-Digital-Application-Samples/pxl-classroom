// Hub defence in depth.
//
// `workflow_dispatch` runs the workflow file from whatever ref you name, and
// the `participating-orgs` branch carries deliberately lighter protection
// (ARCHITECTURE §5.5) so that automation can commit the org registry to it.
// Together that is a path to running hub code at a ref an attacker controls,
// with the App private key in scope.
//
// A job that names an environment does not start at all when the run's ref is
// outside that environment's deployment branch policy - `provisioning` allows
// `main` only. That is what closes it, so every job holding a hub credential
// has to name it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const WORKFLOW_DIR = join(root, ".github", "workflows");

// Credentials that grant power beyond this repository: the App key mints
// installation tokens for every participating org, the invite key mints
// invitations every broker will accept, and the claim key decrypts every
// student's institutional email address out of the public event archive - the
// one piece of personal data the design deliberately puts on a public channel
// in sealed form.
// PXL_BROKER_PRIVATE_KEY is here too. It is deliberately far weaker than the
// others - Contents: write on the hub repository alone, which is exactly what a
// repository_dispatch needs - but on the HUB it is still a credential handed to
// public repositories, and the same ref and environment rules apply to the job
// that distributes it.
const HUB_CREDENTIALS =
  /PXL_APP_PRIVATE_KEY|PXL_INVITE_SIGNING_KEY|PXL_CLAIM_PRIVATE_KEY|PXL_BROKER_PRIVATE_KEY/;
const ENVIRONMENT = "provisioning";

/** Every composite action in the repo - they carry `uses:` steps too. */
const COMPOSITE_ACTIONS = readdirSync(root, { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(join(root, e.name, "action.yml")))
  .map((e) => join(e.name, "action.yml"));

function workflows() {
  return readdirSync(WORKFLOW_DIR)
    .filter((f) => f.endsWith(".yml"))
    .map((f) => ({ file: f, doc: parse(readFileSync(join(WORKFLOW_DIR, f), "utf8")) }));
}

test("every job holding a hub credential is pinned to the provisioning environment", () => {
  const unguarded = [];
  let guarded = 0;
  for (const { file, doc } of workflows()) {
    for (const [name, job] of Object.entries(doc?.jobs || {})) {
      if (!HUB_CREDENTIALS.test(JSON.stringify(job))) continue;
      // `environment:` may be a string or an object with a `name`.
      const env = typeof job.environment === "object" ? job.environment?.name : job.environment;
      if (env === ENVIRONMENT) guarded++;
      else unguarded.push(`${file}:${name} (environment: ${JSON.stringify(job.environment)})`);
    }
  }
  assert.ok(guarded > 0, "expected to find jobs using hub credentials");
  assert.deepEqual(
    unguarded,
    [],
    `these jobs could run from a ref other than main with a hub credential in scope:\n  ${unguarded.join("\n  ")}`
  );
});

test("the admin workflows refuse an automated dispatch", () => {
  // A lecturer dispatches these as themselves. The other thing that can reach
  // workflow_dispatch is an App installation token - what a stolen broker
  // credential would be - and it arrives as `<slug>[bot]`. Guarding the
  // identity beats maintaining an allowlist of people.
  //
  // THE CLASS, NOT A LIST. This used to name three files by hand, and the list
  // was wrong: sync-starter-code.yml and open-feedback-prs.yml both hold
  // PXL_APP_PRIVATE_KEY and both mint a token for an ARBITRARY org taken from
  // their own input, and neither had the guard - nor did reconcile-registry.yml
  // or weekly-usage-report.yml. Four gaps behind a test that passed, because a
  // hand-maintained list only ever covers what somebody remembered.
  //
  // The rule is derived instead: a workflow that can be dispatched, and reads a
  // hub credential, needs the guard on every job that reads one - UNLESS
  // another workflow in this repository genuinely dispatches it, which is a
  // legitimate machine caller and would be broken by the guard. That exemption
  // is computed from real dispatch calls (`gh workflow run <file>`, the REST
  // `workflows/<file>/dispatches` path, or a `workflow_id:` naming it), never
  // from the filename merely appearing - half these files mention each other in
  // comments, and matching those exempted almost everything.
  const machineDispatched = (file) => {
    const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const call = new RegExp(
      `gh\\s+workflow\\s+run\\s+["']?${escaped}` +
        `|workflows/${escaped}/dispatches` +
        `|workflow_id:\\s*["']?${escaped}`,
    );
    return workflows().some((w) => w.file !== file && call.test(readFileSync(join(WORKFLOW_DIR, w.file), "utf8")));
  };

  const offenders = [];
  let checked = 0;

  for (const { file, doc } of workflows()) {
    const src = readFileSync(join(WORKFLOW_DIR, file), "utf8");
    if (!/workflow_dispatch/.test(src)) continue;
    if (!HUB_CREDENTIALS.test(src)) continue;
    if (machineDispatched(file)) continue;

    const jobs = doc?.jobs ?? {};
    const hasGuard = (job) => (job?.steps ?? [])[0]?.name === "Reject automated dispatch";

    // A guard UPSTREAM is real protection: if `arm` refuses a [bot] dispatch,
    // every job that needs it is skipped and never starts. deadline-sentinel's
    // `watch` job holds a credential and is guarded exactly this way, through
    // aggregate-armable -> arm. Requiring its own guard would be cargo cult.
    // Resolved transitively, with a seen-set because `needs:` is a graph.
    const guardedUpstream = (jobId, seen = new Set()) => {
      if (seen.has(jobId)) return false;
      seen.add(jobId);
      const needs = jobs[jobId]?.needs;
      const parents = Array.isArray(needs) ? needs : needs ? [needs] : [];
      return parents.some((p) => hasGuard(jobs[p]) || guardedUpstream(p, seen));
    };

    for (const [jobId, job] of Object.entries(jobs)) {
      const steps = job?.steps ?? [];
      if (!steps.length) continue;
      // Only jobs that actually reach a credential. A job-level guard protects
      // only its own job, so this is per job rather than per file.
      const readsCredential = HUB_CREDENTIALS.test(JSON.stringify(job));
      if (!readsCredential) continue;
      if (guardedUpstream(jobId)) continue;

      checked++;
      const first = steps[0];
      if (first?.name !== "Reject automated dispatch") {
        offenders.push(`${file}:${jobId} - the guard must be the FIRST step, before anything mints a token`);
        continue;
      }
      if (!/github\.event_name == 'workflow_dispatch'/.test(first.if ?? "")) {
        offenders.push(`${file}:${jobId} - the guard must only fire on workflow_dispatch (a cron must still run)`);
      }
      if (!/endsWith\(github\.actor, '\[bot\]'\)/.test(first.if ?? "")) {
        offenders.push(`${file}:${jobId} - the guard must test for a [bot] actor`);
      }
      if (!/exit 1/.test(first.run ?? "")) {
        offenders.push(`${file}:${jobId} - the guard must fail the run, not just log`);
      }
    }
  }

  assert.deepEqual(offenders, [], offenders.join("\n"));
  // A floor, because a walk that silently stops matching looks exactly like a
  // clean repo. Six workflows carried the guard when this was written.
  assert.ok(checked >= 7, `expected the sweep to reach at least 7 credential-bearing jobs, reached ${checked}`);
});

test("every action is pinned to a SHA, not a mutable tag", () => {
  // `actions/setup-node@v4` survived in sync-starter-code.yml and
  // open-feedback-prs.yml while all 36 checkouts and all 24 App-token steps
  // were SHA-pinned - and in both files that step runs AFTER the App token is
  // minted, with PXL_APP_PRIVATE_KEY in scope through `environment:
  // provisioning`. A compromised tag would have executed beside both.
  //
  // The existing pinning tests were per-action (create-github-app-token,
  // actions/checkout), so an action nobody had written a test for was unpinned
  // by default. This covers every `uses:` instead.
  const offenders = [];
  const files = [
    ...workflows().map((w) => ({ label: w.file, doc: w.doc })),
    ...COMPOSITE_ACTIONS.map((p) => ({ label: p, doc: parse(readFileSync(join(root, p), "utf8")) })),
  ];

  for (const { label, doc } of files) {
    const stepLists = [
      ...Object.entries(doc?.jobs ?? {}).map(([id, j]) => [id, j?.steps ?? []]),
      ["runs", doc?.runs?.steps ?? []],
    ];
    for (const [jobId, steps] of stepLists) {
      for (const step of steps ?? []) {
        const uses = typeof step?.uses === "string" ? step.uses : "";
        if (!uses || uses.startsWith("./")) continue; // local composite actions
        if (!/@[0-9a-f]{40}$/.test(uses)) {
          offenders.push(`${label}:${jobId} uses a mutable ref: ${uses}`);
        }
      }
    }
  }

  assert.deepEqual(offenders, [], `every third-party action must be SHA-pinned:\n${offenders.join("\n")}`);
});

test("no workflow reads a hub credential outside a step that needs it", () => {
  // Workflow-level `env:` would put the key in every step's environment,
  // including third-party actions that have no business seeing it.
  for (const { file, doc } of workflows()) {
    assert.ok(
      !HUB_CREDENTIALS.test(JSON.stringify(doc.env || {})),
      `${file}: hub credentials must not be exposed at workflow level`
    );
    for (const [name, job] of Object.entries(doc?.jobs || {})) {
      assert.ok(
        !HUB_CREDENTIALS.test(JSON.stringify(job.env || {})),
        `${file}:${name}: hub credentials must not be exposed at job level`
      );
    }
  }
});

// "Save & publish" writes state: published from the SPA before dispatching, and
// the workflow flips it again on success. When a step in between fails - the
// broker push rejected by an org ruleset, say - the assignment was left claiming
// published with no invitation and no working broker. The SPA only ever reverted
// a failed DISPATCH; nothing covered a workflow that failed after dispatching.
test("a failed publish reverts the assignment rather than stranding it", () => {
  const doc = parse(readFileSync(join(WORKFLOW_DIR, "publish-assignment.yml"), "utf8"));
  const steps = doc.jobs.publish.steps;
  const names = steps.map((s) => s.name);

  const prior = steps.find((s) => s.name === "Record prior state");
  const revert = steps.find((s) => s.name === "Revert to prior state on failure");
  assert.ok(prior, "the prior state must be recorded before anything changes");
  assert.ok(revert, "a failed publish must undo its own transition");

  // Order matters: the prior state has to be captured before the first write.
  assert.ok(
    names.indexOf("Record prior state") < names.indexOf("Mint invitation token"),
    "prior state must be recorded before the first write"
  );
  assert.ok(
    names.indexOf("Revert to prior state on failure") > names.indexOf("Update assignment state"),
    "the revert must come after the steps it undoes"
  );

  assert.match(revert.if, /failure\(\)/, "the revert only runs when the publish failed");
  // Demoting an assignment that was ALREADY published, because a repair
  // republish failed, would strand every student behind rejected:not-published.
  assert.match(
    revert.if,
    /steps\.prior\.outputs\.state != 'published'/,
    "a repair republish of a live assignment must never demote it"
  );
});

test("every App-token step uses one pinned action version, and its inputs", () => {
  // `sync-starter-code.yml` and `open-feedback-prs.yml` were the only two
  // workflows on the floating `actions/create-github-app-token@v1` tag, and v1
  // has no `client-id` input - it takes `app-id`. So the very first step of
  // both died with "Input required and not supplied: app-id", and neither
  // workflow ever ran once. Nothing caught it because the failure is in the
  // action's own input validation, which lives outside every schema and lint
  // this repo has, and because both are dispatch-only: no cron ever went red.
  //
  // Pinning them all to one SHA is what makes "these inputs are the right
  // inputs" a single fact rather than a per-file guess.
  const versions = new Set();
  const offenders = [];

  for (const { file, doc } of workflows()) {
    for (const [jobId, job] of Object.entries(doc?.jobs ?? {})) {
      for (const step of job?.steps ?? []) {
        const uses = typeof step?.uses === "string" ? step.uses : "";
        if (!uses.startsWith("actions/create-github-app-token@")) continue;

        versions.add(uses);
        if (!/@[0-9a-f]{40}$/.test(uses)) {
          offenders.push(`${file}:${jobId} is not pinned to a SHA (${uses})`);
        }
        const withKeys = Object.keys(step.with ?? {});
        if (!withKeys.includes("client-id")) {
          offenders.push(`${file}:${jobId} must mint with client-id`);
        }
        if (withKeys.includes("app-id")) {
          offenders.push(`${file}:${jobId} mixes app-id with the client-id form`);
        }
      }
    }
  }

  assert.deepEqual(offenders, [], offenders.join("\n"));
  assert.equal(
    versions.size,
    1,
    `all App-token steps must agree on one version, found: ${[...versions].join(", ")}`,
  );
});

test("every hub checkout agrees on one pinned version", () => {
  // The same two workflows the test above is about - sync-starter-code.yml and
  // open-feedback-prs.yml - were also the last two on actions/checkout@v4 while
  // every other hub workflow had moved to a pinned v7. They were written at a
  // different time and swept by nothing since, which is the whole reason that
  // pair keeps appearing in these tests.
  //
  // v4 runs on Node 20, which GitHub has deprecated: a live autograding run on
  // 2026-08-26 carried a warning annotation naming it. Agreeing on one SHA is
  // what stops a third straggler appearing.
  const versions = new Set();
  const offenders = [];

  for (const { file, doc } of workflows()) {
    for (const [jobId, job] of Object.entries(doc?.jobs ?? {})) {
      for (const step of job?.steps ?? []) {
        const uses = typeof step?.uses === "string" ? step.uses : "";
        if (!uses.startsWith("actions/checkout@")) continue;
        versions.add(uses);
        if (!/@[0-9a-f]{40}$/.test(uses)) {
          offenders.push(`${file}:${jobId} is not pinned to a SHA (${uses})`);
        }
      }
    }
  }

  assert.deepEqual(offenders, [], offenders.join("\n"));
  assert.equal(
    versions.size,
    1,
    `all hub checkouts must agree on one version, found: ${[...versions].join(", ")}`,
  );
});

test("the workflow written into student repositories is not on a deprecated Node", () => {
  // This one is NOT pinned to a SHA, deliberately: it is written into every
  // student repository, so a pin freezes hundreds of copies at a commit
  // somebody has to remember to bump, and those repos hold no credential beyond
  // their own GITHUB_TOKEN. What it must not do is ship a major GitHub has
  // deprecated - v4 put a Node 20 warning annotation on every student's grading
  // run, which is noise on the one screen a student reads for their mark.
  const src = readFileSync(join(root, "provisioning", "provision.mjs"), "utf8");
  const uses = [...src.matchAll(/actions\/checkout@(v\d+|[0-9a-f]{40})/g)].map((m) => m[1]);
  assert.ok(uses.length > 0, "the generated workflow must still check the repository out");
  for (const v of uses) {
    const major = Number(String(v).replace("v", ""));
    assert.ok(
      Number.isNaN(major) || major >= 5,
      `actions/checkout@${v} runs on Node 20, which GitHub has deprecated`,
    );
  }
});

test("no workflow trusts gh's stdout instead of its exit code", () => {
  // `gh` writes API ERRORS TO STDOUT. Measured 2026-08-26 against the live API:
  //
  //   $ gh api users/does-not-exist --jq .id   # exit 1
  //   stdout: {"message":"Not Found","documentation_url":"...","status":"404"}
  //   stderr: gh: Not Found (HTTP 404)
  //
  // So a captured value is non-empty on failure, and `[ -z "$VAR" ]` is not a
  // check - it is a guard that can never fire. retry-acceptance.yml had exactly
  // that, and only Actions' default `bash -e` kept it from writing a JSON error
  // blob into $GITHUB_OUTPUT as a student's account id.
  //
  // The rule: a capture must be guarded by the exit code, either `if ! VAR=$(gh
  // ...)` or `VAR=$(gh ...) || ...`. What it then does with the value is its own
  // business, but it may not assume success from the text.
  const offenders = [];
  for (const file of readdirSync(WORKFLOW_DIR).filter((f) => /\.ya?ml$/.test(f))) {
    const raw = readFileSync(join(WORKFLOW_DIR, file), "utf8");
    raw.split("\n").forEach((line, i) => {
      if (!/\$\(gh\s/.test(line)) return;
      if (/^\s*#/.test(line)) return;
      const guarded = /\bif\s+!\s+\w+=\$\(gh\s/.test(line) || /\)\s*\|\|/.test(line);
      if (!guarded) offenders.push(`${file}:${i + 1} ${line.trim()}`);
    });
  }
  assert.deepEqual(
    offenders,
    [],
    `gh output captured without checking the exit code:\n${offenders.join("\n")}`,
  );
});

/** `actions: write` in effect, given a job-level or workflow-level block. */
function grantsActionsWrite(perms) {
  if (perms === "write-all") return true;
  if (!perms || typeof perms !== "object") return false;
  return perms.actions === "write";
}

/** True when the step dispatches with something other than GITHUB_TOKEN. */
function usesForeignToken(job, step) {
  const DEFAULT = /^\$\{\{\s*(github\.token|secrets\.GITHUB_TOKEN)\s*\}\}$/;
  const given = step?.with?.["github-token"];
  if (given && !DEFAULT.test(String(given).trim())) return true;
  const env = { ...(job?.env ?? {}), ...(step?.env ?? {}) };
  return ["GH_TOKEN", "GITHUB_TOKEN"].some(
    (k) => env[k] && !DEFAULT.test(String(env[k]).trim()),
  );
}

test("a step dispatching a workflow with GITHUB_TOKEN declares actions: write", () => {
  // Dispatching a workflow needs `actions: write`, and both github-script and
  // `gh` default to the job's own GITHUB_TOKEN. Its permissions come from the
  // job's `permissions:` block or, when the job has none, from the workflow's.
  //
  // A job-level block REPLACES the workflow-level one rather than merging,
  // which is the half that bites twice: omitting it leaves a dispatch under a
  // read-only workflow default, and adding `actions: write` without restating
  // `contents: read` silently breaks the job's own checkout.
  //
  // deadline-sentinel.yml's `Finalize now` shipped without one and 403'd with
  // `Resource not accessible by integration` on the sentinel's FIRST REAL
  // FIRING (2026-08-26, run 33013299689). Nothing had exercised it: the step
  // is gated on `fired == true`, so only a sentinel actually reaching a
  // deadline gets there - the same shape as sync-starter-code.yml and
  // open-feedback-prs.yml, which had never run either. Writes still stopped
  // and the nightly still finalized, so no data was at risk; what it cost was
  // a red job at every single deadline, and a workflow that goes red whenever
  // it does its job is one people stop reading.
  const DISPATCHES = /createWorkflowDispatch|createDispatchEvent|gh\s+workflow\s+run|\/dispatches\b/;
  const stripComments = (s) =>
    s.split("\n").filter((l) => !/^\s*(#|\/\/)/.test(l)).join("\n");

  const offenders = [];
  for (const { file, doc } of workflows()) {
    for (const [jobName, job] of Object.entries(doc?.jobs ?? {})) {
      for (const step of job?.steps ?? []) {
        const body = stripComments(
          [step?.run, step?.with?.script].filter(Boolean).join("\n"),
        );
        if (!DISPATCHES.test(body)) continue;
        if (usesForeignToken(job, step)) continue;
        if (grantsActionsWrite(job?.permissions ?? doc?.permissions)) continue;
        offenders.push(`${file} job '${jobName}' step '${step?.name ?? "(unnamed)"}'`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `dispatches a workflow with GITHUB_TOKEN but has no actions: write:\n${offenders.join("\n")}`,
  );
});

test("a scoped dispatch can never disable a workflow for every org", () => {
  // The minimal-minutes design lets the nightly switch ITSELF off when no
  // assignment is active, and only a publish switches it back on. That makes
  // `gh workflow disable` a statement about the whole hub - so it may only be
  // reached by a run that actually looked at the whole hub.
  //
  // Both of daily-activity.yml's disable jobs decided on evidence scoped to
  // whatever `inputs.org` narrowed the run to. Measured 2026-08-26: a drill
  // dispatched as `-f org=PXLAutomation`, whose single published assignment had
  // just passed its deadline, reported active_count == 0 and disabled the
  // nightly for EVERY organization - four days before a live exam in an org
  // that run never opened. Nothing but a publish re-enables it, so that exam
  // would never have been finalized, silently.
  //
  // `disable-when-empty` had the same shape one step earlier: a typo'd or
  // non-participating org name yields `orgs == '[]'`, which describes the
  // INPUT, not the hub.
  //
  // The guard is the same in every case: a scheduled run may disable; a
  // workflow_dispatch may only disable when it was not narrowed to one org.
  const offenders = [];
  for (const { file, doc } of workflows()) {
    const takesOrgInput = doc?.on?.workflow_dispatch?.inputs?.org !== undefined;
    if (!takesOrgInput) continue;

    for (const [jobName, job] of Object.entries(doc?.jobs ?? {})) {
      const disables = (job?.steps ?? []).some((s) =>
        /gh\s+workflow\s+disable/.test(String(s?.run ?? "")),
      );
      if (!disables) continue;

      const guard = String(job?.if ?? "").replace(/\s+/g, " ");
      const scopeChecked =
        /github\.event_name\s*!=\s*'workflow_dispatch'/.test(guard) &&
        /inputs\.org\s*==\s*''/.test(guard);
      if (!scopeChecked) offenders.push(`${file} job '${jobName}'`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "disables a workflow without proving the run covered every org:\n" + offenders.join("\n"),
  );
});

test("no workflow stages a control-repo directory that might not exist", () => {
  // `git add <dir>/` EXITS 128 when the directory is absent, and stages
  // nothing at all - not even the pathspecs that did match. Under `set -e`
  // that kills the step, so work already done against the checkout is written
  // and then discarded, with a green-looking script and a red step nobody
  // reads as data loss.
  //
  // It bites because CONTROL_SCAFFOLD_DIRS grows: `teams/` joined the staging
  // list on 2026-08-19 with group assignments, and every control repo
  // scaffolded before that has no teams/ (git cannot store an empty
  // directory). Surveyed live 2026-08-27 across the participating orgs:
  // PXL-Systems-Expert and PXL-2TIN-DevOps-2627 were both missing it, and both
  // had a published assignment still accepting.
  //
  // The fix is `mkdir -p` immediately before the add, not a conditional around
  // it: `git add` on an EXISTING but empty directory exits 0 and stages
  // nothing, so creating it first is a no-op when there was nothing to commit
  // and correct when there was. A `[ -d ]` guard would instead skip silently
  // over a directory that DID have content if anything went wrong upstream -
  // and, as this repo found the hard way, a shell helper defined in one `run:`
  // block does not exist in the next one.
  //
  // `|| true` and `git add -A` are also safe: neither is fatal.
  const offenders = [];
  for (const file of readdirSync(WORKFLOW_DIR).filter((f) => /\.ya?ml$/.test(f))) {
    const raw = readFileSync(join(WORKFLOW_DIR, file), "utf8");
    const lines = raw.split("\n");
    lines.forEach((line, i) => {
      if (!/git\s+(-C\s+\S+\s+)?add\s/.test(line)) return;
      if (/^\s*#/.test(line)) return;
      if (/\|\|\s*true/.test(line)) return;           // tolerated on purpose
      if (/add\s+-A\b|add\s+\.$/.test(line)) return;  // stages whatever is there
      if (/git\s+remote\s+add/.test(line)) return;

      const dirs = [...line.matchAll(/["']?([a-z][a-z-]*)\/["']?/g)].map((m) => m[1]);
      if (!dirs.length) return;

      // The mkdir has to be nearby, not merely somewhere in the file - a
      // guard satisfied from a different step is how the first version of
      // this test passed against the bug it was written for.
      const window = lines.slice(Math.max(0, i - 4), i).join("\n");
      for (const d of dirs) {
        if (!new RegExp(`mkdir -p [^\\n]*\\b${d}\\b`).test(window)) {
          offenders.push(`${file}:${i + 1} stages ${d}/ without a preceding mkdir -p`);
        }
      }
    });
  }
  assert.deepEqual(
    offenders,
    [],
    "git add is fatal on a missing directory, and these are unguarded:\n" +
      offenders.map((o) => `  ${o}`).join("\n"),
  );
});

test("a reusable workflow has a caller, and every workflow can actually fire", () => {
  // A workflow nothing can trigger is untested code that looks like coverage.
  // This repo has already been bitten twice by paths nothing exercised:
  // sync-starter-code.yml and open-feedback-prs.yml were both broken from
  // their first line - the App-token step had the wrong input - and nothing
  // noticed, because both are dispatch-only and no cron ever went red.
  //
  // Found by the same sweep, 2026-08-27: provision.yml was `workflow_call`
  // only with ZERO runs in its entire history and no caller anywhere in the
  // repo, and its companion provision-caller-example.yml had been failing
  // since 2026-06-24. Real provisioning goes through `uses: ./provisioning`
  // directly. Both removed; ARCHITECTURE stopped listing a workflow the
  // system does not use.
  const files = readdirSync(WORKFLOW_DIR).filter((f) => /\.ya?ml$/.test(f));

  // A caller is another file, and it is a `uses:` line - not a comment.
  // The first version of this test searched every workflow's whole text
  // including the candidate's own, and _find-orgs.reusable.yml names ITSELF in
  // its header comment ("Called via `uses: ./.github/workflows/...`"), so
  // deleting all five of its real callers still passed. A guard satisfied by
  // the thing it is checking is the shape this whole sweep keeps finding.
  const callersOf = (file) =>
    files
      .filter((f) => f !== file)
      .some((f) =>
        readFileSync(join(WORKFLOW_DIR, f), "utf8")
          .split("\n")
          .some((l) => !/^\s*#/.test(l) && /uses:/.test(l) && l.includes(`/${file}`)),
      );

  const unreachable = [];
  for (const { file, doc } of workflows()) {
    const on = doc?.on ?? {};
    const triggers = typeof on === "string" ? [on] : Object.keys(on);
    if (!triggers.length) {
      unreachable.push(`${file} declares no trigger at all`);
      continue;
    }

    // A reusable workflow fires only when something calls it by path.
    const onlyCallable = triggers.length === 1 && triggers[0] === "workflow_call";
    if (onlyCallable) {
      const referenced = callersOf(file);
      if (!referenced) unreachable.push(`${file} is workflow_call only and nothing calls it`);
    }
  }
  assert.deepEqual(
    unreachable,
    [],
    "these cannot be triggered, so nothing exercises them:\n" +
      unreachable.map((u) => `  ${u}`).join("\n"),
  );
});

test("the retry serializes against the same things an ordinary acceptance does", () => {
  // GitHub serializes only runs whose concurrency group STRING matches, so two
  // workflows that both provision for a student have to build that string the
  // same way or they do not wait for each other at all.
  //
  // They did not. acceptance-handler keys on `team_hint || github_login` -
  // per-TEAM for a group assignment, which is the only thing guarding
  // max_team_size, since there is no distributed lock (ARCHITECTURE 5.8) and
  // accept.mjs really does members.push() then writeFile(). retry-acceptance
  // keyed on github_login alone, so a lecturer's retry and a student's join on
  // the same team produced different strings, both ran, and both could read
  // the manifest at n-1 members and append.
  //
  // The retry cannot discover the team itself - a concurrency group is
  // evaluated before any step runs - so the lecturer supplies it and the keys
  // then coincide. Left empty it behaves exactly as it did.
  const groupOf = (file) => {
    const doc = parse(readFileSync(join(WORKFLOW_DIR, file), "utf8"));
    return String(doc?.concurrency?.group ?? "");
  };

  const handler = groupOf("acceptance-handler.yml");
  const retry = groupOf("retry-acceptance.yml");

  assert.match(handler, /^accept-/, "the acceptance group must still be the accept- family");
  assert.match(retry, /^accept-/, "the retry must serialize in the same family");

  // Both must fall back to the login, and both must prefer a team key.
  for (const [name, group] of [["acceptance-handler", handler], ["retry-acceptance", retry]]) {
    assert.match(group, /github_login/, `${name}: must key on the login`);
    assert.match(
      group,
      /team_hint|team_slug/,
      `${name}: must prefer a team key, or per-team serialization is lost`,
    );
    assert.match(group, /\|\|/, `${name}: the team key must FALL BACK to the login`);
  }
});

test("every control-repo commit pushes through the retry helper", () => {
  // A control repository is written by many things at once: the nightly, a
  // dashboard regeneration, every acceptance, a lecturer's retry. A bare
  // `git push` loses to any of them with a non-fast-forward and takes the
  // record with it.
  //
  // scripts/git-push-with-retry.sh exists for exactly this and its own header
  // records what it replaced - `git pull --rebase || true; git push`, which
  // pushed whatever the working tree held even when the rebase had failed. It
  // rebases properly and FAILS if it cannot, rather than reporting success
  // over a lost write.
  //
  // Found by sweeping, 2026-08-27: open-feedback-prs.yml and
  // sync-starter-code.yml both committed to a control repo and then ran a bare
  // `git push`. Both are dispatch-only - so they run precisely when a lecturer
  // is doing something else - and both are the pair that had never run at all
  // until 2026-08-25, which is why nothing had noticed.
  // Scoped PER STEP, not per file. publish-assignment.yml pushes the BROKER
  // repository in one step and the control repo in others; a file-wide scan
  // called that broker push a violation, which it is not - a broker is created
  // fresh by that same step and has no concurrent writer.
  const offenders = [];
  for (const { file, doc } of workflows()) {
    for (const job of Object.values(doc?.jobs ?? {})) {
      for (const step of job?.steps ?? []) {
        const run = String(step?.run ?? "");
        if (!/git (-C \S+ )?commit/.test(run)) continue;
        // A step that builds its own remote is pushing somewhere else.
        if (/BROKER_REPO|git remote add/.test(run)) continue;

        // In scope only when the step is operating on a CONTROL checkout.
        // setup-org.yml pushes the hub's `participating-orgs` branch, which is
        // a different repository with a different contention profile - and it
        // is already serialized by that workflow's own setup-org-registry
        // concurrency group, so nothing races it.
        const inControl =
          /git -C control\b/.test(run) || step["working-directory"] === "control";
        if (!inControl) continue;

        for (const line of run.split("\n")) {
          if (/^\s*#/.test(line)) continue;
          if (!/^\s*git (-C \S+ )?push\b/.test(line)) continue;
          offenders.push(`${file} step "${step.name ?? "(unnamed)"}": ${line.trim()}`);
        }
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "these push to a control repo without rebasing on contention:\n" +
      offenders.map((o) => `  ${o}`).join("\n"),
  );
});

test("publishing never force-pushes the broker", () => {
  // An org is entitled to forbid force-push - PXL-Systems-Expert carries
  // Classroom50 org rulesets that do - and rewriting a broker's history buys
  // nothing. A rejected push here fails the publish after the invitation has
  // already been minted.
  const broker = readFileSync(join(root, "acceptance", "broker-workflow.yml"), "utf8");
  const publish = readFileSync(join(WORKFLOW_DIR, "publish-assignment.yml"), "utf8");
  const forcePush = /git push[^\r\n]*--force/;
  assert.ok(!forcePush.test(publish), "publish must not force-push the broker");
  assert.ok(!forcePush.test(broker), "the broker template must not force-push either");
});

test("the provisioning App's key never reaches a public broker", () => {
  // THE BIGGEST BLAST RADIUS IN THE SYSTEM, until 2026-08-31.
  //
  // publish-assignment.yml wrote PXL_APP_PRIVATE_KEY as a repository secret
  // onto every `broker-<id>` repo, and those are created `--public`. Counted
  // live: 11 of them across 8 organizations. `GET /apps/pxl-classroom-
  // provisioner` shows what that key mints - administration=write,
  // organization_administration=write, members=write, secrets=write,
  // workflows=write, contents=write - on every org the App is installed on.
  // `workflows: write` with `contents: write` is arbitrary code execution in
  // every repository in every course org.
  //
  // Anyone with admin on ONE course org could push a workflow to that org's
  // broker and read the secret out, so a lecturer scoped to one course held the
  // keys to all twelve. Scoping the minted TOKEN never addressed it: the secret
  // is what is stored, and that was the unscoped master key.
  //
  // The broker now gets its own App - hub repository only, Contents: write only,
  // which is exactly what POST /dispatches requires. This test is what stops the
  // old wiring coming back, in either file.
  const broker = readFileSync(join(root, "acceptance", "broker-workflow.yml"), "utf8");
  const publish = readFileSync(join(WORKFLOW_DIR, "publish-assignment.yml"), "utf8");

  // Comments blanked: both files explain the change by NAMING the old secret,
  // and a raw scan reads the prose as configuration.
  const brokerCode = broker.replace(/^\s*#[^\n]*$/gm, "");
  assert.ok(
    !/PXL_APP_PRIVATE_KEY|PXL_APP_CLIENT_ID/.test(brokerCode),
    "the broker must not reference the provisioning App's credential at all",
  );

  const doc = parse(broker);
  const mint = Object.values(doc.jobs)[0].steps.find(
    (s) => typeof s?.uses === "string" && s.uses.startsWith("actions/create-github-app-token@"),
  );
  assert.ok(mint, "the broker must still mint a dispatch token");
  assert.match(String(mint.with["client-id"]), /PXL_BROKER_CLIENT_ID/, "minted with the broker App");
  assert.match(String(mint.with["private-key"]), /PXL_BROKER_PRIVATE_KEY/, "minted with the broker App");
  // Defence in depth on top of the narrow secret: `repositories` bounds it to
  // the hub, and the permission bounds it to the one call it makes.
  assert.equal(mint.with.repositories, "pxl-classroom", "the token is scoped to the hub repository");
  assert.equal(mint.with["permission-contents"], "write", "and to the one permission a dispatch needs");
  assert.ok(
    !("permission-workflows" in mint.with) && !("permission-administration" in mint.with),
    "the broker token must never ask for anything beyond contents",
  );

  // The other half: publish must not write the App key to a broker, and must
  // actively remove it from the eleven that already carry it. Ceasing to write
  // a secret does not delete it.
  const publishCode = publish.replace(/^\s*#[^\n]*$/gm, "");
  assert.ok(
    !/gh secret set PXL_APP_(PRIVATE_KEY|CLIENT_ID)/.test(publishCode),
    "publish must never write the provisioning App's credential to a broker",
  );
  assert.match(
    publishCode,
    /gh secret delete "?\$?\{?name\}?"?|gh secret delete PXL_APP_PRIVATE_KEY/,
    "publish must REMOVE the legacy secret from brokers that still hold it - republishing is the migration",
  );
  // Ordering is load-bearing: the old broker workflow reads PXL_APP_CLIENT_ID,
  // so deleting before the new workflow is pushed breaks acceptance in between.
  assert.ok(
    publishCode.indexOf("Push broker workflow") < publishCode.indexOf("Remove the provisioning App key"),
    "the legacy secret must be removed AFTER the new broker workflow is pushed, never before",
  );
});

// A `run:` block bigger than the pipe buffer deadlocks the linter on Windows.
//
// actionlint copies each script to shellcheck's stdin. Windows anonymous pipes
// hold ~4 KB by default; once the script exceeds that, the copy blocks on a
// full pipe and Wait() never returns - actionlint hangs for ever, with no
// output and no exit. Linux pipes hold 64 KB, so CI stays green throughout,
// which is the worst possible shape: `npm run lint` is the command CLAUDE.md
// says to trust, and it silently stopped terminating on 2026-08-26 when one
// step in publish-assignment.yml reached 4145 bytes. The commit that did it
// shipped with "local actionlint could not be run to completion" in its
// message instead of a lint result.
//
// scripts/lint.mjs now times that out and names the cause, but a two-minute
// timeout is a diagnosis, not a guard. This is the guard: it runs in
// milliseconds, on every platform, and points at the fix.
//
// The step that did it measured 4106 bytes and every other block in the repo
// was under 3 KB, which puts the cliff exactly at the 4096-byte buffer rather
// than somewhere near it. The limit is set well below anyway: actionlint
// rewrites the script before handing it over, so the last few bytes of
// headroom are not ours to spend.
const MAX_RUN_BLOCK_BYTES = 3500;

test("no run: block is large enough to deadlock actionlint's shellcheck", () => {
  // Composite actions too - actionlint lints their run: blocks the same way,
  // and tests/broker-injection.test.mjs already had to learn that lesson.
  const files = [
    ...readdirSync(WORKFLOW_DIR).filter((f) => f.endsWith(".yml")).map((f) => join(WORKFLOW_DIR, f)),
    ...readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith(".") && d.name !== "node_modules")
      .map((d) => join(root, d.name, "action.yml"))
      .filter((p) => existsSync(p)),
  ];

  const oversized = [];
  let scanned = 0;

  const visitSteps = (steps, label) => {
    for (const step of steps || []) {
      if (typeof step?.run !== "string") continue;
      scanned++;
      const bytes = Buffer.byteLength(step.run, "utf8");
      if (bytes > MAX_RUN_BLOCK_BYTES) {
        oversized.push(`${label} -> "${step.name || "(unnamed step)"}": ${bytes} bytes`);
      }
    }
  };

  for (const path of files) {
    const doc = parse(readFileSync(path, "utf8"));
    const label = relative(root, path);
    for (const job of Object.values(doc?.jobs || {})) visitSteps(job?.steps, label);
    visitSteps(doc?.runs?.steps, label); // composite action
  }

  // A walk that silently stops matching looks exactly like a clean repo.
  assert.ok(scanned > 40, `expected to scan many run: blocks, saw ${scanned}`);

  assert.deepEqual(
    oversized,
    [],
    "these run: blocks will hang `npm run lint` on Windows. Split the step - it is " +
      "platform-neutral and the blocks read better anyway; a Windows-only workaround " +
      "would reintroduce the local-vs-CI drift scripts/lint.mjs exists to end:\n  " +
      oversized.join("\n  ")
  );
});
