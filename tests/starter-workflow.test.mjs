// PXL Classroom - lib/starter-workflow.mjs
//
// The fixtures are the two grading workflows this project has actually met,
// both read live on 2026-09-04:
//
//   PXL-2TIN-CloudEssentials-2627/template_proef_PE1   gated on a commit message
//   PXL-SNE-AutomationAndScripting2627/…-2627          gated on the ACTOR
//
// The second one is why `readGateMessage` is not a regex over the raw text: it
// carries `if: github.actor != 'github-classroom[bot]'`, and reading that as a
// hand-in message would tell a lecturer their students must type
// "github-classroom[bot]".

import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "yaml";

import {
  STARTER_PATH,
  buildStarterWorkflow,
  isGradingWorkflow,
  readGateMessage,
} from "../lib/starter-workflow.mjs";

const MESSAGE_GATED = `
name: Autograding Tests
on:
  push:
    branches:
      - main
jobs:
  run-autograding-tests:
    runs-on: ubuntu-latest
    if: github.event.head_commit.message == 'einde examen'
    steps:
    - name: Checkout code
      uses: actions/checkout@v4
    - name: vpc-test
      id: vpc-test
      uses: classroom-resources/autograding-io-grader@v1
      with:
        test-name: vpc test
        command: node .github/aws-autograde/vpc.js
        expected-output: correct
        comparison-method: exact
        timeout: 10
        max-score: 10
    - name: Autograding Reporter
      uses: classroom-resources/autograding-grading-reporter@v1
      env:
        VPC-TEST_RESULTS: "\${{steps.vpc-test.outputs.result}}"
      with:
        runners: vpc-test
`;

const ACTOR_GATED = `
name: Autograding Tests
'on':
    - push
    - repository_dispatch
jobs:
    run-autograding-tests:
      runs-on: ubuntu-latest
      if: github.actor != 'github-classroom[bot]'
      steps:
        - uses: actions/checkout@v4
        - name: Autograding Reporter
          uses: classroom-resources/autograding-grading-reporter@v1
          with:
            runners: t1
`;

// -----------------------------------------------------------------------------
// Is this a workflow that grades?
// -----------------------------------------------------------------------------

test("the reporter is the signal, not the filename", () => {
  // A lecturer may call the file anything. What makes it a grading workflow is
  // the step that turns results into the `Points X/Y` annotation the dashboard
  // reads.
  assert.equal(isGradingWorkflow(MESSAGE_GATED), true);
  assert.equal(isGradingWorkflow(ACTOR_GATED), true);
  assert.equal(isGradingWorkflow(buildStarterWorkflow()), true);

  assert.equal(isGradingWorkflow("name: Deploy\njobs:\n  build:\n    runs-on: ubuntu-latest\n"), false);
  assert.equal(isGradingWorkflow(""), false);
  assert.equal(isGradingWorkflow(undefined), false);
});

// -----------------------------------------------------------------------------
// What does it grade on?
// -----------------------------------------------------------------------------

test("a message gate is read back whole", () => {
  assert.equal(readGateMessage(MESSAGE_GATED), "einde examen");
});

test("an ACTOR gate is not a hand-in message", () => {
  // GitHub Classroom's own generated workflow. It grades every human push, so
  // "every push" is the honest answer - not "students must commit
  // github-classroom[bot]".
  assert.equal(readGateMessage(ACTOR_GATED), null);
});

test("no gate at all is every push", () => {
  assert.equal(readGateMessage(buildStarterWorkflow()), null);
  assert.equal(readGateMessage("name: x\njobs:\n  a:\n    runs-on: ubuntu-latest\n"), null);
});

test("unparseable YAML is not a gate, and does not throw", () => {
  // A template can hold anything. Reading it is allowed to fail; it is not
  // allowed to take the dialog down with it (nothing throws at module scope,
  // and nothing throws here either).
  assert.equal(readGateMessage("jobs: [unclosed\n  - :::"), null);
  assert.equal(readGateMessage(""), null);
  assert.equal(readGateMessage(null), null);
});

test("the gate is found whichever job carries it", () => {
  const twoJobs = `
jobs:
  lint:
    runs-on: ubuntu-latest
  grade:
    runs-on: ubuntu-latest
    if: github.event.head_commit.message == "hand in"
`;
  assert.equal(readGateMessage(twoJobs), "hand in");
});

