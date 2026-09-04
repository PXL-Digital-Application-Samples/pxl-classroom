// reports/dashboard.json is written by three surfaces and was validated by none.
//
// The e2e fixture checks every control-repo write against the schema for its
// path, and this one file was exempt for want of a schema - so the cross-assignment
// roll-up that the org overview reads, and that report.mjs, the Admin Panel's
// state patch and the detail view's live refresh all write, was the single
// document no test could reject. schemas/dashboard.schema.json closes that, and
// this file pins the schema to the builder rather than to a copy of it.
//
// NEVER RE-IMPLEMENT THE THING UNDER TEST. The property list below is derived
// from what buildDashboardEntry actually returns, so a field added to the
// builder and forgotten in the schema fails here instead of being written
// unchecked for months - which is exactly how `with_warnings` survived being
// renamed to `with_repo_faults`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildDashboardEntry, assignmentFacts } from "../lib/dashboard-aggregate.mjs";
import { validateAgainst } from "../lib/validate.mjs";

const SCHEMA = JSON.parse(
  readFileSync(new URL("../schemas/dashboard.schema.json", import.meta.url), "utf8"),
);

const ASSIGNMENT = {
  id: "linux-processes-2026",
  title: "Linux Processes",
  state: "published",
  opens_at: "2026-02-01T08:00:00.000Z",
  deadline_at: "2026-03-01T22:00:00.000Z",
  timezone: "Europe/Brussels",
  max_acceptances: 50,
};

const STUDENTS = [
  { github_login: "alice", acceptance_state: "accepted", repo_id: 1, submission_status: "on-time", warnings: [] },
  { github_login: "bob", acceptance_state: "accepted", repo_id: 2, submission_status: "late", warnings: ["missing-repo-id"] },
  { github_login: "carol", acceptance_state: "not-accepted", submission_status: "no-submission", warnings: [] },
];

/** The document as it is actually written: undefined values are gone. */
const asWritten = (doc) => JSON.parse(JSON.stringify(doc));

const wrap = (entries) => ({
  schema_version: 1,
  assignments: entries,
  generated_at: "2026-03-02T01:22:31.171Z",
});

function check(doc) {
  return validateAgainst("dashboard", asWritten(doc));
}

test("what buildDashboardEntry produces is a valid dashboard", () => {
  const { valid, errors } = check(wrap({ [ASSIGNMENT.id]: buildDashboardEntry(ASSIGNMENT, STUDENTS) }));
  assert.equal(valid, true, JSON.stringify(errors, null, 2));
});

test("the schema declares exactly the fields the builder writes", () => {
  const entry = asWritten(buildDashboardEntry(ASSIGNMENT, STUDENTS));
  const declared = Object.keys(SCHEMA.definitions.entry.properties).sort();
  const written = Object.keys(entry).sort();

  assert.deepEqual(
    written.filter((k) => !declared.includes(k)),
    [],
    "the builder writes fields the schema does not declare - they would be rejected on the next write",
  );
  assert.deepEqual(
    declared.filter((k) => !written.includes(k)),
    [],
    "the schema declares fields the builder no longer writes - a renamed field leaves its old spelling behind here",
  );
});

test("a renamed field is caught, in both directions", () => {
  // The `with_warnings` -> `with_repo_faults` rename, replayed. An entry
  // carrying the old spelling is refused, which is what makes report.mjs warn
  // about a sibling instead of writing it forward for ever.
  const entry = buildDashboardEntry(ASSIGNMENT, STUDENTS);
  const { with_repo_faults, ...rest } = entry;
  const stale = check(wrap({ [ASSIGNMENT.id]: { ...rest, with_warnings: with_repo_faults } }));
  assert.equal(stale.valid, false);

  const messages = JSON.stringify(stale.errors);
  assert.match(messages, /additional properties|required property/i);
});

