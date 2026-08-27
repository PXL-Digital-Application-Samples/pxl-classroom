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
//     the guessing oracle CLAIM_PLAN insisted must ship bounded was unbounded.
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
test("every directory the acceptance writes is staged by the workflow", () => {
  const written = directoriesWritten();
  assert.ok(written.length >= 3, `expected several written directories, found ${written.join(", ")}`);
  assert.ok(written.includes("students"), "students/ is where the claim binding and counter live");

  // Two spellings reach the index, and both count. A raw `git add` can carry
  // several paths (`add "repositories/" "teams/"`), and the stage() helper
  // takes bare directory names (`stage repositories teams`) so it can skip the
  // ones that do not exist - see the fatal-pathspec test below.
  const staged = new Set();
  for (const m of allRun.matchAll(/git -C control add((?:\s+"[^"]+")+)/g)) {
    for (const p of m[1].matchAll(/"([^"]+)"/g)) staged.add(p[1].replace(/\/$/, ""));
  }
  for (const m of allRun.matchAll(/^\s*stage ([a-z ]+)$/gm)) {
    for (const d of m[1].trim().split(/\s+/)) staged.add(d);
  }
  const unstaged = written.filter((d) => !staged.has(d));
  assert.deepEqual(
    unstaged,
    [],
    "accept.mjs writes these, and no step commits them - they are discarded with the runner:\n" +
      unstaged.map((d) => `  ${d}/`).join("\n"),
  );
});

test("a REJECTED acceptance still commits what it wrote", () => {
  // The counter only matters on failure, so a commit step gated on success is
  // a rate limit that can never count.
  const persists = steps.filter((s) => {
    const cond = String(s?.if ?? "");
    return /rejected:/.test(cond) && String(s?.run ?? "").includes('git -C control add "students/"');
  });

  assert.equal(
    persists.length,
    1,
    "exactly one step must persist student state on a rejected outcome",
  );
  const step = persists[0];
  assert.match(String(step.run), /git-push-with-retry/, "it has to actually push");
  // A rejection exits 0 on purpose - a red run for a student who is not on the
  // roster teaches people to ignore red runs. A failed push ABOUT a rejection
  // must not undo that.
  assert.equal(step["continue-on-error"], true, "must not turn a rejection into a failure");
});

test("the accepted path commits student state too", () => {
  const accepted = steps.find((s) => s?.name === "Write repository record into control checkout, push");
  assert.ok(accepted, "the accepted-path commit step must still exist");
  assert.match(
    String(accepted.run),
    /^\s*stage students$|git -C control add "students\/"/m,
    "the binding written on a successful claim has to be staged",
  );
});
