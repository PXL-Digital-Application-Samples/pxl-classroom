// Promoting accepted students onto the roster.
//
// Under roster_mode: open nobody is on the roster and any GitHub account inside
// the window may accept. Who turned up is recorded in
// acceptances/<id>/<login>.json and goes no further, so the next assignment
// starts from the same blank roster. Promotion closes that loop.
//
// What these tests exist to pin, in order of how badly each would hurt:
//
//   1. MERGE, NEVER REPLACE. A CSV import replaces the roster wholesale (which
//      is why it confirms before removing anybody). Promotion is additive, and
//      an entry that already exists must come back byte-identical - losing a
//      student_number to a helper that "updated" the roster is unrecoverable
//      without the original CSV.
//   2. NEVER INVENT AN IDENTITY. GitHub knows a login, an id and a timestamp.
//      It does not know a name or a student number, and guessing one puts a
//      fabricated value in a field that gets graded.
//   3. NO TEAM DATA. lib/seed-teams.mjs deliberately refuses to write team
//      columns to the roster; promotion must not reintroduce them by the back
//      door, because a CSV re-import replaces the file and would wipe them.
//   4. The result must still validate, and must still be readable by the thing
//      that actually grants repositories - acceptance/accept.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stringify as yamlStringify, parse as yamlParse } from "yaml";

import {
  planPromotion,
  promotionChangesAnything,
  promoteCommitMessage,
  planClaimPromotion,
  claimPromotionChangesAnything,
  ROSTER_PATH,
} from "../lib/promote-roster.mjs";
import {
  rosterKey,
  diffRosters,
  describeRosterEntry,
  isPromotedEntry,
  ROSTER_SOURCES,
  PROMOTED_SOURCE,
} from "../lib/roster-entries.mjs";
import { validateAgainst } from "../lib/validate.mjs";

// ROSTER_SOURCES was exported and imported by nobody, while isPromotedEntry
// compared against the literal "accepted" - a constant describing a rule it did
// not enforce, which is the decoy lib/group-config.mjs's header is about. It is
// the schema's enum now, and this is what keeps the two from drifting apart.
test("ROSTER_SOURCES is the enum the roster schema declares", () => {
  const schema = JSON.parse(
    readFileSync(new URL("../schemas/roster.schema.json", import.meta.url), "utf8"),
  );
  const declared =
    schema.properties?.students?.items?.properties?.source?.enum ??
    schema.$defs?.student?.properties?.source?.enum;
  assert.ok(Array.isArray(declared), "the roster schema must still declare a source enum");
  assert.deepEqual([...ROSTER_SOURCES], declared, "lib/roster-entries.mjs and the schema disagree");
  assert.ok(declared.includes(PROMOTED_SOURCE), "PROMOTED_SOURCE must be one of them");
  assert.equal(isPromotedEntry({ source: PROMOTED_SOURCE }), true);
  assert.equal(isPromotedEntry({ source: ROSTER_SOURCES[0] }), false);
});

const NOW = "2026-09-01T10:00:00.000Z";
const ACTOR = "tomcoolpxl";

function assignment(over = {}) {
  return {
    id: "net-advanced-guts-2627",
    title: ".NET Advanced GUTS",
    roster_mode: "open",
    assignment_type: "individual",
    ...over,
  };
}

function acceptance(login, over = {}) {
  return {
    schema_version: 1,
    assignment_id: "net-advanced-guts-2627",
    github_login: login,
    github_id: 1000 + login.length,
    accepted_at: "2026-08-30T09:00:00.000Z",
    status: "provisioned",
    ...over,
  };
}

function roster(students) {
  return { schema_version: 2, students };
}

const IMPORTED = {
  student_number: "0123456",
  full_name: "Alice Example",
  email: "alice@student.pxl.be",
  class_group: "3A",
  github_login: "alice-pxl",
};

function plan(over = {}) {
  return planPromotion({
    acceptances: [],
    roster: roster([]),
    assignment: assignment(),
    now: NOW,
    actor: ACTOR,
    ...over,
  });
}

// The gate acceptance/accept.mjs actually applies, copied verbatim in shape so
// the test proves a promoted roster admits the student rather than assuming it.
function acceptGateAdmits(rosterDoc, login) {
  return (rosterDoc?.students || []).some(
    (s) => s.github_login?.toLowerCase() === login.toLowerCase(),
  );
}

// --------------------------------------------------------------------------
// Happy path
// --------------------------------------------------------------------------

