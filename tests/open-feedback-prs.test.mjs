// PXL Classroom - scripts/open-feedback-prs.mjs
//
// This script had never run: the workflow could not mint an App token
// (`client-id` on an action version that takes `app-id`) and the script itself
// handed `loadYaml` file text instead of a path without awaiting it, so
// `assignment.feedback_pr` was `undefined` and it exited "does not have
// feedback_pr enabled" for every assignment. Everything below was found by
// finally running it against live GitHub on 2026-08-25.
//
// These are source-shape assertions rather than a fake GitHub. The behaviour
// was verified live (open / skip / adopt / re-run / partial failure); what
// needs pinning here is that the specific decisions do not quietly revert.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { isAlreadyExists, isNoCommitsBetween, feedbackPrTitle } from "../lib/feedback-pr.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = readFileSync(join(root, "scripts", "open-feedback-prs.mjs"), "utf8");
const workflow = parse(readFileSync(join(root, ".github", "workflows", "open-feedback-prs.yml"), "utf8"));

// Comments quote the faults verbatim, so a scanner that reads them as code
// confirms the opposite of what it is asserting - the trap
// tests/student-wait-copy.test.mjs already had to fix once.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

const code = stripComments(script);

test("the assignment is read from a path, and awaited", () => {
  // `loadYaml(text)` returns a Promise of a failed read. Every field on it is
  // undefined, so the script decided feedback_pr was off - for every
  // assignment, always, and silently, because that is a legitimate state.
  assert.match(code, /await loadYaml\(asgnPath\)/);
  assert.doesNotMatch(code, /loadYaml\(asgnYaml\)/);
});

