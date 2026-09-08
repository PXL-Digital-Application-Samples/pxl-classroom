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
  assertReporterCanFindEveryRunner(reporterStep);
});

/**
 * The reporter DERIVES the environment variable it reads; we do not name it.
 * From the published source of autograding-grading-reporter@v1:
 *
 *   process.env[`${runner.trim().toUpperCase()}_RESULTS`]
 *
 * Upper-cased and nothing else - a hyphen stays a hyphen. So this is derived
 * from the `runners` list the same way, rather than written out a second time.
 * A hand-written expectation is what let the old spelling stand: the generator
 * folded `-` to `_`, the test asserted the folded name, both agreed, and the
 * reporter found `undefined` for every hyphenated id - which is every id the
 * schema's `^[a-z0-9][a-z0-9-]{0,63}$` can produce with more than one word.
 * Measured on the testbed 2026-09-08: all graders green, grading job red,
 * "The runners input must be a comma-separated list of strings", no score.
 */
function assertReporterCanFindEveryRunner(reporterStep) {
  const runners = String(reporterStep.with.runners).split(",");
  for (const runner of runners) {
    const key = `${runner.trim().toUpperCase()}_RESULTS`;
    assert.ok(
      reporterStep.env[key],
      `the reporter will read process.env[${JSON.stringify(key)}] for runner ${JSON.stringify(runner)}, and the workflow does not set it (it sets ${JSON.stringify(Object.keys(reporterStep.env))})`,
    );
    assert.equal(reporterStep.env[key], `\${{ steps.${runner.trim()}.outputs.result }}`);
  }
}

test("an io check asks for a comparison the grader will accept", () => {
  // autograding-io-grader@v1 throws on anything outside this set, and the
  // throw is caught into a result carrying NO `max_score` - so the reporter
  // scores the check 0 out of 0 and the assignment's stated total shrinks
  // without saying so. Its own action.yml documents `included`, which the code
  // refuses; the documentation is what we followed, and it was wrong.
  //
  // `exact` is also the only value that agrees with the CLI runners, which
  // compare `normalize(stdout) === normalize(expected_stdout)`. ARCHITECTURE
  // §11.6: one test definition means one thing on both paths.
  const ACCEPTED_BY_THE_GRADER = ["exact", "contains", "regex"];
  const assignment = {
    autograde: {
      enabled: true,
      execution_environment: "github_actions",
      visibility: "public",
      tests: [{ id: "io-check", type: "io", command: "./run", stdin: "x", expected_stdout: "y", points: 1 }],
    },
  };
  const doc = parse(buildAutogradingWorkflow(assignment, "PXLAutomation"));
  const io = doc.jobs.grade.steps.find((s) => s.uses === "classroom-resources/autograding-io-grader@v1");
  assert.ok(ACCEPTED_BY_THE_GRADER.includes(io.with["comparison-method"]),
    `comparison-method ${JSON.stringify(io.with["comparison-method"])} is not one the grader accepts (${ACCEPTED_BY_THE_GRADER.join(", ")})`);
  assert.equal(io.with["comparison-method"], "exact", "and equality is what the CLI runners do");
});

test("every runner's results reach the reporter under the name it looks up", () => {
  // The whole point of the generated workflow is that a score comes back. It
  // cannot if the reporter cannot find the step outputs, and that failure is
  // silent in the only way that matters: every grader step goes green.
  const assignment = {
    autograde: {
      enabled: true,
      execution_environment: "github_actions",
      visibility: "public",
      tests: [
        { id: "greeting-runs", type: "run", command: "python3 greet.py", points: 2 },
        { id: "greets-by-name", type: "io", command: "python3 greet.py", stdin: "Ada\n", expected_stdout: "Hello, Ada!", points: 3 },
        { id: "single", type: "run", command: "true", points: 1 },
      ],
    },
  };
  const doc = parse(buildAutogradingWorkflow(assignment, "PXLAutomation"));
  const reporterStep = doc.jobs.grade.steps.at(-1);
  assert.equal(reporterStep.uses, "classroom-resources/autograding-grading-reporter@v1");
  assertReporterCanFindEveryRunner(reporterStep);

  // And nothing else is in there: an env key no runner names is a result the
  // reporter will never read, which is the shape the bug had.
  assert.equal(Object.keys(reporterStep.env).length, 3);
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
  // ONE MINUTE, and this line used to read 10. The grader's `timeout` is in
  // minutes - its own action.yml says so - while the schema field is
  // `timeout_s`, seconds, default 30. A test that declares no limit never asked
  // for more than half a minute, so it gets the smallest cap that can express
  // it rather than the ten minutes the old default silently bought.
  assert.equal(ioStep.with.timeout, 1);
  assert.equal(ioStep.with.command, "./calc");
});

// Autograding on with no checks used to emit `run: npm test` - a guess at the
// student's toolchain, whose result was then reported as this assignment's
// grade in every repository. `tests` has minItems: 1 and the Admin Panel cannot
// produce the state any more (ARCHITECTURE §11.6), so this is only reachable from a
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
