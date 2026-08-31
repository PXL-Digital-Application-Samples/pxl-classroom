// Documentation cross-references, guarded the way the code ones are.
//
// The docs cite each other by section number - `ARCHITECTURE §4.3.2`,
// `RUNBOOK §3.12` - and so do ~340 comments and user-facing strings in the
// source. Nothing rendered those as links, so a reference to a section that no
// longer exists reads as ordinary text: no build error, no dead link, nothing
// to notice. Fifteen were dangling when this was first run, one of them from a
// RUNBOOK heading that had been declared TWICE with fifteen references split
// between the two meanings.
//
// WHAT THIS CANNOT DO, and it matters: a reference that resolves to the WRONG
// section passes. `See INSTALL.md §3.1` resolved cleanly to "Invitation signing
// keypair" while the procedure it meant was RUNBOOK §3.12 - a lecturer sent to
// the wrong page mid-incident, and this test green throughout. Renumbering is
// where that gets created in bulk, so when you renumber, read the diff for
// references whose *title* stopped matching; do not take a pass here as proof.
//
// The heading set is re-derived from the documents on every run rather than
// listed here, so this cannot validate its own assumptions.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative, extname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Documents that own a numbered section space. */
const DOCS = ["ARCHITECTURE.md", "RUNBOOK.md", "ADMIN.md", "INSTALL.md", "DESIGN.md"];

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".tools", "dist", "test-results", "playwright-report", "coverage",
]);
const EXTS = new Set([".md", ".mjs", ".js", ".vue", ".yml", ".yaml", ".cjs", ".ts"]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (EXTS.has(extname(name))) out.push(full);
  }
  return out;
}

/** Numbered headings a document declares: "### 4.3.2 Signed ..." -> "4.3.2". */
function headingsOf(file) {
  const found = new Map();
  for (const line of readFileSync(join(ROOT, file), "utf8").split(/\r?\n/)) {
    const m = /^#{1,6}\s+([0-9]+(?:\.[0-9a-z]+)*)[.)]?\s+\S/.exec(line);
    if (m) found.set(m[1], (found.get(m[1]) || 0) + 1);
  }
  return found;
}

const HEADINGS = new Map(DOCS.map((d) => [d, headingsOf(d)]));
const ANY_HEADING = new Set([...HEADINGS.values()].flatMap((s) => [...s.keys()]));
const FILES = walk(ROOT);

// A reference, plus the document it names when it names one.
const REF = /(ARCHITECTURE|RUNBOOK|DESIGN|INSTALL|ADMIN)?[^\n]{0,24}?§([0-9]+(?:\.[0-9a-z]+)*)/g;

test("no document declares the same section number twice", () => {
  const dupes = [];
  for (const [doc, set] of HEADINGS) {
    for (const [num, count] of set) {
      if (count > 1) dupes.push(`${doc} declares §${num} ${count} times`);
    }
  }
  assert.deepEqual(
    dupes,
    [],
    `A number that means two things makes every reference to it ambiguous:\n  ${dupes.join("\n  ")}`,
  );
});

test("every § reference resolves to a section that exists", () => {
  const dangling = [];

  for (const file of FILES) {
    const rel = relative(ROOT, file).replace(/\\/g, "/");
    readFileSync(file, "utf8").split(/\r?\n/).forEach((line, i) => {
      for (const m of line.matchAll(REF)) {
        const [, doc, num] = m;
        let ok;
        if (doc) {
          // Named its document: it must resolve THERE.
          ok = HEADINGS.get(`${doc}.md`)?.has(num);
        } else if (HEADINGS.has(rel)) {
          // Unqualified inside a numbered doc: its own space first, any second.
          ok = HEADINGS.get(rel).has(num) || ANY_HEADING.has(num);
        } else {
          ok = ANY_HEADING.has(num);
        }
        if (!ok) {
          dangling.push(`${rel}:${i + 1}  §${num}${doc ? ` (named ${doc}.md)` : ""}  -> ${line.trim().slice(0, 90)}`);
        }
      }
    });
  }

  assert.deepEqual(
    dangling,
    [],
    `A reference to a section that does not exist renders as plain text - nothing else will report it:\n  ${dangling.join("\n  ")}`,
  );
});

