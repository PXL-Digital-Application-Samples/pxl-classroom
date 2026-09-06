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
