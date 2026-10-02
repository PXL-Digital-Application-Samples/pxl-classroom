// How an acceptance decides and saves WITHOUT a GitHub concurrency group.
//
// THE QUEUE WAS THE ONLY THING GUARDING A TEAM'S SIZE, AND IT WAS NOT A QUEUE.
// acceptance-handler.yml serialised every join to one team with
// `concurrency: accept-<org>-<id>-<team>`. GitHub keeps ONE pending run per
// group and the newest arrival cancels it, and a run that never gets a runner
// holds the group for up to 24 hours (timeout-minutes only counts a running
// job). On 2026-10-02 one join to PXL-2TIN-DevOps-2627's `fullhouse` sat
// queued from 10:13, and the seven joins to that team behind it each cancelled
// the one before - two students left in no team, their pages spinning, until
// somebody cancelled the stuck run by hand (LESSONS.md).
//
// So nothing here relies on scheduling. A run decides against the control
// repository as it is, saves that decision BEFORE it touches GitHub, and the
// save is a plain `git push` without a rebase - which GitHub refuses when
// somebody else pushed in between. Then the run looks at what that somebody
// changed: if it was anything the decision read, it decides again from the new
// state (the second decision may be "team full", and that is now an ordinary
// refusal); if not, its own commit is replayed on top. A git ref update is
// atomic, so two runs can never both commit "3 of 4 -> 4 of 4".
//
// Isomorphic, and imports nothing but the control-repo layout and the email
// normaliser, so the tests run it directly and the SPA can import it.

import { acceptancePath, acceptancesDir, teamsDir } from "./control-layout.mjs";
import { normalizeEmail } from "./normalize-email.mjs";

/**
 * What a decision commits, by outcome. EXHAUSTIVE on purpose: the test derives
 * every outcome accept.mjs can produce and requires each to be classified here,
 * because an outcome that writes and is committed by nobody is a green run with
 * no record - the failure tests/acceptance-outcome-persisted.test.mjs exists
 * for.
 *
 * - An admitted acceptance or confirmation commits everything it may write:
 *   the acceptance record, team manifests, and students/ (claim bindings and
 *   their attempt counters).
 * - A REFUSAL commits students/ alone - the attempt counter that makes the claim
 *   limit enforceable. Never acceptances/: a Retry removes the student's record
 *   from the checkout so the gates run again, and a refusal must leave that
 *   record exactly where it was (tests/retry-refusal-changes-nothing.test.mjs).
 * - `superseded` writes nothing: a newer attempt by the same student already
 *   decided, and this older one must not undo it.
 */
const ADMITTED = Object.freeze(["acceptances", "teams", "students"]);
const REFUSED = Object.freeze(["students"]);
const NOTHING = Object.freeze([]);

export const OUTCOME_PATHS = Object.freeze({
  accepted: ADMITTED,
  "already-accepted": ADMITTED,
  confirmed: ADMITTED,
  "already-confirmed": ADMITTED,
  superseded: NOTHING,
});

/** The outcome accept.mjs reports when a newer attempt has already decided. */
export const SUPERSEDED = "superseded";

/**
 * `decided_by_run_id` for a record a LECTURER changed - a move, an add or a
 * removal in the Teams tab (lib/team-member-records.mjs). No run has id 0, so
 * a student's run that is still provisioning sees the record is no longer its
 * own and writes nothing, instead of pointing the student back at the
 * repository of the team they were just moved out of.
 */
export const DECIDED_BY_LECTURER = "0";

/**
 * The control-repo directories a decision with this outcome commits, `[]` for
 * one that writes nothing, or null for an outcome nobody classified (and for
 * `fail:*`, which commits nothing because nothing it wrote is trustworthy).
 *
 * @param {string} outcome
 * @param {{persistRefusals?: boolean}} [opts] false on a lecturer's Retry,
 *   whose refusals were never counted against the student
 * @returns {readonly string[]|null}
 */
export function pathsToCommit(outcome, { persistRefusals = true } = {}) {
  if (typeof outcome !== "string" || !outcome) return null;
  if (outcome.startsWith("fail:")) return null;
  if (outcome.startsWith("rejected:")) return persistRefusals ? REFUSED : NOTHING;
  return Object.hasOwn(OUTCOME_PATHS, outcome) ? OUTCOME_PATHS[outcome] : null;
}

