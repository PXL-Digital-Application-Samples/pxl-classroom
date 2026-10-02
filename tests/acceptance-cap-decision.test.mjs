// `max_acceptances` can overshoot under concurrency. That is a DECISION, and
// this file exists so a future pass cannot quietly reverse it.
//
// The race is real and easy to spot: accept.mjs counts acceptances/<id>/*.json,
// compares against the cap, then writes - check-then-act. A decision is saved by
// a push that fails when another run pushed first, and is made again only when
// that run changed one of ITS inputs (lib/acceptance-reservation.mjs
// `decisionInputsChanged`) - and other students' acceptance records are
// deliberately not inputs. Two students arriving together both read 49, both
// see 49 < 50, and both write.
//
// Anyone auditing this code will find that, correctly identify it as a race,
// and be tempted to make every acceptance record an input. That closes it - and
// makes every acceptance for the assignment decide again against every other.
// A 200-student cohort accepting in the first minutes of a lecture would then
// effectively run one at a time at roughly 30s each, on a system whose design
// goal is billing zero minutes when idle. (Until 2026-10-02 the same decision
// was a concurrency group keyed per student rather than per assignment; the
// group is gone, the decision is not.)
//
// Raised and explicitly rejected on 2026-08-24. The cap's job is to stop an
// unbounded link being farmed, and it does that; it is not a seat allocator.
//
// What this file pins is therefore the opposite of the usual: not that a bug is
// fixed, but that a known one is still deliberately open, and that the decision
// is still written down next to it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");

test("another student's acceptance record is still not an input to a decision", async () => {
  // The exact change that would close the race. If this goes red, somebody is
  // trading a lecture-hall's worth of re-decisions for a cap that is exact -
  // read the decision above before deciding that is what you want.
  const { decisionInputsChanged } = await import("../lib/acceptance-reservation.mjs");
  const who = { assignmentId: "lab-1", login: "alice" };
  assert.equal(
    decisionInputsChanged(["acceptances/lab-1/bob.json", "repositories/lab-1/bob.json"], who),
    false,
    "another student accepting must not make this one decide again",
  );
  // ...while the student's OWN record, and every team manifest, still is.
  assert.equal(decisionInputsChanged(["acceptances/lab-1/alice.json"], who), true);
  assert.equal(decisionInputsChanged(["teams/lab-1/fullhouse.json"], who), true);

  // And nothing went back to GitHub's concurrency group, which is what this
  // decision used to be spelled as.
  const wf = read(".github", "workflows", "acceptance-handler.yml");
  assert.doesNotMatch(wf, /^concurrency:/m, "acceptance-handler.yml has a concurrency group again");
});

test("the decision is recorded where the race is, not only in a commit message", () => {
  // A race with no note beside it gets re-reported every time somebody reads
  // the file. The comment is the thing that stops the next audit.
  const src = read("acceptance", "accept.mjs");
  const at = src.indexOf("const maxAcceptances = assignment.max_acceptances");
  assert.ok(at > 0, "the cap check must still exist");

  const preamble = src.slice(Math.max(0, at - 1600), at);
  assert.match(preamble, /GUARDRAIL, NOT A HARD LIMIT/i, "say what it is");
  assert.match(preamble, /check-then-act|read, compared, and then written/i, "name the race plainly");
  assert.match(preamble, /2026-08-24/, "date the decision");
  assert.match(preamble, /decisionInputsChanged/, "name the mechanism that would close it");
});

test("no surface calls the cap exact", () => {
  // The one obligation the decision creates (C4): the UI must not describe
  // behaviour the system does not have. "Hard cap" is the phrasing that did.
  for (const p of [
    ["frontend", "src", "views", "AdminView.vue"],
    ["frontend", "src", "views", "AssignmentView.vue"],
    ["frontend", "src", "components", "GroupAcceptanceCard.vue"],
  ]) {
    const rendered = read(...p)
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    assert.ok(
      !/hard cap/i.test(rendered),
      `${p.at(-1)}: the cap can overshoot under a simultaneous burst, so nothing may call it hard`,
    );
  }
});