test("an existing pull request is looked up among OPEN ones", () => {
  // "A pull request already exists" can only be an open one - a closed pull
  // request does not block a new one, confirmed live. Asking for `state=all`
  // and taking [0] leant on GitHub's default sort to avoid recording a CLOSED
  // pull request as the assignment's feedback thread.
  assert.match(code, /pulls\?head=[^`"']*&base=\$\{baseline\}&state=open/);
  assert.doesNotMatch(code, /state=all/);
});

test("created and adopted are counted apart", () => {
  // "12 opened" reads very differently when eleven were already there. The CLI
  // has always reported these separately; this script folded both into one
  // counter called `opened`.
  for (const name of ["created", "adopted"]) {
    assert.match(code, new RegExp(`let ${name} = 0`), `${name} needs its own counter`);
    assert.match(code, new RegExp(`${name}\\+\\+`), `${name} must actually be counted`);
  }
  assert.match(code, /\$\{created\} opened, \$\{adopted\} adopted/);
});

test("a partial failure exits non-zero", () => {
  // A run that could not open a PR for four students out of forty is not a
  // success, and a lecturer reading a green tick would never go looking.
  // Verified live: a record pointing at a missing repo gives exit code 1.
  assert.match(code, /if \(failed > 0\) \{\s*process\.exitCode = 1;/);
});

test("every counted failure is logged as one", () => {
  // The compare failure incremented `failed` while logging `[skip]` - the one
  // line a lecturer would read to decide the run was fine.
  const skipLines = code.match(/console\.log\(`\[skip\][^`]*`\)/g) || [];
  for (const line of skipLines) {
    const after = code.slice(code.indexOf(line) + line.length, code.indexOf(line) + line.length + 60);
    assert.doesNotMatch(after, /failed\+\+/, `logged as a skip but counted as a failure: ${line}`);
  }
});

test("GitHub claiming a PR exists and then not listing it is recorded", () => {
  // This branch used to fall through recording nothing at all: not opened, not
  // failed, and no record written - so the student had a feedback PR the
  // control repo never knew about and the summary said neither.
  assert.match(code, /did not list it/);
});

test("the 422s are told apart by message, not by status", () => {
  // The same 422 carries genuinely different problems. Keying on the status
  // alone would adopt a pull request in response to "No commits between", which
  // is where every student starts.
  const exists = { message: "Validation Failed", errors: [{ message: "A pull request already exists for Org:main." }] };
  const noCommits = { message: "Validation Failed", errors: [{ message: "No commits between pxl-baseline and main" }] };
  const drafts = { message: "Draft pull requests are not supported in this repository." };

  assert.equal(isAlreadyExists(422, exists), true);
  assert.equal(isAlreadyExists(422, noCommits), false);
  assert.equal(isAlreadyExists(422, drafts), false);
  assert.equal(isAlreadyExists(404, exists), false, "only a 422 means this");

  assert.equal(isNoCommitsBetween(422, noCommits), true);
  assert.equal(isNoCommitsBetween(422, exists), false);

  // Some responses put the text on `message` rather than `errors[]`.
  assert.equal(isAlreadyExists(422, { message: "A pull request already exists for Org:main." }), true);
  // Malformed bodies must not throw.
  assert.equal(isAlreadyExists(422, null), false);
  assert.equal(isAlreadyExists(422, { errors: "not an array" }), false);

  assert.equal(feedbackPrTitle({ title: "Linux Processes" }, "linux"), "Linux Processes - Feedback");
  assert.equal(feedbackPrTitle({}, "linux-processes"), "linux-processes - Feedback");
});

test("all three surfaces classify the 422 through the shared module", () => {
  // The SPA had NO adopt path: "already exists" was counted as a failure, so a
  // student whose record lost its PR number was reported broken on every run
  // and never recorded - while the CLI adopted them and the script adopted the
  // wrong one. One classifier now.
  const surfaces = {
    "scripts/open-feedback-prs.mjs": script,
    "cli/src/commands/feedback.mjs": readFileSync(join(root, "cli", "src", "commands", "feedback.mjs"), "utf8"),
    "frontend/src/views/AssignmentDetailView.vue": readFileSync(
      join(root, "frontend", "src", "views", "AssignmentDetailView.vue"), "utf8"),
  };
  for (const [name, src] of Object.entries(surfaces)) {
    const body = stripComments(src);
    assert.match(body, /isAlreadyExists\(/, `${name} must classify through lib/feedback-pr.mjs`);
    // The phrase used as a PREDICATE, not merely mentioned - a log line that
    // quotes GitHub back to the lecturer is fine and is not a second copy.
    assert.doesNotMatch(
      body,
      // Both spellings the three surfaces actually used: the phrase inside a
      // predicate call, and a regex literal built around it.
      /(includes|test|match)\([^)]*already exists|\/[^/\n]*already exists[^/\n]*\/[a-z]*/i,
      `${name} must not re-implement the "already exists" test`,
    );
  }
});

test("the SPA writes the whole cohort's records in ONE commit, and says when it cannot", () => {
  // One commitFile() per student is 200 commits on a 200-student cohort,
  // against a ~80 writes/min secondary limit - the arithmetic that made team
  // seeding use gittree. And the failed write was a console.warn, so the PRs
  // existed while the dashboard silently disagreed.
  const view = stripComments(
    readFileSync(join(root, "frontend", "src", "views", "AssignmentDetailView.vue"), "utf8"));
  const fn = view.slice(view.indexOf("async function executeOpenFeedbackPrs"));
  const end = fn.indexOf("\n}\n");
  const impl = fn.slice(0, end);

  assert.match(impl, /commitFiles\(/, "records must go in one multi-file commit");
  assert.doesNotMatch(impl, /commitFile\(/, "no per-student commit");
  assert.doesNotMatch(impl, /console\.warn/, "a failed record write must reach the lecturer");
  assert.match(impl, /recordsSaved/, "the commit result must be acted on");
});

test("S1: the pull request's head is the submission branch, run for real against a fake GitHub", async () => {
  // Review 2026-10-14: every surface spelled `main`, so a `master` template's
  // compare was a 404 for every student, and a full-history copy whose default
  // is `develop` beside a template `main` opened the template's own `main`.
  const { createServer } = await import("node:http");
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { spawn } = await import("node:child_process");
  const calls = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      calls.push({ method: req.method, url: req.url, body: raw ? JSON.parse(raw) : null });
      const send = (status, data) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
      if (req.method === "GET" && req.url.includes("/compare/")) return send(200, { ahead_by: 2 });
      if (req.method === "POST" && req.url.endsWith("/pulls")) return send(201, { number: 7, html_url: "https://github.com/Org/r-alice/pull/7" });
      return send(404, { message: "not stubbed" });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const dir = mkdtempSync(join(tmpdir(), "pxl-fbpr-"));
    mkdirSync(join(dir, "assignments"));
    mkdirSync(join(dir, "repositories", "a1"), { recursive: true });
    writeFileSync(join(dir, "assignments", "a1.yml"), "id: a1\ntitle: Lab\nfeedback_pr: true\nsubmission_ref: refs/heads/master\n");
    writeFileSync(join(dir, "repositories", "a1", "alice.json"), JSON.stringify({ github_login: "alice", repo_name: "Org/r-alice" }));
    const out = await new Promise((resolve) => {
      const p = spawn(process.execPath, [join(root, "scripts", "open-feedback-prs.mjs")], {
        env: { ...process.env, GITHUB_TOKEN: "x", ORG: "Org", ASSIGNMENT_ID: "a1", DATA_DIR: dir, GITHUB_API_URL: `http://127.0.0.1:${server.address().port}` },
      });
      let s = "";
      p.stdout.on("data", (c) => (s += c));
      p.stderr.on("data", (c) => (s += c));
      p.on("close", (code) => resolve({ code, s }));
    });
    assert.equal(out.code, 0, out.s);
    assert.ok(calls.some((c) => c.method === "GET" && c.url.endsWith("/compare/pxl-baseline...master")), JSON.stringify(calls));
    const post = calls.find((c) => c.method === "POST");
    assert.equal(post.body.head, "master");
    assert.match(post.body.body, /Head: `master`/);
  } finally {
    server.close();
  }
});

test("S1: no surface spells `main` as the head any more", () => {
  const view = readFileSync(join(root, "frontend", "src", "views", "AssignmentDetailView.vue"), "utf8");
  const cli = readFileSync(join(root, "cli", "src", "commands", "feedback.mjs"), "utf8");
  for (const [name, src] of [["script", code], ["page", stripComments(view)], ["cli", stripComments(cli)]]) {
    assert.doesNotMatch(src, /head:\s*['"]main['"]|:main&|\.\.\.main\b/, name);
    assert.match(src, /submissionBranch\(/, `${name} takes the head from the submission branch`);
  }
});

test("S10: the page offers a feedback PR only for a started repository, and 'no commits yet' is not a failure", () => {
  const view = readFileSync(join(root, "frontend", "src", "views", "AssignmentDetailView.vue"), "utf8");
  assert.match(view, /const hasWorkToReview = \(s\) => s\.submission_status === 'on-time' \|\| s\.submission_status === 'late'/);
  const fn = view.slice(view.indexOf("async function executeOpenFeedbackPrs"));
  assert.match(fn.slice(0, fn.indexOf("\n}\n")), /isNoCommitsBetween\(prRes\.status, prRes\.data\)\) \{\s*pending\+\+/);
});

test("the records are committed even when the run failed", () => {
  // The script now exits non-zero on partial failure, and the records for the
  // pull requests that DID open are already on disk. Abandoning them makes the
  // next run rediscover every one through the adopt path. Same rule as
  // daily-activity's lockdown record surviving a failed leg.
  const steps = workflow.jobs["open-prs"].steps;
  const commit = steps.find((s) => /Commit updated repository records/.test(s.name || ""));
  assert.ok(commit, "the commit step must exist");
  // ...as long as there is a checkout to commit from (TL-13 follow-up).
  assert.equal(commit.if, "always() && steps.control.outcome == 'success'", "the commit step must run even after a failure");
});