/**
 * Paths whose change cannot alter this student's decision. Everything else is
 * assumed to, which is the safe direction: deciding again costs a few seconds,
 * deciding on a stale read admits a fifth member to a team of four.
 *
 * - Other students' acceptance records: they feed `max_acceptances`, whose
 *   overshoot is a recorded decision (ARCHITECTURE §5.4,
 *   tests/acceptance-cap-decision.test.mjs) - re-deciding on them would turn a
 *   class-wide burst into every run re-deciding against every other, which is
 *   the serialisation that decision refused. They also feed `is_first_member`,
 *   which nothing consumes.
 * - repositories/, observations/, reports/: written after a decision, read by
 *   none.
 *
 * Note what is NOT here: teams/ (capacity, one team per student, a name already
 * taken), students/ (the roster, and every claim binding - first holder of an
 * address is decided across all of them), assignments/, overrides/ and
 * lockdowns/ (the window and the lock).
 */
const NEVER_INPUTS = ["repositories/", "observations/", "reports/"];

/**
 * Paths that are inputs only when their CONTENT concerns this student, and
 * which kind of question decides it. In a burst these are what everyone else
 * writes - in a group assignment every join rewrites a team manifest, under
 * `claim` every acceptance writes a binding - so treating each as an input
 * out: with ten runs contending and every write of theirs an input, roughly
 * one push in ten lands (an estimate from the shape, not a measurement), and
 * fifteen tries leave a few percent of a burst refused for nothing.
 *
 * - `team`: another team's manifest of this assignment. It matters when it is
 *   the team this decision placed the student in, or when it lists them
 *   (before or after) - one team per student. Any other team is somebody
 *   else's business.
 * - `claim`: another account's binding. It matters only when it holds the
 *   address this student's own binding holds (first holder of an address).
 * - `attempts`: another account's failed-attempt counter. Never this
 *   student's business; their OWN counter is `always`.
 *
 * @param {string} path
 * @param {{assignmentId: string, githubId?: string|number|null}} who
 * @returns {"team"|"claim"|"attempts"|null}
 */
export function contentDecides(path, { assignmentId, githubId = null }) {
  const own = githubId === null || githubId === undefined ? null : String(githubId);
  const teams = `${teamsDir(assignmentId)}/`;
  if (path.startsWith(teams) && !path.slice(teams.length).includes("/") && path.endsWith(".json")) return "team";
  const claim = /^students\/claims\/([0-9]+)\.json$/.exec(path);
  if (claim) return claim[1] === own ? null : "claim";
  const attempts = /^students\/claim-attempts\/([0-9]+)\.json$/.exec(path);
  if (attempts) return attempts[1] === own ? null : "attempts";
  return null;
}

/**
 * Did the commits that beat ours to the branch change anything our decision
 * read?
 *
 * @param {string[]} changedPaths repository-relative, forward slashes
 * @param {{assignmentId: string, login: string, githubId?: string|number|null}} who
 * @param {{concerns?: (path: string, kind: "team"|"claim") => boolean}} [opts]
 *   asked for a path whose CONTENT decides (contentDecides): does this version
 *   of it concern this student? Absent, every such path is an input - the
 *   safe direction, and what a caller that cannot read the contents gets.
 * @returns {boolean}
 */
export function decisionInputsChanged(changedPaths, { assignmentId, login, githubId = null }, { concerns } = {}) {
  const ownRecord = acceptancePath(assignmentId, String(login)).toLowerCase();
  const acceptancesOfThis = `${acceptancesDir(assignmentId)}/`;
  for (const raw of changedPaths || []) {
    const path = String(raw).trim().replace(/\\/g, "/");
    if (!path) continue;
    if (NEVER_INPUTS.some((p) => path.startsWith(p))) continue;
    if (path.startsWith(acceptancesOfThis) && path.toLowerCase() !== ownRecord) {
      // Another student's record for this assignment. A nested path is not a
      // record, and is treated as an input rather than guessed about.
      if (!path.slice(acceptancesOfThis.length).includes("/")) continue;
    }
    const kind = contentDecides(path, { assignmentId, githubId });
    if (kind === "attempts") continue;
    if (kind && concerns && !concerns(path, kind)) continue;
    return true;
  }
  return false;
}

/**
 * Does a team manifest, as one version of it reads, concern this decision?
 * Unreadable or malformed concerns it - never a guess that it does not.
 *
 * @param {string|null} text the file's content at that version; null if absent
 * @param {{login: string, teamSlug?: string|null, path: string}} args
 */
