// A markdown link points at something that exists.
//
// tests/doc-refs.test.mjs checks that an ANCHOR resolves to a heading, and does
// it well - but only within the five documents it reads, and it steps over
// anything else: `if (!set) continue; // a file this test does not read is not
// its business`. So the file half of a link has never been checked at all.
// `[the runbook](RUNOBOK.md)` renders as a working-looking link that 404s, with
// no build error and nothing to notice.
//
// That gap is cheap to live with while nothing moves, and expensive the moment
// something does - a rename, a reorganisation, a file folded into another. It
// is also the gap that decides whether reorganising the documentation is a
// mechanical change or a hopeful one.
//
// Two checks here, deliberately separate:
//   1. the target FILE exists
//   2. an anchor on ANOTHER file resolves in that file's headings
//
// The second is what doc-refs skips. Both are scoped to relative links -
// http(s) targets are somebody else's uptime, and this suite does not make
// network calls.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".tools", "dist", "test-results", "playwright-report",
  "coverage", "control-repo-template",
]);

function walkMarkdown(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkMarkdown(p, out);
    else if (extname(p) === ".md") out.push(p);
  }
  return out;
}

/** GitHub's heading slug. Spelled out rather than imported - see doc-refs.test.mjs. */
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

function headingsOf(file) {
  const set = new Set();
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^#{1,6}\s+(.*)$/.exec(line);
    if (m) set.add(slug(m[1]));
  }
  return set;
}

const FILES = walkMarkdown(ROOT);

/**
 * Blank out code, keeping every other character in place.
 *
 * Code is not prose and must not be read as prose. CLAUDE.md carries the
 * regex `^[A-Za-z0-9](-?[A-Za-z0-9]){0,38}$`, and the `](-?[A-Za-z0-9])` in the
 * middle of it is a perfectly good markdown link as far as a regex is
 * concerned - the first run of this guard duly reported a dead link to
 * `-?[A-Za-z0-9]`. A guard that cries wolf about documentation that is correct
 * teaches people to disable it.
 *
 * Replaced with spaces rather than removed, so the line numbers this reports
 * still point at the right line. Fenced blocks first: an inline-code pass over
 * a fence full of backticks pairs them wrongly and eats the prose between.
 */
function stripCode(src) {
  const blank = (m) => m.replace(/[^\n]/g, " ");
  return src
    .replace(/```[\s\S]*?```/g, blank)
    .replace(/~~~[\s\S]*?~~~/g, blank)
    .replace(/`[^`\n]*`/g, blank);
}

/**
 * Every `[text](target)` in the repo's markdown, with its source and line.
 *
 * Link text may wrap a line - prose does - so this reads whole files rather
 * than line by line, the same correction doc-refs needed. Reference-style
 * links and bare autolinks are not matched; neither is used here.
 */
function linksIn(file) {
  const src = stripCode(readFileSync(file, "utf8"));
  const out = [];
  for (const m of src.matchAll(/\[(?:[^\]]|\n(?!\s*\n))*\]\(([^)\s]+)\)/g)) {
    out.push({ target: m[1], line: src.slice(0, m.index).split(/\r?\n/).length });
  }
  return out;
}

/** Relative links only. Anchors-only (`#x`) are doc-refs' business, not ours. */
function relativeLinks(file) {
  return linksIn(file).filter(
    ({ target }) =>
      !/^[a-z][a-z0-9+.-]*:/i.test(target) && // http:, mailto:, etc
      !target.startsWith("#") &&
      !target.startsWith("//"),
  );
}

test("a link-shaped regex inside code is not read as a link", () => {
  // The false positive that shaped stripCode(), pinned so a later change to it
  // cannot quietly reintroduce the noise.
  const src = "Validated against `^[A-Za-z0-9](-?[A-Za-z0-9]){0,38}$` beside the write.\n";
  assert.equal(stripCode(src).includes("["), false);

  // And a fenced block, which must be blanked before inline code is considered.
  const fenced = "text\n```\n[not a link](nowhere.md)\n```\nmore\n";
  assert.equal(stripCode(fenced).includes("nowhere.md"), false);
  // Line count preserved, or every line number this file reports is wrong.
  assert.equal(stripCode(fenced).split("\n").length, fenced.split("\n").length);
});

test("the sweep actually found links to check", () => {
  // Non-vacuity. A regex that stops matching turns every assertion below into a
  // loop over nothing, which passes silently - the exact failure mode this file
  // exists to close.
  const total = FILES.reduce((n, f) => n + relativeLinks(f).length, 0);
  assert.ok(FILES.length > 5, `only ${FILES.length} markdown files found`);
  assert.ok(total > 40, `only ${total} relative markdown links found - has the link regex stopped matching?`);
});

test("every relative markdown link points at a file that exists", () => {
  const dead = [];
  for (const file of FILES) {
    const rel = relative(ROOT, file).replace(/\\/g, "/");
    for (const { target, line } of relativeLinks(file)) {
      const path = target.split("#")[0];
      if (!path) continue; // pure anchor, handled elsewhere
      const resolved = resolve(dirname(file), path);
      if (!existsSync(resolved)) dead.push(`${rel}:${line}  ->  ${target}`);
    }
  }
  assert.deepEqual(
    dead,
    [],
    `these links render as links and go nowhere:\n  ${dead.join("\n  ")}`,
  );
});

test("an anchor into another file resolves to a heading there", () => {
  // The half doc-refs skips. `[see](RUNBOOK.md#section-that-moved)` is the
  // failure a renumbering produces, and it looks identical to a working link.
  const headings = new Map();
  const dead = [];

  for (const file of FILES) {
    const rel = relative(ROOT, file).replace(/\\/g, "/");
    for (const { target, line } of relativeLinks(file)) {
      const [path, anchor] = target.split("#");
      if (!path || !anchor) continue;
      const resolved = resolve(dirname(file), path);
      if (extname(resolved) !== ".md" || !existsSync(resolved)) continue; // file check owns that
      if (!headings.has(resolved)) headings.set(resolved, headingsOf(resolved));
      if (!headings.get(resolved).has(anchor)) {
        dead.push(`${rel}:${line}  ->  ${target}`);
      }
    }
  }

  assert.deepEqual(
    dead,
    [],
    `these point at a section of another document that does not exist:\n  ${dead.join("\n  ")}`,
  );
});