test("promotes a login that is not yet on the roster", () => {
  const p = plan({ acceptances: [acceptance("bob-pxl")] });
  assert.equal(p.ok, true);
  assert.equal(p.stats.added, 1);
  assert.deepEqual(p.added[0], {
    github_login: "bob-pxl",
    github_id: 1007,
    source: "accepted",
    promoted_from: {
      assignment_id: "net-advanced-guts-2627",
      accepted_at: "2026-08-30T09:00:00.000Z",
      promoted_at: NOW,
      promoted_by: ACTOR,
    },
  });
});

test("NEVER INVENTS AN IDENTITY - no full_name, no student_number, no email", () => {
  const p = plan({ acceptances: [acceptance("bob-pxl")] });
  const keys = Object.keys(p.added[0]).sort();
  assert.deepEqual(keys, ["github_id", "github_login", "promoted_from", "source"]);
  for (const forbidden of ["full_name", "student_number", "email", "class_group"]) {
    assert.equal(forbidden in p.added[0], false, `${forbidden} must not be invented`);
  }
});

test("an acceptance with no github_id omits the field rather than writing null", () => {
  const p = plan({ acceptances: [acceptance("bob-pxl", { github_id: undefined })] });
  assert.equal("github_id" in p.added[0], false);
});

test("a non-integer github_id is dropped rather than written", () => {
  const p = plan({ acceptances: [acceptance("bob-pxl", { github_id: "12345" })] });
  assert.equal("github_id" in p.added[0], false);
});

// --------------------------------------------------------------------------
// 1. Merge, never replace
// --------------------------------------------------------------------------

test("MERGE - an existing student with a full identity is returned byte-identical", () => {
  const before = JSON.stringify(IMPORTED);
  const p = plan({
    roster: roster([{ ...IMPORTED }]),
    acceptances: [acceptance("alice-pxl")],
  });
  assert.equal(p.stats.added, 0);
  assert.deepEqual(p.alreadyOnRoster, ["alice-pxl"]);
  assert.equal(JSON.stringify(p.nextRoster.students[0]), before);
});

test("MERGE - case-mismatched login is the same student, not a second entry", () => {
  const p = plan({
    roster: roster([{ ...IMPORTED, github_login: "Alice-PXL" }]),
    acceptances: [acceptance("alice-pxl")],
  });
  assert.equal(p.stats.added, 0);
  assert.equal(p.nextRoster.students.length, 1);
  assert.equal(p.nextRoster.students[0].github_login, "Alice-PXL", "the roster's spelling wins");
});

test("MERGE - existing entries keep their order; promoted ones append", () => {
  const p = plan({
    roster: roster([{ ...IMPORTED }, { student_number: "2", full_name: "Zed", github_login: "zed" }]),
    acceptances: [acceptance("bob-pxl")],
  });
  assert.deepEqual(
    p.nextRoster.students.map((s) => s.github_login),
    ["alice-pxl", "zed", "bob-pxl"],
  );
});

test("MERGE - a roster entry with no github_login is left alone", () => {
  const unlinked = { student_number: "9", full_name: "Not Linked Yet" };
  const p = plan({ roster: roster([unlinked]), acceptances: [acceptance("bob-pxl")] });
  assert.deepEqual(p.nextRoster.students[0], unlinked);
  assert.equal(p.stats.added, 1);
});

test("MERGE - sibling keys on the roster document are carried through", () => {
  const p = plan({
    roster: { schema_version: 2, students: [], future_field: "kept" },
    acceptances: [acceptance("bob-pxl")],
  });
  assert.equal(p.nextRoster.future_field, "kept");
  assert.equal(p.nextRoster.schema_version, 2);
});

// --------------------------------------------------------------------------
// 3. No team data
// --------------------------------------------------------------------------

test("NO TEAM DATA - a group acceptance's team_slug never reaches the roster", () => {
  const p = plan({
    assignment: assignment({ assignment_type: "group" }),
    acceptances: [acceptance("bob-pxl", { team_slug: "alpha", team_name: "Alpha Team" })],
  });
  assert.equal("team_slug" in p.added[0], false);
  assert.equal("team_name" in p.added[0], false);
  assert.equal("teams" in p.added[0], false);
  assert.ok(p.warnings.some((w) => w.code === "teams-not-promoted"));
});

// --------------------------------------------------------------------------
// Roster shapes the planner must refuse rather than guess about
// --------------------------------------------------------------------------