export function teamConcerns(text, { login, teamSlug = null, path }) {
  const slug = path.slice(path.lastIndexOf("/") + 1).replace(/\.json$/, "").toLowerCase();
  if (teamSlug && slug === String(teamSlug).toLowerCase()) return true;
  if (text === null) return false;
  try {
    const doc = JSON.parse(text);
    if (!Array.isArray(doc?.members)) return true;
    const me = String(login).toLowerCase();
    return doc.members.some((m) => String(m).toLowerCase() === me);
  } catch {
    return true;
  }
}

/**
 * Does another account's claim binding, as one version of it reads, hold the
 * address this student's own binding holds?
 *
 * @param {string|null} text the binding at that version; null if absent
 * @param {string|null} ownEmail the address this student's binding holds, or
 *   null when they hold none - then nobody else's binding is about them
 */
export function claimConcerns(text, ownEmail) {
  if (!ownEmail) return false;
  if (text === null) return false;
  try {
    const email = JSON.parse(text)?.email;
    if (typeof email !== "string") return true;
    // The same normaliser first-holder is decided with (lib/claim.mjs), so
    // "the same address" means here what it means there.
    return normalizeEmail(email) === normalizeEmail(ownEmail);
  } catch {
    return true;
  }
}

/**
 * Has a NEWER attempt by this student already been decided?
 *
 * The broker numbers attempts for us: every acceptance is an issue, and issue
 * numbers only grow. A run GitHub starts late - hours late, in an outage - must
 * not undo what the student did since: their join to `fullhouse` from 10:13
 * landing at 11:00, after they had switched to another team at 10:40, would
 * move them back.
 *
 * Only a DECIDED newer attempt supersedes. A newer issue that was never
 * processed (dropped by GitHub, refused by the broker) supersedes nothing, or a
 * phantom attempt would leave the student with neither.
 *
 * @param {{issue_number?: unknown}|null|undefined} storedAcceptance
 * @param {number|null} issueNumber this run's attempt; null for a lecturer's Retry
 */
export function supersededBy(storedAcceptance, issueNumber) {
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) return null;
  const stored = storedAcceptance?.issue_number;
  if (typeof stored !== "number" || !Number.isInteger(stored)) return null;
  return stored > issueNumber ? stored : null;
}

/**
 * How long after the deadline a request made BEFORE it is still honoured.
 *
 * GitHub sometimes starts a run late - minutes in a busy hour, longer in an
 * outage - and the student did nothing late: GitHub stamped their request when
 * they made it. One hour covers an ordinary incident without turning the
 * deadline into a suggestion.
 */
export const DEADLINE_GRACE_MS = 60 * 60 * 1000;

/**
 * Is a request the student made before the deadline still in time, although
 * the run deciding it started after?
 *
 * Every condition is needed:
 * - `actedAt` is GitHub's own `created_at` on the student's issue, read by the
 *   hub - never a value from the dispatch payload, which the broker controls.
 * - it is at or before the deadline, and not in the future (a clock that ran
 *   ahead is no evidence of anything);
 * - the run starts within DEADLINE_GRACE_MS of the deadline;
 * - the deadline's lock has not run. Lockdown and preservation work from the
 *   records that exist when they run, so a repository created after them would
 *   be the one nobody locked or archived. Once the lock record exists the
 *   ordinary refusal applies.
 *
 * @param {{deadline: Date, now: Date, actedAt: Date|null, lockRan: boolean}} args
 * @returns {boolean}
 */
export function actedInTime({ deadline, now, actedAt, lockRan }) {
  if (!(actedAt instanceof Date) || Number.isNaN(actedAt.getTime())) return false;
  if (!(deadline instanceof Date) || Number.isNaN(deadline.getTime())) return false;
  if (lockRan) return false;
  if (actedAt > now) return false;
  if (actedAt > deadline) return false;
  return now.getTime() - deadline.getTime() <= DEADLINE_GRACE_MS;
}

/**
 * A validated `created_at`, or null. Strict ISO 8601 UTC as GitHub writes it,
 * so nothing else can be mistaken for one.
 *
 * @param {unknown} value
 * @returns {Date|null}
 */
export function parseActedAt(value) {
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(s)) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * A validated issue number, or null.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
export function parseIssueNumber(value) {
  const s = String(value ?? "").trim();
  if (!/^[1-9][0-9]{0,9}$/.test(s)) return null;
  return Number(s);
}
