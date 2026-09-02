// PXL Classroom - the manual's topic ids, in one place.
//
// The UI names a topic by id when it opens the help drawer; MANUAL.md's ids are
// GitHub's own slugs of its `## ` headings, so one anchor works both in the app
// and for anyone reading the file on github.com. Neither side knows about the
// other, so without a registry a renamed heading is a help button that opens
// nothing - silently, because a missing topic looks exactly like a topic with
// no content.
//
// Deriving ids from headings is only safe BECAUSE of this file. Rename a
// heading and its slug changes; the test below then reports the old id as
// registered-but-not-written and the new one as written-but-not-registered,
// which is the rename staring you in the face rather than a dead button.
//
// `tests/manual-topics.test.mjs` checks BOTH directions against MANUAL.md: every
// id here has a heading, and every heading has an id here. It parses the
// markdown itself rather than importing the build script, so the guard cannot
// be satisfied by a parser bug it shares.
//
// Adding a topic is two edits: a `## Title {#id}` section in MANUAL.md and a
// line here. The test tells you if you did one and not the other.

/**
 * Every topic the manual declares, in the order it is written.
 *
 * @type {ReadonlyArray<string>}
 */
export const MANUAL_TOPICS = Object.freeze([
  "who-may-accept",
  "late-work",
  "deadlines-and-extensions",
  "archiving",
  "group-assignments",
  "automated-checks",
  "feedback-pull-requests",
  "adding-students-who-accepted",
  "retiring-an-assignment",
]);

/** @param {string} id */
export function isManualTopic(id) {
  return typeof id === "string" && MANUAL_TOPICS.includes(id);
}
