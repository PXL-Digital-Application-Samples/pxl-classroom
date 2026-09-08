// What a lecturer reads where a report row carries a stored value.
//
// The assignment table printed the field straight into the cell, so the Status
// column read `on-time` / `no-submission` and the Acceptance column read
// `provisioned`. Lowercase and hyphenated: nobody writes that in a sentence,
// and `provisioned` in particular is a word only this codebase uses.
//
// DISPLAY ONLY. `lib/report-csv.mjs` exports the raw values and that column
// list is a contract with its own guard, so nothing here may reach an export or
// a filter - the data keeps its words and the screen gets these.
//
// ONE module because three surfaces render the same two fields: the student
// table, the card layout it collapses to on a phone, and TeamsTable. Three
// copies of a label map is how one of them ends up saying something the others
// do not.

/**
 * `submission_status`, whose enum lives in schemas/report.schema.json.
 *
 * `unknown` is a real state and keeps its own word: the collector could not
 * establish a commit date, which is not the same as nothing being handed in.
 */
export const SUBMISSION_LABELS = Object.freeze({
  "on-time": "On time",
  late: "Late",
  "no-submission": "No submission",
  unknown: "Unknown",
});

/**
 * `acceptance_state`, which is an acceptance record's `status` - enumerated in
 * schemas/acceptance.schema.json - or `not-accepted` where report.mjs found no
 * record at all.
 *
 * `provisioned` is "Repository ready" rather than "Provisioned" because the
 * fact a lecturer wants is that the student has somewhere to work, not that a
 * step ran. `provisioning` is the same sentence one moment earlier.
 */
export const ACCEPTANCE_LABELS = Object.freeze({
  accepted: "Accepted",
  provisioning: "Setting up",
  provisioned: "Repository ready",
  failed: "Setup failed",
  "not-accepted": "Not accepted",
});

/**
 * `score_source`, enumerated in schemas/grading-summary.schema.json: where a
 * grade's number actually came from.
 *
 * IT WAS WRITTEN AND NEVER READ. The schema's own description says why it
 * exists - "`conclusion` means no reporter annotation was found and the grade
 * is all-or-nothing, which is not the same kind of fact as a parsed score" -
 * the Admin Panel dutifully stored it, and no surface showed it. So a lecturer
 * saw `0/10` and could not tell a zero somebody measured from a grading job
 * that died before it reached the student's code.
 *
 * Both are real. Measured on pxl-classroom-testbed 2026-09-08: a Docker-based
 * grader that cannot build its image fails the whole job at BUILD time, before
 * `Checkout code`, and the check run concludes `failure` with no score
 * annotation - which parses as 0 out of the assignment's total, identical in
 * every visible respect to the student who genuinely scored nothing.
 *
 * `conclusion` is not always wrong, which is why the number is still shown: a
 * template workflow with no reporter in it is legitimately pass/fail, and green
 * there really is full marks. What a lecturer needs is to know which they are
 * looking at.
 */
export const SCORE_SOURCE_LABELS = Object.freeze({
  "annotation-json": "Reported by the grader",
  points: "Reported by the grader",
  conclusion: "From the run's outcome - no score was reported",
});

/** Whether a grade was measured, or inferred from whether the run went green. */
export function scoreWasReported(source) {
  return source === "annotation-json" || source === "points";
}

/**
 * An assignment's `state`, enumerated in schemas/assignment.schema.json.
 *
 * Four surfaces rendered this with a two-branch ternary - published and closed
 * named, everything else falling through to the stored value - so a lecturer
 * read `draft` and `archived`, and the assignment editor printed all four raw.
 * The student acceptance page and the student diagnostics dialog did it too,
 * which put a schema value in front of somebody who has never seen a schema.
 *
 * `published` is "Accepting" because that is the fact a reader wants: whether a
 * student can join right now. It is also what three of those four surfaces
 * already said, so this is the shared spelling rather than a new one.
 */
export const ASSIGNMENT_STATE_LABELS = Object.freeze({
  draft: "Draft",
  published: "Accepting",
  closed: "Closed",
  archived: "Archived",
});

/**
 * The label for a value, or the value itself when there is none.
 *
 * FALLING BACK TO THE RAW STRING IS DELIBERATE. A new state added upstream
 * would otherwise render as an empty cell, which reads as "nothing to report"
 * about a student the system has something to say about. An unlovely word is a
 * far better failure than a blank, and `tests/status-labels.test.mjs` fails
 * when a schema gains a value this file does not know.
 */
function label(map, value) {
  if (typeof value !== "string" || !value) return "";
  return map[value] ?? value;
}

/** @param {string|null|undefined} value */
export function submissionLabel(value) {
  return label(SUBMISSION_LABELS, value);
}

/** @param {string|null|undefined} value */
export function acceptanceLabel(value) {
  return label(ACCEPTANCE_LABELS, value);
}

/** @param {string|null|undefined} value */
export function assignmentStateLabel(value) {
  return label(ASSIGNMENT_STATE_LABELS, value);
}

/**
 * How a set of scores was produced.
 *
 * `github_actions` / `docker` / `host` are the schema's words for a machine, and
 * the panel used to print them raw after "via". They read as configuration
 * because they are. The phrases are written to sit inside a sentence about when
 * the reading happened, which is why they begin with a preposition.
 */
export const GRADING_RUNNER_LABELS = Object.freeze({
  github_actions: "from GitHub Actions",
  docker: "in Docker",
  host: "on the lecturer’s machine",
});

/** Display only; lib/report-csv.mjs still exports the stored word. */
export function gradingRunnerLabel(value) {
  return GRADING_RUNNER_LABELS[value] || (value ? `via ${value}` : "")
}