test("an absent title is caught, because JSON.stringify drops it", () => {
  // The mechanism, demonstrated rather than asserted about: assignment.schema.json
  // requires `title`, so a document without one is hand-edited - and the entry
  // built from it does not carry `title: null`, it carries no title at all.
  const entry = buildDashboardEntry({ ...ASSIGNMENT, title: undefined }, STUDENTS);
  assert.equal("title" in entry, true, "the builder sets the key");
  assert.equal("title" in asWritten(entry), false, "and JSON.stringify removes it again");

  const { valid } = check(wrap({ [ASSIGNMENT.id]: entry }));
  assert.equal(valid, false, "a titled-less entry must not reach the overview");
});

test("no cap is null, never a substituted number", () => {
  const entry = buildDashboardEntry({ ...ASSIGNMENT, max_acceptances: undefined }, STUDENTS);
  assert.equal(entry.max_acceptances, null);
  assert.equal(check(wrap({ [ASSIGNMENT.id]: entry })).valid, true);

  // Zero is not "no cap" and must not be storable as one.
  assert.equal(check(wrap({ [ASSIGNMENT.id]: { ...entry, max_acceptances: 0 } })).valid, false);
});

test("state and timezone are optional, because the assignment document does not require them", () => {
  const entry = buildDashboardEntry({ ...ASSIGNMENT, state: undefined, timezone: undefined }, STUDENTS);
  assert.equal(check(wrap({ [ASSIGNMENT.id]: entry })).valid, true);

  // But a state nobody defined is still refused.
  assert.equal(check(wrap({ [ASSIGNMENT.id]: { ...entry, state: "accepting" } })).valid, false);
});

test("the seed report.mjs writes when the file does not exist yet is valid", () => {
  // report.mjs starts from `{ schema_version: 1, assignments: {} }` and only
  // sets generated_at at the end, so the empty document has to be legal.
  assert.equal(validateAgainst("dashboard", { schema_version: 1, assignments: {} }).valid, true);
});

test("the Admin Panel's merge-patch keeps the entry valid", () => {
  // syncDashboardState writes `{ ...entry, ...assignmentFacts(doc) }`. The
  // counts it leaves alone and the facts it overwrites have to compose into a
  // document the backend can still read.
  const entry = buildDashboardEntry(ASSIGNMENT, STUDENTS);
  const closed = { ...entry, ...assignmentFacts({ ...ASSIGNMENT, state: "closed" }) };

  const { valid, errors } = check(wrap({ [ASSIGNMENT.id]: closed }));
  assert.equal(valid, true, JSON.stringify(errors, null, 2));
  assert.equal(asWritten(closed).state, "closed");
  assert.equal(asWritten(closed).accepted, entry.accepted, "a patch must not touch the counts");
});

test("an unknown top-level key is refused", () => {
  const doc = wrap({ [ASSIGNMENT.id]: buildDashboardEntry(ASSIGNMENT, STUDENTS) });
  assert.equal(check({ ...doc, assignment_count: 1 }).valid, false);
});

test("a key that is not an assignment id is refused", () => {
  const doc = wrap({ "Linux Processes": buildDashboardEntry(ASSIGNMENT, STUDENTS) });
  assert.equal(check(doc).valid, false);
});

test("every field the schema requires is one the builder always writes", () => {
  // `required` is the half that fails closed, so it may only name fields the
  // builder cannot omit. `state` and `timezone` are deliberately absent from it
  // - the assignment document does not require them either.
  const entry = asWritten(buildDashboardEntry(ASSIGNMENT, STUDENTS));
  const missing = SCHEMA.definitions.entry.required.filter((k) => !(k in entry));
  assert.deepEqual(missing, [], "the schema requires a field the builder does not produce");

  const optional = Object.keys(SCHEMA.definitions.entry.properties).filter(
    (k) => !SCHEMA.definitions.entry.required.includes(k),
  );
  assert.deepEqual(optional.sort(), ["state", "timezone"]);
});
