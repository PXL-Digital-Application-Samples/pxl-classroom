// PXL Classroom - effective-deadline.test.mjs
//
// The deadline that applies to one student, and the reason this module exists:
// report.mjs read `override.deadline_at`, the Admin Panel has written
// `overrides[].value` since 2026-06-17, and lockdown.mjs and find-finalizable.mjs
// did not read overrides at all. So a granted extension demoted the student at
// the assignment's own deadline and was then reported as active.
//
// Every test here that names the array shape fails if that regression returns.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  effectiveDeadlineFor,
  extensionFrom,
  indexOverrides,
  latestEffectiveDeadline,
} from "../lib/effective-deadline.mjs";

const ASSIGNMENT = { deadline_at: "2026-09-10T22:00:00Z" };
const DEADLINE = new Date(ASSIGNMENT.deadline_at).getTime();

/** An override document in the shape the Admin Panel actually writes. */
function overrideDoc(login, ...extensions) {
  return {
    schema_version: 1,
    assignment_id: "test-asgn",
    github_login: login,
    overrides: extensions.map((e, i) => ({
      type: e.type ?? "deadline_extension",
      value: e.value,
      reason: e.reason ?? `reason ${i}`,
      overridden_by: "admin-panel",
      overridden_at: "2026-09-09T12:00:00Z",
    })),
  };
}

// --- no override -------------------------------------------------------------

test("no overrides -> the assignment's own deadline", () => {
  const eff = effectiveDeadlineFor(ASSIGNMENT, "alice", { overrides: [] });
  assert.equal(eff.deadline.getTime(), DEADLINE);
  assert.equal(eff.extended, false);
  assert.equal(eff.reason, null);
  assert.equal(eff.grantedTo, null);
});

test("an assignment with no deadline has none, extension or not", () => {
  assert.equal(effectiveDeadlineFor({}, "alice", { overrides: [] }).deadline, null);
});

test("an override that is not an extension does not move anything", () => {
  const doc = overrideDoc("alice", { type: "annotation", value: "2026-12-01T00:00:00Z" });
  const eff = effectiveDeadlineFor(ASSIGNMENT, "alice", { overrides: [doc] });
  assert.equal(eff.deadline.getTime(), DEADLINE);
  assert.equal(eff.extended, false, "an annotation must not read as extra time");
});

// --- the shape the Admin Panel writes ---------------------------------------

test("a granted extension moves this student's deadline (the live bug)", () => {
  const granted = "2026-09-17T22:00:00Z";
  const doc = overrideDoc("alice", { value: granted, reason: "medical" });
  const eff = effectiveDeadlineFor(ASSIGNMENT, "alice", { overrides: [doc] });

  assert.equal(eff.deadline.toISOString(), new Date(granted).toISOString());
  assert.equal(eff.extended, true);
  assert.equal(eff.reason, "medical");
  assert.equal(eff.grantedTo, "alice");
  assert.equal(eff.base.getTime(), DEADLINE, "the assignment deadline is still reported");
});

test("an extension for someone else leaves this student alone", () => {
  const doc = overrideDoc("bob", { value: "2026-09-17T22:00:00Z" });
  const eff = effectiveDeadlineFor(ASSIGNMENT, "alice", { overrides: [doc] });
  assert.equal(eff.deadline.getTime(), DEADLINE);
  assert.equal(eff.extended, false);
});

test("overrides are append-only: the last extension is the one in force", () => {
  const doc = overrideDoc(
    "alice",
    { value: "2026-09-12T22:00:00Z", reason: "first" },
    { value: "2026-09-20T22:00:00Z", reason: "second" },
  );
  const eff = effectiveDeadlineFor(ASSIGNMENT, "alice", { overrides: [doc] });
  assert.equal(eff.deadline.toISOString(), "2026-09-20T22:00:00.000Z");
  assert.equal(eff.reason, "second");
});

test("logins match case-insensitively - the filename's case is not the record's", () => {
  const doc = overrideDoc("Alice", { value: "2026-09-17T22:00:00Z" });
  const eff = effectiveDeadlineFor(ASSIGNMENT, "alice", { overrides: [doc] });
  assert.equal(eff.extended, true);
});

// --- groups ------------------------------------------------------------------

test("a group takes the most generous extension among its members", () => {
  const overrides = [
    overrideDoc("bob", { value: "2026-09-12T22:00:00Z", reason: "short" }),
    overrideDoc("carol", { value: "2026-09-25T22:00:00Z", reason: "long" }),
  ];
  const eff = effectiveDeadlineFor(ASSIGNMENT, "alice", {
    overrides,
    team: { members: ["alice", "bob", "carol"] },
  });
  // They share one repository: locking it at bob's deadline locks carol out of
  // time she was granted.
  assert.equal(eff.deadline.toISOString(), "2026-09-25T22:00:00.000Z");
  assert.equal(eff.grantedTo, "carol");
  assert.equal(eff.reason, "long");
});

test("a team-mate's extension does not leak to a student outside the team", () => {
  const overrides = [overrideDoc("carol", { value: "2026-09-25T22:00:00Z" })];
  const eff = effectiveDeadlineFor(ASSIGNMENT, "alice", {
    overrides,
    team: { members: ["alice", "bob"] },
  });
  assert.equal(eff.extended, false);
});

