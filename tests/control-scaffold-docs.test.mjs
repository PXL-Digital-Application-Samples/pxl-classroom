// The control repo's directory list, as the docs describe it and as the code
// creates it, checked against each other.
//
// ARCHITECTURE.md §3.1 listed `errors` among the control repo's contents. There
// is no `errors` in CONTROL_SCAFFOLD_DIRS, nothing creates it and nothing writes
// to it - so the sentence describing where things go named a directory that has
// never existed. It went unnoticed because a doc claim fails silently: the file
// reads plausibly, and the only way to find out is to go looking, which is
// precisely what nobody does until an incident.
//
// This is prose-parsing and therefore fragile, which is a deliberate trade. It
// is anchored to the ONE table row that enumerates the directories, and it
// fails loudly if that row stops being findable rather than passing vacuously -
// an absence assertion over a table that has been reworded would otherwise
// report clean forever.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { CONTROL_SCAFFOLD_DIRS } from "../lib/control-layout.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ARCH = readFileSync(join(ROOT, "ARCHITECTURE.md"), "utf8");

/** The repository-roles table row that enumerates what a control repo holds. */
const ROW = /\|\s*\*\*Control repo\*\*[^|]*\|[^|]*\|[^|]*\|([^|]*)\|/;

test("the control-repo row still exists to be checked", () => {
  // Non-vacuity. Without this, rewording the table turns every assertion below
  // into a comparison against an empty list, which passes.
  assert.match(ARCH, ROW, "ARCHITECTURE.md no longer has a **Control repo** row listing its contents - update this guard with it");
});

test("every directory the docs claim is one the scaffold creates", () => {
  const listed = ROW.exec(ARCH)[1]
    .split(",")
    .map((s) => s.trim().replace(/`/g, "").toLowerCase())
    .filter(Boolean);

  // The row is prose - "Assignments, roster, acceptances, ..." - so `roster` is
  // a document inside `students`, not a directory. Only words that name a
  // scaffold directory are checked; the rest are descriptions and none of this
  // guard's business.
  const KNOWN_NON_DIRS = new Set(["roster"]);

  const claimed = listed.filter((w) => !KNOWN_NON_DIRS.has(w));
  const unknown = claimed.filter((w) => !CONTROL_SCAFFOLD_DIRS.includes(w));

  assert.deepEqual(
    unknown,
    [],
    `ARCHITECTURE.md §3.1 says a control repo holds these, and CONTROL_SCAFFOLD_DIRS does not create them: ${unknown.join(", ")}`,
  );
});

test("the row names enough of the scaffold to be a description of it", () => {
  // The other direction, loosely. An exhaustive match would make every
  // rewording a test failure, which teaches people to weaken the guard. But a
  // row that had drifted to naming two of ten directories would no longer be
  // describing the control repo at all.
  const row = ROW.exec(ARCH)[1].toLowerCase();
  const named = CONTROL_SCAFFOLD_DIRS.filter((d) => row.includes(d));
  assert.ok(
    named.length >= CONTROL_SCAFFOLD_DIRS.length - 2,
    `the row names only ${named.length} of ${CONTROL_SCAFFOLD_DIRS.length} scaffold directories: missing ${CONTROL_SCAFFOLD_DIRS.filter((d) => !row.includes(d)).join(", ")}`,
  );
});
