// lib/retry-outcome.mjs - what a lecturer's Retry decided, said by its run and
// read by the page.
//
// 2026-11-13: the page printed "Retry started. @student is on the
// assignment's list in a minute or two" as soon as the dispatch was accepted.
// The hub refused that Retry two seconds later, the run was green because a
// refusal is an outcome, and the lecturer marked the notice dealt with.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { parse as parseYaml } from "yaml";
import { RETRY_OUTCOME_TITLE, describeRetry, parseRetryOutcome, retryOutcomeLine } from "../lib/retry-outcome.mjs";

const root = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8");

// What GitHub hands back for a `::notice title=T::M` workflow command.
const annotation = (message, title = RETRY_OUTCOME_TITLE) => ({ annotation_level: "notice", title, message, path: ".github", start_line: 1 });

test("what the run writes is what the page reads: every outcome round-trips", () => {
  for (const o of [
    { accept: "accepted", provision: "provisioned:invited", record: "success" },
    { accept: "already-accepted", provision: "provisioned:exists", record: "success" },
    { accept: "rejected:no-claim", provision: "", record: "skipped" },
    { accept: "accepted", provision: "fail:template-missing", record: "failure" },
  ]) {
    assert.deepEqual(parseRetryOutcome([annotation("something else", "other"), annotation(retryOutcomeLine(o))]), o);
  }
});

test("a value that is not an outcome is not written, and not read", () => {
  assert.equal(retryOutcomeLine({ accept: "rejected:no-claim", provision: "x y", record: "$(rm -rf)" }), "accept=rejected:no-claim");
  assert.equal(retryOutcomeLine({}), "");
  assert.deepEqual(parseRetryOutcome([annotation("accept=accepted provision=<b> other=1 record")]), { accept: "accepted", provision: "", record: "" });
  assert.equal(parseRetryOutcome([annotation("accept=accepted", "someone-elses-title")]), null);
  assert.equal(parseRetryOutcome(null), null);
});

test("the script prints exactly one notice the parser reads, and none when nothing was decided", () => {
  const run = (env) => spawnSync("node", ["scripts/say-retry-outcome.mjs"], { cwd: new URL(".", root), encoding: "utf8", env: { ...process.env, ACCEPT_OUTCOME: "", PROVISION_OUTCOME: "", RECORD_OUTCOME: "", ...env } });
  const out = run({ ACCEPT_OUTCOME: "rejected:no-claim", RECORD_OUTCOME: "skipped" }).stdout.trim();
  const m = out.match(/^::notice title=([^:]+)::(.*)$/);
  assert.ok(m, out);
  assert.deepEqual(parseRetryOutcome([annotation(m[2], m[1])]), { accept: "rejected:no-claim", provision: "", record: "skipped" });
  assert.equal(run({}).stdout, "", "a run that died before deciding says nothing");
});

// -----------------------------------------------------------------------------
// The line under the button
// -----------------------------------------------------------------------------

const over = { status: "completed", conclusion: "success" };
const said = (o) => describeRetry({ login: "bob", run: over, outcome: o });