test("an ARRAY-SHAPED roster is refused, not overwritten", () => {
  // It parses, roster.students is undefined, and accept.mjs's
  // `roster?.students || []` therefore sees nobody. Rewriting it would be a
  // fix, but silently replacing a file we failed to understand is how a
  // hand-edited cohort gets deleted by a helper that meant well.
  const p = planPromotion({
    roster: [{ student_number: "1", full_name: "A" }],
    acceptances: [acceptance("bob-pxl")],
    assignment: assignment(),
  });
  assert.equal(p.ok, false);
  assert.equal(p.errors[0].code, "roster-array-shaped");
  assert.equal(p.nextRoster, null);
});

test("a students key that is not a list is refused", () => {
  const p = planPromotion({
    roster: { schema_version: 2, students: { a: 1 } },
    acceptances: [acceptance("bob-pxl")],
    assignment: assignment(),
  });
  assert.equal(p.ok, false);
  assert.equal(p.errors[0].code, "roster-students-not-a-list");
});

test("a roster that is not an object at all is refused", () => {
  const p = planPromotion({ roster: "nonsense", acceptances: [], assignment: assignment() });
  assert.equal(p.ok, false);
  assert.equal(p.errors[0].code, "roster-not-an-object");
});

test("an ABSENT roster is created, not refused", () => {
  const p = plan({ roster: null, acceptances: [acceptance("bob-pxl")] });
  assert.equal(p.ok, true);
  assert.equal(p.nextRoster.schema_version, 2);
  assert.equal(p.nextRoster.students.length, 1);
  assert.ok(p.warnings.some((w) => w.code === "roster-created"));
});

test("a roster with students omitted is filled in rather than refused", () => {
  const p = plan({ roster: { schema_version: 2 }, acceptances: [acceptance("bob-pxl")] });
  assert.equal(p.ok, true);
  assert.equal(p.nextRoster.students.length, 1);
});

test("an empty students list is a normal starting point", () => {
  const p = plan({ acceptances: [acceptance("bob-pxl")] });
  assert.equal(p.ok, true);
  assert.equal(p.stats.roster_total, 1);
});

test("no assignment is refused", () => {
  assert.equal(planPromotion({}).errors[0].code, "no-assignment");
});

// --------------------------------------------------------------------------
// Acceptance records that are not clean
// --------------------------------------------------------------------------

test("no acceptances at all is not an error", () => {
  const p = plan({ acceptances: [] });
  assert.equal(p.ok, true);
  assert.equal(p.stats.added, 0);
  assert.ok(p.warnings.some((w) => w.code === "no-acceptances"));
  assert.equal(promotionChangesAnything(p), false);
});

test("a record with no login is skipped, and said out loud", () => {
  const p = plan({ acceptances: [acceptance("bob-pxl"), { github_login: "  " }] });
  assert.equal(p.stats.added, 1);
  assert.deepEqual(p.skipped, [{ login: null, reason: "no-login" }]);
  assert.ok(p.warnings.some((w) => w.code === "records-skipped"));
});

test("malformed records are skipped rather than crashing", () => {
  const p = plan({ acceptances: [null, 42, "x", acceptance("bob-pxl")] });
  assert.equal(p.stats.added, 1);
  assert.equal(p.skipped.filter((s) => s.reason === "malformed-record").length, 3);
});

test("the same login twice in one batch produces ONE entry", () => {
  const p = plan({ acceptances: [acceptance("bob-pxl"), acceptance("BOB-PXL")] });
  assert.equal(p.stats.added, 1);
  assert.deepEqual(p.skipped, [{ login: "BOB-PXL", reason: "duplicate-acceptance" }]);
});

test("a login is trimmed before use", () => {
  const p = plan({ acceptances: [acceptance("  bob-pxl  ")] });
  assert.equal(p.added[0].github_login, "bob-pxl");
});

test("an unusual but legal login is promoted unchanged", () => {
  const p = plan({ acceptances: [acceptance("a-9-Z")] });
  assert.equal(p.added[0].github_login, "a-9-Z");
});

test("a failed acceptance is still a student who turned up", () => {
  const p = plan({ acceptances: [acceptance("bob-pxl", { status: "failed" })] });
  assert.equal(p.stats.added, 1);
});

// --------------------------------------------------------------------------
// Idempotency and determinism
// --------------------------------------------------------------------------

