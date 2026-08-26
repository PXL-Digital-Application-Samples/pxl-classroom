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
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const WORKFLOW_DIR = join(root, ".github", "workflows");

// Credentials that grant power beyond this repository: the App key mints
// installation tokens for every participating org, and the invite key mints
// invitations every broker will accept.
const HUB_CREDENTIALS = /PXL_APP_PRIVATE_KEY|PXL_INVITE_SIGNING_KEY/;
const ENVIRONMENT = "provisioning";

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
  // retry-acceptance can provision for an arbitrary login with the deadline
  // bypassed, and setup-org creates org-level state; neither should be
  // reachable by a credential rather than a person.
  for (const file of ["setup-org.yml", "retry-acceptance.yml", "publish-assignment.yml"]) {
    const doc = parse(readFileSync(join(WORKFLOW_DIR, file), "utf8"));
    const job = Object.values(doc.jobs)[0];
    const first = job.steps[0];
    assert.equal(
      first?.name,
      "Reject automated dispatch",
      `${file}: the guard must be the first step, before anything mints a token`
    );
    assert.match(first.if, /github\.event_name == 'workflow_dispatch'/);
    assert.match(first.if, /endsWith\(github\.actor, '\[bot\]'\)/);
    assert.match(first.run, /exit 1/, `${file}: the guard must fail the run, not just log`);
  }
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
