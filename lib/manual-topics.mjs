// PXL Classroom - the manual's topics, in one place.
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
// Adding a topic is two edits: a `## Title` section in MANUAL.md and a line
// here. The test tells you if you did one and not the other.
//
// THE SUMMARY IS THE `?` BUTTON'S TOOLTIP, and it is written here rather than
// lifted from the topic's first line. That is a second copy of one fact and it
// is a deliberate one: the tooltip has to be a single short sentence that reads
// well on hover, and a manual section's opening line is written to be read with
// the rest of the section under it. The two jobs are different enough that
// deriving one from the other would have made both worse.
//
// What the test CAN check, it does: every topic has a summary, one sentence,
// short enough to read in a tooltip. What no test can check is whether it is
// still true - so when you change what a topic describes, change this line.

/**
 * Every topic the manual declares, in the order it is written, with the
 * one-sentence summary its `?` button shows on hover.
 *
 * @type {ReadonlyArray<{id: string, summary: string}>}
 */
const TOPICS = Object.freeze([
  {
    id: "how-the-pieces-fit",
    summary: "How the roster, class groups, cohorts and teams relate.",
  },
  {
    id: "who-may-accept",
    summary: "Who is allowed to use the invitation link.",
  },
  {
    id: "who-is-this-assignment-for",
    summary: "Picking which students on your roster this assignment is for.",
  },
  {
    id: "confirming-an-email-address",
    summary: "Linking a student's GitHub account to their email address.",
  },
  {
    id: "late-work",
    summary: "What happens to work handed in after the deadline.",
  },
  {
    id: "deadlines-and-extensions",
    summary: "Setting the deadline and giving individual students more time.",
  },
  {
    id: "archiving",
    summary: "Keeping a copy of every submission before repositories change.",
  },
  {
    id: "group-assignments",
    summary: "Whether each student gets a repository, or a team shares one.",
  },
  {
    id: "autograding",
    summary: "Checks that score a student's work automatically.",
  },
  {
    id: "feedback-pull-requests",
    summary: "A pull request in each repository for leaving comments.",
  },
  {
    id: "adding-students-who-accepted",
    summary: "Putting students who accepted onto your roster.",
  },
  {
    id: "retiring-an-assignment",
    summary: "Closing an assignment and keeping a copy of the work.",
  },
]);

/**
 * Just the ids, which is what every existing caller wants.
 *
 * Derived rather than listed a second time: two hand-written lists of the same
 * ids is the shape that lets one gain a topic the other has never heard of.
 *
 * @type {ReadonlyArray<string>}
 */
export const MANUAL_TOPICS = Object.freeze(TOPICS.map((t) => t.id));

/** id -> one-sentence tooltip. @type {Readonly<Record<string, string>>} */
export const TOPIC_SUMMARIES = Object.freeze(
  Object.fromEntries(TOPICS.map((t) => [t.id, t.summary])),
);

/** @param {string} id */
export function isManualTopic(id) {
  return typeof id === "string" && MANUAL_TOPICS.includes(id);
}

/**
 * The tooltip for a topic, or "" when there is none.
 *
 * Empty rather than a guess: a `title` built from the id would render
 * "how-the-pieces-fit" at a lecturer, which is worse than no tooltip.
 *
 * @param {string} id
 */
export function topicSummary(id) {
  return TOPIC_SUMMARIES[id] ?? "";
}
