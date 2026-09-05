// Class groups after they stopped being a gate.
//
// This file used to test an acceptance decision. It does not any more: the gate
// is `lib/cohort.mjs` and `tests/cohort.test.mjs` covers it. What is left is
// what a class group is for now - finding people in the picker - so these are
// tests about filtering a roster, and there is nothing here that can refuse a
// student a repository.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeClassGroup,
  rosterClassGroups,
  studentInClassGroup,
  classGroupCounts,
} from "../lib/class-groups.mjs";

const ROSTER = {
  students: [
    { student_number: "0001", full_name: "Alice", class_group: "3A" },
    { student_number: "0002", full_name: "Bram", class_group: "3a" },
    { student_number: "0003", full_name: "Cara", class_group: " 3B " },
    { student_number: "0004", full_name: "Dries", class_group: "3B" },
    { student_number: "0005", full_name: "Ella" },
    { student_number: "0006", full_name: "Finn", class_group: "  " },
  ],
};

test("comparison is trimmed and case-insensitive, so a section is not split in two", () => {
  assert.equal(normalizeClassGroup("3A"), "3a");
  assert.equal(normalizeClassGroup(" 3a "), "3a");
  assert.equal(normalizeClassGroup(""), "");
  assert.equal(normalizeClassGroup("   "), "");
  assert.equal(normalizeClassGroup(null), "");
  assert.equal(normalizeClassGroup(7), "");
});

test("the groups offered are the lecturer's own spelling, once each", () => {
  // "3A" and "3a" are one section. The first spelling seen wins - there is no
  // basis for preferring another - and a whitespace-only value is not a group.
  assert.deepEqual(rosterClassGroups(ROSTER), ["3A", "3B"]);
  assert.deepEqual(rosterClassGroups(ROSTER.students), ["3A", "3B"], "a bare array works too");
  assert.deepEqual(rosterClassGroups(null), []);
  assert.deepEqual(rosterClassGroups({ students: "nope" }), []);
});

test("the ungrouped are a filter of their own, not an absence", () => {
  // They used to be invisible in this control and refused by the gate behind it.
  // Now a lecturer can see them and tick them.
  assert.equal(studentInClassGroup({ class_group: "3A" }, "3a"), true);
  assert.equal(studentInClassGroup({ class_group: " 3B " }, "3B"), true);
  assert.equal(studentInClassGroup({ class_group: "3A" }, "3B"), false);

  assert.equal(studentInClassGroup({}, ""), true, "no group matches the ungrouped filter");
  assert.equal(studentInClassGroup({ class_group: "  " }, ""), true, "and so does whitespace");
  assert.equal(studentInClassGroup({ class_group: "3A" }, ""), false);
  assert.equal(studentInClassGroup(null, ""), true);
});

test("counts answer the question a bare chip could not: how many am I admitting", () => {
  assert.deepEqual(classGroupCounts(ROSTER), [
    { group: "3A", count: 2 },
    { group: "3B", count: 2 },
    { group: "", count: 2 },
  ]);
});

test("the ungrouped entry is present even at zero, so the caller decides", () => {
  // Inferring "no ungrouped students" from a missing key is how a chip silently
  // stops rendering; the count is always there and the caller chooses.
  const counts = classGroupCounts({ students: [{ class_group: "3A" }] });
  assert.deepEqual(counts, [
    { group: "3A", count: 1 },
    { group: "", count: 0 },
  ]);
  assert.deepEqual(classGroupCounts(null), [{ group: "", count: 0 }]);
});

test("the counts and the offered groups agree", () => {
  // Derived from each other rather than written twice: a group offered as a
  // filter with no count behind it is a chip that filters to nothing.
  const offered = rosterClassGroups(ROSTER);
  const counted = classGroupCounts(ROSTER).filter((c) => c.group !== "").map((c) => c.group);
  assert.deepEqual(counted, offered);

  const total = classGroupCounts(ROSTER).reduce((n, c) => n + c.count, 0);
  assert.equal(total, ROSTER.students.length, "every student is counted exactly once");
});
