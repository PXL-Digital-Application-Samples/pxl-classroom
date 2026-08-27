// A guard whose anchor has been renamed away checks nothing, silently.
//
// Most source-scanning tests here slice a function body out by string search:
//
//     const fn = src.slice(src.indexOf("async function saveTeamMembers"));
//     const body = fn.slice(0, fn.indexOf("\nasync function "));
//
// That is fine while the anchor exists. When it stops existing - a rename, a
// refactor, a `function` becoming an arrow - `indexOf` returns -1, `slice(-1)`
// yields the LAST CHARACTER of the file, and `slice(0, -1)` yields everything
// but the last one. An absence assertion over either passes vacuously, and the
// guard reports success while inspecting nothing.
//
// This is not hypothetical here. A buildDoc sweep anchored on `const doc = {`,
// which that file has never contained (it is `return {`), fell back to scanning
// the whole file and cheerfully reported "omits 0 fields" while checking
// nothing at all.
//
// Rather than rewrite sixty slice sites, this asserts the cheap invariant that
// makes them safe: every literal a test searches for must still exist somewhere
// in the code. When a rename lands, the guard that depended on the old name
// goes red HERE, naming itself, instead of going quiet.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const SRC_DIRS = [
  "lib", "scripts", "acceptance", "provisioning", "collect", "lockdown", "preserve",
  "report", "notify", "pages", "registry", "frontend/src", "cli/src", ".github/workflows",
  "schemas", "control-repo-template",
];

// Files outside those trees that tests legitimately read. frontend/index.html
// is the one that matters: it carries the inline theme boot script, which
// tests/theme-tokens.test.mjs anchors into, and it deliberately duplicates the
// storage key so light-mode users do not flash dark before the bundle loads.
const EXTRA_FILES = ["frontend/index.html", "frontend/vite.config.js", "package.json", "deployment.yml"];

/** Everything a scanning test might legitimately be looking at. */
function corpus() {
  const parts = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      if (name === "node_modules" || name === ".git" || name === "dist" || name === ".claude") continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(mjs|js|vue|yml|yaml|json|css|html)$/.test(name)) parts.push(readFileSync(full, "utf8"));
    }
  };
  for (const d of SRC_DIRS) walk(join(root, d));
  for (const f of EXTRA_FILES) {
    try { parts.push(readFileSync(join(root, f), "utf8")); } catch { /* optional */ }
  }
  return parts.join("\n");
}

function testFiles() {
  const out = [];
  for (const dir of ["tests", "cli/tests"]) {
    let entries;
    try { entries = readdirSync(join(root, dir)); } catch { continue; }
    for (const n of entries) if (n.endsWith(".test.mjs")) out.push(join(root, dir, n));
  }
  return out;
}

function unescape(s) {
  return s.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\r/g, "\r").replace(/\\\\/g, "\\");
}

test("every literal a test anchors on still exists in the code", () => {
  const haystack = corpus();
  const dead = [];
  let anchors = 0;

  for (const file of testFiles()) {
    const rel = relative(root, file).replace(/\\/g, "/");
    // Comments blanked (not removed, so line numbers still point at the source):
    // several of these files - this one included - explain the rule by quoting an
    // `indexOf` anchor, and a raw scan reads the prose as code. Same reason the
    // claim-mode and roster-entries guards strip before scanning.
    const scannable = readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
      .replace(/^(\s*)\/\/.*$/gm, (m, indent) => indent + " ".repeat(Math.max(0, m.length - indent.length)));

    scannable.split("\n").forEach((line, i) => {
      // A deliberate "this must NOT appear" check: the literal is expected to
      // be absent, so it is not an anchor.
      if (/-1|=== *-1|!== *-1/.test(line)) return;

      for (const m of line.matchAll(/\.indexOf\(\s*(["'])((?:\\.|(?!\1).)+)\1/g)) {
        const literal = unescape(m[2]);
        // Structural anchors ("\n}", ")\n", "=") are punctuation, not names -
        // they cannot rot the way an identifier can.
        if (literal.trim().length < 6) continue;
        anchors++;
        if (!haystack.includes(literal)) {
          dead.push(`  ${rel}:${i + 1} anchors on ${JSON.stringify(m[2])}, which appears nowhere in the code`);
        }
      }
    });
  }

  // The scan must have actually scanned - an empty walk looks exactly like a
  // clean repo, which is the very failure this file is about.
  assert.ok(anchors >= 40, `expected many anchors across the suite, found ${anchors}`);

  assert.deepEqual(
    dead,
    [],
    "these guards slice on a name the code no longer has, so they inspect nothing:\n" + dead.join("\n"),
  );
});
