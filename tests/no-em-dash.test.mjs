import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// NO EM DASHES IN THE DOCUMENTATION.
//
// A house style rule rather than a defect: the prose here already used a spaced
// hyphen far more often than an em dash, so the two were mixed on the same page
// and often in the same paragraph. 758 of them were replaced in one pass on
// 2026-09-09; this is what stops the next one arriving.
//
// SCOPED TO MARKDOWN, deliberately. The SPA uses `—` as a GLYPH - `{{
// s.student_number || '—' }}` is the dash that means "no value" in a table
// cell, which is a display convention and not prose. Telling those apart from a
// sentence needs judgement this test does not have, so it does not try: the
// documents are unambiguous and are where the prose lives.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("no top-level document contains an em dash", () => {
  const offenders = [];
  for (const name of readdirSync(root).filter((f) => f.endsWith(".md"))) {
    const text = readFileSync(join(root, name), "utf-8");
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      // INLINE CODE IS EXEMPT, because the rule has to be able to name the
      // character it forbids - CLAUDE.md quotes it three times in one sentence,
      // and a guard that cannot survive its own rule being written down is a
      // guard somebody deletes.
      const prose = line.replace(/`[^`]*`/g, "");
      // BOTH CHARACTERS. The em dash is the one people mean, and the en dash
      // arrived separately in numeric ranges - `16-24px`, `20-30s`, `6.1-6.3` -
      // where it is typographically correct and still not what this project
      // writes. One rule with no exception is easier to hold than a right one
      // that needs judgement at every use.
      const found = [...prose].find((c) => c === "—" || c === "–");
      if (found) offenders.push(`${name}:${i + 1}: ${line.trim().slice(0, 90)}`);
    });
  }
  assert.deepEqual(
    offenders,
    [],
    "Use a spaced hyphen, a comma, a colon or parentheses instead of an em dash:\n" +
      offenders.join("\n"),
  );
});

test("the guard can actually fail - it is reading the files", () => {
  // A test that globbed nothing would pass forever over an empty set. This is
  // the mutation check on the reader, not on the rule.
  const docs = readdirSync(root).filter((f) => f.endsWith(".md"));
  assert.ok(docs.length >= 10, `expected the project's documents, found ${docs.length}`);
  assert.ok(docs.includes("CLAUDE.md") && docs.includes("LESSONS.md"));
  // And it would notice either one if it were there.
  assert.ok("a — b".includes("—"));
  assert.ok("16–24px".includes("–"));
});
