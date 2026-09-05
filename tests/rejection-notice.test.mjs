// The dedup key is a contract between a workflow and a Vue component.
//
// `acceptance-handler.yml` writes it in YAML; the Admin Panel reads it in
// JavaScript; nothing compiles both. A key spelled one way and matched the
// other is a panel that silently shows nothing - which is exactly the state
// this feature exists to end, so it would look like the feature simply not
// working rather than like a bug.
//
// So the workflow's literal is checked against what the shared builder
// produces. Same shape as tests/workflow-output-contract.test.mjs: derive one
// spelling from the other rather than writing a careful copy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DEDUP_MARKER,
  rejectionDedupKey,
  parseRejectionDedupKey,
  rejectionReason,
  rejectionsForAssignment,
  rejectionCount,
} from "../lib/rejection-notice.mjs";

const workflow = readFileSync(
  new URL("../.github/workflows/acceptance-handler.yml", import.meta.url),
  "utf8",
);

test("the workflow writes the key this module builds", () => {
  // The YAML literal, with its `${{ }}` expressions turned back into the values
  // they carry. If someone reorders the parts or drops a dash, the two stop
  // agreeing and this fails rather than the panel going quiet.
  const line = workflow.split("\n").find((l) => l.includes("dedup-key:") && l.includes("reject-"));
  assert.ok(line, "acceptance-handler.yml must still write a reject- dedup key");

  const asBuilt = line
    .slice(line.indexOf("reject-"))
    .replace("${{ github.event.client_payload.assignment_id }}", "ASSIGNMENT")
    .replace("${{ github.event.client_payload.github_login }}", "LOGIN")
    .replace("${{ steps.accept.outputs.outcome }}", "OUTCOME")
    .trim();

  assert.equal(
    asBuilt,
    rejectionDedupKey({ assignmentId: "ASSIGNMENT", login: "LOGIN", outcome: "OUTCOME" }),
  );
});

test("a key round-trips, even when the ids carry dashes", () => {
  // Both an assignment id and a login may contain `-`, so counting dashes
  // cannot work. Knowing the assignment is what makes the split exact.
  const cases = [
    { assignmentId: "lab-3", login: "cara", outcome: "rejected:not-in-cohort" },
    { assignmentId: "2526-examen-aut2-ek2", login: "alice-dev", outcome: "rejected:not-on-roster" },
    { assignmentId: "x", login: "a-b-c-d", outcome: "rejected:claim-taken" },
  ];
  for (const c of cases) {
    const key = rejectionDedupKey(c);
    assert.deepEqual(parseRejectionDedupKey(key, c.assignmentId), {
      login: c.login,
      outcome: c.outcome,
    });
  }
});

test("another assignment's key is not this assignment's rejection", () => {
  const key = rejectionDedupKey({ assignmentId: "lab-3", login: "cara", outcome: "rejected:closed" });
  assert.equal(parseRejectionDedupKey(key, "lab-4"), null);
  // A prefix match is not a match: `lab-3` must not claim `lab-30`'s refusals.
  const other = rejectionDedupKey({ assignmentId: "lab-30", login: "cara", outcome: "rejected:closed" });
  assert.equal(parseRejectionDedupKey(other, "lab-3"), null);
});

test("a malformed or unrelated key yields nothing, never a half-read row", () => {
  for (const bad of [
    "", "reject-lab-3-cara", "reject-lab-3--rejected:closed", "provisioning-lab-3-cara",
    "reject-lab-3-cara-success", null, 42,
  ]) {
    assert.equal(parseRejectionDedupKey(bad, "lab-3"), null, JSON.stringify(bad));
  }
});

test("comments group into one row per reason, students listed once", () => {
  const comment = (assignmentId, login, outcome) => ({
    body: `${DEDUP_MARKER}${rejectionDedupKey({ assignmentId, login, outcome })}-->\n### x\n prose`,
  });
  const rows = rejectionsForAssignment(
    [
      comment("lab-3", "cara", "rejected:not-in-cohort"),
      comment("lab-3", "dries", "rejected:not-in-cohort"),
      // The same student retrying the same closed door - the notifier updates
      // one comment, and a duplicate here must not double-count anyway.
      comment("lab-3", "cara", "rejected:not-in-cohort"),
      comment("lab-3", "zoe", "rejected:not-on-roster"),
      // Another assignment's refusal, on the same shared tracking issue.
      comment("lab-4", "finn", "rejected:cap-reached"),
      { body: "a human wrote this" },
      {},
    ],
    "lab-3",
  );

  assert.deepEqual(rows, [
    { outcome: "rejected:not-in-cohort", reason: "not in this assignment", logins: ["cara", "dries"] },
    { outcome: "rejected:not-on-roster", reason: "not on the roster", logins: ["zoe"] },
  ]);
  assert.equal(rejectionCount(rows), 3);
});

test("a student refused twice for two reasons is two rows, and one person", () => {
  // "not on the roster" and later "cap reached" are different things to fix, so
  // both are shown - but the headline count is people, not incidents.
  const comment = (login, outcome) => ({
    body: `${DEDUP_MARKER}${rejectionDedupKey({ assignmentId: "lab-3", login, outcome })}-->`,
  });
  const rows = rejectionsForAssignment(
    [comment("cara", "rejected:not-on-roster"), comment("cara", "rejected:cap-reached")],
    "lab-3",
  );
  assert.equal(rows.length, 2);
  assert.equal(rejectionCount(rows), 1);
});

test("an unfamiliar reason keeps its own spelling rather than being guessed at", () => {
  assert.equal(rejectionReason("rejected:not-in-cohort"), "not in this assignment");
  assert.equal(rejectionReason("rejected:some-new-rule"), "some new rule");
  assert.equal(rejectionReason(undefined), "");
});

test("every rejection the acceptance path can emit has a human reason", () => {
  // A reason table that has fallen behind the code shows a lecturer a slug.
  // Swept from the sources rather than listed here, so a new one fails this.
  const sources = ["../acceptance/accept.mjs", "../lib/claim.mjs"].map((p) =>
    readFileSync(new URL(p, import.meta.url), "utf8"),
  );
  const emitted = new Set();
  for (const src of sources) {
    for (const m of src.matchAll(/["'](rejected:[a-z-]+)["']/g)) emitted.add(m[1]);
  }
  assert.ok(emitted.size >= 6, `expected several outcomes, found ${[...emitted].join(", ")}`);

  const unlabelled = [...emitted].filter((o) => rejectionReason(o) === o.replace(/^rejected:/, "").replace(/-/g, " "));
  assert.deepEqual(
    unlabelled,
    [],
    "these refusals would show a lecturer their raw slug - add them to REASONS in lib/rejection-notice.mjs:\n  " +
      unlabelled.join("\n  "),
  );
});