// -----------------------------------------------------------------------------
// The starter itself
// -----------------------------------------------------------------------------

test("the starter is valid YAML, and says what it grades on", () => {
  const doc = parse(buildStarterWorkflow({ handInMessage: "einde examen" }));
  const job = doc.jobs["run-autograding-tests"];

  assert.equal(job.if, "github.event.head_commit.message == 'einde examen'");
  // The job KEY becomes the check run's name, and the score reader picks the
  // run whose name says it grades (lib/check-run-score.mjs).
  assert.match("run-autograding-tests", /grad|classroom/i);
  assert.match(job.steps[0].uses, /^actions\/checkout@v([5-9]|\d{2,})$/);
});

test("without a hand-in message it grades every push", () => {
  const doc = parse(buildStarterWorkflow({ handInMessage: "" }));
  assert.equal("if" in doc.jobs["run-autograding-tests"], false);
  assert.equal(readGateMessage(buildStarterWorkflow({ handInMessage: "   " })), null);
});

test("the example check FAILS, because a green placeholder is full marks for nothing", () => {
  // DESIGN.md §1.5's most expensive shape: a control that reports a state
  // nobody measured. A skeleton whose example step exits 0 grades an entire
  // cohort full marks and the lecturer finds out afterwards.
  const doc = parse(buildStarterWorkflow());
  const step = doc.jobs["run-autograding-tests"].steps[1];
  assert.match(step.with.command, /exit 1/);
  assert.match(step.with.command, /Replace this check/i);
});

test("every grader step is wired to the reporter, both ways", () => {
  // The three spellings that must agree - the step id, the reporter's
  // `<ID>_RESULTS` env key and its `runners:` list. A mismatch in any of them
  // loses that step's points with no error, which is the failure
  // tests/workflow-output-contract.test.mjs exists for one directory over.
  const doc = parse(buildStarterWorkflow());
  const steps = doc.jobs["run-autograding-tests"].steps;
  const graders = steps.filter((s) => /autograding-.*-grader/.test(s.uses || ""));
  const reporter = steps.find((s) => /autograding-grading-reporter/.test(s.uses || ""));

  assert.ok(graders.length > 0, "sanity: the starter has a grader step");
  const runners = String(reporter.with.runners).split(",");
  for (const g of graders) {
    assert.ok(runners.includes(g.id), `${g.id} is missing from runners:`);
    const key = `${g.id.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}_RESULTS`;
    assert.equal(reporter.env[key], `\${{ steps.${g.id}.outputs.result }}`);
  }
  assert.equal(runners.length, graders.length, "runners: names a step that does not exist");
});

test("a hand-in message carrying a quote cannot break the file", () => {
  // The generator that this replaced pasted values into YAML text, and a quote
  // in a lecturer's string closed it early - a workflow that does not parse, in
  // the template and from there in every repository generated from it.
  const nasty = `einde "examen": it's over`;
  const text = buildStarterWorkflow({ handInMessage: nasty });
  const doc = parse(text);

  // The YAML library handles the YAML. The EXPRESSION is composed, so the
  // single quote is escaped GitHub's way - doubled - or the literal ends at
  // `it` and the runner cannot evaluate what follows.
  assert.equal(
    doc.jobs["run-autograding-tests"].if,
    `github.event.head_commit.message == 'einde "examen": it''s over'`,
  );
  // And it round-trips through the reader, which is what the mismatch warning
  // compares against. Without the escape this read back as `einde "examen": it`
  // and the warning would have fired against the lecturer's own workflow.
  assert.equal(readGateMessage(text), nasty);
});

test("a double-quoted gate written by hand is read too", () => {
  const byHand = `
jobs:
  grade:
    runs-on: ubuntu-latest
    if: github.event.head_commit.message == "einde examen"
`;
  assert.equal(readGateMessage(byHand), "einde examen");
});

test("the path is the one provisioning already leaves alone", () => {
  // `injectAutogradingWorkflow` skips a template that already provides
  // `.github/workflows/autograding.yml` or `classroom.yml`. Writing anywhere
  // else would get a second, generated workflow injected beside this one, and
  // two grading check runs at the same commit.
  assert.equal(STARTER_PATH, ".github/workflows/classroom.yml");
});
