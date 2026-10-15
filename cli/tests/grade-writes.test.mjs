// `pxl-classroom grade` on the Actions path, RUN against a fake control
// repository (review 2026-10-14, TG-1 and TG-3): what it reads the stored
// summary at, what a failed read keeps, and what `--login` may change.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";
import { stringify } from "yaml";
import { registerGradeCommand } from "../src/commands/grade.mjs";
import { fakeControlRepo, install } from "./fake-control.mjs";
import { buildGradingSummary, gradedRowFromLocalRun } from "../../lib/grading-summary.mjs";

const SHA = { alice: "a".repeat(40), bob: "b".repeat(40) };
const LAB = stringify({
  id: "lab", state: "closed",
  autograde: { enabled: true, execution_environment: "github_actions", tests: [{ id: "t", name: "t", run: "true", points: 20 }] },
});
const REPORT = {
  schema_version: 1, assignment_id: "lab", org: "Org", generated_at: "2026-10-14T08:00:00Z",
  students: ["alice", "bob"].map((l) => ({
    github_login: l, repo_name: `Org/lab-${l}`, submission_status: "on-time", preservation_status: "preserved", preserved_sha: SHA[l],
  })),
};
const STORED = buildGradingSummary({
  assignmentId: "lab", gradedBy: "x", runner: "github_actions",
  students: [
    gradedRowFromLocalRun({ login: "alice", earnedPoints: 18, totalPoints: 20, gradedAt: "2026-10-13T08:00:00Z" }),
    gradedRowFromLocalRun({ login: "bob", earnedPoints: 12, totalPoints: 20, gradedAt: "2026-10-13T08:00:00Z" }),
  ],
});

/**
 * A scored run per student; `unread` logins answer their check runs 404, their
 * repository 200 (an API failure); `gone` ones their repository 404 too (a
 * read that failed for that student: `unreadable`); `running` ones a run still going.
 */
function cohort({ unread = [], gone = [], running = [], score = { alice: 20, bob: 15 } } = {}) {
  return fakeControlRepo({
    files: { "assignments/lab.yml": LAB, "reports/lab.json": REPORT, "grading/lab/summary.json": STORED },
    routes: (c) => {
      const m = c.path.match(/^\/repos\/Org\/lab-(\w+)(\/.*)?$/);
      if (!m) return undefined;
      const [, login, rest = ""] = m;
      if (gone.includes(login)) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
      if (rest === "") return { name: `lab-${login}`, full_name: `Org/lab-${login}` };
      if (rest === `/commits/${SHA[login]}/check-runs`) {
        if (unread.includes(login)) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
        if (running.includes(login)) return { total_count: 1, check_runs: [{ id: 9, name: "Autograding", status: "in_progress", conclusion: null, check_suite: { id: 5 }, output: { annotations_count: 0 } }] };
        return { total_count: 1, check_runs: [{ id: 9, name: "Autograding", status: "completed", conclusion: "success", check_suite: { id: 5 }, output: { title: `Points ${score[login]}/20`, summary: "", annotations_count: 0 } }] };
      }
      if (rest.startsWith("/actions/runs")) return { total_count: 0, workflow_runs: [] };
      return undefined;
    },
  });
}

async function run(fake, argv) {
  const io = install(fake);
  const exit = process.exit;
  let code;
  process.exit = (c) => { code = c ?? 0; throw new Error(`exit ${code}`); };
  try {
    const program = new Command();
    program.exitOverride();
    registerGradeCommand(program);
    try {
      await program.parseAsync(["node", "pxl", "grade", "--org", "Org", "--assignment", "lab", ...argv]);
    } catch (e) {
      if (!/^exit \d+$/.test(e.message)) throw e;
    }
    return { out: io.out(), err: io.err(), exitCode: code ?? io.exitCode() ?? 0 };
  } finally {
    process.exit = exit;
    io.restore();
  }
}

const row = (fake, login) => fake.file("grading/lab/summary.json").students.find((r) => r.login === login);

