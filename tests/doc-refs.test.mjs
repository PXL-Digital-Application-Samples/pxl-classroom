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

/**
 * Numbered sections a document declares.
 *
 * Two shapes, because the docs use two. ARCHITECTURE, RUNBOOK, ADMIN and
 * INSTALL number their headings ("### 4.3.2 Signed ..."). DESIGN numbers its
 * PRINCIPLES as an ordered list under a numbered heading, and the code cites
 * them that way - `DESIGN.md §1.2` means section 1, principle 2 - so a
 * heading-only reader would call every one of those dangling.
 */
function headingsOf(file) {
  const found = new Map();
  const add = (n) => found.set(n, (found.get(n) || 0) + 1);
  let section = null;
  for (const line of readFileSync(join(ROOT, file), "utf8").split(/\r?\n/)) {
    const h = /^#{1,6}\s+([0-9]+(?:\.[0-9a-z]+)*)[.)]?\s+\S/.exec(line);
    if (h) {
      add(h[1]);
      section = h[1].includes(".") ? null : h[1];
      continue;
    }
    const item = /^([0-9]+)\.\s+\*\*/.exec(line);
    if (item && section) add(`${section}.${item[1]}`);
  }
  return found;
}

const HEADINGS = new Map(DOCS.map((d) => [d, headingsOf(d)]));
const ANY_HEADING = new Set([...HEADINGS.values()].flatMap((s) => [...s.keys()]));
const FILES = walk(ROOT);

// Finding which document a reference names is done in TWO passes, not one
// regex. A single pattern with an optional leading doc name and a gap before
// the § is scanned left to right and matches at the earliest position that can
// reach the §, which is usually BEFORE the doc name - so `DESIGN.md §1.2` came
// back with no document and was checked against "does any document have a
// §1.2". RUNBOOK had one, so it passed while pointing at the wrong file.
const QUALIFIED = /\b(ARCHITECTURE|RUNBOOK|DESIGN|INSTALL|ADMIN|LESSONS)(?:\.md)?[ \t]+§/g;
const ANY_REF = /§([0-9]+(?:\.[0-9a-z]+)*)/g;

/** Every §-reference on a line, each tagged with the document it names. */
function refsOn(line) {
  const named = new Map(); // index of the "§" -> document
  for (const m of line.matchAll(QUALIFIED)) {
    named.set(m.index + m[0].length - 1, `${m[1]}.md`);
  }
  const out = [];
  for (const m of line.matchAll(ANY_REF)) {
    out.push({ num: m[1], doc: named.get(m.index) ?? null });
  }
  return out;
}

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
      for (const { num, doc } of refsOn(line)) {
        let ok;
        if (doc) {
          // Named its document: it must resolve THERE, not just somewhere.
          ok = HEADINGS.get(doc)?.has(num);
        } else if (HEADINGS.has(rel)) {
          // Unqualified inside a numbered doc: its own space first, any second.
          ok = HEADINGS.get(rel).has(num) || ANY_HEADING.has(num);
        } else {
          ok = ANY_HEADING.has(num);
        }
        if (!ok) {
          dangling.push(`${rel}:${i + 1}  §${num}${doc ? ` (named ${doc})` : ""}  -> ${line.trim().slice(0, 90)}`);
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

// The UI never points a user at this repository's documentation.
//
// RUNBOOK, ADMIN and INSTALL are written for whoever operates a deployment. A
// student who cannot sign in, or a lecturer whose dashboard will not load, is
// not that person: they cannot act on a section number, and half the time the
// procedure behind it is not even theirs to run. The sign-in card - the same
// one a student uses to accept an assignment - used to answer a misconfigured
// deployment by naming a build secret and an ARCHITECTURE section.
//
// So the rule is: a message says what happened and who can fix it, and if the
// reader should go somewhere it links there. Section numbers are a maintainer's
// index and they move; three files' worth moved in one afternoon.
//
// Developer comments are exempt and deliberately so - `// ARCHITECTURE §4.3.2`
// beside the code it constrains is how the reasoning stays attached to it.
const COMMENT_BLOCKS = [
  /<!--[\s\S]*?-->/g, // vue template
  /\/\*[\s\S]*?\*\//g, // js and css block
];

/** Strip comments so what is left is roughly what a user could be shown. */
function renderedText(source) {
  let text = source;
  for (const re of COMMENT_BLOCKS) text = text.replace(re, "");
  return text
    .split(/\r?\n/)
    // A line comment, but not the "//" inside a URL.
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");
}

test("no user-facing string points at this repository's documentation", () => {
  const DOC_NAME = /\b(?:ARCHITECTURE|RUNBOOK|ADMIN|INSTALL|DESIGN|LESSONS|OPEN-ITEMS)\.md\b/;
  const SECTION = /§/;

  const offenders = [];
  for (const file of FILES) {
    const rel = relative(ROOT, file).replace(/\\/g, "/");
    // The SPA, plus the module that writes System Health's messages.
    const isUi = rel.startsWith("frontend/src/") || rel === "lib/diagnostics.mjs";
    if (!isUi) continue;

    renderedText(readFileSync(file, "utf8")).split(/\r?\n/).forEach((line, i) => {
      if (DOC_NAME.test(line) || SECTION.test(line)) {
        offenders.push(`${rel}:${i + 1}  ${line.trim().slice(0, 110)}`);
      }
    });
  }

  assert.deepEqual(
    offenders,
    [],
    "A user cannot act on a documentation reference - say what happened and who can fix it:\n  " +
      offenders.join("\n  "),
  );
});
