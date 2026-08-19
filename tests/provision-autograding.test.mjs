import { test } from "node:test";
import assert from "node:assert/strict";
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
  const yaml = buildAutogradingWorkflow(assignment, "PXLAutomation");
  assert.ok(yaml.includes("uses: PXLAutomation/pxl-classroom-control/.github/workflows/grade.yml@main"));
  assert.ok(!yaml.includes("classroom-resources"));
});

test("buildAutogradingWorkflow: generates full autograding workflow with graders and reporter when visibility is public", () => {
  const assignment = {
    autograde: {
      enabled: true,
      execution_environment: "github_actions",
      visibility: "public",
      tests: [
        { id: "task-1-lint", type: "run", command: "npm run lint", timeout_s: 5, points: 5 },
        { id: "task-2-io", type: "io", command: "./greet", stdin: "Alice\n", expected_stdout: "Hello Alice\n", timeout_s: 3, points: 10 },
        { id: "task-3-pytest", type: "python", script: "def test_it(): pass", timeout_s: 15, points: 15 }
      ]
    }
  };
  const yaml = buildAutogradingWorkflow(assignment, "PXLAutomation");
  
  // Graders present
  assert.ok(yaml.includes("uses: classroom-resources/autograding-command-grader@v1"));
  assert.ok(yaml.includes("uses: classroom-resources/autograding-io-grader@v1"));
  assert.ok(yaml.includes("uses: classroom-resources/autograding-python-grader@v1"));

  // Reporter present
  assert.ok(yaml.includes("uses: classroom-resources/autograding-grading-reporter@v1"));
  assert.ok(yaml.includes("TASK_1_LINT_RESULTS"));
  assert.ok(yaml.includes("TASK_2_IO_RESULTS"));
  assert.ok(yaml.includes("TASK_3_PYTEST_RESULTS"));
  assert.ok(yaml.includes("runners: task-1-lint,task-2-io,task-3-pytest"));
  
  // Guardrails
  assert.ok(yaml.includes("timeout-minutes: 10"));
  assert.ok(yaml.includes("cancel-in-progress: true"));
});

test("buildAutogradingWorkflow: fallback for public visibility with no tests", () => {
  const assignment = {
    autograde: {
      enabled: true,
      execution_environment: "github_actions",
      visibility: "public",
      tests: []
    }
  };
  const yaml = buildAutogradingWorkflow(assignment, "PXLAutomation");
  assert.ok(yaml.includes("npm test"));
  assert.ok(yaml.includes("timeout-minutes: 10"));
});
