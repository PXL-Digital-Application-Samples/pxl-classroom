// Every outcome accept.mjs can emit is one whose writes are COMMITTED.
//
// The bug this exists for has now happened twice, the same way both times. The
// hub's only commit step was gated on an ACCEPTED outcome, so a run that wrote
// something into the control checkout and then did not provision had its work
// discarded - the checkout is a runner temp directory, and nothing says so.
//
//   `rejected:*` wrote the failed-attempt counter behind MAX_CLAIM_ATTEMPTS.
//   It was thrown away, so the limit was unenforceable and the guessing oracle
//   unbounded.
//
//   `confirmed` wrote the claim binding. Measured live against
//   pxl-classroom-testbed on 2026-09-06: the broker run was green, the hub run
//   was green, accept.mjs logged "@tomcoolpxl confirmed
//   confirm-smoke-test@student.pxl.be", and students/claims/71908551.json came
//   back 404. The feature did nothing at all, silently.
//
// NEITHER WAS REACHABLE BY ANY OTHER TEST, and that is the point. accept.mjs
// writes the file correctly - tests/confirm-accept.test.mjs proves it against a
// temp dir. The browser posts correctly - tests/e2e/64 proves that. The loss
// happened in the seam between them.
//
// Since 2026-10-02 the seam is one table: acceptance/reserve.mjs saves every
// decision before the action returns, committing the directories
// lib/acceptance-reservation.mjs `pathsToCommit` names for its outcome. The
// outcomes are DERIVED from accept.mjs rather than listed here, so a new one
// fails this test until somebody classifies it - and an outcome the table does
// not know makes reserve.mjs fail the run rather than save nothing quietly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { EXISTING_REPO_REJECTIONS } from "../lib/existing-repo.mjs";
import { pathsToCommit } from "../lib/acceptance-reservation.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const acceptSrc = readFileSync(join(root, "acceptance", "accept.mjs"), "utf8");
const actionSrc = readFileSync(join(root, "acceptance", "action.yml"), "utf8");
const handlerSrc = readFileSync(join(root, ".github", "workflows", "acceptance-handler.yml"), "utf8");

/**
 * Every literal outcome accept.mjs sets.
 *
 * `reject()` and `fail()` take a category, so their call sites are read too -
 * a `rejected:*` is an outcome exactly as much as `accepted` is, and the
 * counter behind one is what was being discarded.
 */
function declaredOutcomes() {
  const out = new Set();
  for (const m of acceptSrc.matchAll(/setOutput\(\s*"outcome"\s*,\s*"([^"]+)"/g)) out.add(m[1]);
  for (const m of acceptSrc.matchAll(/setOutput\(\s*"outcome"\s*,[^)]*?\?\s*"([^"]+)"\s*:\s*"([^"]+)"/g)) {
    out.add(m[1]);
    out.add(m[2]);
  }
  for (const m of acceptSrc.matchAll(/\b(?:await\s+)?(?:reject|fail)\(\s*"([^"]+)"/g)) out.add(m[1]);
  for (const o of EXISTING_REPO_REJECTIONS) out.add(o);
  return out;
}

test("the indirect outcomes are genuinely reachable from accept.mjs", () => {
  assert.match(acceptSrc, /reject\(\s*verdict\.reject/, "step 7 no longer rejects through the verdict");
  assert.match(acceptSrc, /existingRepoVerdict/, "accept.mjs no longer asks lib/existing-repo.mjs");
});

/**
 * Outcomes a `fail:*` run reaches.
 *
 * A `fail:` exits 1 before anything is written, or because a deployment fault
 * means nothing CAN be written - there is no record to persist, and a commit
 * firing on one would push a half-built state. pathsToCommit says null for
 * them on purpose.
 */
const isFailure = (o) => o.startsWith("fail:");

test("every outcome accept.mjs can produce is classified by what it commits", () => {
  const unclassified = [];
  for (const outcome of declaredOutcomes()) {
    if (isFailure(outcome)) {
      assert.equal(pathsToCommit(outcome), null, `${outcome} must commit nothing`);
      continue;
    }
    if (pathsToCommit(outcome) === null) unclassified.push(outcome);
  }
  assert.deepEqual(
    unclassified,
    [],
    "These outcomes are not in lib/acceptance-reservation.mjs OUTCOME_PATHS, so " +
      "acceptance/reserve.mjs would refuse to save them. Decide what each one commits.",
  );
});

test("the guard can actually fail - the outcomes are read, not assumed", () => {
  // A regex that matched nothing would make the test above pass over an empty
  // set forever. This is the mutation check on the extractor itself.
  const found = declaredOutcomes();
  for (const expected of ["accepted", "already-accepted", "confirmed", "already-confirmed", "superseded"]) {
    assert.ok(found.has(expected), `expected to extract ${expected} from accept.mjs`);
  }
  assert.ok([...found].some((o) => o.startsWith("rejected:")), "no rejected:* extracted");
  assert.ok([...found].some((o) => o.startsWith("fail:")), "no fail:* extracted");
  assert.equal(pathsToCommit("made-up-outcome"), null, "an unknown outcome must not be guessed at");
});

test("the acceptance action saves through reserve.mjs, and nothing else commits a decision", () => {
  // The table above only matters if it is what saves. accept.mjs run on its
  // own commits nothing; reserve.mjs is what commits and pushes.
  assert.match(actionSrc, /run: node "\$GITHUB_ACTION_PATH\/reserve\.mjs"/, "./acceptance no longer runs reserve.mjs");
  // A separate persist step, gated on a list of outcomes, was the seam that
  // lost two features. Nothing in the workflow commits to the control checkout
  // any more: the decision is reserve.mjs's, the record is
  // scripts/record-acceptance.sh's.
  assert.doesNotMatch(handlerSrc, /git -C control (add|commit)\b/, "a step in acceptance-handler.yml commits to the control checkout again");
  assert.match(handlerSrc, /run: scripts\/record-acceptance\.sh/, "the record step no longer runs the shared script");
});