test("IDEMPOTENT - promoting twice adds nothing the second time", () => {
  const first = plan({ acceptances: [acceptance("bob-pxl"), acceptance("carol")] });
  const second = planPromotion({
    roster: first.nextRoster,
    acceptances: [acceptance("bob-pxl"), acceptance("carol")],
    assignment: assignment(),
    now: "2026-12-25T00:00:00.000Z",
    actor: ACTOR,
  });
  assert.equal(second.stats.added, 0);
  assert.equal(promotionChangesAnything(second), false);
  assert.equal(
    yamlStringify(second.nextRoster),
    yamlStringify(first.nextRoster),
    "a second run must produce byte-identical YAML, or it commits forever",
  );
});

test("IDEMPOTENT - the first promotion's timestamp is not rewritten by the second", () => {
  const first = plan({ acceptances: [acceptance("bob-pxl")] });
  const second = planPromotion({
    roster: first.nextRoster,
    acceptances: [acceptance("bob-pxl")],
    assignment: assignment(),
    now: "2026-12-25T00:00:00.000Z",
  });
  assert.equal(second.nextRoster.students[0].promoted_from.promoted_at, NOW);
});

test("promoted entries are sorted by login, so output is deterministic", () => {
  const p = plan({ acceptances: [acceptance("zed"), acceptance("alice2"), acceptance("Mike")] });
  assert.deepEqual(p.added.map((s) => s.github_login), ["alice2", "Mike", "zed"]);
});

test("the same student promoted from a SECOND assignment keeps the first provenance", () => {
  const first = plan({ acceptances: [acceptance("bob-pxl")] });
  const second = planPromotion({
    roster: first.nextRoster,
    acceptances: [acceptance("bob-pxl", { assignment_id: "later" })],
    assignment: assignment({ id: "later" }),
    now: "2026-12-25T00:00:00.000Z",
  });
  assert.equal(second.stats.added, 0);
  assert.equal(second.nextRoster.students[0].promoted_from.assignment_id, "net-advanced-guts-2627");
});

test("a 200-student cohort lands in one plan", () => {
  const acceptances = Array.from({ length: 200 }, (_, i) => acceptance(`student-${i}`));
  const p = plan({ acceptances });
  assert.equal(p.stats.added, 200);
  assert.equal(p.nextRoster.students.length, 200);
});

// --------------------------------------------------------------------------
// roster_mode: enforced
// --------------------------------------------------------------------------

test("promoting an ENFORCED assignment whose students are all on the roster is a no-op", () => {
  const p = plan({
    assignment: assignment({ roster_mode: "enforced" }),
    roster: roster([{ ...IMPORTED }]),
    acceptances: [acceptance("alice-pxl")],
  });
  assert.equal(p.stats.added, 0);
  assert.ok(p.warnings.some((w) => w.code === "nothing-to-add"));
});

test("an ENFORCED acceptance no longer on the roster is re-added, and flagged", () => {
  // They passed the roster gate when they accepted, so they were removed after.
  // Re-adding is right - they hold a repository - but silently undoing a
  // lecturer's removal is not.
  const p = plan({
    assignment: assignment({ roster_mode: "enforced" }),
    roster: roster([]),
    acceptances: [acceptance("ghost")],
  });
  assert.equal(p.stats.added, 1);
  const w = p.warnings.find((x) => x.code === "readded-after-removal");
  assert.ok(w);
  assert.deepEqual(w.logins, ["ghost"]);
});

test("an absent roster_mode is treated as enforced, matching accept.mjs", () => {
  const p = plan({ assignment: { id: "x" }, roster: roster([]), acceptances: [acceptance("ghost")] });
  assert.ok(p.warnings.some((w) => w.code === "readded-after-removal"));
});

// --------------------------------------------------------------------------
// 4. The result is usable by the rest of the system
// --------------------------------------------------------------------------

test("the promoted roster VALIDATES against roster.schema.json", () => {
  const p = plan({
    roster: roster([{ ...IMPORTED }]),
    acceptances: [acceptance("bob-pxl"), acceptance("carol")],
  });
  const { valid, errors } = validateAgainst("roster", structuredClone(p.nextRoster));
  assert.equal(valid, true, JSON.stringify(errors));
});

test("the promoted roster ADMITS the student at accept.mjs's gate", () => {
  const p = plan({ acceptances: [acceptance("bob-pxl")] });
  assert.equal(acceptGateAdmits(p.nextRoster, "bob-pxl"), true);
  assert.equal(acceptGateAdmits(p.nextRoster, "BOB-PXL"), true, "the gate is case-insensitive");
  assert.equal(acceptGateAdmits(p.nextRoster, "someone-else"), false);
});

