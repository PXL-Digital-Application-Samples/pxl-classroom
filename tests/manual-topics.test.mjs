// The manual and the buttons that open it, checked against each other.
//
// Three parties have to agree and none of them can see the others:
//
//   MANUAL.md               declares `## Title {#id}`
//   lib/manual-topics.mjs   lists the ids the UI is allowed to name
//   the .vue files          write <HelpButton topic="id" …>
//
// A renamed heading is a help button that opens nothing, and it fails the way
// absences always do here - silently, because a missing topic and a topic with
// no content look identical to whoever pressed the button.
//
// This file parses MANUAL.md with its OWN reader and never imports
// scripts/build-manual.mjs. A checker built from the transform it is checking
// validates its own bugs; if the build script's regex were wrong, importing it
// here would make both agree and both be wrong.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { MANUAL_TOPICS, TOPIC_SUMMARIES, isManualTopic, topicSummary } from "../lib/manual-topics.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = readFileSync(join(ROOT, "MANUAL.md"), "utf8");

/**
 * GitHub's heading slug, spelled out here rather than imported.
 *
 * tests/doc-refs.test.mjs makes the same choice for the same reason, and its
 * comment records what happened when it did not: a checker reusing the buggy
 * slug it was checking reported zero dead links while 91 were dead.
 */
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

/** Deliberately spelled out here rather than shared with the build script. */
function headingsInManual(md) {
  const out = [];
  for (const line of md.split(/\r?\n/)) {
    const m = /^##\s+(.+?)\s*$/.exec(line.trim());
    if (m) out.push({ title: m[1], id: slug(m[1]) });
  }
  return out;
}

/** Internal links: `[text](#id)`, including ones whose text wraps a line. */
function internalLinks(md) {
  return [...md.matchAll(/\[[^\]]+\]\(#([A-Za-z0-9][A-Za-z0-9-]*)\)/gs)].map((m) => m[1]);
}

const HEADINGS = headingsInManual(SRC);
const HEADING_IDS = HEADINGS.map((h) => h.id);

test("MANUAL.md actually declares topics", () => {
  // Without this the two set comparisons below both pass on an empty manual.
  assert.ok(HEADINGS.length >= 5, `only ${HEADINGS.length} topics found - is the {#id} syntax still right?`);
});

test("every registered topic has a heading in MANUAL.md", () => {
  const missing = MANUAL_TOPICS.filter((id) => !HEADING_IDS.includes(id));
  assert.deepEqual(missing, [], `registered but not written: ${missing.join(", ")}`);
});

test("every heading in MANUAL.md is registered", () => {
  const unregistered = HEADING_IDS.filter((id) => !MANUAL_TOPICS.includes(id));
  assert.deepEqual(unregistered, [], `written but not registered: ${unregistered.join(", ")}`);
});

test("no topic id is declared twice", () => {
  // Two headings with one id is a drawer that cannot say which it means, and
  // the build script exits non-zero on it. Caught here first, with the name.
  const seen = new Set();
  const dupes = HEADING_IDS.filter((id) => (seen.has(id) ? true : (seen.add(id), false)));
  assert.deepEqual(dupes, [], `duplicate topic ids: ${dupes.join(", ")}`);
});

test("internal links point at topics that exist", () => {
  // `[see this](#nope)` renders as a control that blanks the drawer, and as a
  // dead link for anyone reading MANUAL.md on github.com.
  //
  // tests/doc-refs.test.mjs checks the same thing across every .md file, but it
  // scans line by line, so a link whose text wraps across a newline slips past
  // it. This one reads the whole file, which is why it is not redundant.
  const dangling = internalLinks(SRC).filter((id) => !HEADING_IDS.includes(id));
  assert.deepEqual(dangling, [], `dangling internal links: ${dangling.join(", ")}`);
});

// ---------------------------------------------------------------- the UI side

const SKIP = new Set(["node_modules", "dist", ".git", "generated"]);

function vueFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) vueFiles(p, out);
    else if (entry.endsWith(".vue")) out.push(p);
  }
  return out;
}

