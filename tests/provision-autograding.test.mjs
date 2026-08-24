import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "yaml";
import { buildAutogradingWorkflow } from "../provisioning/provision.mjs";

test("buildAutogradingWorkflow: generates reusable caller when visibility is private", () => {
  const assignment = {
    autograde: {
      enabled: true,
      execution_environment: "github_actions",
      visibility: "private",
      tests: [{ id: "t1", type: "run", command: "npm test", points: 10 }]
    }
  };
  const yamlStr = buildAutogradingWorkflow(assignment, "PXLAutomation");
  assert.ok(yamlStr.includes("uses: PXLAutomation/pxl-classroom-control/.github/workflows/grade.yml@main"));
  assert.ok(!yamlStr.includes("classroom-resources"));

  // Verify valid YAML
  const doc = parse(yamlStr);
  assert.equal(doc.name, "Autograding");
  assert.ok(doc.jobs?.grade?.uses);
});

test("buildAutogradingWorkflow: generates full autograding workflow with graders and reporter when visibility is public", () => {
  const assignment = {
    autograde: {
      enabled: true,
      execution_environment: "github_actions",
      visibility: "public",
      tests: [
        { id: "task-1-lint", type: "run", command: "npm run lint", timeout_s: 5, points: 5 },
        { id: "task-2-io", type: "io", command: "./greet", stdin: "Alice\nBob\n", expected_stdout: "Hello Alice\nHello Bob\n", timeout_s: 3, points: 10 },
        { id: "task-3-pytest", type: "python", script: "def test_it(): pass", timeout_s: 15, points: 15 }
      ]
    }
  };
  const yamlStr = buildAutogradingWorkflow(assignment, "PXLAutomation");
  
  // Graders present
  assert.ok(yamlStr.includes("uses: classroom-resources/autograding-command-grader@v1"));
  assert.ok(yamlStr.includes("uses: classroom-resources/autograding-io-grader@v1"));
  assert.ok(yamlStr.includes("uses: classroom-resources/autograding-python-grader@v1"));

  // Reporter present
  assert.ok(yamlStr.includes("uses: classroom-resources/autograding-grading-reporter@v1"));
  assert.ok(yamlStr.includes("TASK_1_LINT_RESULTS"));
  assert.ok(yamlStr.includes("TASK_2_IO_RESULTS"));
  assert.ok(yamlStr.includes("TASK_3_PYTEST_RESULTS"));
  assert.ok(yamlStr.includes("runners: task-1-lint,task-2-io,task-3-pytest"));
  
  // Guardrails
  assert.ok(yamlStr.includes("timeout-minutes: 10"));
  assert.ok(yamlStr.includes("cancel-in-progress: true"));

  // Verify parsed YAML structure
  const doc = parse(yamlStr);
  assert.equal(doc.name, "Autograding");
  assert.equal(doc.jobs.grade["timeout-minutes"], 10);
  // checkout + 3 tests + reporter, plus the python test's write-script step
  assert.equal(doc.jobs.grade.steps.length, 6);
});

test("buildAutogradingWorkflow: sanitizes runner IDs and environment variable keys", () => {
  const assignment = {
    autograde: {
      enabled: true,
      execution_environment: "github_actions",
      visibility: "public",
      tests: [
        { id: "Task 1.0 (Setup & Build)", type: "run", command: "make build", points: 10 },
        { id: "task_2_test!", type: "run", command: "make test", points: 20 }
      ]
    }
  };
  const yamlStr = buildAutogradingWorkflow(assignment, "PXLAutomation");
  const doc = parse(yamlStr);
  assert.ok(doc);
  
  // Reporter step is the last step
  const reporterStep = doc.jobs.grade.steps[doc.jobs.grade.steps.length - 1];
  assert.equal(reporterStep.uses, "classroom-resources/autograding-grading-reporter@v1");
  assert.ok(reporterStep.with.runners.includes("task-1-0--setup---build-"));
  assert.ok(reporterStep.with.runners.includes("task_2_test-"));
  assert.ok(reporterStep.env["TASK_1_0__SETUP___BUILD__RESULTS"]);
  assert.ok(reporterStep.env["TASK_2_TEST__RESULTS"]);
});

test("buildAutogradingWorkflow: handles io tests with multiline strings and default parameters", () => {
  const assignment = {
    autograde: {
      enabled: true,
      execution_environment: "github_actions",
      visibility: "public",
      tests: [
        { id: "io-test-default", type: "io", command: "./calc" }
      ]
    }
  };
  const yamlStr = buildAutogradingWorkflow(assignment, "PXLAutomation");
  const doc = parse(yamlStr);
  const ioStep = doc.jobs.grade.steps[1];
  assert.equal(ioStep.uses, "classroom-resources/autograding-io-grader@v1");
  assert.equal(ioStep.with["max-score"], 1);
  assert.equal(ioStep.with.timeout, 10);
  assert.equal(ioStep.with.command, "./calc");
});

// Autograding on with no checks used to emit `run: npm test` - a guess at the
// student's toolchain, whose result was then reported as this assignment's
// grade in every repository. `tests` has minItems: 1 and the Admin Panel cannot
// produce the state any more (UX_PLAN §6.3), so this is only reachable from a
// hand-written YAML the schema rejects. It fails loudly instead of grading
// somebody else's test command.
test("buildAutogradingWorkflow: enabled with no checks fails the run rather than guessing one", () => {
  for (const autograde of [
    { enabled: true, execution_environment: "github_actions", visibility: "public", tests: [] },
    { enabled: true, execution_environment: "github_actions", visibility: "public" },
  ]) {
    const yamlStr = buildAutogradingWorkflow({ autograde }, "PXLAutomation");
    assert.ok(!yamlStr.includes("npm test"), "no guess at the student's toolchain");

    const doc = parse(yamlStr);
    assert.equal(doc.jobs.grade.steps.length, 1);
    const [step] = doc.jobs.grade.steps;
    assert.match(step.run, /exit 1/, "a job that reports a grade it did not measure is worse than a red one");
    assert.match(step.run, /defines no checks/, "and it says what is wrong");
  }
});
