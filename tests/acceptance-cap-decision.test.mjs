// `max_acceptances` can overshoot under concurrency. That is a DECISION, and
// this file exists so a future pass cannot quietly reverse it.
//
// The race is real and easy to spot: accept.mjs counts acceptances/<id>/*.json,
// compares against the cap, then writes - check-then-act - while the acceptance
// concurrency group is keyed on `team_hint || github_login`, so acceptances by
// DIFFERENT students are not serialized against each other. Two students
// arriving together both read 49, both see 49 < 50, and both write.
//
// Anyone auditing this code will find that, correctly identify it as a race,
// and be tempted to key the concurrency group on the assignment instead. That
// closes it - and serializes every acceptance for the assignment. A
// 200-student cohort accepting in the first minutes of a lecture would then run
// one at a time at roughly 30s each, on a system whose design goal is billing
// zero minutes when idle.
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

test("the acceptance concurrency group is still keyed per student, not per assignment", () => {
  // The exact change that would close the race. If this goes red, somebody is
  // trading a lecture-hall's worth of queued runners for a cap that is exact -
  // read the decision above before deciding that is what you want.
  const wf = read(".github", "workflows", "acceptance-handler.yml");
  const group = wf.match(/^\s*group:\s*(.+)$/m)?.[1] ?? "";

  assert.match(
    group,
    /team_hint \|\| github\.event\.client_payload\.github_login/,
    "the group must stay keyed on the team hint or the student - keying it on the " +
      "assignment alone serializes every acceptance in the cohort",
  );
  assert.ok(
    group.includes("client_payload.assignment_id"),
    "it is still scoped to the assignment; what must not happen is that being the WHOLE key",
  );
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
  assert.match(preamble, /concurrency group/i, "name the mechanism that would close it");
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