test("the promoted roster survives a YAML round trip", () => {
  const p = plan({ acceptances: [acceptance("bob-pxl")] });
  const reparsed = yamlParse(yamlStringify(p.nextRoster));
  assert.deepEqual(reparsed, p.nextRoster);
  const { valid } = validateAgainst("roster", structuredClone(reparsed));
  assert.equal(valid, true);
});

test("the changes a caller writes go to the one roster path", () => {
  assert.equal(ROSTER_PATH, "students/roster.yml");
  const p = plan({ acceptances: [acceptance("bob-pxl")] });
  assert.match(promoteCommitMessage(p, { assignmentId: "x" }), /Promote 1 accepted student\(s\) from x/);
});

test("the planner does not mutate its inputs", () => {
  const existing = roster([{ ...IMPORTED }]);
  const records = [acceptance("bob-pxl")];
  const snapshot = JSON.stringify({ existing, records });
  plan({ roster: existing, acceptances: records });
  assert.equal(JSON.stringify({ existing, records }), snapshot);
});

// --------------------------------------------------------------------------
// The schema contract itself
// --------------------------------------------------------------------------

test("schema: an imported entry still requires student_number and full_name", () => {
  const { valid } = validateAgainst("roster", roster([{ github_login: "bob" }]));
  assert.equal(valid, false, "a login-only entry with no source marker must be refused");
});

test("schema: a promoted entry needs only a github_login", () => {
  const { valid, errors } = validateAgainst(
    "roster",
    roster([{ github_login: "bob", source: "accepted" }]),
  );
  assert.equal(valid, true, JSON.stringify(errors));
});

test("schema: a promoted entry WITHOUT a github_login is refused", () => {
  // Otherwise promotion could write an entry that identifies nobody at all.
  const { valid } = validateAgainst("roster", roster([{ source: "accepted" }]));
  assert.equal(valid, false);
});

test("schema: a promoted entry with a null github_login is refused", () => {
  const { valid } = validateAgainst(
    "roster",
    roster([{ source: "accepted", github_login: null }]),
  );
  assert.equal(valid, false);
});

test("schema: an unknown source value is refused", () => {
  const { valid } = validateAgainst(
    "roster",
    roster([{ github_login: "bob", source: "guessed" }]),
  );
  assert.equal(valid, false);
});

test("schema: a promoted entry may later gain an institutional identity", () => {
  const { valid, errors } = validateAgainst(
    "roster",
    roster([{ github_login: "bob", source: "accepted", student_number: "1", full_name: "Bob" }]),
  );
  assert.equal(valid, true, JSON.stringify(errors));
});

test("schema: promoted_from requires the fields that make it useful", () => {
  const bad = validateAgainst(
    "roster",
    roster([{ github_login: "b", source: "accepted", promoted_from: { promoted_at: NOW } }]),
  );
  assert.equal(bad.valid, false, "assignment_id is what makes provenance reconcilable");
});

test("schema: the shipped control-repo roster template still validates", () => {
  // The scaffold every new org starts from. A schema change that breaks it
  // strands onboarding.
  const text = readFileSync(new URL("../control-repo-template/students/roster.yml", import.meta.url), "utf8");
  const { valid, errors } = validateAgainst("roster", yamlParse(text));
  assert.equal(valid, true, JSON.stringify(errors));
});

// --------------------------------------------------------------------------
// roster-entries: identity and diff
// --------------------------------------------------------------------------

test("rosterKey prefers the institutional number", () => {
  assert.equal(rosterKey({ student_number: "0123456", github_login: "a" }), "num:0123456");
});

test("rosterKey falls back to a lowercased login", () => {
  assert.equal(rosterKey({ github_login: "Alice-PXL" }), "login:alice-pxl");
});

test("rosterKey keeps the two namespaces apart", () => {
  assert.notEqual(rosterKey({ student_number: "123" }), rosterKey({ github_login: "123" }));
});

test("rosterKey is null when an entry identifies nobody", () => {
  assert.equal(rosterKey({ full_name: "Anon" }), null);
  assert.equal(rosterKey(null), null);
});

