// PXL Classroom - whether an assignment takes a NEW acceptance now, and why not.
//
// THE ONE JUDGE OF THE WINDOW. Three dates bound it: `opens_at`, from which a
// student may accept; `accepts_until`, after which nobody new may (optional,
// since 2026-11-03: a course whose invitation closes a week in while the work
// is due a week later); and `deadline_at`, the deadline for the work, which
// also closes acceptance where no `accepts_until` is set. Every assignment
// from before the field had that one window, opens_at..deadline_at, and keeps
// it: absent means the deadline.
//
// Before `accepts_until` the window was spelled by hand in ten places: the
// hub's gate, the status label, both student pages, the invitation share
// panel, the student's diagnostics dialog, the organization light (twice: the
// list's and the dashboard's), the team switch rule and the assignment page's
// Retry dialog. A third date added to ten spellings is a third date one of
// them misses, and a page that offers
// Accept where the hub refuses is the failure LESSONS.md records under "Stop
// accepting leaves a page offering an Accept button" - except that no save
// would heal this one. So the question is asked here and nowhere else, and
// tests/acceptance-window.test.mjs fails on a reader that spells it by hand.
//
// What the hub does with the answer is the hub's: `deadline-passed` and
// `acceptance-closed` both get the hour of grace for a request GitHub started
// late (lib/acceptance-reservation.mjs `actedInTime`), and only the deadline
// has a lock to ask about. Nothing else reads `accepts_until`: the sentinel,
// the lock, the archive, the grades and a student's extension are all the
// deadline's, and an extension never widens acceptance - the hub reads none
// for one (review 2026-10-14, T4).
//
// The comparisons are the ones the hub always made: `now < opens_at` is not
// open yet, `now > deadline_at` is passed, so the instant itself still
// accepts. A date that cannot be parsed counts as absent, as every reader
// did before - the editor refuses to save one, and failing closed here would
// turn a hand-edited `deadline_at: soon` into an assignment nobody can accept
// with no surface able to say why.
//
// Isomorphic and dependency-free: the SPA and the hub import it.

/** @typedef {"not-published"|"not-open"|"accepting"|"acceptance-closed"|"deadline-passed"} AcceptancePhase */

/** Every phase, for a reader that wants to be exhaustive. */
export const ACCEPTANCE_PHASES = Object.freeze([
  "not-published",
  "not-open",
  "accepting",
  "acceptance-closed",
  "deadline-passed",
]);

/** A parsed moment in ms, or null for absent and for what cannot be read. */
function momentOf(value) {
  if (typeof value !== "string" || !value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * When acceptance closes, as the document spells it: `accepts_until` where it
 * is set and not after the deadline, otherwise the deadline. Null where
 * neither is set or readable.
 *
 * @param {{accepts_until?: string|null, deadline_at?: string|null}|null|undefined} assignment
 * @returns {string|null}
 */
export function acceptanceClosesAt(assignment) {
  const until = momentOf(assignment?.accepts_until);
  const deadline = momentOf(assignment?.deadline_at);
  if (until === null && deadline === null) return null;
  if (until === null) return assignment.deadline_at;
  if (deadline === null || until <= deadline) return assignment.accepts_until;
  return assignment.deadline_at;
}

/**
 * The acceptance deadline as a surface may SHOW it: the document's
 * `accepts_until` where it is the date that closes acceptance, otherwise
 * null. A hand-edited one after the deadline is never reached and one that
 * cannot be read is no date at all, so neither is shown beside the deadline
 * as "Accept until" - which is what printing the field raw did.
 *
 * @param {{accepts_until?: string|null, deadline_at?: string|null}|null|undefined} assignment
 * @returns {string|null}
 */
export function acceptsUntilInForce(assignment) {
  const until = assignment?.accepts_until;
  if (typeof until !== "string" || momentOf(until) === null) return null;
  return acceptanceClosesAt(assignment) === until ? until : null;
}

/**
 * What the DATES say, whatever the state: where the schedule stands now.
 *
 * For a surface that asks about the dates of an assignment that is not
 * published - the state button of a closed one deciding between Reopen and
 * "move the date first", the Retry dialog saying which date it bypasses, the
 * diagnostics dialog naming a deadline that passed. A student's page asks
 * `acceptanceWindow` instead, which refuses anything not published first.
 *
 * The deadline is asked before the acceptance deadline, so past both it is
 * `deadline-passed`: that is the answer with a lock behind it, and the one the
 * lecturer's surfaces already name.
 *
 * @param {{opens_at?: string|null, accepts_until?: string|null, deadline_at?: string|null}|null|undefined} assignment
 * @param {number|Date} [now]
 * @returns {{ phase: Exclude<AcceptancePhase, "not-published">, at: string|null }}
 *   `at` is the date that decided it - when it opens, when acceptance closed,
 *   when the deadline passed - and for `accepting` the date acceptance will
 *   close on, null when nothing closes it. Always the document's own string,
 *   so a reader formats what the lecturer typed in the zone they chose.
 */
export function scheduledWindow(assignment, now = Date.now()) {
  const t = now instanceof Date ? now.getTime() : now;
  const opens = momentOf(assignment?.opens_at);
  if (opens !== null && t < opens) return { phase: "not-open", at: assignment.opens_at };
  const deadline = momentOf(assignment?.deadline_at);
  if (deadline !== null && t > deadline) return { phase: "deadline-passed", at: assignment.deadline_at };
  const until = momentOf(assignment?.accepts_until);
  if (until !== null && t > until) return { phase: "acceptance-closed", at: assignment.accepts_until };
  return { phase: "accepting", at: acceptanceClosesAt(assignment) };
}

/**
 * Where this assignment stands for a student who wants to accept NOW: the
 * state first (only a published assignment accepts), then the dates.
 *
 * @param {{state?: string|null, opens_at?: string|null, accepts_until?: string|null, deadline_at?: string|null}|null|undefined} assignment
 * @param {number|Date} [now]
 * @returns {{ phase: AcceptancePhase, at: string|null }} as `scheduledWindow`
 */
export function acceptanceWindow(assignment, now = Date.now()) {
  if (assignment?.state !== "published") return { phase: "not-published", at: null };
  return scheduledWindow(assignment, now);
}

/**
 * Whether the hub takes a new acceptance now.
 *
 * @param {Parameters<typeof acceptanceWindow>[0]} assignment
 * @param {number|Date} [now]
 */
export function isAccepting(assignment, now = Date.now()) {
  return acceptanceWindow(assignment, now).phase === "accepting";
}
