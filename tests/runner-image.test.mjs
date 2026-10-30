// Every workflow names one runner image, spelled once in lib/runner-image.mjs.
//
// `ubuntu-latest` moves by itself: GitHub moved it to 26.04 over the weeks from
// 2026-10-19 to 2026-11-19, with both images answering the label during the move,
// in the middle of a semester of exams. A workflow cannot import a constant, so
// this reads the YAML and holds each one to it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

import { repoFiles } from "./repo-files.mjs";
import { RUNNER_IMAGE, NEXT_RUNNER_IMAGE } from "../lib/runner-image.mjs";
import { buildStarterWorkflow } from "../lib/starter-workflow.mjs";
import { buildAutogradingWorkflow } from "../provisioning/provision.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROBE = ".github/workflows/runner-probe.yml";
const isWorkflow = (f) =>
  /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f) ||
  /^templates\/[^/]+\/\.github\/workflows\/[^/]+\.ya?ml$/.test(f) ||
  f === "acceptance/broker-workflow.yml";

const workflows = repoFiles().map((f) => relative(root, f).replaceAll("\\", "/")).filter(isWorkflow);
const jobsOf = (f) => Object.entries(parse(readFileSync(join(root, f), "utf8")).jobs ?? {});

test("every workflow job names RUNNER_IMAGE", () => {
  const offenders = [];
  let checked = 0;
  for (const file of workflows.filter((f) => f !== PROBE)) {
    for (const [name, job] of jobsOf(file)) {
      // A job that calls a reusable workflow has no runner of its own.
      if (job.uses) continue;
      checked++;
      if (job["runs-on"] !== RUNNER_IMAGE) offenders.push(`${file}#${name}: ${job["runs-on"]}`);
    }
  }
  assert.ok(checked > 30, `sanity: only ${checked} jobs were read`);
  assert.deepEqual(offenders, []);
});

test("the sweep reaches the broker template and the autograding templates", () => {
  assert.ok(workflows.includes("acceptance/broker-workflow.yml"));
  assert.ok(workflows.some((f) => f.startsWith("templates/")));
  assert.ok(workflows.includes(".github/workflows/ci.yml"));
});

test("the probe compares the image in use with the next one, and holds no credential", () => {
  const text = readFileSync(join(root, PROBE), "utf8");
  const [[, job]] = jobsOf(PROBE);
  assert.deepEqual(job.strategy.matrix.image, [RUNNER_IMAGE, NEXT_RUNNER_IMAGE]);
  assert.equal(job["runs-on"], "${{ matrix.image }}");
  assert.equal(job.strategy["fail-fast"], false, "one image failing must not cancel the other's answer");
  assert.doesNotMatch(text, /secrets\./);
  assert.doesNotMatch(text, /environment:/);
});

test("actionlint is told about the next image and no other", () => {
  const config = parse(readFileSync(join(root, ".github/actionlint.yaml"), "utf8"));
  assert.deepEqual(config["self-hosted-runner"].labels, [NEXT_RUNNER_IMAGE]);
});

test("what provisioning writes into a student's repository names it too", () => {
  const starter = parse(buildStarterWorkflow());
  for (const job of Object.values(starter.jobs)) assert.equal(job["runs-on"], RUNNER_IMAGE);

  const withChecks = parse(buildAutogradingWorkflow({ autograde: { tests: [{ id: "a", type: "python", script: "print(1)\n" }] } }, "Org"));
  assert.equal(withChecks.jobs.grade["runs-on"], RUNNER_IMAGE);

  const noChecks = parse(buildAutogradingWorkflow({ autograde: { tests: [] } }, "Org"));
  assert.equal(noChecks.jobs.grade["runs-on"], RUNNER_IMAGE);
});
