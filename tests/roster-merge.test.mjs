import test from "node:test";
import assert from "node:assert/strict";

import { diffRosters, PROMOTED_SOURCE, ROSTER_SCHEMA_VERSION } from "../lib/roster-entries.mjs";
import { rowsToRoster } from "../lib/roster-csv.mjs";

const promoted = (login, over = {}) => ({ github_login: login, source: PROMOTED_SOURCE, ...over });
const imported = (num, name, over = {}) => ({ student_number: num, full_name: name, ...over });
const doc = (students) => ({ schema_version: ROSTER_SCHEMA_VERSION, students });

// --------------------------------------------------------- the defect itself

test("THE DEFECT: a CSV naming a promoted student MERGES onto their row", () => {
  // rosterKey prefers `num:`, so the CSV row keyed `num:0123456` and the stored
  // row keyed `login:lowieserneelspxl` could never meet: the import ADDED one
  // and REMOVED the other. Two rows for one student.
  const current = doc([promoted("LowieSerneelsPXL")]);
  const next = doc([imported("0123456", "Lowie Serneels", { github_login: "LowieSerneelsPXL" })]);

  const d = diffRosters(current, next);
  assert.deepEqual(d.added, [], "not a new student");
  assert.deepEqual(d.removed, [], "and the old row is not removed");
  assert.equal(d.updated.length, 1);
  assert.equal(d.merged.students.length, 1, "one row, not two");
});

test("…and the login survives even when the CSV has no github_login column", () => {
  // The worst version: the CSV names the student by number alone, so the login
  // - the one fact the promoted row existed to hold - was simply gone.
  const current = doc([promoted("alice-dev", { student_number: "0123456" })]);
  const next = doc([imported("0123456", "Alice Example")]);

  const d = diffRosters(current, next);
  assert.equal(d.merged.students[0].github_login, "alice-dev");
  assert.equal(d.merged.students[0].full_name, "Alice Example", "and the CSV still wins its own columns");
});

test("matching is case-insensitive, like every other login comparison here", () => {
  const current = doc([promoted("LowieSerneelsPXL")]);
  const next = doc([imported("0123456", "Lowie Serneels", { github_login: "lowieserneelspxl" })]);
  assert.equal(diffRosters(current, next).merged.students.length, 1);
});

test("the number matches too, when both rows carry one", () => {
  const current = doc([imported("0123456", "Old Name", { class_group: "3A" })]);
  const next = doc([imported("0123456", "New Name")]);
  const d = diffRosters(current, next);
  assert.equal(d.merged.students.length, 1);
  assert.equal(d.merged.students[0].full_name, "New Name");
  assert.equal(d.merged.students[0].class_group, "3A", "a group set in the table survives an import");
});

// --------------------------------------------------------------- the merge

test("MERGE, NEVER REPLACE: the CSV wins its own columns and nothing else moves", () => {
  const current = doc([promoted("alice-dev", {
    email: "alice@student.pxl.be",
    class_group: "3A",
    team_slug: "alpha",
  })]);
  const next = doc([imported("0123456", "Alice Example", { github_login: "alice-dev", class_group: "3B" })]);

  const merged = diffRosters(current, next).merged.students[0];
  assert.deepEqual(merged, {
    github_login: "alice-dev",
    source: PROMOTED_SOURCE,
    email: "alice@student.pxl.be",   // not in the CSV, kept
    team_slug: "alpha",              // not in the CSV, kept
    student_number: "0123456",       // from the CSV
    full_name: "Alice Example",      // from the CSV
    class_group: "3B",               // the CSV wins where it speaks
  });
});

test("a CSV cannot clear a field, which is why merging is safe", () => {
  // coerceCell omits an empty cell, so an absent column and a blank cell are
  // the same thing and neither can mean "clear this". Removing a student is
  // what the `removed` list is for, and both surfaces confirm it.
  const parsed = rowsToRoster(
    [{ student_number: "0123456", full_name: "Alice Example", email: "" }],
    ["student_number", "full_name", "email"],
  );
  assert.ok(!("email" in parsed.students[0]), "a blank cell writes no key at all");

  const current = doc([imported("0123456", "Alice Example", { email: "alice@student.pxl.be" })]);
  assert.equal(diffRosters(current, parsed).merged.students[0].email, "alice@student.pxl.be");
});

