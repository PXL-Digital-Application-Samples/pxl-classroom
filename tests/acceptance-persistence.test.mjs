// Everything accept.mjs WRITES has to be something the workflow COMMITS.
//
// accept.mjs runs against a checkout of the control repository in the runner's
// workspace. Anything it writes that the workflow does not `git add` is written
// to a disk that is thrown away seconds later - and it fails completely
// silently, because the script succeeded, the run is green, and the file was
// really there while anyone was looking.
//
// Measured 2026-08-27 by running a real claim end to end: the acceptance
// succeeded, the log said `[ok] claim - @tomcoolpxl claimed tom.cool@pxl.be`,
// and students/claims/71908551.json was a 404 afterwards. Three things were
// inert as a result, and only the third is merely annoying:
//
//   - MAX_CLAIM_ATTEMPTS was unenforceable. The counter never persisted, so
//     the guessing oracle that has to ship bounded was in fact unbounded.
//   - `rejected:claim-taken` could never fire, because findClaimForEmail scans
//     a directory that was always empty - two accounts could hold one address.
//   - the org-scoped binding did not exist, so every assignment re-prompted.
//
// The rejected path was worse than the accepted one: the only commit step in
// the workflow is gated on an ACCEPTED outcome, so a failed attempt - the one
// case where the counter is the entire point - never reached a commit at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const workflow = parse(
  readFileSync(join(root, ".github", "workflows", "acceptance-handler.yml"), "utf8"),
);
const steps = workflow?.jobs?.accept?.steps ?? [];
const allRun = steps.map((s) => String(s?.run ?? "")).join("\n");

/**
 * Top-level control-repo directories accept.mjs WRITES into.
 *
 * Keyed on `mkdir`, not on every `join(dataDir, ...)`. The looser scan also
 * catches `assignments/`, which acceptance only ever READS - and a test that
 * demands the workflow commit a directory nothing writes is a test that has to
 * be argued with rather than believed.
 *
 * mkdir is the honest signal here: a directory is created precisely because
 * something is about to be written into it, and every write path in this file
 * is preceded by one.
 */
function directoriesWritten() {
  const src = readFileSync(join(root, "acceptance", "accept.mjs"), "utf8");
  const dirs = new Set();
  for (const m of src.matchAll(/mkdir\(\s*join\(\s*dataDir\s*,\s*"([a-z-]+)"/g)) dirs.add(m[1]);
  // `mkdir(teamsDir)` / `mkdir(acceptDir)` go through a local, so resolve the
  // one hop rather than pretending the regex saw it.
  for (const m of src.matchAll(/const\s+(\w+)\s*=\s*join\(\s*dataDir\s*,\s*"([a-z-]+)"/g)) {
    if (new RegExp(`mkdir\\(\\s*${m[1]}\\b`).test(src)) dirs.add(m[2]);
  }
  return [...dirs].sort();
}

// Whether an add is FATAL when its directory is absent is a separate rule and
// a repo-wide one - it lives in tests/workflow-hardening.test.mjs ("no workflow
// stages a control-repo directory that might not exist"), because six other
// workflows had the same shape. This file answers the narrower question: does
// the workflow commit everything accept.mjs writes.
// THE DECISION IS SAVED BY acceptance/reserve.mjs, which commits the
// directories lib/acceptance-reservation.mjs `pathsToCommit` names for the
// outcome. So "does the workflow commit everything accept.mjs writes" is now a
// question about that table - asked of the directories accept.mjs really
// creates, never of a list copied here.
test("every directory the acceptance writes is committed when it is admitted", async () => {
  const { pathsToCommit } = await import("../lib/acceptance-reservation.mjs");
  const written = directoriesWritten();
  assert.ok(written.length >= 3, `expected several written directories, found ${written.join(", ")}`);
  assert.ok(written.includes("students"), "students/ is where the claim binding and counter live");

  for (const outcome of ["accepted", "already-accepted", "confirmed", "already-confirmed"]) {
    const committed = new Set(pathsToCommit(outcome) ?? []);
    const missing = written.filter((d) => !committed.has(d));
    assert.deepEqual(
      missing,
      [],
      `accept.mjs writes these and a "${outcome}" decision does not commit them - they are discarded with the runner:\n` +
        missing.map((d) => `  ${d}/`).join("\n"),
    );
  }
});

test("a REJECTED acceptance still commits what it wrote", async () => {
  // The counter only matters on failure, so a commit gated on success is a
  // rate limit that can never count.
  const { pathsToCommit } = await import("../lib/acceptance-reservation.mjs");
  assert.ok(pathsToCommit("rejected:claim-domain").includes("students"), "a refusal must commit the attempt counter");
  assert.ok(!pathsToCommit("rejected:claim-domain").includes("acceptances"), "a refusal must never commit an acceptance record");

  // The ordinary acceptance persists refusals; only a lecturer's Retry opts out.
  const handlerAccept = steps.find((s) => s?.uses === "./acceptance");
  assert.ok(handlerAccept, "acceptance-handler.yml no longer runs ./acceptance");
  assert.notEqual(String(handlerAccept.with?.["persist-refusals"] ?? "true"), "false", "an ordinary acceptance must count refusals");

  const reserve = readFileSync(join(root, "acceptance", "reserve.mjs"), "utf8");
  assert.match(reserve, /"push"/, "it has to actually push");
  // A rejection exits 0 on purpose - a red run for a student who is not on the
  // roster teaches people to ignore red runs. reserve.mjs forwards accept.mjs's
  // own exit status, so a refusal stays 0.
  assert.match(reserve, /finish\(decided\.status\)/, "the decision's own exit status is what the step reports");
});

test("the accepted path commits student state too", async () => {
  const { pathsToCommit } = await import("../lib/acceptance-reservation.mjs");
  assert.ok(pathsToCommit("accepted").includes("students"), "the binding written on a successful claim has to be committed");
});

test("every acceptance push is patient enough for a class accepting in one minute", () => {
  // Five tries lost one student in fifteen on 2026-09-28: their repository
  // existed and its record was never written. Every push an acceptance or a
  // retry makes to the control repo asks for at least fifteen.
  const reserve = readFileSync(join(root, "acceptance", "reserve.mjs"), "utf8");
  const reserveTries = Number(/MAX_ATTEMPTS \|\| (\d+)/.exec(reserve)?.[1] ?? 0);
  assert.ok(reserveTries >= 15, `saving a decision tries ${reserveTries} times`);
  const record = readFileSync(join(root, "scripts", "record-acceptance.sh"), "utf8");
  const recordTries = Number(/MAX_RETRIES:-(\d+)/.exec(record)?.[1] ?? 0);
  assert.ok(recordTries >= 15, `writing the record tries ${recordTries} times`);

  const retry = parse(readFileSync(join(root, ".github", "workflows", "retry-acceptance.yml"), "utf8"));
  const retryRuns = Object.values(retry.jobs).flatMap((j) => j.steps ?? []).map((s) => String(s?.run ?? "")).join("\n");
  for (const prefix of [...(allRun + "\n" + retryRuns).matchAll(/^(.*)scripts\/git-push-with-retry\.sh control/gm)].map((m) => m[1])) {
    const n = Number(/MAX_RETRIES=(\d+)/.exec(prefix)?.[1] ?? 0);
    assert.ok(n >= 15, `a push with "${prefix.trim()}" retries ${n || "the default 5"} times`);
  }
});