/** `<HelpButton topic="who-may-accept" …>` - the only way the UI names a topic. */
const USAGE = /<HelpButton\b[^>]*\btopic="([^"]+)"/g;

function helpButtonUsages() {
  const found = [];
  for (const file of vueFiles(join(ROOT, "frontend", "src"))) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(USAGE)) {
      found.push({ file: relative(ROOT, file).replace(/\\/g, "/"), topic: m[1] });
    }
  }
  return found;
}

test("every HelpButton names a topic that exists", () => {
  const usages = helpButtonUsages();

  // Non-vacuity: if HelpButton is renamed or the attribute changes, the regex
  // above quietly matches nothing and this file would report clean over a UI
  // full of dead buttons. Fail instead, and say why.
  assert.ok(
    usages.length > 0,
    "no <HelpButton topic=\"…\"> found in frontend/src - either none ship, or this guard's pattern is stale",
  );

  const bad = usages.filter((u) => !isManualTopic(u.topic));
  assert.deepEqual(
    bad.map((u) => `${u.file} -> ${u.topic}`),
    [],
    "help buttons naming topics that do not exist",
  );
});

// --------------------------------------------------------------- the tooltips
//
// The summary is the `?` button's hover text, and it is HAND-WRITTEN beside the
// topic id rather than lifted from the topic's first line - a deliberate second
// copy, because a tooltip has to work alone in one short sentence and a
// section's opening line is written with the section under it.
//
// A second copy of a fact is the shape this repo keeps being bitten by, so
// everything that CAN be checked is. What cannot is whether the sentence is
// still true, and no test will ever tell you that.

test("every topic has a tooltip, and every tooltip has a topic", () => {
  // Both directions, like the ids above: a summary for an id nobody declares is
  // a line nothing renders, and an id with no summary is a `?` that reveals
  // nothing on hover while its neighbours do.
  const missing = MANUAL_TOPICS.filter((id) => !TOPIC_SUMMARIES[id]);
  assert.deepEqual(missing, [], "topics with no summary - their `?` shows no tooltip");

  const orphaned = Object.keys(TOPIC_SUMMARIES).filter((id) => !MANUAL_TOPICS.includes(id));
  assert.deepEqual(orphaned, [], "summaries for topics that do not exist");
});

test("a tooltip is ONE short sentence, because that is all a hover can carry", () => {
  const problems = [];
  for (const [id, summary] of Object.entries(TOPIC_SUMMARIES)) {
    if (summary !== summary.trim()) problems.push(`${id}: leading or trailing space`);
    if (/[\r\n]/.test(summary)) problems.push(`${id}: spans lines`);
    // A title attribute is not a paragraph. 90 characters is about what reads
    // in one glance beside a control.
    if (summary.length > 90) problems.push(`${id}: ${summary.length} chars, over 90`);
    if (summary.length < 15) problems.push(`${id}: ${summary.length} chars - too short to say anything`);
    // Two sentences means the second one is the part nobody reads.
    if (/[.!?]\s+\S/.test(summary)) problems.push(`${id}: more than one sentence`);
    if (!summary.endsWith(".")) problems.push(`${id}: does not end in a full stop`);
    // Markdown does not render in a title attribute - it renders as asterisks.
    if (/[*_`]/.test(summary)) problems.push(`${id}: carries markdown, which a tooltip shows literally`);
  }
  assert.deepEqual(problems, []);
});

test("topicSummary returns empty for an unknown id, never a guess", () => {
  // A `title` built from the id would render "how-the-pieces-fit" at a
  // lecturer, which is worse than no tooltip at all.
  assert.equal(topicSummary("no-such-topic"), "");
  assert.equal(topicSummary(undefined), "");
  assert.equal(topicSummary("how-the-pieces-fit").length > 0, true);
});