// --- an extension only ever extends ------------------------------------------

test("an extension earlier than the deadline does not shorten it", () => {
  // The panel refuses to grant one, but a hand-edited file must not lock a
  // student out early - that is the failure this module exists to prevent.
  const doc = overrideDoc("alice", { value: "2026-09-01T22:00:00Z" });
  const eff = effectiveDeadlineFor(ASSIGNMENT, "alice", { overrides: [doc] });
  assert.equal(eff.deadline.getTime(), DEADLINE);
  assert.equal(eff.extended, false);
});

// --- malformed records -------------------------------------------------------

test("a malformed extension value is ignored, not trusted", () => {
  const doc = overrideDoc("alice", { value: "next tuesday" });
  const eff = effectiveDeadlineFor(ASSIGNMENT, "alice", { overrides: [doc] });
  assert.equal(eff.deadline.getTime(), DEADLINE, "must not become an Invalid Date");
  assert.equal(eff.extended, false);
});

test("a malformed latest entry falls back to the last valid grant", () => {
  const doc = overrideDoc(
    "alice",
    { value: "2026-09-20T22:00:00Z", reason: "valid" },
    { value: "", reason: "typo" },
  );
  const eff = effectiveDeadlineFor(ASSIGNMENT, "alice", { overrides: [doc] });
  assert.equal(eff.deadline.toISOString(), "2026-09-20T22:00:00.000Z");
  assert.equal(eff.reason, "valid");
});

test("documents with no overrides array, or none at all, are survivable", () => {
  assert.equal(extensionFrom(undefined), null);
  assert.equal(extensionFrom({}), null);
  assert.equal(extensionFrom({ overrides: null }), null);
  assert.equal(extensionFrom({ overrides: [null, 7, "x"] }), null);
  const eff = effectiveDeadlineFor(ASSIGNMENT, "alice", { overrides: [{ github_login: "alice" }] });
  assert.equal(eff.deadline.getTime(), DEADLINE);
});

test("no context at all still answers with the assignment deadline", () => {
  assert.equal(effectiveDeadlineFor(ASSIGNMENT, "alice").deadline.getTime(), DEADLINE);
});

// --- the pre-2026-06-17 flat shape -------------------------------------------

test("a legacy flat override document is still honoured", () => {
  // The first Admin Panel (5b3295a) wrote deadline_at at the top level. Control
  // repos from before 9671afd still hold those, and dropping support would
  // silently un-extend those students.
  const doc = {
    schema_version: 1,
    assignment_id: "test-asgn",
    github_login: "alice",
    deadline_at: "2026-09-18T22:00:00Z",
    reason: "legacy medical extension",
  };
  const eff = effectiveDeadlineFor(ASSIGNMENT, "alice", { overrides: [doc] });
  assert.equal(eff.deadline.toISOString(), "2026-09-18T22:00:00.000Z");
  assert.equal(eff.reason, "legacy medical extension");
});

test("the array shape wins over a stray flat field on the same document", () => {
  const doc = {
    github_login: "alice",
    deadline_at: "2026-09-30T22:00:00Z",
    overrides: [{ type: "deadline_extension", value: "2026-09-14T22:00:00Z", reason: "current" }],
  };
  const eff = effectiveDeadlineFor(ASSIGNMENT, "alice", { overrides: [doc] });
  assert.equal(eff.deadline.toISOString(), "2026-09-14T22:00:00.000Z");
  assert.equal(eff.reason, "current");
});

// --- indexing ----------------------------------------------------------------

test("indexOverrides accepts an array or passes a Map through", () => {
  const doc = overrideDoc("Alice", { value: "2026-09-17T22:00:00Z" });
  const index = indexOverrides([doc]);
  assert.equal(index.get("alice"), doc);
  assert.equal(indexOverrides(index), index);
  assert.equal(indexOverrides(undefined).size, 0);

  const eff = effectiveDeadlineFor(ASSIGNMENT, "alice", { overrides: index });
  assert.equal(eff.extended, true, "a prebuilt Map must work as the array does");
});

// --- the cohort-wide question find-finalizable asks ---------------------------

test("latestEffectiveDeadline is the last instant anyone is still working to", () => {
  const overrides = [
    overrideDoc("bob", { value: "2026-09-12T22:00:00Z" }),
    overrideDoc("carol", { value: "2026-09-25T22:00:00Z" }),
  ];
  assert.equal(
    latestEffectiveDeadline(ASSIGNMENT, overrides).toISOString(),
    "2026-09-25T22:00:00.000Z",
  );
});

test("latestEffectiveDeadline is the assignment deadline when nothing extends it", () => {
  assert.equal(latestEffectiveDeadline(ASSIGNMENT, []).getTime(), DEADLINE);
  assert.equal(
    latestEffectiveDeadline(ASSIGNMENT, [overrideDoc("bob", { value: "2026-09-01T00:00:00Z" })]).getTime(),
    DEADLINE,
    "an earlier override must not pull the cohort's deadline back",
  );
  assert.equal(latestEffectiveDeadline({}, []), null);
});
