// scripts/grade-at-deadline.mjs - the half of grading nobody had to press.
//
// The nightly finalizes an assignment and, until now, never read a score. The
// three things this has to get right are all refusals:
//
//   * it must not touch an assignment that grades nothing, or it names every
//     student in the cohort as a grading failure;
//   * it must not overwrite a summary a PERSON produced;
//   * it must not fail the finalize, which by the time it runs has already
//     locked the cohort and pushed their submissions to the archive.
//
// Driven as a subprocess against a real control-repo directory and a fake API,
// because the script's job is reading those files and writing one back.
//
// NOT spawnSync: it blocks the event loop, so an in-process server can never
// answer the child. That deadlock presents as this whole FILE timing out with
// no output rather than as a failing test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateAgainst } from "../lib/validate.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(root, "scripts", "grade-at-deadline.mjs");
const ID = "lab-1";
const REPO = "TestOrg/lab-1-ada";

// The shape GitHub actually returns for an Actions-created check run: the score
// is in the ANNOTATIONS, `output.summary` is null.
const RUN = {
  id: 77,
  name: "run-autograding-tests",
  conclusion: "success",
  html_url: "https://github.com/TestOrg/lab-1-ada/runs/1",
  output: { title: null, summary: null, text: null, annotations_count: 2 },
};
const ANNOTATIONS = [
  { annotation_level: "notice", title: "Autograding report", message: '{"totalPoints":12,"maxPoints":20}', path: ".github" },
  { annotation_level: "notice", title: "Autograding complete", message: "Points 12/20", path: ".github" },
];

