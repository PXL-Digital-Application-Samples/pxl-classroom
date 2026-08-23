import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "yaml";
import { buildAutogradingWorkflow } from "../provisioning/provision.mjs";
import { parseCheckRunScore } from "../cli/src/commands/grade.mjs";
import { validateAgainst } from "../lib/validate.mjs";

test("autograde workflow: parses valid YAML with multi-step commands and custom timeout", () => {
  const assignment = {
    id: "cs101-lab3",
    autograde: {
      enabled: true,
      execution_environment: "github_actions",
      visibility: "public",
      tests: [
        {
          id: "step-1-compile",
          type: "run",
          command: "gcc -Wall -Werror -o solution main.c",
          timeout_s: 30,
          points: 25
        },
        {
          id: "step-2-io-basic",
          type: "io",
          command: "./solution",
          stdin: "4 5\n",
          expected_stdout: "Sum: 9\n",
          timeout_s: 10,
          points: 25
        },
        {
          id: "step-3-io-negative",
          type: "io",
          command: "./solution",
          stdin: "-10 20\n",
          expected_stdout: "Sum: 10\n",
          timeout_s: 10,
          points: 25
        },
        {
          id: "step-4-python-validator",
          type: "python",
          script: "import subprocess\nassert subprocess.run(['./solution']).returncode != 0",
          timeout_s: 15,
          points: 25
        }
      ]
    }
  };

  const yamlStr = buildAutogradingWorkflow(assignment, "PXL-CS");
  const doc = parse(yamlStr);

  assert.equal(doc.name, "Autograding");
  assert.equal(doc.on.push.branches[0], "main");
  assert.equal(doc.jobs.grade["timeout-minutes"], 10);

  const steps = doc.jobs.grade.steps;
  // checkout + 4 tests + reporter, and the python test writes its script first
  assert.equal(steps.length, 7);

  assert.equal(steps[0].uses, "actions/checkout@v4");
  
  // Step 1
  assert.equal(steps[1].id, "step-1-compile");
  assert.equal(steps[1].uses, "classroom-resources/autograding-command-grader@v1");
  assert.equal(steps[1].with["test-name"], "step-1-compile");
  assert.equal(steps[1].with.command, "gcc -Wall -Werror -o solution main.c");
  assert.equal(steps[1].with.timeout, 30);
  assert.equal(steps[1].with["max-score"], 25);

  // Step 2
  assert.equal(steps[2].id, "step-2-io-basic");
  assert.equal(steps[2].uses, "classroom-resources/autograding-io-grader@v1");
  assert.equal(steps[2].with.input, "4 5\n");
  assert.equal(steps[2].with["expected-output"], "Sum: 9\n");

  // Step 4 is the python test, and it is two steps: the script is written to a
  // file from `env:` and then run, which is what both CLI runners do. It used
  // to be `command: t.command || "pytest"` with `script` thrown away.
  assert.equal(steps[4].env.PXL_SCRIPT, "import subprocess\nassert subprocess.run(['./solution']).returncode != 0");
  assert.equal(steps[4].env.PXL_SCRIPT_PATH, ".pxl-autograde/step-4-python-validator.py");
  assert.ok(!steps[4].run.includes("subprocess"), "the script must not be pasted into the run text");
  assert.equal(steps[5].id, "step-4-python-validator");
  assert.equal(steps[5].uses, "classroom-resources/autograding-python-grader@v1");
  assert.equal(steps[5].with.command, "python3 .pxl-autograde/step-4-python-validator.py");
  assert.equal(steps[5].with["setup-command"], "", "the CLI runners install nothing either");

  // Reporter
  assert.equal(steps[6].uses, "classroom-resources/autograding-grading-reporter@v1");
  assert.equal(steps[6].with.runners, "step-1-compile,step-2-io-basic,step-3-io-negative,step-4-python-validator");
  assert.equal(steps[6].env.STEP_1_COMPILE_RESULTS, "${{ steps.step-1-compile.outputs.result }}");
  assert.equal(steps[6].env.STEP_2_IO_BASIC_RESULTS, "${{ steps.step-2-io-basic.outputs.result }}");
  assert.equal(steps[6].env.STEP_3_IO_NEGATIVE_RESULTS, "${{ steps.step-3-io-negative.outputs.result }}");
  assert.equal(steps[6].env.STEP_4_PYTHON_VALIDATOR_RESULTS, "${{ steps.step-4-python-validator.outputs.result }}");
});

