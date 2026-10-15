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
// The documents first. The SPA uses `—` as a GLYPH - `{{ s.student_number ||
// '—' }}` is the dash that means "no value" in a table cell, which is a display
// convention and not prose - so its test, below, exempts exactly that form.
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

// THE SPA TOO, since 2026-10-15: the help audit found eleven in UI copy - a
// dialog title, a footnote, a filter warning - and ten in style.css comments.
// The glyph has one form, the character alone inside quotes (`'—'`, `"—"`,
// `empty-text="—"`), and that is what a table cell's "no value" is; anything
// else is prose and refused.
test("no em or en dash in the SPA's source, except the no-value glyph", () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== "generated") walk(path); continue; }
      if (!/\.(vue|js|mjs|css)$/.test(entry.name)) continue;
      readFileSync(path, "utf-8").split("\n").forEach((line, i) => {
        const rest = line.replace(/(['"])[—–]\1/g, "");
        if (/[—–]/.test(rest)) offenders.push(`${path.slice(root.length + 1)}:${i + 1}: ${line.trim().slice(0, 90)}`);
      });
    }
  };
  walk(join(root, "frontend", "src"));
  assert.deepEqual(offenders, [], "Use a spaced hyphen, a comma, a colon or parentheses:\n" + offenders.join("\n"));
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