test("an unchanged import reports nothing and writes the same document", () => {
  const current = doc([imported("0123456", "Alice Example", { github_login: "alice-dev" })]);
  const next = doc([imported("0123456", "Alice Example", { github_login: "alice-dev" })]);
  const d = diffRosters(current, next);
  assert.deepEqual([d.added, d.updated, d.removed], [[], [], []]);
  assert.deepEqual(d.merged.students, current.students);
});

// ------------------------------------------------------ what still happens

test("a student the CSV does not name is still REMOVED", () => {
  // Unchanged behaviour, and the destructive half both surfaces confirm.
  const current = doc([imported("0123456", "Alice"), promoted("bob-dev")]);
  const next = doc([imported("0123456", "Alice")]);
  const d = diffRosters(current, next);
  assert.deepEqual(d.removed.map((s) => s.github_login), ["bob-dev"]);
  assert.equal(d.merged.students.length, 1);
});

test("a genuinely new student is added", () => {
  const d = diffRosters(doc([]), doc([imported("0123456", "Alice")]));
  assert.equal(d.added.length, 1);
  assert.equal(d.merged.students.length, 1);
});

test("the merged document keeps the incoming document's own fields", () => {
  const d = diffRosters(doc([]), { schema_version: 2, students: [] });
  assert.equal(d.merged.schema_version, 2);
});

test("`updated.after` IS what gets written - the diff cannot describe another document", () => {
  // The previous shape was: preview here, build your own document there. That
  // is exactly how a diff and a write come to disagree.
  const current = doc([promoted("alice-dev", { class_group: "3A" })]);
  const next = doc([imported("0123456", "Alice", { github_login: "alice-dev" })]);
  const d = diffRosters(current, next);
  assert.deepEqual(d.updated[0].after, d.merged.students[0]);
});

// ---------------------------------------------------------------- the edges

test("one stored row is claimed once, even when two incoming rows name it", () => {
  // Both would otherwise merge into it and write it twice.
  const current = doc([promoted("alice-dev")]);
  const next = doc([
    imported("0123456", "Alice One", { github_login: "alice-dev" }),
    imported("0999999", "Alice Two", { github_login: "alice-dev" }),
  ]);
  const d = diffRosters(current, next);
  assert.equal(d.merged.students.length, 2, "two incoming rows, two rows out");
  assert.equal(d.updated.length, 1);
  assert.equal(d.added.length, 1);
});

test("…and rowsToRoster refuses that CSV in the first place", () => {
  // A login is an identity on the import path now, so two rows sharing one are
  // two students claiming to be one person.
  assert.throws(
    () => rowsToRoster(
      [
        { student_number: "0123456", full_name: "Alice One", github_login: "alice-dev" },
        { student_number: "0999999", full_name: "Alice Two", github_login: "Alice-Dev" },
      ],
      ["student_number", "full_name", "github_login"],
    ),
    /line 3: duplicate github_login "Alice-Dev"/,
  );
});

test("rows with no identity are reported and still written", () => {
  // Refusing to write one would turn a malformed row into a silent deletion.
  const next = { schema_version: 2, students: [{ full_name: "Nobody" }] };
  const d = diffRosters(doc([]), next);
  assert.equal(d.unkeyed.next.length, 1);
  assert.equal(d.merged.students.length, 1);
  assert.deepEqual(d.added, [], "unkeyed is not 'added' - it is unmatched");
});

test("a stored row with no identity is reported, and not silently removed twice", () => {
  const current = { schema_version: 2, students: [{ full_name: "Nobody" }] };
  const d = diffRosters(current, doc([]));
  assert.equal(d.unkeyed.current.length, 1);
  assert.deepEqual(d.removed, [], "it was never keyed, so it is not a keyed removal");
});

test("null and empty documents do not throw", () => {
  for (const [a, b] of [[null, null], [undefined, doc([])], [doc([]), null]]) {
    const d = diffRosters(a, b);
    assert.ok(Array.isArray(d.merged.students));
  }
});

test("the merged order follows the incoming document", () => {
  // The CSV is the intended roster; the stored order is incidental.
  const current = doc([imported("2", "Bob"), imported("1", "Alice")]);
  const next = doc([imported("1", "Alice"), imported("2", "Bob")]);
  assert.deepEqual(
    diffRosters(current, next).merged.students.map((s) => s.student_number),
    ["1", "2"],
  );
});
