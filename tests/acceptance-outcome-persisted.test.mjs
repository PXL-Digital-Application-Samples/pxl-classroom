// Every outcome accept.mjs can emit is handled by a step that COMMITS.
//
// The bug this exists for has now happened twice, the same way both times. The
// hub's only commit step is gated on an ACCEPTED outcome, so a run that writes
// something into the control checkout and then does not provision has its work
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
// happens in the seam between them, in YAML, which no unit test imports and no
// e2e test runs.
//
// This is the "two places that must agree, with no mechanism making them agree"
// rule applied to that seam: the outcomes are DERIVED from accept.mjs rather
// than listed here, so a new one fails this test until somebody decides which
// step persists it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { REJECT_REPO_EXISTS, REJECT_REPO_FROZEN } from "../lib/existing-repo.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const acceptSrc = readFileSync(join(root, "acceptance", "accept.mjs"), "utf8");
const handlerSrc = readFileSync(
  join(root, ".github", "workflows", "acceptance-handler.yml"),
  "utf8",
);

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
  // The ternary form: setOutput("outcome", x ? "a" : "b")
  for (const m of acceptSrc.matchAll(/setOutput\(\s*"outcome"\s*,[^)]*?\?\s*"([^"]+)"\s*:\s*"([^"]+)"/g)) {
    out.add(m[1]);
    out.add(m[2]);
  }
  for (const m of acceptSrc.matchAll(/\b(?:await\s+)?(?:reject|fail)\(\s*"([^"]+)"/g)) out.add(m[1]);
  // AND THE ONES REACHED THROUGH A VARIABLE. Step 7 calls
  // `reject(verdict.reject, …)`, where the outcome comes back from
  // lib/existing-repo.mjs - so the regexes above cannot see it, and an
  // extractor that silently sees less than it did is the failure this file's
  // second test exists to catch one level up. Read from the module that owns
  // the names rather than spelled again here.
  //
  // These two happen to be `rejected:*`, which the persist step covers as a
  // family, so nothing is currently at risk - the point is that the NEXT
  // indirect outcome may not be, and it would arrive invisible.
  for (const o of [REJECT_REPO_FROZEN, REJECT_REPO_EXISTS]) out.add(o);
  return out;
}

test("the indirect outcomes are genuinely reachable from accept.mjs", () => {
  // Otherwise the two added above are a claim, not a derivation: this file
  // would be asserting coverage for outcomes the script can no longer emit.
  assert.match(acceptSrc, /reject\(\s*verdict\.reject/, "step 7 no longer rejects through the verdict");
  assert.match(acceptSrc, /existingRepoVerdict/, "accept.mjs no longer asks lib/existing-repo.mjs");
});

// Outcomes whose work is committed by the provisioning path's own step, which
// stages repositories/, teams/, acceptances/ AND students/.
const PROVISIONING = new Set(["accepted", "already-accepted"]);

/**
 * Outcomes a `fail:*` run reaches.
 *
 * A `fail:` exits 1 before anything is written, or because a deployment fault
 * means nothing CAN be written - there is no record to persist, and a commit
 * step firing on one would push a half-built state. Excluded deliberately
 * rather than forgotten, which is the distinction this file exists to force.
 */
const isFailure = (o) => o.startsWith("fail:");

test("every outcome that writes and does not provision has a commit step", () => {
  const persistStep = handlerSrc.slice(
    handlerSrc.indexOf("Persist records written without provisioning"),
  );
  assert.ok(
    persistStep,
    "the persist step was renamed - this guard reads it by name, and an absent " +
      "anchor makes an absence assertion pass vacuously",
  );
  // Just its `if:`, not the rest of the workflow.
  const condition = persistStep.slice(0, persistStep.indexOf("run: |"));

  const unhandled = [];
  for (const outcome of declaredOutcomes()) {
    if (PROVISIONING.has(outcome) || isFailure(outcome)) continue;
    // `rejected:` is matched as a family by startsWith, everything else by name.
    const covered = outcome.startsWith("rejected:")
      ? condition.includes("startsWith(steps.accept.outputs.outcome, 'rejected:')")
      : condition.includes(`steps.accept.outputs.outcome == '${outcome}'`);
    if (!covered) unhandled.push(outcome);
  }

  assert.deepEqual(
    unhandled,
    [],
    "These outcomes write into the control checkout and no step commits it, so " +
      "the work is discarded when the runner is torn down - green run, no record. " +
      "Add them to the persist step's `if:`, or to PROVISIONING here if the " +
      "provisioning step already commits for them.",
  );
});

test("the guard can actually fail - the outcomes are read, not assumed", () => {
  // A regex that matched nothing would make the test above pass over an empty
  // set forever. This is the mutation check on the extractor itself.
  const found = declaredOutcomes();
  for (const expected of ["accepted", "already-accepted", "confirmed", "already-confirmed"]) {
    assert.ok(found.has(expected), `expected to extract ${expected} from accept.mjs`);
  }
  assert.ok([...found].some((o) => o.startsWith("rejected:")), "no rejected:* extracted");
  assert.ok([...found].some((o) => o.startsWith("fail:")), "no fail:* extracted");
});

test("the provisioning step really does commit students/, which is why accept is exempt", () => {
  // PROVISIONING claims those two outcomes are covered elsewhere. If that stops
  // being true, this file would be exempting them from the only guard there is.
  const step = handlerSrc.slice(handlerSrc.indexOf("Write repository record into control checkout"));
  assert.ok(step.includes('git -C control add "students/"'), "students/ is no longer staged there");
  assert.ok(
    step.includes("outcome == 'accepted'") && step.includes("outcome == 'already-accepted'"),
    "the provisioning commit step no longer fires for the outcomes exempted here",
  );
});
