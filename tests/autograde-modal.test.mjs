// UX_PLAN §6 - automated checks stop being a config language.
//
// The presets are the interesting part: "add a row, now pick a type, now work
// out which of four textareas that type wants" is a language, and the schema
// was the only thing checking the result - three commits downstream, as
// `/autograde/tests/0/id must match pattern "^[a-z0-9]..."`.
//
// So these run the REAL presets through the REAL schema. A test that asserted
// the preset objects look right would pass while `additionalProperties: false`
// rejected every one of them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

import { validateAgainst } from "../lib/validate.mjs";
import { buildAutogradingWorkflow } from "../provisioning/provision.mjs";
import {
  CHECK_PRESETS,
  newCheck,
  checkProblem,
  checkProblems,
  cleanChecks,
  totalPoints,
  summariseAutograde,
} from "../frontend/src/lib/autograde.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const base = () => parse(readFileSync(join(root, "tests", "fixtures", "valid-assignment.yml"), "utf8"));

const withChecks = (checks, over = {}) => ({
  ...base(),
  autograde: { enabled: true, execution_environment: "lecturer_local", ...over, tests: cleanChecks(checks) },
});

// ------------------------------------------------------------------ presets

test("every preset produces a check the schema accepts, straight out of the box", () => {
  for (const preset of CHECK_PRESETS) {
    const check = newCheck(preset.key, []);
    assert.ok(check, `${preset.key} must produce a check`);
    assert.equal(checkProblem(check), null, `${preset.key} arrives complete`);

    const { valid, errors } = validateAgainst("assignment", withChecks([check]));
    assert.equal(valid, true, `${preset.key}: ${JSON.stringify(errors)}`);
  }
});

test("all three presets together still validate, and reach the generator", () => {
  const checks = CHECK_PRESETS.map((p) => newCheck(p.key, []));
  const doc = withChecks(checks, { execution_environment: "github_actions", visibility: "public" });

  const { valid, errors } = validateAgainst("assignment", doc);
  assert.equal(valid, true, JSON.stringify(errors));

  // The workflow the generator builds from them is real YAML with a step per
  // check - the python one contributing two.
  const workflow = parse(buildAutogradingWorkflow(doc, "PXLAutomation"));
  const steps = workflow.jobs.grade.steps;
  assert.equal(steps.length, 6, "checkout + run + io + (write + python) + reporter");
  assert.equal(steps.at(-1).with.runners, "builds,output,script");
});

test("a second check of the same kind gets its own id, because ids collide in the workflow", () => {
  const first = newCheck("run", []);
  const second = newCheck("run", [first]);
  const third = newCheck("run", [first, second]);
  assert.deepEqual([first.id, second.id, third.id], ["builds", "builds-2", "builds-3"]);
  assert.deepEqual(checkProblems([first, second, third]), [null, null, null]);
});

test("an unknown preset produces nothing rather than an empty row", () => {
  assert.equal(newCheck("nonsense", []), null);
});

// --------------------------------------------------------------- row checks

test("an incomplete row says what is missing, in lecturer words", () => {
  const cases = [
    [{ id: "", type: "run", command: "make", points: 1 }, /give this check an ID/i],
    [{ id: "Task 1", type: "run", command: "make", points: 1 }, /lowercase letters, numbers and dashes/],
    [{ id: "ok", type: "run", command: "  ", points: 1 }, /command to run/],
    [{ id: "ok", type: "io", command: "./x", points: 1 }, /what output to expect/],
    [{ id: "ok", type: "python", script: "  \n ", points: 1 }, /needs a script/],
    [{ id: "ok", type: "run", command: "make", points: -1 }, /0 or more/],
    [{ id: "ok", type: "run", command: "make", points: "abc" }, /0 or more/],
  ];
  for (const [check, pattern] of cases) {
    const problem = checkProblem(check);
    assert.ok(problem, `${JSON.stringify(check)} must be refused`);
    assert.match(problem, pattern);
    // And no JSON Pointer, keyword or regex leaks into it.
    assert.ok(!/\/autograde|minItems|\^\[a-z0-9\]/.test(problem), problem);
  }
});

test("two checks sharing an id are both flagged, because the workflow ids collide", () => {
  const problems = checkProblems([
    { id: "same", type: "run", command: "make", points: 1 },
    { id: "same", type: "run", command: "make", points: 1 },
    { id: "other", type: "run", command: "make", points: 1 },
  ]);
  assert.match(problems[0], /share this ID/);
  assert.match(problems[1], /share this ID/);
  assert.equal(problems[2], null);
});

test("a complete row is not flagged, and zero points is a legitimate choice", () => {
  assert.equal(checkProblem({ id: "setup", type: "run", command: "pip install -r req.txt", points: 0 }), null);
});

// --------------------------------------------------------------- the document

test("cleanChecks writes only the fields the type uses", () => {
  const [run, io, py] = cleanChecks([
    { id: "a", type: "run", command: "make", script: "leftover", points: 1 },
    { id: "b", type: "io", command: "./x", stdin: "1\n", expected_stdout: "2\n", points: 2 },
    { id: "c", type: "python", script: "assert True", command: "leftover", points: 3 },
  ]);
  assert.deepEqual(run, { id: "a", type: "run", points: 1, command: "make" });
  assert.deepEqual(io, { id: "b", type: "io", points: 2, command: "./x", stdin: "1\n", expected_stdout: "2\n" });
  // A leftover `command` on a python check is a field the schema forbids and
  // the generator would once have preferred over the script.
  assert.deepEqual(py, { id: "c", type: "python", points: 3, script: "assert True" });
});

test("total points is the number a lecturer actually cares about", () => {
  assert.equal(totalPoints([{ points: 10 }, { points: 5 }, { points: 0 }]), 15);
  assert.equal(totalPoints([{ points: 10 }, { points: "x" }]), 10, "a half-typed row does not make it NaN");
  assert.equal(totalPoints(null), 0);
});

// ------------------------------------------------------------- the summary

test("the summary line describes the configuration, in one line", () => {
  const cases = [
    [{ enabled: false, tests: [] }, "Off"],
    [{ enabled: true, tests: [] }, "Off"],
    [{ enabled: true, execution_environment: "lecturer_local", tests: [1, 2, 3] }, "3 checks · run on your machine"],
    [{ enabled: true, execution_environment: "lecturer_local", tests: [1] }, "1 check · run on your machine"],
    [
      { enabled: true, execution_environment: "github_actions", visibility: "private", tests: [1, 2] },
      "2 checks · run in student repos, hidden",
    ],
    [
      { enabled: true, execution_environment: "github_actions", visibility: "public", tests: [1, 2] },
      "2 checks · run in student repos, visible",
    ],
  ];
  for (const [config, expected] of cases) {
    assert.equal(summariseAutograde(config), expected, JSON.stringify(config));
  }
  assert.equal(summariseAutograde(), "Off", "and no configuration at all is Off");
});

test("an enabled configuration with no checks is Off, not an unsaveable state", () => {
  // `tests` has minItems: 1, so "enabled with zero checks" is a document the
  // schema rejects. The summary must not describe it as anything else.
  assert.equal(summariseAutograde({ enabled: true, execution_environment: "github_actions", tests: [] }), "Off");
  const { valid } = validateAgainst("assignment", withChecks([]));
  assert.equal(valid, false, "and the schema agrees it is not a document");
});
