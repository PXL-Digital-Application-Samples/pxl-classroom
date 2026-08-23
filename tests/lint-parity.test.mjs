// PXL Classroom - lint-parity.test.mjs
//
// `npm run lint` was `eslint .`. CI's `test` job ran `npx eslint . --max-warnings 0`
// and CI's `lint` job ran actionlint plus scripts/workflow-lint.mjs, neither of
// which had any local equivalent. So a change could be linted clean locally,
// repeatedly, while CI had been red since 48ed831 over a shellcheck finding no
// local command would ever produce - and nine commits shipped on top of it.
//
// The fix is that both sides run one command. This is what stops them drifting
// apart again: CI may not lint by any route other than `npm run lint`, and that
// script has to actually carry all three checks.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const ciText = readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8");
const ci = parse(ciText);
const lintScript = readFileSync(join(root, "scripts", "lint.mjs"), "utf8");

/** Every `run:` body in ci.yml, with the job and step it came from. */
function ciRunSteps() {
  const out = [];
  for (const [jobName, job] of Object.entries(ci.jobs || {})) {
    for (const step of job.steps || []) {
      if (typeof step.run === "string") out.push({ job: jobName, name: step.name, run: step.run });
    }
  }
  return out;
}

test("npm run lint is the single entry point", () => {
  assert.equal(pkg.scripts.lint, "node scripts/lint.mjs");
});

test("CI lints only by running npm run lint", () => {
  // A second lint invocation is how they came apart the first time: CI grew
  // checks that package.json never learned about.
  const offenders = ciRunSteps().filter(
    (s) => /\b(eslint|actionlint|shellcheck|workflow-lint)\b/.test(s.run) && !/npm run lint\b/.test(s.run)
  );
  assert.deepEqual(
    offenders.map((s) => `${s.job}: ${s.name ?? s.run.trim().split("\n")[0]}`),
    [],
    "these CI steps lint by some route a developer cannot reproduce with `npm run lint`"
  );
});

test("CI does lint, by that route", () => {
  const lintSteps = ciRunSteps().filter((s) => /npm run lint\b/.test(s.run));
  assert.ok(lintSteps.length > 0, "ci.yml must run `npm run lint` somewhere");
});

test("the entry point carries all three checks", () => {
  // Not a spelling check on the file: each of these is the command the script
  // actually spawns, and dropping one silently is the failure mode.
  assert.match(lintScript, /eslint/, "eslint");
  assert.match(lintScript, /workflow-lint\.mjs/, "this repo's own workflow rules + bash -n");
  assert.match(lintScript, /actionlint/, "actionlint - the only thing running shellcheck on run: blocks");
  assert.match(lintScript, /--max-warnings/, "a warning nobody fails on is a warning nobody reads");
});

test("the external tools are pinned, and shellcheck is not the runner's", () => {
  // actionlint at a floating version reports different findings over time; a
  // shellcheck taken from whatever the runner image ships is the same drift in
  // another coat, since that is what decides which SC* codes appear.
  assert.match(lintScript, /ACTIONLINT_VERSION = "\d+\.\d+\.\d+"/, "actionlint version is pinned in one place");
  assert.ok(pkg.devDependencies?.shellcheck, "shellcheck is a pinned devDependency, not a runner coincidence");
  assert.match(lintScript, /node_modules[\\/"]+.*shellcheck/, "and that is the binary actionlint is pointed at");
  assert.match(lintScript, /-shellcheck/, "passed explicitly rather than left to PATH");
});

test("a missing tool fails the run instead of skipping the check", () => {
  // The whole bug was a check that did not run and said nothing.
  const missingToolBranch = lintScript.slice(lintScript.indexOf("if (!actionlint)"));
  assert.match(missingToolBranch, /failed = true/, "an unobtainable tool must fail, not warn");
  assert.doesNotMatch(
    lintScript,
    /SKIP_ACTIONLINT|skipActionlint|--no-actionlint/,
    "no escape hatch: one would be used, and then relied on"
  );
});

test(".tools is ignored, so the fetched binary never lands in a commit", () => {
  const ignored = readFileSync(join(root, ".gitignore"), "utf8");
  assert.match(ignored, /^\.tools\/$/m);
});