// GitHub's anchor rule: lowercase, drop anything that is not a letter, digit,
// space, hyphen or underscore, spaces -> hyphens, no truncation. Implemented
// here rather than shared with whatever produced the links, because a guard
// that reuses the buggy slug function it is checking reports zero dead links
// while 91 are dead - which is what happened.
function slug(heading) {
  return heading
    .replace(/`/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, "")
    .trim()
    .replace(/ /g, "-");
}

test("every markdown anchor link resolves to a heading", () => {
  const mdFiles = FILES.filter((f) => extname(f) === ".md");
  const anchorsOf = new Map();
  for (const file of mdFiles) {
    const rel = relative(ROOT, file).replace(/\\/g, "/");
    const set = new Set();
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = /^#{1,6}\s+(.*)$/.exec(line);
      if (m) set.add(slug(m[1]));
    }
    anchorsOf.set(rel, set);
  }

  const dead = [];
  for (const file of mdFiles) {
    const rel = relative(ROOT, file).replace(/\\/g, "/");
    readFileSync(file, "utf8").split(/\r?\n/).forEach((line, i) => {
      // [text](#anchor) and [text](OTHER.md#anchor)
      for (const m of line.matchAll(/\[[^\]]*\]\(([A-Za-z0-9._-]*)#([^)]+)\)/g)) {
        const target = m[1] === "" ? rel : m[1];
        const set = anchorsOf.get(target);
        if (!set) continue; // a file this test does not read is not its business
        if (!set.has(m[2])) dead.push(`${rel}:${i + 1}  ${target}#${m[2]}`);
      }
    });
  }

  assert.deepEqual(dead, [], `Dead anchors render as a link that goes nowhere:\n  ${dead.join("\n  ")}`);
});

test("every doc anchor the SPA links to still resolves", () => {
  // The app builds real links into the docs - docUrl('ADMIN.md') + '#1-...' -
  // and those are CLICKED BY LECTURERS. They are composed at runtime from a
  // base and a fragment, so the markdown check above cannot see them: splitting
  // RUNBOOK.md into three files silently broke four of them at once, each
  // landing on the top of the wrong document.
  const anchorsByDoc = new Map();
  for (const doc of DOCS) {
    const set = new Set();
    for (const line of readFileSync(join(ROOT, doc), "utf8").split(/\r?\n/)) {
      const m = /^#{1,6}\s+(.*)$/.exec(line);
      if (m) set.add(slug(m[1]));
    }
    anchorsByDoc.set(doc, set);
  }

  const broken = [];
  for (const file of FILES) {
    const rel = relative(ROOT, file).replace(/\\/g, "/");
    if (!rel.startsWith("frontend/src/")) continue;
    readFileSync(file, "utf8").split(/\r?\n/).forEach((line, i) => {
      // docUrl('ADMIN.md')}#1-onboarding-...  - the doc and the fragment sit on
      // one line, which is what makes this checkable at all.
      for (const m of line.matchAll(/docUrl\(\s*['"]([A-Za-z0-9._-]+\.md)['"]\s*\)\}#([a-z0-9][a-z0-9-]*)/g)) {
        const [, doc, anchor] = m;
        const set = anchorsByDoc.get(doc);
        if (!set) {
          broken.push(`${rel}:${i + 1}  links into ${doc}, which is not a document this test knows`);
        } else if (!set.has(anchor)) {
          broken.push(`${rel}:${i + 1}  ${doc}#${anchor} -> no such heading`);
        }
      }
    });
  }

  assert.deepEqual(
    broken,
    [],
    `A lecturer clicking these lands on the wrong page, and nothing else reports it:\n  ${broken.join("\n  ")}`,
  );
});
