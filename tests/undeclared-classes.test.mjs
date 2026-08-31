// A CSS class declared nowhere renders unstyled, and nothing says so.
//
// This is the same failure mode DESIGN.md §5 rule 3 names for custom
// properties - "undefined tokens fail silently" - applied to class names, and
// tests/scoped-style-leakage.test.mjs skips it on purpose:
//
//     const owners = scopedOwners.get(c);
//     if (!owners) continue; // not styled anywhere; not this test's concern
//
// That is how `.btn-warning` shipped in seven places across two components,
// rendering with the plain `.btn` face, while a test asserted the class was
// present in the template - which it was. And how `.font-semibold`, written in
// ten components, rendered every one of those headings at the body weight.
//
// The utilities are fixed. The rest is a real backlog of component vocabulary
// whose intended appearance is not recorded anywhere, so it is pinned here
// rather than invented: nothing new may join it, and removing one from the code
// forces removing it from the list.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  findUndeclaredClasses,
  classesUsed,
  classesDeclared,
} from "../scripts/lint-undeclared-classes.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const BACKLOG = JSON.parse(
  readFileSync(join(root, "tests", "fixtures", "undeclared-classes.backlog.json"), "utf8")
).classes;

test("no NEW class is used without being declared anywhere", async () => {
  const undeclared = await findUndeclaredClasses();
  const added = [...undeclared]
    .filter(([cls]) => !(cls in BACKLOG))
    .map(([cls, where]) => `.${cls} (used by ${[...where].join(", ")})`);

  assert.deepEqual(
    added,
    [],
    "These classes are declared in neither style.css nor any scoped block, so they render " +
      "UNSTYLED with no build error. Declare them, or drop them from the markup:\n  " +
      added.join("\n  ")
  );
});

test("the backlog only shrinks", async () => {
  // A stale entry means somebody fixed a class and left the exemption behind,
  // which is how a backlog stops being one.
  const undeclared = await findUndeclaredClasses();
  const stale = Object.keys(BACKLOG).filter((cls) => !undeclared.has(cls));
  assert.deepEqual(
    stale,
    [],
    "These are declared now - remove them from tests/fixtures/undeclared-classes.backlog.json:\n  " +
      stale.join("\n  ")
  );
});

test("the utilities that shipped dead are declared globally", async () => {
  // .font-semibold alone appeared in ten components. These have unambiguous
  // intent and sit beside the .text-sm / .text-xs group that already existed.
  const style = classesDeclared(readFileSync(join(root, "frontend", "src", "style.css"), "utf8"));
  for (const cls of ["font-medium", "font-semibold", "font-bold", "uppercase", "text-xl", "text-left", "list-disc"]) {
    assert.ok(style.has(cls), `.${cls} must be declared in style.css`);
  }
});

test("btn-warning stays gone", async () => {
  const undeclared = await findUndeclaredClasses();
  assert.ok(!undeclared.has("btn-warning"), "btn-warning is not a DESIGN.md §3 variant");
  assert.ok(!("btn-warning" in BACKLOG), "and must never be exempted");
});

test("nothing on the backlog is used by more than one component", async () => {
  // The backlog's remaining entries are per-component vocabulary whose intended
  // appearance is not recorded anywhere, so they are pinned rather than
  // invented. A class used by TWO components is a different thing: a scoped
  // block cannot reach across, so it can only be fixed in style.css, and
  // leaving it here means both components render it unstyled forever.
  //
  // Fourteen were in exactly that state - `.form-group` in three components,
  // `.data-table` in two, plus the five the duplicated autograding modal
  // carried into both of its copies. They are declared now; this is what stops
  // the category coming back.
  const undeclared = await findUndeclaredClasses();
  const shared = [...undeclared]
    .filter(([, where]) => where.size > 1)
    .map(([cls, where]) => `.${cls} (used by ${[...where].join(", ")})`);

  assert.deepEqual(
    shared,
    [],
    "A class more than one component uses belongs in style.css - a scoped block " +
      "cannot reach the other one, so it renders unstyled in both:\n  " +
      shared.join("\n  "),
  );
});

// --- The extractor itself ---------------------------------------------------
//
// It decides what counts as a class, so a sloppy one either misses real bugs or
// buries them in noise. Both happened while this was being written.

test("static class attributes are read, dynamic ones are not mistaken for them", () => {
  const used = classesUsed('<div class="card is-open">');
  assert.deepEqual([...used].sort(), ["card", "is-open"]);
});

test("a quoted literal in a comparison is not a class name", () => {
  // `:class="{ active: filter === 'on-time' }"` compares against a filter
  // value. Reading 'on-time' as a class reported four components as using a
  // class nobody ever meant to style.
  const used = classesUsed(`<div :class="{ active: statusFilter === 'on-time' }">`);
  assert.deepEqual([...used].sort(), ["active"]);

  const reversed = classesUsed(`<div :class="{ active: 'late' === statusFilter }">`);
  assert.deepEqual([...reversed].sort(), ["active"]);
});

test("literals in class position ARE class names", () => {
  const array = classesUsed(`<div :class="['badge', ok ? 'badge-success' : 'badge-error']">`);
  assert.deepEqual([...array].sort(), ["badge", "badge-error", "badge-success"]);
});

test("a bare `class=` inside `:class=` is not read twice", () => {
  // `\\bclass="` matches the `class="` inside `:class="`, which is how the
  // original extractor read whole expressions as class names.
  const used = classesUsed(`<div :class="[cond ? 'a' : 'b']">`);
  assert.ok(!used.has("cond"), "expression identifiers are not classes");
});

test("declarations are found in compound and nested selectors", () => {
  const declared = classesDeclared(`
    .status.late { color: red; }
    .card > .row:hover { color: blue; }
    .a, .b { color: green; }
    @media (max-width: 600px) { .narrow { display: none; } }
  `);
  for (const cls of ["status", "late", "card", "row", "a", "b", "narrow"]) {
    assert.ok(declared.has(cls), `.${cls} must be recognised as declared`);
  }
});

test("a property value is not mistaken for a declaration", () => {
  const declared = classesDeclared(".x { transition: opacity .2s; margin: 1.5rem; }");
  assert.ok(declared.has("x"));
  assert.ok(!declared.has("2s"), "a decimal in a value is not a class");
  assert.ok(!declared.has("5rem"), "nor is a decimal in a length");
});
