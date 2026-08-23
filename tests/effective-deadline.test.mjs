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
  DEADLINE_EXTENSION,
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

// --- one implementation, everywhere -----------------------------------------

test("nothing re-implements the rule instead of importing it", async () => {
  // The SPA had forked it three ways: the backend and two lecturer views took
  // the LAST entry of the append-only history, while the two student-facing
  // readers took the FIRST. A student granted a second extension was shown the
  // superseded one - told they had less time than they did.
  //
  // Same guard as tests/rate-limit.test.mjs puts on the retry policy: a local
  // `filter(o => o.type === 'deadline_extension')` is the shape of that fork,
  // so it may only live in the module itself.
  const { readFileSync, readdirSync, statSync } = await import("node:fs");
  const { join, dirname, relative } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");

  const walk = (dir, out = []) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "dist" || entry === ".git" || entry === ".tools") continue;
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(mjs|js|vue)$/.test(entry)) out.push(p);
    }
    return out;
  };

  const allowed = new Set([
    join(root, "lib", "effective-deadline.mjs"),        // the implementation
    join(root, "tests", "effective-deadline.test.mjs"), // this file
  ]);

  const offenders = walk(root)
    .filter((p) => !allowed.has(p) && !p.startsWith(join(root, "tests")))
    .filter((p) => /deadline_extension/.test(readFileSync(p, "utf8")))
    .filter((p) => {
      const src = readFileSync(p, "utf8");
      // Writing one is fine - AdminView and AssignmentDetailView both grant
      // extensions. Deciding which one is in force is not.
      //
      // `[\s\S]{0,80}?` rather than `[^)]*`: the predicate is an arrow function
      // whose own parens close before the token, so a paren-excluding class
      // never reaches it and the guard silently matches nothing. Confirmed by
      // putting the fork back and watching this pass.
      return /\.(filter|find)\([\s\S]{0,80}?deadline_extension/.test(src);
    })
    .map((p) => relative(root, p));

  assert.deepEqual(
    offenders,
    [],
    `these pick the extension in force themselves instead of using lib/effective-deadline.mjs:\n  ${offenders.join("\n  ")}`
  );
});

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

// --- boundaries -------------------------------------------------------------

test("an extension exactly equal to the deadline is not an extension", () => {
  // `>` not `>=`. It moves nothing, so reporting it as extra time would put
  // override_applied on a row where nothing was granted.
  const doc = overrideDoc("alice", { value: ASSIGNMENT.deadline_at });
  const eff = effectiveDeadlineFor(ASSIGNMENT, "alice", { overrides: [doc] });
  assert.equal(eff.extended, false);
  assert.equal(eff.deadline.getTime(), DEADLINE);
});

test("one millisecond past the deadline is", () => {
  const doc = overrideDoc("alice", { value: new Date(DEADLINE + 1).toISOString() });
  assert.equal(effectiveDeadlineFor(ASSIGNMENT, "alice", { overrides: [doc] }).extended, true);
});

test("an assignment with no deadline is extended by any grant", () => {
  // Nothing to be later than, so `!base` has to count as extendable or a
  // deadline-less assignment could never honour an extension at all.
  const doc = overrideDoc("alice", { value: "2026-09-17T22:00:00Z" });
  const eff = effectiveDeadlineFor({}, "alice", { overrides: [doc] });
  assert.equal(eff.extended, true);
  assert.equal(eff.deadline.toISOString(), "2026-09-17T22:00:00.000Z");
  assert.equal(eff.base, null);
});

// --- documents that disagree with themselves ---------------------------------

test("a document whose github_login differs from its filename is keyed on the field", () => {
  // indexOverrides reads the record, never the path. A hand-renamed file must
  // not silently extend the wrong student.
  const doc = overrideDoc("bob", { value: "2026-09-17T22:00:00Z" });
  const index = indexOverrides([doc]);
  assert.equal(index.get("bob"), doc);
  assert.equal(effectiveDeadlineFor(ASSIGNMENT, "alice", { overrides: index }).extended, false);
  assert.equal(effectiveDeadlineFor(ASSIGNMENT, "bob", { overrides: index }).extended, true);
});

test("two documents for the same login: the last one indexed wins, deterministically", () => {
  const early = overrideDoc("alice", { value: "2026-09-12T22:00:00Z" });
  const late = overrideDoc("alice", { value: "2026-09-25T22:00:00Z" });
  assert.equal(indexOverrides([early, late]).get("alice"), late);
  assert.equal(indexOverrides([late, early]).get("alice"), early);
});

test("a document with no github_login is ignored rather than indexed under undefined", () => {
  const index = indexOverrides([{ overrides: [{ type: DEADLINE_EXTENSION, value: "2026-09-25T22:00:00Z" }] }]);
  assert.equal(index.size, 0);
});

test("an overrides field that is not an array is survivable", () => {
  for (const junk of [{ overrides: "later please" }, { overrides: 42 }, { overrides: {} }]) {
    assert.equal(extensionFrom(junk), null);
  }
});

test("an entry with no value is not an extension", () => {
  const doc = { github_login: "alice", overrides: [{ type: DEADLINE_EXTENSION, reason: "forgot the date" }] };
  assert.equal(extensionFrom(doc), null);
});

// --- teams -------------------------------------------------------------------

test("the student's own extension wins when it is the most generous", () => {
  const overrides = [
    overrideDoc("alice", { value: "2026-09-30T22:00:00Z", reason: "mine" }),
    overrideDoc("bob", { value: "2026-09-12T22:00:00Z", reason: "theirs" }),
  ];
  const eff = effectiveDeadlineFor(ASSIGNMENT, "alice", { overrides, team: { members: ["alice", "bob"] } });
  assert.equal(eff.grantedTo, "alice");
  assert.equal(eff.reason, "mine");
});

test("a member listed twice, or in a different case, is counted once and correctly", () => {
  const overrides = [overrideDoc("Bob", { value: "2026-09-25T22:00:00Z" })];
  const eff = effectiveDeadlineFor(ASSIGNMENT, "alice", {
    overrides,
    team: { members: ["alice", "bob", "BOB", "Bob"] },
  });
  assert.equal(eff.extended, true);
  assert.equal(eff.grantedTo, "bob");
});

test("a team with no members, or a null team, falls back to the student alone", () => {
  const overrides = [overrideDoc("alice", { value: "2026-09-17T22:00:00Z" })];
  for (const team of [null, undefined, {}, { members: [] }, { members: [null, ""] }]) {
    assert.equal(effectiveDeadlineFor(ASSIGNMENT, "alice", { overrides, team }).extended, true, JSON.stringify(team));
  }
});

test("a missing login still answers with the assignment deadline", () => {
  const eff = effectiveDeadlineFor(ASSIGNMENT, undefined, { overrides: [] });
  assert.equal(eff.deadline.getTime(), DEADLINE);
  assert.equal(eff.extended, false);
});

// --- the cohort-wide question ------------------------------------------------

test("latestEffectiveDeadline ignores non-extension overrides and malformed ones", () => {
  const overrides = [
    overrideDoc("bob", { type: "annotation", value: "2027-01-01T00:00:00Z" }),
    overrideDoc("carol", { value: "not a date" }),
  ];
  assert.equal(latestEffectiveDeadline(ASSIGNMENT, overrides).getTime(), DEADLINE);
});

test("latestEffectiveDeadline works with no assignment deadline at all", () => {
  const overrides = [overrideDoc("bob", { value: "2026-09-25T22:00:00Z" })];
  assert.equal(latestEffectiveDeadline({}, overrides).toISOString(), "2026-09-25T22:00:00.000Z");
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
