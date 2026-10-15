// The CLI's other writes decided from what they read, RUN against a fake
// control repository (review 2026-10-14, TG-4 and TG-5): `feedback open`
// records the pull request it opened only onto the record as it is now, and
// `roster import` commits only onto the roster it planned from.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { registerFeedbackCommand } from "../src/commands/feedback.mjs";
import { registerRosterCommand } from "../src/commands/roster.mjs";
import { fakeControlRepo, install } from "./fake-control.mjs";
import { ROSTER_PATH } from "../../lib/roster-entries.mjs";

/** Run one command; a `process.exit` is caught and returned as the exit code. */
async function run(fake, register, argv) {
  const io = install(fake);
  const exit = process.exit;
  let code;
  process.exit = (c) => { code = c ?? 0; throw new Error(`exit ${code}`); };
  try {
    const program = new Command();
    program.exitOverride();
    register(program);
    try {
      await program.parseAsync(["node", "pxl", ...argv]);
    } catch (e) {
      if (!/^exit \d+$/.test(e.message)) throw e;
    }
    return { out: io.out(), err: io.err(), exitCode: code ?? io.exitCode() ?? 0 };
  } finally {
    process.exit = exit;
    io.restore();
  }
}

const LAB = stringify({ id: "lab", state: "closed", feedback_pr: true, submission_ref: "refs/heads/master" });
const record = (extra = {}) => ({ schema_version: 1, assignment_id: "lab", github_login: "ann", repo_name: "Org/lab-ann", repo_id: 10, ...extra });
const pr = { number: 7, html_url: "https://github.com/Org/lab-ann/pull/7" };

function feedbackRepo({ onCall, existingPr = false } = {}) {
  const posted = [];
  const fake = fakeControlRepo({
    files: { "assignments/lab.yml": LAB, "repositories/lab/ann.json": record() },
    onCall: (c) => onCall?.(c, fake),
    routes: (c) => {
      if (c.method === "POST" && c.path === "/repos/Org/lab-ann/pulls") {
        posted.push(c.body);
        return existingPr
          ? new Response(JSON.stringify({ message: "Validation Failed", errors: [{ message: "A pull request already exists for Org:master." }] }), { status: 422, headers: { "content-type": "application/json" } })
          : new Response(JSON.stringify(pr), { status: 201, headers: { "content-type": "application/json" } });
      }
      if (c.method === "GET" && c.path === "/repos/Org/lab-ann/pulls") return [pr];
      return undefined;
    },
  });
  return { fake, posted };
}

test("feedback open: the pull request is opened from the submission branch and recorded on the record", async () => {
  const { fake, posted } = feedbackRepo();
  const res = await run(fake, registerFeedbackCommand, ["feedback", "open", "--org", "Org", "--assignment", "lab"]);
  assert.equal(res.exitCode, 0, res.out + res.err);
  assert.equal(posted[0].head, "master", "the template's branch, never a spelled main");
  assert.equal(fake.file("repositories/lab/ann.json").feedback_pr_number, 7);
});

