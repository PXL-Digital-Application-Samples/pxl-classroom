// The door nothing ever closed.
//
// `publish-assignment.yml` sets `INVITE_ENABLED=true` on an assignment's
// broker, and until 2026-09-03 nothing ever set it back. Measured that day on
// PXL-Automation-II:
//
//   broker-2526-examen-aut2-ek2   INVITE_ENABLED=true   deadline 30 Aug
//   broker-test-pe-1              INVITE_ENABLED=true
//   broker-test-pe3               INVITE_ENABLED=true
//
// The cost is not money - the broker is a PUBLIC repository, so the runner is
// free, and the repo's own header says so ("one boot on a free public
// runner"). It is that the door has nothing behind it: after the deadline the
// hub refuses every acceptance as `rejected:past-deadline`, so each boot is
// guaranteed waste, and the set of open doors grows by one per assignment for
// the life of the organization.
//
// Closing it moves the refusal into the broker's pre-runner `if:`, where it
// costs no runner at all.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const SCRIPT = read("scripts/close-acceptance.mjs");
const NIGHTLY = parse(read(".github/workflows/daily-activity.yml"));
const BROKER = read("acceptance/broker-workflow.yml");
const PUBLISH = read(".github/workflows/publish-assignment.yml");

const steps = Object.values(NIGHTLY.jobs).flatMap((j) => j.steps || []);
const closeStep = steps.find((s) => s.name === "5. Close acceptance on the broker");

test("the variable this closes is the one the broker actually reads", () => {
  // Two files, one name. Written one way and read another, the door stays open
  // and every run reports success - which is the whole shape this repo keeps
  // paying for.
  assert.match(SCRIPT, /const VARIABLE = "INVITE_ENABLED"/);
  assert.match(BROKER, /vars\.INVITE_ENABLED != 'false'/, "the broker gate must still read it");
  assert.match(PUBLISH, /gh variable set INVITE_ENABLED --body "true"/, "publishing must still open it");

  // And it must be set to the exact string the gate compares against. `false`
  // as a boolean, or "False", leaves the door open.
  assert.match(SCRIPT, /value: "false"/, 'the gate compares against the string "false"');
});

test("the broker's name is decided, never composed", () => {
  // An assignment carrying a custom `broker_repo` is why lib/broker-repo.mjs
  // exists; a hand-built `broker-${id}` here would silently close nothing on
  // exactly those assignments.
  assert.match(SCRIPT, /brokerRepoName\(/, "must go through the shared decider");
  assert.ok(
    !/`broker-\$\{/.test(SCRIPT),
    "composing the broker name is the thing lib/broker-repo.mjs exists to prevent",
  );
});

test("closing runs in the finalize job, and cannot fail the finalisation", () => {
  assert.ok(closeStep, "the nightly must close acceptance when it finalizes");
  assert.equal(closeStep["continue-on-error"], true, "a stuck variable must not undo a lockdown");
  assert.match(String(closeStep.if), /always\(\)/, "the assignment is finished either way");
  assert.match(closeStep.run, /node scripts\/close-acceptance\.mjs/);

  // It must be given the org and assignment from the matrix, and the control
  // checkout to read the assignment document from.
  assert.match(String(closeStep.env.ORG), /matrix\.assignment\.org/);
  assert.match(String(closeStep.env.ASSIGNMENT_ID), /matrix\.assignment\.assignment_id/);
  assert.equal(closeStep.env.DATA_DIR, "control");
});

test("it runs BEFORE the commit, so a push failure cannot skip it", () => {
  // The commit step can fail on a push race. Closing after it would then be
  // skipped for the one assignment that just finalized.
  const names = steps.map((s) => s.name);
  const close = names.indexOf("5. Close acceptance on the broker");
  const commit = names.indexOf("Commit + push");
  assert.ok(close > 0 && commit > 0, "both steps must exist");
  assert.ok(close < commit, "close acceptance before the commit that can race");
});

test("a failure is a warning, never [ok] and never fatal", () => {
  // The same rule the acceptance publisher learned the hard way: a failure
  // printed as the expected path, under continue-on-error, is invisible for as
  // long as nobody re-reads the log.
  const code = SCRIPT.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.equal(
    code.match(/console\.log\(\s*`\[ok\][^`]*(could not|Could not)[^`]*`/g),
    null,
    "a failure printed as [ok]",
  );
  assert.match(code, /::warning::Could not close acceptance on/, "the HTTP failure is annotated");
  assert.match(code, /res\.data\?\.message/, "with GitHub's own message, not just the status");
});

test("an unreadable assignment closes nothing rather than guessing a broker", () => {
  // Reading the document is how the broker is identified. If that read fails,
  // the only alternative is composing a name - which is the bug above.
  const code = SCRIPT.replace(/^\s*\/\/.*$/gm, "");
  const at = code.indexOf("catch (e)");
  assert.ok(at > 0, "the read must be guarded");
  assert.match(code.slice(at, at + 260), /::warning::Could not read/, "say so rather than proceed");
  assert.match(code.slice(at, at + 260), /return/, "and stop");
});