test("diffRosters does NOT collapse promoted entries onto one key", () => {
  // Keying on student_number alone mapped every promoted entry to `undefined`:
  // fifty students became one diff row, and the import that followed silently
  // removed forty-nine of them.
  const promoted = (l) => ({ github_login: l, source: "accepted" });
  const d = diffRosters(roster([]), roster([promoted("a"), promoted("b"), promoted("c")]));
  assert.equal(d.added.length, 3);
});

test("diffRosters matches a promoted entry against itself across a round trip", () => {
  const doc = roster([{ github_login: "bob", source: "accepted" }]);
  const d = diffRosters(doc, yamlParse(yamlStringify(doc)));
  assert.deepEqual([d.added.length, d.updated.length, d.removed.length], [0, 0, 0]);
});

test("diffRosters is key-order independent", () => {
  // The SPA used JSON.stringify, so a roster whose YAML serialised its keys in
  // another order showed EVERY student as updated in the Admin Panel while the
  // CLI reported the same file unchanged.
  const a = roster([{ student_number: "1", full_name: "A", github_login: "a" }]);
  const b = roster([{ github_login: "a", full_name: "A", student_number: "1" }]);
  assert.equal(diffRosters(a, b).updated.length, 0);
});

test("diffRosters still detects a real change", () => {
  const a = roster([{ student_number: "1", full_name: "A" }]);
  const b = roster([{ student_number: "1", full_name: "A. Changed" }]);
  assert.equal(diffRosters(a, b).updated.length, 1);
});

test("diffRosters reports unkeyable entries separately instead of inventing a pairing", () => {
  const d = diffRosters(roster([{ full_name: "Anon" }]), roster([]));
  assert.equal(d.removed.length, 0);
  assert.equal(d.unkeyed.current.length, 1);
});

test("describeRosterEntry names a promoted entry instead of printing undefined", () => {
  // This string lands in the CSV import's removal list - the one place a
  // lecturer is asked to confirm a destructive change.
  assert.equal(describeRosterEntry({ github_login: "bob", source: "accepted" }), "@bob");
  assert.match(describeRosterEntry(IMPORTED), /^0123456 {2}Alice Example {2}@alice-pxl$/);
});

test("isPromotedEntry only matches the marker", () => {
  assert.equal(isPromotedEntry({ source: "accepted" }), true);
  assert.equal(isPromotedEntry({ source: "import" }), false);
  assert.equal(isPromotedEntry(IMPORTED), false);
});

// --------------------------------------------------------------------------
// The rule may not fork again
// --------------------------------------------------------------------------