test("TG-4: a record changed between the read and the commit is not overwritten; the PR is said to be open and unrecorded", async () => {
  // The second branch-head read is the commit's own (the first is the fresh
  // read of the record); a Teams-tab move lands just then.
  let heads = 0;
  const { fake } = feedbackRepo({
    onCall: (c, f) => {
      if (c.method === "GET" && c.path.endsWith("/git/ref/heads/main") && ++heads === 2) {
        f.writeAs({ "repositories/lab/ann.json": record({ student_permission: "maintain" }) });
      }
    },
  });
  const res = await run(fake, registerFeedbackCommand, ["feedback", "open", "--org", "Org", "--assignment", "lab"]);
  assert.equal(res.exitCode, 1, res.out + res.err);
  assert.match(res.err, /ann: PR #7 is open, but it was not recorded: the repository record was changed by someone else while this ran/);
  assert.equal(fake.file("repositories/lab/ann.json").student_permission, "maintain", "their change stands");
  assert.equal(fake.file("repositories/lab/ann.json").feedback_pr_number, undefined);
  // Counted once, as the failure it is (R6-43): it was "1 opened" and "1
  // failed" for one student. The line above says the PR is open.
  assert.match(res.out, /0 opened, 0 adopted pre-existing, 0 already on record, 0 pending \(no commits yet\), 1 failed/);

  // Run again: GitHub says the pull request exists, so it is adopted, and
  // recorded onto the record as it is now.
  const again = feedbackRepo({ existingPr: true });
  again.fake.writeAs({ "repositories/lab/ann.json": record({ student_permission: "maintain" }) });
  const second = await run(again.fake, registerFeedbackCommand, ["feedback", "open", "--org", "Org", "--assignment", "lab"]);
  assert.equal(second.exitCode, 0, second.out + second.err);
  assert.match(second.out, /ann: adopted pre-existing PR #7/);
  const rec = again.fake.file("repositories/lab/ann.json");
  assert.equal(rec.feedback_pr_number, 7);
  assert.equal(rec.student_permission, "maintain", "written onto the record as it is now");
});

test("R6-43: feedback list shows a comment count it could not read as ?, never 0, and says so", async () => {
  const listing = (status) => fakeControlRepo({
    files: { "assignments/lab.yml": LAB, "repositories/lab/ann.json": record({ feedback_pr_number: 7, feedback_pr_url: pr.html_url }) },
    routes: (c) => (c.method === "GET" && c.path === "/repos/Org/lab-ann/pulls/7/comments"
      ? new Response(JSON.stringify(status === 200 ? [{ id: 1 }, { id: 2 }] : { message: "Server Error" }), { status, headers: { "content-type": "application/json" } })
      : undefined),
  });
  const read = await run(listing(200), registerFeedbackCommand, ["feedback", "list", "--org", "Org", "--assignment", "lab"]);
  assert.equal(read.exitCode, 0, read.out + read.err);
  assert.match(read.out, /ann\s+#7\s+2\s+https/);
  // 403, which is not retried: a 5xx is, for 14 seconds.
  const failed = await run(listing(403), registerFeedbackCommand, ["feedback", "list", "--org", "Org", "--assignment", "lab"]);
  assert.equal(failed.exitCode, 1, failed.out + failed.err);
  assert.match(failed.out, /ann\s+#7\s+\?\s+https/);
  assert.match(failed.out, /1 comment count could not be read/);
});

test("TG-5: roster import commits only onto the roster it planned from", async () => {
  const roster = { schema_version: 2, students: [{ student_number: "S1", full_name: "Ann", github_login: "ann" }] };
  const csv = join(mkdtempSync(join(tmpdir(), "pxl-roster-")), "roster.csv");
  writeFileSync(csv, "student_number,full_name,email,class_group,github_login\nS1,Ann,,,ann\nS2,Bob,,,bob\n");

  const clean = fakeControlRepo({ files: { [ROSTER_PATH]: stringify(roster) } });
  const ok = await run(clean, registerRosterCommand, ["roster", "import", csv, "--org", "Org"]);
  assert.equal(ok.exitCode, 0, ok.out + ok.err);
  assert.match(clean.file(ROSTER_PATH), /bob/);

  // The Roster tab saves while the import is between its read and its commit.
  let heads = 0;
  const racing = fakeControlRepo({
    files: { [ROSTER_PATH]: stringify(roster) },
    onCall: (c) => {
      if (c.method === "GET" && c.path.endsWith("/git/ref/heads/main") && ++heads === 2) {
        racing.writeAs({ [ROSTER_PATH]: stringify({ ...roster, students: [...roster.students, { student_number: "S9", full_name: "Cy", github_login: "cy" }] }) });
      }
    },
  });
  const refused = await run(racing, registerRosterCommand, ["roster", "import", csv, "--org", "Org"]);
  assert.equal(refused.exitCode, 1, refused.out + refused.err);
  assert.match(refused.err, /Nothing was committed: the roster was changed by someone else while this ran/);
  assert.match(racing.file(ROSTER_PATH), /cy/, "the other save stands");
  assert.doesNotMatch(racing.file(ROSTER_PATH), /bob/);
});
