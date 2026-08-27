// `roster_mode: claim` splits a question that used to have one answer.
//
// Before it there was exactly ONE roster-gated mode, so a single
// `=== "enforced"` answered both "is the roster the thing that decides who may
// accept?" and "is the student's LOGIN what gets looked up in it?". Seven call
// sites spelled it that way. `claim` is roster-gated but keyed on the EMAIL
// ADDRESS, so those two questions now have different answers and every site
// wants one or the other:
//
//   rosterGatesAcceptance  - enforced AND claim. The roster must exist and be
//                            readable, or nobody can accept.
//   rosterMatchesLogin     - enforced ONLY. Anything that reports "you are not
//                            on the roster", or counts entries carrying a
//                            github_login, must ask this - `github_login` is
//                            precisely the column a claim assignment does not
//                            expect the lecturer to have.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_ROSTER_MODE,
  ROSTER_MODES,
  normalizeRosterMode,
  requiresAcceptanceCap,
  rosterGatesAcceptance,
  rosterMatchesLogin,
} from "../lib/roster-mode.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

test("claim is a mode, and the gate still fails closed", () => {
  assert.ok(ROSTER_MODES.includes("claim"));
  assert.equal(normalizeRosterMode("claim"), "claim");

  // The rule that makes ADDING a mode the dangerous direction: anything
  // unrecognised must still collapse to the most restrictive mode, never to
  // the new one.
  for (const junk of ["Claim", "CLAIM", "org_member", "", null, undefined, 7, {}]) {
    assert.equal(normalizeRosterMode(junk), DEFAULT_ROSTER_MODE, `${JSON.stringify(junk)} must fail closed`);
  }
});

test("only open requires a cap - claim has the roster instead", () => {
  assert.equal(requiresAcceptanceCap("open"), true);
  assert.equal(requiresAcceptanceCap("claim"), false);
  assert.equal(requiresAcceptanceCap("enforced"), false);
});

test("the two questions have different answers, which is the whole point", () => {
  assert.equal(rosterGatesAcceptance("enforced"), true);
  assert.equal(rosterGatesAcceptance("claim"), true);
  assert.equal(rosterGatesAcceptance("open"), false);

  assert.equal(rosterMatchesLogin("enforced"), true);
  assert.equal(rosterMatchesLogin("claim"), false, "claim matches on the ADDRESS");
  assert.equal(rosterMatchesLogin("open"), false);

  // Both fail closed on junk, in the same direction as normalizeRosterMode.
  assert.equal(rosterGatesAcceptance("nonsense"), true);
  assert.equal(rosterMatchesLogin("nonsense"), true);
});

test("nothing decides roster-gating with a bare enforced comparison any more", () => {
  // The guard against the fork. Before `claim` a hand-written
  // `=== "enforced"` was correct everywhere; now it is correct only where the
  // question is specifically about the login, and re-introducing one silently
  // excludes claim assignments from a roster check they need.
  const files = [
    "acceptance/accept.mjs",
    "lib/seed-teams.mjs",
    "lib/promote-roster.mjs",
    "pages/generate.mjs",
    "frontend/src/views/AdminView.vue",
    "frontend/src/views/AssignmentView.vue",
    "frontend/src/components/StudentDiagnosticsModal.vue",
  ];
  const offenders = [];
  for (const rel of files) {
    let src;
    try {
      src = readFileSync(join(root, rel), "utf8");
    } catch {
      continue; // a file that does not exist cannot fork the rule
    }
    // Strip comments: several of them quote the old spelling while explaining
    // why it changed, which is exactly the trap that made an earlier guard in
    // this repo pass against nothing.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/<!--[\s\S]*?-->/g, "");
    const re = /===\s*['"]enforced['"]|['"]enforced['"]\s*===/g;
    if (re.test(code)) offenders.push(rel);
  }
  assert.deepEqual(
    offenders,
    [],
    "these decide roster-gating themselves instead of asking lib/roster-mode.mjs:\n" +
      offenders.join("\n"),
  );
});

test("the claim gate refuses before it spends anything", () => {
  // Ordering is where the cost is saved: under `claim` the step is a guessing
  // oracle, and every attempt is an issue plus a hub workflow run on a system
  // whose design goal is billing zero when idle. The two free refusals - an
  // existing binding and an exhausted counter - must come before the decrypt
  // and before the roster is consulted.
  const src = readFileSync(join(root, "acceptance", "accept.mjs"), "utf8");
  const gate = src.slice(src.indexOf("async function runClaimGate"));
  const body = gate.slice(0, gate.indexOf("\n}\n"));

  const at = (needle) => {
    const i = body.indexOf(needle);
    assert.ok(i > -1, `runClaimGate no longer contains ${needle}`);
    return i;
  };

  assert.ok(at("claimAttemptsExhausted") < at("decryptClaim"),
    "the attempt ceiling must be checked before anything is decrypted");
  assert.ok(at("claimAttemptsExhausted") < at("rosterEntryForEmail"),
    "the attempt ceiling must be checked before the roster is consulted");
  assert.ok(at("existing?.email") < at("claimAttemptsExhausted"),
    "an already-bound student must not touch the counter at all");
  assert.ok(at("decryptClaim") < at("domainAllowed"),
    "nothing can be domain-checked before it is decrypted");
  assert.ok(at("domainAllowed") < at("rosterEntryForEmail"),
    "the cheap domain filter comes before the roster scan");
});

test("a missing payload and a missing hub key never spend a student's attempts", () => {
  // Both are deployment faults rather than guesses. Burning the counter for
  // them turns a stale link or an unset secret into a student locked out for
  // good - the `no-nonce` mistake in a new place.
  const src = readFileSync(join(root, "acceptance", "accept.mjs"), "utf8");
  const gate = src.slice(src.indexOf("async function runClaimGate"));
  const body = gate.slice(0, gate.indexOf("\n}\n"));

  // The no-payload branch: between finding no payload and rejecting, nothing
  // may increment.
  const noPayload = body.slice(body.indexOf("if (!payload)"), body.indexOf("const privateKey"));
  assert.ok(!noPayload.includes("countFailure"), "a missing claim payload must not count as an attempt");

  const noKey = body.slice(body.indexOf("if (!privateKey)"), body.indexOf("// 4."));
  assert.ok(!noKey.includes("countFailure"), "a missing hub key must not count as an attempt");
  assert.ok(noKey.includes("fail("), "a missing hub key is a red run, not a student-facing rejection");
});

test("a successful claim clears the counter rather than zeroing it", () => {
  const src = readFileSync(join(root, "acceptance", "accept.mjs"), "utf8");
  const gate = src.slice(src.indexOf("async function runClaimGate"));
  assert.match(gate, /rm\(attemptsFile\)/, "the counter file is deleted on success");
});