// Comments are stripped first: the ones this change added quote the old
// implementation by name, so a scan including them fails against its own
// explanation - the trap tests/student-wait-copy.test.mjs documents.
function sourceOf(rel) {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const DIFF_CONSUMERS = [
  "cli/src/commands/roster.mjs",
  "frontend/src/lib/csv.js",
];

for (const rel of DIFF_CONSUMERS) {
  test(`${rel} imports the shared roster diff rather than defining its own`, () => {
    const src = sourceOf(rel);
    assert.doesNotMatch(
      src,
      /function\s+diffRosters/,
      `${rel} defines its own diffRosters. The two copies had already forked - one compared with a stable stringify and the other with JSON.stringify, and both keyed on student_number, which a promoted entry does not have.`,
    );
    assert.match(src, /roster-entries\.mjs/, `${rel} must import lib/roster-entries.mjs`);
  });

  test(`${rel} does not key a roster map on student_number by hand`, () => {
    assert.doesNotMatch(
      sourceOf(rel),
      /\[\s*s\.student_number\s*,/,
      `${rel} builds its own student_number-keyed index; use rosterKey().`,
    );
  });
}

// --------------------------------------------------------------------------
// Folding claims into the roster (ARCHITECTURE §15)
// --------------------------------------------------------------------------
//
// The opposite operation from promotion, which is why it is a separate planner
// rather than a flag: promotion ADDS entries for logins the roster has never
// heard of, folding UPDATES entries it already has. Under `claim` the student
// was always on the roster - matched by address - and what the claim supplies
// is the GitHub account, the column the mode exists to avoid asking for.

const claimRec = (login, id, email) => ({
  schema_version: 1,
  github_login: login,
  github_id: id,
  email,
  claim_verified: true,
  claimed_at: NOW,
  claimed_via: "hw-1",
});

const claimRoster = (...students) => ({ schema_version: 2, students });

// --- what an UNATTENDED fold may touch -------------------------------------
//
// The nightly folds claims so a lecturer has no step to find, and that is only
// safe for claims that are evidence. `claim_verified` is false whenever the
// student TYPED an address instead of confirming one GitHub had verified, and
// lib/claim.mjs is blunt about what that is worth: "Someone with a shared link
// and a made-up address is always false". Unattended, those wait for a human.

test("verifiedOnly folds a GitHub-verified claim", () => {
  const plan = planClaimPromotion({
    roster: claimRoster({ student_number: "0123456", full_name: "Alice", email: "alice@student.pxl.be" }),
    claims: [claimRec("alice-gh", 111, "alice@student.pxl.be")],
    verifiedOnly: true,
  });

  assert.equal(plan.stats.updated, 1);
  assert.equal(plan.stats.unverified, 0);
  assert.equal(plan.nextRoster.students[0].github_login, "alice-gh");
});

test("verifiedOnly HOLDS a typed one, and says whose", () => {
  const typed = { ...claimRec("mallory", 999, "alice@student.pxl.be"), claim_verified: false };
  const plan = planClaimPromotion({
    roster: claimRoster({ student_number: "0123456", full_name: "Alice", email: "alice@student.pxl.be" }),
    claims: [typed],
    verifiedOnly: true,
  });

  assert.equal(plan.stats.updated, 0, "nothing may be written unattended on a typed address");
  assert.equal(plan.stats.unverified, 1);
  assert.equal(plan.nextRoster.students[0].github_login ?? null, null, "the roster entry is untouched");
  // Named, not just counted - the review list has to say who to look at.
  assert.equal(plan.unverified[0].email, "alice@student.pxl.be");
  assert.equal(plan.unverified[0].claim_login, "mallory");
  assert.ok(plan.warnings.some((w) => w.code === "claim-unverified"));
});

test("a lecturer running it by hand still folds a typed one", () => {
  // verifiedOnly is FALSE by default. The human is the review step, and they
  // are looking at the plan - taking this away would make the CLI unable to do
  // the one thing the nightly deliberately refuses to do alone.
  const typed = { ...claimRec("alice-gh", 111, "alice@student.pxl.be"), claim_verified: false };
  const plan = planClaimPromotion({
    roster: claimRoster({ student_number: "0123456", full_name: "Alice", email: "alice@student.pxl.be" }),
    claims: [typed],
  });

  assert.equal(plan.stats.updated, 1);
  assert.equal(plan.stats.unverified, 0, "nothing is held when nobody asked for the distinction");
  assert.equal(plan.nextRoster.students[0].github_login, "alice-gh");
});

test("verifiedOnly does not rescue a conflict or an ambiguity", () => {
  // Verified says the ADDRESS is real. It says nothing about which of two
  // accounts should win, or about a roster row that already names another - so
  // the existing guards still apply on top of it.
  const conflicting = planClaimPromotion({
    roster: claimRoster({ email: "alice@student.pxl.be", github_login: "someone-else" }),
    claims: [claimRec("alice-gh", 111, "alice@student.pxl.be")],
    verifiedOnly: true,
  });
  assert.equal(conflicting.stats.updated, 0);
  assert.equal(conflicting.stats.conflicts, 1);

  const ambiguousPlan = planClaimPromotion({
    roster: claimRoster({ email: "alice@student.pxl.be" }),
    claims: [claimRec("one", 1, "alice@student.pxl.be"), claimRec("two", 2, "alice@student.pxl.be")],
    verifiedOnly: true,
  });
  assert.equal(ambiguousPlan.stats.updated, 0);
  assert.equal(ambiguousPlan.stats.ambiguous, 1);
});

test("folding writes the claimed account onto the entry that address belongs to", () => {
  const plan = planClaimPromotion({
    roster: claimRoster({ student_number: "0123456", full_name: "Alice", email: "alice@student.pxl.be" }),
    claims: [claimRec("alice-gh", 111, "alice@student.pxl.be")],
  });

  assert.equal(plan.ok, true);
  assert.equal(plan.stats.updated, 1);
  assert.equal(plan.nextRoster.students[0].github_login, "alice-gh");
  assert.equal(plan.nextRoster.students[0].github_id, 111);
  // Rule 1: the columns the lecturer imported survive.
  assert.equal(plan.nextRoster.students[0].student_number, "0123456");
  assert.equal(plan.nextRoster.students[0].full_name, "Alice");
});

test("nothing else is copied off the claim", () => {
  // Rule 2. `email` is already the join, and claim_verified is evidence about
  // one acceptance rather than a roster fact - putting it in a graded document
  // is the same mistake as inventing a full_name from a login.
  const plan = planClaimPromotion({
    roster: claimRoster({ email: "alice@student.pxl.be" }),
    claims: [claimRec("alice-gh", 111, "alice@student.pxl.be")],
  });
  assert.deepEqual(Object.keys(plan.nextRoster.students[0]).sort(), ["email", "github_id", "github_login"]);
});

test("a github_login the lecturer already set is NEVER overwritten", () => {
  // The sharper form of merge-never-replace. One of the two is wrong and only a
  // human knows which, so it is reported for unlink rather than resolved by
  // whichever ran last.
  const plan = planClaimPromotion({
    roster: claimRoster({ full_name: "Dave", email: "dave@student.pxl.be", github_login: "dave-pxl" }),
    claims: [claimRec("someone-else", 222, "dave@student.pxl.be")],
  });

  assert.equal(plan.stats.updated, 0);
  assert.equal(plan.stats.conflicts, 1);
  assert.equal(plan.nextRoster.students[0].github_login, "dave-pxl", "the lecturer's value stands");
  assert.equal(plan.conflicts[0].claim_login, "someone-else");
  assert.match(plan.warnings.find((w) => w.code === "claim-conflicts").message, /unlink/);
});

test("a claim agreeing with the roster changes nothing and is not a conflict", () => {
  const plan = planClaimPromotion({
    roster: claimRoster({ email: "bob@student.pxl.be", github_login: "Bob-PXL" }),
    claims: [claimRec("bob-pxl", 222, "bob@student.pxl.be")],
  });
  assert.equal(plan.stats.conflicts, 0, "case-insensitive, as every other login comparison is");
  assert.equal(plan.stats.unchanged, 1);
  assert.equal(claimPromotionChangesAnything(plan), false);
});

test("an address claimed twice is left alone rather than picking a winner", () => {
  // accept.mjs refuses to create this, so it is a hand-edited or restored file.
  const plan = planClaimPromotion({
    roster: claimRoster({ email: "shared@student.pxl.be" }),
    claims: [claimRec("first", 111, "shared@student.pxl.be"), claimRec("second", 222, "shared@student.pxl.be")],
  });
  assert.equal(plan.stats.updated, 0);
  assert.equal(plan.stats.ambiguous, 1);
  assert.equal(plan.nextRoster.students[0].github_login, undefined);
});

test("an orphan claim adds nobody", () => {
  // Folding updates; it never invents a roster entry from a binding.
  const plan = planClaimPromotion({
    roster: claimRoster({ email: "alice@student.pxl.be" }),
    claims: [claimRec("zoe-gh", 999, "zoe@student.pxl.be")],
  });
  assert.equal(plan.stats.updated, 0);
  assert.equal(plan.nextRoster.students.length, 1);
});

test("an absent roster refuses rather than being created", () => {
  // Unlike promotion, which creates one. A claim can only exist because it
  // matched a roster entry, so an absent roster here means the roster went away
  // underneath the bindings - and folding into a file we would have to invent
  // is the guess this module refuses to make.
  const plan = planClaimPromotion({ roster: null, claims: [claimRec("a", 1, "a@student.pxl.be")] });
  assert.equal(plan.ok, false);
  assert.equal(plan.errors[0].code, "no-roster");
});

test("an array-shaped roster refuses, and says why it already lets nobody accept", () => {
  const plan = planClaimPromotion({
    roster: [{ email: "alice@student.pxl.be" }],
    claims: [claimRec("alice-gh", 111, "alice@student.pxl.be")],
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.errors[0].code, "roster-array-shaped");
});

test("the folded roster still validates against the real schema", () => {
  // The roster is what acceptance reads to decide who gets a repository.
  const plan = planClaimPromotion({
    roster: claimRoster({ student_number: "0123456", full_name: "Alice", email: "alice@student.pxl.be" }),
    claims: [claimRec("alice-gh", 111, "alice@student.pxl.be")],
  });
  const { valid, errors } = validateAgainst("roster", structuredClone(plan.nextRoster));
  assert.equal(valid, true, JSON.stringify(errors));
});

test("sibling keys on the roster document survive the fold", () => {
  const plan = planClaimPromotion({
    roster: { schema_version: 2, generated_by: "csv-import", students: [{ email: "a@student.pxl.be" }] },
    claims: [claimRec("a-gh", 1, "a@student.pxl.be")],
  });
  assert.equal(plan.nextRoster.generated_by, "csv-import");
});
