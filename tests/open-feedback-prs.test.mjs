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

test("the records are committed even when the run failed", () => {
  // The script now exits non-zero on partial failure, and the records for the
  // pull requests that DID open are already on disk. Abandoning them makes the
  // next run rediscover every one through the adopt path. Same rule as
  // daily-activity's lockdown record surviving a failed leg.
  const steps = workflow.jobs["open-prs"].steps;
  const commit = steps.find((s) => /Commit updated repository records/.test(s.name || ""));
  assert.ok(commit, "the commit step must exist");
  assert.equal(commit.if, "always()", "the commit step must run even after a failure");
});