function controlDir({ assignmentExtra = "", report = null, summary = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pxl-grade-"));
  mkdirSync(join(dir, "assignments"), { recursive: true });
  mkdirSync(join(dir, "reports"), { recursive: true });
  writeFileSync(
    join(dir, "assignments", `${ID}.yml`),
    [
      "schema_version: 1",
      `id: ${ID}`,
      "title: Lab 1",
      "organization: TestOrg",
      "template:",
      "  owner: TestOrg",
      "  repository: tpl",
      `repository_name_pattern: ${ID}-{github_login}`,
      "opens_at: 2026-08-01T08:00:00.000Z",
      "deadline_at: 2026-09-01T22:00:00.000Z",
      "state: closed",
      assignmentExtra,
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(dir, "reports", `${ID}.json`),
    JSON.stringify(
      report ?? {
        schema_version: 1,
        assignment_id: ID,
        generated_at: "2026-09-02T00:30:00.000Z",
        students: [{ github_login: "ada", repo_name: REPO, preserved_sha: "a".repeat(40) }],
      },
      null,
      2,
    ),
  );
  if (summary) {
    mkdirSync(join(dir, "grading", ID), { recursive: true });
    writeFileSync(join(dir, "grading", ID, "summary.json"), JSON.stringify(summary, null, 2));
  }
  return dir;
}

function fakeApi() {
  const state = { calls: [] };
  const server = createServer((req, res) => {
    state.calls.push(`${req.method} ${req.url}`);
    const send = (code, data) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    };
    // Answers for ADA'S repository only. A fake that answers for every repo
    // grades the "this repository cannot be read" case too, and the test that
    // needs a failure passes over a success.
    if (req.url.startsWith(`/repos/${REPO}/`)) {
      if (req.url.includes("/check-runs/77/annotations")) return send(200, ANNOTATIONS);
      if (req.url.includes("/check-runs")) return send(200, { check_runs: [RUN] });
    }
    // 400, never a 5xx: lib/gh.mjs retries anything >= 500 six times with the
    // secondary-rate-limit backoff, so a catch-all 599 turns an unimplemented
    // path into a suite that hangs for minutes and never says why.
    return send(400, { message: `unexpected ${req.url}` });
  });
  return { server, state };
}

const run = (dir, port, env = {}) =>
  new Promise((resolve) => {
    const child = spawn("node", [SCRIPT], {
      env: {
        ...process.env,
        DATA_DIR: dir,
        ASSIGNMENT_ID: ID,
        GITHUB_TOKEN: "x",
        GITHUB_API_URL: `http://127.0.0.1:${port}`,
        ...env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });

async function withApi(dir, env, fn) {
  const { server, state } = fakeApi();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    return await fn(await run(dir, server.address().port, env), state);
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

const summaryAt = (dir) => {
  const p = join(dir, "grading", ID, "summary.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
};

test("IT GRADES THE COHORT AND WRITES A VALID SUMMARY", async () => {
  const dir = controlDir({ assignmentExtra: "template_grades: true" });
  try {
    await withApi(dir, {}, (res) => {
      assert.equal(res.status, 0, res.stderr || res.stdout);
      const doc = summaryAt(dir);
      assert.ok(doc, `no summary written: ${res.stdout}`);
      assert.equal(doc.runner, "github_actions");
      assert.equal(doc.students[0].login, "ada");
      assert.equal(doc.students[0].earned_points, 12);
      assert.equal(doc.students[0].total_points, 20);
      // `graded_by` is NULL and the schema says what that means: "the session
      // had no user on hand". A made-up bot login here would make the next run
      // refuse to replace its own work.
      assert.equal(doc.graded_by, null);
      const v = validateAgainst("grading-summary", doc);
      assert.equal(v.valid, true, JSON.stringify(v.errors));
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AN ASSIGNMENT THAT GRADES NOTHING IS NOT TOUCHED", async () => {
  // The permissive answer here names every student in the cohort as a grading
  // failure on an assignment that has never graded anything. Same judge the
  // Admin Panel uses, from the same module.
  const dir = controlDir({ assignmentExtra: "template_grades: false" });
  try {
    await withApi(dir, {}, (res, state) => {
      assert.equal(res.status, 0, res.stderr);
      assert.match(res.stdout, /not graded in GitHub Actions/);
      assert.equal(summaryAt(dir), null);
      assert.deepEqual(state.calls, [], "and it does not go looking");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CHECKS THE LECTURER RUNS ARE NOT READ FROM CI", async () => {
  const dir = controlDir({
    assignmentExtra: [
      "autograde:",
      "  enabled: true",
      "  execution_environment: lecturer_local",
      "  tests:",
      "    - id: one",
      "      type: run",
      "      points: 5",
      "      run: make test",
    ].join("\n"),
  });
  try {
    await withApi(dir, {}, (res, state) => {
      assert.equal(res.status, 0, res.stderr);
      assert.equal(summaryAt(dir), null);
      assert.deepEqual(state.calls, []);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("IT NEVER OVERWRITES A SUMMARY A PERSON PRODUCED", async () => {
  // A lecturer ran the checks on their own machine. That result outranks this
  // one, and replacing it as a side effect of a nightly would take away work
  // they did deliberately.
  const mine = {
    schema_version: 1,
    assignment_id: ID,
    generated_at: "2026-09-01T12:00:00.000Z",
    graded_by: "tomcoolpxl",
    runner: "docker",
    students: [{ login: "ada", earned_points: 20, total_points: 20 }],
  };
  const dir = controlDir({ assignmentExtra: "template_grades: true", summary: mine });
  try {
    await withApi(dir, {}, (res, state) => {
      assert.equal(res.status, 0, res.stderr);
      assert.match(res.stdout, /already graded by @tomcoolpxl/);
      assert.deepEqual(summaryAt(dir), mine, "byte for byte what the lecturer left");
      assert.deepEqual(state.calls, [], "and it does not even look");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("but it DOES replace its own earlier reading", async () => {
  // `graded_by: null` + `runner: github_actions` is this script's own answer,
  // and a finalize run is not once. Refusing to replace it would freeze a score
  // read before a student's grading run was re-run.
  const mine = {
    schema_version: 1,
    assignment_id: ID,
    generated_at: "2026-09-01T12:00:00.000Z",
    graded_by: null,
    runner: "github_actions",
    students: [{ login: "ada", earned_points: 3, total_points: 20 }],
  };
  const dir = controlDir({ assignmentExtra: "template_grades: true", summary: mine });
  try {
    await withApi(dir, {}, (res) => {
      assert.equal(res.status, 0, res.stderr);
      assert.equal(summaryAt(dir).students[0].earned_points, 12);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("A GRADING FAILURE NEVER FAILS THE FINALIZE", async () => {
  // By the time this runs the cohort is locked and their submissions are in the
  // archive. A non-zero exit here re-queues all of that to fix a score, and
  // burns an attempt from the ceiling that stops find-finalizable looping.
  const dir = controlDir({
    assignmentExtra: "template_grades: true",
    report: {
      schema_version: 1,
      assignment_id: ID,
      generated_at: "2026-09-02T00:30:00.000Z",
      // A repository the fake API answers 400 for.
      students: [{ github_login: "ada", repo_name: "TestOrg/gone", preserved_sha: "a".repeat(40) }],
    },
  });
  try {
    await withApi(dir, {}, (res) => {
      assert.equal(res.status, 0, "the leg must survive");
      assert.match(res.stdout, /not written/);
      assert.equal(summaryAt(dir), null, "and nothing is written rather than a summary of nobody");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the workflow runs it, after the report and before the commit", () => {
  // A script nothing calls looks exactly like working automatic grading. The
  // ORDER is the property: it reads the report's rows to know which commit each
  // score belongs to, and the commit step is what carries the summary out.
  // Sliced to the FINALIZE job. `Commit + push` also names a step in the
  // collect job hundreds of lines earlier, so searching the whole file compares
  // positions in two different jobs and proves nothing.
  const whole = readFileSync(join(root, ".github/workflows/daily-activity.yml"), "utf8");
  const wf = whole.slice(whole.indexOf("\n  finalize:"));
  assert.ok(wf.length > 0, "the finalize job must be findable");
  // `uses: ./report`, not the script path: the report is a composite action.
  const report = wf.indexOf("uses: ./report");
  const grade = wf.indexOf("scripts/grade-at-deadline.mjs");
  // `- name:`, because a COMMENT above the preserve step says "the reason
  // Commit + push below already gives" and a bare search finds that first -
  // which put the commit before the grading step and failed for the wrong
  // reason. An anchor that matches prose is the same defect as one whose
  // heading was renamed.
  const commit = wf.indexOf("- name: Commit + push");
  assert.ok(report > -1 && grade > -1 && commit > -1, "all three steps must be present");
  assert.ok(report < grade, "the report is read before the scores");
  assert.ok(grade < commit, "and the summary is written before the commit that carries it");

  // `grading/` is not a scaffolded directory, so `git add grading/` on the
  // first assignment an org ever grades would exit 128 and stage NOTHING -
  // including the paths that did match.
  const step = wf.slice(commit);
  assert.match(step, /mkdir -p [^\n]*control\/grading/);
  assert.match(step, /git -C control add[^\n]*grading\//);
  assert.ok(step.indexOf("mkdir -p") < step.indexOf("git -C control add"));
});