test("while the run is going it says it is waiting, and promises nothing", () => {
  for (const run of [undefined, { status: "queued" }, { status: "in_progress" }, { status: "pending" }]) {
    const v = describeRetry({ login: "bob", run });
    assert.equal(v.state, "waiting");
    assert.equal(v.done, false);
    assert.doesNotMatch(v.text, /on the assignment's list/);
  }
  const unread = describeRetry({ login: "bob", run: null });
  assert.equal(unread.done, false, "a failed read is asked again");
  assert.equal(unread.state, "unknown");
});

test("THE CASE: a green run that refused says refused, why, and what to do", () => {
  const v = said({ accept: "rejected:no-claim", provision: "", record: "skipped" });
  assert.equal(v.state, "refused");
  assert.equal(v.tone, "warning");
  assert.match(v.text, /^Not added: no confirmed email address\. /);
  assert.match(v.text, /Ask them to open the invitation link and accept again with their address; they keep their repository/);
  assert.doesNotMatch(v.text, /rejected:/, "a stored value is not a label");
});

test("a refusal with nothing a lecturer can do here says the reason alone", () => {
  const v = said({ accept: "rejected:claim-blocked", provision: "", record: "" });
  assert.equal(v.text, "Not added: too many failed attempts.");
  // An outcome this file has never heard of keeps its own words.
  assert.equal(said({ accept: "rejected:something-new", provision: "", record: "" }).text, "Not added: something new.");
});

test("added only when the record was saved", () => {
  assert.deepEqual(
    said({ accept: "accepted", provision: "provisioned:invited", record: "success" }),
    { state: "added", tone: "success", done: true, text: "@bob is on the assignment's list." },
  );
  assert.equal(said({ accept: "already-accepted", provision: "provisioned:exists", record: "success" }).state, "added");
  // Admitted, repository fine, record lost: the very failure this whole
  // change started from. Never "added".
  for (const record of ["failure", "skipped", "cancelled", ""]) {
    const v = said({ accept: "accepted", provision: "provisioned:invited", record });
    assert.equal(v.state, "failed", record);
    assert.match(v.text, /record could not be saved, so they are not on the list yet/);
  }
  assert.equal(said({ accept: "accepted", provision: "fail:template-missing", record: "success" }).state, "failed");
});

test("a run that ended without an answer never claims one", () => {
  const silent = describeRetry({ login: "bob", run: over, outcome: null });
  assert.equal(silent.state, "unknown");
  const unread = describeRetry({ login: "bob", run: over, outcome: null, outcomeRead: false });
  assert.match(unread.text, /its answer could not be read/);
  const red = describeRetry({ login: "bob", run: { status: "completed", conclusion: "failure" }, outcome: null });
  assert.equal(red.state, "failed");
  assert.match(red.text, /nothing was changed for @bob/);
  for (const v of [silent, unread, red]) assert.equal(v.done, true);
});

// -----------------------------------------------------------------------------
// The workflow says it, always, from the steps' own answers
// -----------------------------------------------------------------------------

test("retry-acceptance.yml says the outcome in a step that always runs, fed by the three steps it names", () => {
  const steps = parseYaml(read(".github/workflows/retry-acceptance.yml")).jobs.retry.steps;
  const say = steps.find((s) => /say-retry-outcome\.mjs/.test(s.run || ""));
  assert.ok(say, "the step exists");
  assert.equal(say.if, "always()", "a refusal, a failure and a success all say so");
  const script = read("scripts/say-retry-outcome.mjs");
  for (const name of Object.keys(say.env)) assert.match(script, new RegExp(`process\\.env\\.${name}\\b`), `${name} is read by the script`);
  for (const name of [...script.matchAll(/process\.env\.(\w+)/g)].map((m) => m[1])) assert.ok(name in say.env, `${name} is given by the step`);
  const id = (expr) => expr.match(/^\$\{\{ steps\.(\w+)\./)?.[1];
  const acceptStep = steps.find((s) => s.uses === "./acceptance");
  const provStep = steps.find((s) => s.uses === "./provisioning");
  const recordStep = steps.find((s) => /record-acceptance\.sh/.test(s.run || ""));
  assert.equal(say.env.ACCEPT_OUTCOME, `\${{ steps.${acceptStep.id}.outputs.outcome }}`);
  assert.equal(say.env.PROVISION_OUTCOME, `\${{ steps.${provStep.id}.outputs.outcome }}`);
  assert.ok(recordStep.id, "the record step has an id, or its outcome is the empty string for ever");
  assert.equal(say.env.RECORD_OUTCOME, `\${{ steps.${recordStep.id}.outcome }}`);
  for (const k of Object.keys(say.env)) assert.ok(steps.indexOf(steps.find((s) => s.id === id(say.env[k]))) < steps.indexOf(say));
});

test("the page no longer promises an outcome at the click", () => {
  const view = read("frontend/src/views/OrganizationView.vue");
  assert.doesNotMatch(view, /is on the assignment's list in a minute or two/);
  assert.match(view, /describeRetry\(/);
  assert.match(view, /parseRetryOutcome\(/);
});
