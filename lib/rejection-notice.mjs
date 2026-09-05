// WHO WAS TURNED AWAY, AND WHY - read back out of the tracking issue.
//
// A rejection is an outcome, not a failure: `accept.mjs` exits 0 for every
// `rejected:*` so a student who is not on the roster does not paint the hub's
// Actions tab red. It is announced to the lecturer by `acceptance-handler.yml`,
// as a comment on the control repo's instructor tracking issue - and that was
// the whole of it. The Admin Panel showed nothing, so an assignment refusing
// exactly the people it was configured to refuse looked identical, on screen,
// to a broken invitation link.
//
// PARSED FROM THE DEDUP KEY, NOT FROM THE PROSE. Every rejection comment
// carries `<!-- pxl-dedup:reject-<assignment>-<login>-<outcome>-->`, which the
// notifier already relies on for exactness - two comments dedupe only when the
// key matches byte for byte - so it is the one part of that comment which
// cannot drift without something else breaking first. The sentence beside it is
// for a human and may be reworded at any time.
//
// The key is BUILT here too, so the workflow's spelling and this reader's are
// derived from one function rather than written twice.
// `tests/rejection-notice.test.mjs` checks the literal in
// `.github/workflows/acceptance-handler.yml` against what this produces: a
// dedup key spelled one way and matched another is a panel that silently shows
// nothing, which is the state this module exists to end.
//
// Isomorphic and dependency-free: the SPA reads it through
// `frontend/src/lib/rejection-notice.js`.

/** The marker `notify.mjs` writes ahead of a deduplicated comment. */
export const DEDUP_MARKER = "<!-- pxl-dedup:";

/** The label and issue the tracking issue is found by. */
export const TRACKING_LABEL = "pxl-tracking";

/**
 * The dedup key for one refused acceptance.
 *
 * @param {{assignmentId: string, login: string, outcome: string}} args
 * @returns {string}
 */
export function rejectionDedupKey({ assignmentId, login, outcome }) {
  return `reject-${assignmentId}-${login}-${outcome}`;
}

/**
 * Pull `{login, outcome}` out of a dedup key for a KNOWN assignment.
 *
 * Knowing the assignment is what makes this unambiguous. Both an assignment id
 * and a GitHub login may contain `-`, so `reject-a-b-c-rejected:x` cannot be
 * split by counting dashes - but the caller is always looking at one
 * assignment's page, so the prefix is known exactly and what remains splits at
 * the last `-rejected:`.
 *
 * @param {string} key
 * @param {string} assignmentId
 * @returns {{login: string, outcome: string}|null}
 */
export function parseRejectionDedupKey(key, assignmentId) {
  if (typeof key !== "string" || typeof assignmentId !== "string" || !assignmentId) return null;
  const prefix = `reject-${assignmentId}-`;
  if (!key.startsWith(prefix)) return null;
  const rest = key.slice(prefix.length);
  const at = rest.lastIndexOf("-rejected:");
  if (at <= 0) return null;
  const login = rest.slice(0, at);
  const outcome = rest.slice(at + 1);
  if (!login || !outcome.startsWith("rejected:")) return null;
  return { login, outcome };
}

/**
 * What a lecturer should read for each `rejected:*`.
 *
 * Plain language, and it says what to DO where there is something to do. The
 * raw outcome is kept beside it because it is what the workflow log and the
 * control repo record say, and a lecturer chasing one student should be able to
 * match them up.
 */
const REASONS = Object.freeze({
  // Who they are
  "rejected:not-on-roster": "not on the roster",
  "rejected:not-in-cohort": "not in this assignment",
  "rejected:no-roster": "no roster imported yet",
  // Proving who they are, under `claim`
  "rejected:no-claim": "no confirmed email address",
  "rejected:no-claim-match": "address is not on the roster",
  "rejected:claim-taken": "address already claimed by another account",
  "rejected:claim-domain": "address outside the allowed domains",
  "rejected:claim-blocked": "too many failed attempts",
  // When they tried
  "rejected:not-open": "before the assignment opened",
  "rejected:past-deadline": "after the deadline",
  "rejected:not-published": "the assignment was not published",
  "rejected:no-assignment": "the assignment no longer exists",
  "rejected:cap-reached": "the acceptance cap was full",
  // Teams. Every one of these is a group assignment refusing a team decision,
  // and they are the reasons a lecturer is most likely to have to act on -
  // "no assigned team" is a student the seed missed.
  "rejected:no-assigned-team": "no team assigned to them",
  "rejected:team-not-assigned": "tried to join a team they were not assigned",
  "rejected:no-team": "did not name a team",
  "rejected:invalid-team-slug": "team name is not usable",
  "rejected:team-full": "the team was already full",
  "rejected:team-creation-disabled": "tried to create a team, which is switched off",
});

/**
 * A human label for an outcome, never a guess.
 *
 * An unrecognised `rejected:*` keeps its own spelling rather than being
 * described as something it might be - a new refusal reason should read as
 * unfamiliar rather than be quietly folded into the nearest known one.
 */
export function rejectionReason(outcome) {
  return REASONS[outcome] || String(outcome || "").replace(/^rejected:/, "").replace(/-/g, " ");
}

/**
 * Group a tracking issue's comments into this assignment's refusals.
 *
 * ONE ROW PER STUDENT PER REASON, which is what the dedup key already
 * guarantees: a student retrying the same closed door updates one comment
 * rather than adding another, so counting comments counts distinct refusals.
 * A student refused twice for two different reasons appears twice, correctly -
 * "not on the roster" and later "cap reached" are two different things to fix.
 *
 * @param {Array<{body?: string}>|unknown} comments
 * @param {string} assignmentId
 * @returns {Array<{outcome: string, reason: string, logins: string[]}>} most refusals first
 */
export function rejectionsForAssignment(comments, assignmentId) {
  const byOutcome = new Map();
  for (const c of Array.isArray(comments) ? comments : []) {
    const body = typeof c?.body === "string" ? c.body : "";
    const at = body.indexOf(DEDUP_MARKER);
    if (at < 0) continue;
    const end = body.indexOf("-->", at);
    if (end < 0) continue;
    const key = body.slice(at + DEDUP_MARKER.length, end);
    const parsed = parseRejectionDedupKey(key, assignmentId);
    if (!parsed) continue;
    const row = byOutcome.get(parsed.outcome) || {
      outcome: parsed.outcome,
      reason: rejectionReason(parsed.outcome),
      logins: [],
    };
    if (!row.logins.includes(parsed.login)) row.logins.push(parsed.login);
    byOutcome.set(parsed.outcome, row);
  }
  return [...byOutcome.values()].sort(
    (a, b) => b.logins.length - a.logins.length || a.outcome.localeCompare(b.outcome),
  );
}

/** How many distinct students were turned away, across every reason. */
export function rejectionCount(rows) {
  const seen = new Set();
  for (const r of Array.isArray(rows) ? rows : []) {
    for (const l of r.logins || []) seen.add(l);
  }
  return seen.size;
}