test("TG-1: the summary on record is read at the branch head's commit, and a student whose read failed keeps their row, said so", async () => {
  // A read that failed for bob alone (`unreadable`); an API failure is the next test.
  const fake = cohort({ gone: ["bob"] });
  const res = await run(fake, []);
  // Each read names the commit the branch head was at just before: never the
  // branch by name, which can answer a minute old (P2-8).
  const order = fake.calls.map((c) => `${c.method} ${c.path}${c.query}`);
  const read = order.findIndex((c) => c.startsWith("GET /repos/Org/pxl-classroom-control/contents/grading/lab/summary.json"));
  assert.ok(read > 0 && /\?ref=[0-9a-f]{40}$/.test(order[read]), order.join("\n"));
  assert.equal(order[read - 1], "GET /repos/Org/pxl-classroom-control/git/ref/heads/main", "asked for the head first");
  assert.match(res.out, /= bob: nothing new was read, so the result on record is unchanged/);
  assert.equal(row(fake, "alice").earned_points, 20, "alice read anew");
  assert.equal(row(fake, "bob").earned_points, 12, "bob's score on record stands");
  // Alice's result file, then the summary: results are written one at a time.
  assert.match(fake.commitsByCommand().at(-1).message, /^Grade lab: summary \(1 graded, 1 failed\)/);
  assert.equal(res.exitCode, 1, "a failed read is a failure of the run");
});

test("R6-43: a whole-cohort read GitHub's API failed for writes no summary, as the page and the nightly refuse it", async () => {
  const fake = cohort({ unread: ["bob"] });
  const res = await run(fake, []);
  assert.equal(res.exitCode, 1, res.out + res.err);
  assert.match(res.err, /GitHub could not be read for 1 student\(s\): bob\. Did not write the summary of scores/);
  assert.equal(row(fake, "alice").earned_points, 18, "the summary on record is as it was");
  assert.equal(row(fake, "bob").earned_points, 12);
  assert.equal(fake.commitsByCommand().some((c) => /summary/.test(c.message)), false);
});

test("TG-7 (R1-8): a run still going is written as `running`, in the words every grader uses - never 'never completed'", async () => {
  const fake = cohort({ running: ["bob"] });
  await run(fake, []);
  const failed = fake.file("grading/lab/summary.json").failed.find((r) => r.login === "bob");
  assert.equal(failed?.kind, "running", JSON.stringify(fake.file("grading/lab/summary.json")));
  assert.match(failed.reason, /still running|is still/);
  assert.doesNotMatch(failed.reason, /never completed/);
});

test("TG-3: --login, read failed - nothing is written at all", async () => {
  const fake = cohort({ unread: ["alice"] });
  const res = await run(fake, ["--login", "alice"]);
  assert.match(res.out, /Nothing was written\./);
  assert.equal(fake.commitsByCommand().length, 0);
  assert.equal(row(fake, "alice").earned_points, 18);
});

test("TG-3: --login, graded - that row changes, every other row and who read the cohort stay", async () => {
  const fake = cohort();
  const res = await run(fake, ["--login", "alice"]);
  assert.equal(res.exitCode, 0, res.out + res.err);
  const doc = fake.file("grading/lab/summary.json");
  assert.equal(row(fake, "alice").earned_points, 20);
  assert.equal(row(fake, "bob").earned_points, 12, "bob untouched");
  assert.equal(doc.graded_by, "x", "who read the cohort, not who read one student");
  assert.equal(doc.runner, "github_actions");
  // ...and only onto the summary it read: another write landing after that
  // read, before the commit, refuses it.
  let summaryRead = false;
  let changed = false;
  const racing = cohort();
  const original = racing.fetch;
  racing.fetch = async (url, init) => {
    const u = decodeURIComponent(String(url));
    if (summaryRead && !changed && u.includes("/git/ref/heads/main")) {
      changed = true;
      racing.writeAs({ "grading/lab/summary.json": { ...STORED, graded_by: "someone-else" } });
    }
    if (u.includes("/contents/grading/lab/summary.json")) summaryRead = true;
    return original(url, init);
  };
  const refused = await run(racing, ["--login", "alice"]).catch((e) => ({ err: String(e) }));
  assert.match(`${refused.err}${refused.out ?? ""}`, /the grading summary was changed by someone else while this ran/);
  assert.equal(racing.file("grading/lab/summary.json").graded_by, "someone-else", "their write stands");
});