test("parseCheckRunScore: handles realistic markdown tables from autograding-grading-reporter", () => {
  const realisticSummary = `
## Autograding Reporter Results

| Test Name | Status | Points |
| :--- | :--- | :--- |
| **Lint & Syntax** | :white_check_mark: Passed | 10 / 10 |
| **Unit Tests (Math)** | :white_check_mark: Passed | 20 / 20 |
| **Integration (Database)** | :x: Failed | 0 / 20 |
| **Edge Cases** | :white_check_mark: Passed | 15 / 15 |

---

### Total Score
**Points 45/65**
`;

  const run = {
    name: "Autograding",
    conclusion: "failure",
    output: {
      title: "Autograding: 45/65 points",
      summary: realisticSummary,
      text: ""
    }
  };

  const parsed = parseCheckRunScore(run, 65);
  assert.equal(parsed.earned, 45);
  assert.equal(parsed.total, 65);
  assert.equal(parsed.matched, true);
  assert.equal(parsed.passed, false);
});

test("parseCheckRunScore: handles decimals in Points (e.g. 19.5/20)", () => {
  const run = {
    name: "Autograding",
    conclusion: "failure",
    output: {
      title: "Grade Results",
      summary: "Points: 19.5 / 20.0\nOne minor lint warning.",
      text: ""
    }
  };

  const parsed = parseCheckRunScore(run, 20);
  assert.equal(parsed.earned, 19.5);
  assert.equal(parsed.total, 20);
  assert.equal(parsed.matched, true);
});

test("parseCheckRunScore: handles zero total points (Points 0/0)", () => {
  const run = {
    name: "Autograding",
    conclusion: "success",
    output: {
      title: "Pass",
      summary: "Points 0/0",
      text: ""
    }
  };

  const parsed = parseCheckRunScore(run, 0);
  assert.equal(parsed.earned, 0);
  assert.equal(parsed.total, 0);
  assert.equal(parsed.matched, true);
  assert.equal(parsed.passed, false); // total is 0
});

test("parseCheckRunScore: non-matching summary falls back to binary conclusion", () => {
  const successRun = {
    name: "Build & Test",
    conclusion: "success",
    output: {
      title: "Build succeeded",
      summary: "All 14 unit tests passed with 0 errors.",
      text: ""
    }
  };

  const parsedSuccess = parseCheckRunScore(successRun, 100);
  assert.equal(parsedSuccess.earned, 100);
  assert.equal(parsedSuccess.total, 100);
  assert.equal(parsedSuccess.passed, true);
  assert.equal(parsedSuccess.matched, false);

  const failRun = {
    name: "Build & Test",
    conclusion: "failure",
    output: {
      title: "Build failed",
      summary: "SyntaxError on line 42",
      text: ""
    }
  };

  const parsedFail = parseCheckRunScore(failRun, 100);
  assert.equal(parsedFail.earned, 0);
  assert.equal(parsedFail.total, 100);
  assert.equal(parsedFail.passed, false);
  assert.equal(parsedFail.matched, false);
});

test("schema validation: grading-result with full test breakdown", () => {
  const gradingDoc = {
    schema_version: 1,
    assignment_id: "cloud-pe-2",
    github_login: "student_star",
    archive_sha: "f".repeat(40),
    archive_branch: "preserved/cloud-pe-2/student_star",
    graded_at: "2026-03-01T15:00:00.000Z",
    graded_by: "system_checks_api",
    runner: "github_actions",
    total_points: 100,
    earned_points: 92.5,
    tests: [
      {
        id: "task1",
        passed: true,
        points: 50,
        earned: 50,
        duration_ms: 1200,
        exit_code: 0,
        timed_out: false,
        stdout: "Task 1 passed",
        stderr: ""
      },
      {
        id: "task2",
        passed: false,
        points: 50,
        earned: 42.5,
        duration_ms: 3400,
        exit_code: 1,
        timed_out: false,
        stdout: "Task 2 partial",
        stderr: "Minor error on check 9"
      }
    ]
  };

  const { valid, errors } = validateAgainst("grading-result", gradingDoc);
  assert.equal(valid, true, JSON.stringify(errors));
});
