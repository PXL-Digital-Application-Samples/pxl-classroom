// One file decides where the roster lives.
//
// `students/roster.yml` was spelled out by hand in TEN places - the acceptance
// gate, the report, diagnostics, the scaffold, the CLI and six spots in the SPA
// - while `ROSTER_PATH` sat in lib/roster-entries.mjs being imported by two of
// them. The constant existed and the load-bearing readers ignored it.
//
// That matters more here than in most places. The path is what the acceptance
// gate reads to decide who may accept: get it wrong in one of ten copies and
// the failure is either admitting students who are not on the roster, or
// rejecting a whole cohort - and the other nine keep working, so nothing looks
// broken until a lecturer is standing in front of the class.
//
// It is also the thing a per-assignment roster would have to change. Ten call
// sites each learning that independently is ten chances to disagree; one is a
// decision.
//
// SCOPE, stated rather than implied: this checks executable code (.mjs/.js and
// the <script> half of .vue), with comments stripped. Prose that NAMES the file
// for a human - a JSDoc line, a `<code>` block telling a lecturer which file to
// import - is not a second source of truth and is left alone.

import { test } from "node:test";
import assert from "node:assert/strict";

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { ROSTER_PATH } from "../lib/roster-entries.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// The one file allowed to say it, plus the two shims that re-export it.
const OWNERS = new Set([
  "lib/roster-entries.mjs",
  "frontend/src/lib/roster.js",
]);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (["node_modules", "dist", ".git", ".tools", ".claude", "test-results"].includes(entry)) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(mjs|js|vue)$/.test(entry)) out.push(p);
  }
  return out;
}

/** Strip comments so prose naming the file is not mistaken for a second copy. */
function code(source, file) {
  let text = source;
  if (file.endsWith(".vue")) {
    // Only the script half is code; a <code>students/roster.yml</code> in the
    // template is telling a lecturer which file to edit.
    const m = text.match(/<script[^>]*>([\s\S]*?)<\/script>/);
    text = m ? m[1] : "";
  }
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

test("ROSTER_PATH is the path, and it is not spelled out anywhere else", () => {
  const offenders = [];

  for (const file of walk(root)) {
    const rel = relative(root, file).replace(/\\/g, "/");
    if (OWNERS.has(rel)) continue;
    if (rel.startsWith("tests/")) continue; // fixtures legitimately build trees

    const body = code(readFileSync(file, "utf8"), rel);
    // Both spellings that reached production: the plain string, and the
    // segment-wise `join(..., "students", "roster.yml")` the backend used.
    if (body.includes(ROSTER_PATH) || /["']students["']\s*,\s*["']roster\.yml["']/.test(body)) {
      offenders.push(rel);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    "these spell the roster path themselves instead of importing ROSTER_PATH " +
      "(from lib/roster-entries.mjs, or frontend/src/lib/roster.js in the SPA):\n  " +
      offenders.join("\n  "),
  );
});

test("the guard is looking at something", () => {
  // A walk that silently stops matching looks exactly like a clean repo, which
  // is the failure mode the undeclared-classes sweep documents. Floor it.
  const files = walk(root).map((f) => relative(root, f).replace(/\\/g, "/"));
  assert.ok(files.length > 200, `expected to scan the SPA and the backend, scanned ${files.length}`);
  assert.ok(files.includes("acceptance/accept.mjs"), "the acceptance gate must be in scope");
  assert.ok(files.includes("report/report.mjs"), "the report must be in scope");
  assert.ok(files.includes("frontend/src/components/RosterTab.vue"), "the roster editor must be in scope");
});

test("the shims re-export rather than redefine", () => {
  // A second `const ROSTER_PATH = "..."` would satisfy every import above and
  // still be a fork.
  const shim = readFileSync(join(root, "frontend/src/lib/roster.js"), "utf8");
  assert.match(shim, /export\s*\{[^}]*ROSTER_PATH[^}]*\}\s*from/, "must re-export, not redeclare");
  assert.doesNotMatch(shim, /const\s+ROSTER_PATH\s*=/, "must not declare its own copy");
});
