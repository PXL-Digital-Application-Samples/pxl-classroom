// A release redeploys, and a DRY RUN redeploys nothing.
//
// `deploy-frontend.yml` listens for `release: [published]` so the site
// restamps itself with the version just cut. That trigger cannot fire from
// `release.yml`: semantic-release authenticates with `secrets.GITHUB_TOKEN`,
// and GitHub starts no workflow run from an event that token raises. Measured
// 2026-09-22 - v1.3.1 published at 16:56:31Z, no deploy run created, live site
// still advertising v1.3.0, which is the exact symptom the trigger was added
// for in 93e61b8.
//
// So release.yml dispatches the deploy itself. The one thing that must not
// break is the dry run: it exists to answer "what WOULD this release be" and
// must change nothing, and its log is deliberately unreliable as a signal -
// a --dry-run prints "Skip v1.3.1 tag creation in dry-run mode" and then
// "Published release 1.3.1 on default channel". Anything keying off the log
// alone would deploy on a dry run.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE_PATH = join(ROOT, ".github/workflows/release.yml");
const RELEASE_SRC = readFileSync(RELEASE_PATH, "utf8");
const RELEASE = parseYaml(RELEASE_SRC);

const steps = RELEASE.jobs.release.steps;
const releaseStep = steps.find((s) => s.id === "release");
const dispatchStep = steps.find((s) => /createWorkflowDispatch/.test(s.with?.script || ""));

test("the release step is identifiable and reports whether it released", () => {
  assert.ok(releaseStep, "the semantic-release step must keep id: release");
  assert.match(
    releaseStep.run,
    /echo "released=true" >> "\$GITHUB_OUTPUT"/,
    "it must publish a `released` output for the dispatch to gate on",
  );
});

test("a dry run cannot set the released output", () => {
  // THE GUARD IS THE INPUT, NOT THE LOG. Both branches have to be present: the
  // grep says there was something to release, DRY_RUN says it actually was.
  assert.match(
    releaseStep.run,
    /\[ "\$DRY_RUN" != "true" \][\s\S]*grep -q "Published release"/,
    "released=true must require DRY_RUN != true as well as a published release",
  );
});

test("tee cannot swallow a failed release", () => {
  // Without pipefail the exit status is tee's, so a release that died would
  // still be read as "nothing to release" - or worse, the grep could match
  // output printed before the failure and redeploy after a release that never
  // happened.
  assert.match(releaseStep.run, /set -e -o pipefail/, "the release step must set pipefail");
});

test("the deploy is dispatched, and only when a release really happened", () => {
  assert.ok(dispatchStep, "release.yml must dispatch deploy-frontend.yml");
  assert.equal(
    dispatchStep.if,
    "steps.release.outputs.released == 'true'",
    "the dispatch must be gated on the release step's own output, exactly",
  );
  assert.match(dispatchStep.with.script, /workflow_id: 'deploy-frontend\.yml'/);
  assert.match(dispatchStep.with.script, /ref: 'main'/);
});

test("the job declares the permission that dispatch needs", () => {
  // A dispatch with GITHUB_TOKEN and no `actions: write` is a 403 at the moment
  // of use, after the tag exists - the release would look fine and the site
  // would stay on the old version, which is the failure this replaces.
  assert.equal(RELEASE.jobs.release.permissions.actions, "write");
});

test("the dispatch action is pinned to a SHA, like every other action here", () => {
  // The parsed value carries no comment - YAML strips it - so the SHA is
  // checked on the parsed step and the human-readable version on the source.
  assert.match(dispatchStep.uses, /^actions\/github-script@[0-9a-f]{40}$/, "pinned to a full SHA");
  assert.match(
    RELEASE_SRC,
    new RegExp(`${dispatchStep.uses.replace("/", "\\/")} # v`),
    "and the version it names must stay beside it, or nobody can read the pin",
  );
});

test("deploy-frontend still carries the release trigger, and says why it is not enough", () => {
  const deploySrc = readFileSync(join(ROOT, ".github/workflows/deploy-frontend.yml"), "utf8");
  const deploy = parseYaml(deploySrc);
  assert.deepEqual(deploy.on.release?.types, ["published"], "kept for a release cut by hand");
  assert.match(
    deploySrc,
    /GITHUB_TOKEN/,
    "and the comment must keep saying why it cannot fire for a workflow-cut release",
  );
});
