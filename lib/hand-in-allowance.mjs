// PXL Classroom - how many hand-ins one student may make.
//
// An assignment may cap hand-ins (`submission_marker.max_hand_ins`), because on
// a cloud exam every hand-in is a full deploy in the student's lab and ~25
// Actions minutes. A lecturer may raise the cap for one student, and the raise
// is recorded where every other per-student exception already is:
// `overrides/<assignment-id>/<login>.json`, an append-only list of entries each
// carrying a reason, who and when (ARCHITECTURE §5.2). Deadline extensions
// live there; this is the same document and the same rules.
//
// THE ENTRY STORES EXTRA HAND-INS, not a new total. "+2 for a crashed lab" is
// what the lecturer decided, and it has to keep meaning that if the
// assignment's own cap changes afterwards - an absolute 7 would silently become
// a reduction the day the cap went to 8.
//
// REVOKING IS AN ENTRY TOO: `value: 0` with its own reason. The list is
// append-only so that a grade dispute can read what was granted, when and by
// whom, and deleting the grant would erase exactly that. The LAST valid entry
// is the one in force, the rule `lib/effective-deadline.mjs` applies to
// extensions. It revokes the extra hand-ins only; a deadline extension granted
// alongside stays, because extensions only ever extend (that module).
//
// Dependency-free and isomorphic: the SPA, the CLI and the nightly all ask.

import { indexOverrides } from "./effective-deadline.mjs";
import { readMaxHandIns } from "./submission-marker.mjs";

export const HAND_IN_ALLOWANCE = "hand_in_allowance";

/** The most extra hand-ins one entry may grant. The schema says the same. */
export const MAX_EXTRA_HAND_INS = 50;

const norm = (login) => (typeof login === "string" ? login.toLowerCase() : "");

/**
 * The allowance entry in force in one override document, or null.
 *
 * `extra: 0` is a REVOKED allowance and is returned as one, not as null: a
 * surface that says "no exception" over a list that holds a grant and its
 * revocation is not telling the lecturer what happened. A malformed entry is
 * skipped rather than trusted, so a hand-edited file cannot erase a valid one.
 *
 * @returns {{extra: number, reason: string|null, by: string|null, at: string|null,
 *            history: number}|null}
 */
export function allowanceFrom(doc) {
  const entries = Array.isArray(doc?.overrides) ? doc.overrides : [];
  const valid = entries.filter(
    (e) =>
      e?.type === HAND_IN_ALLOWANCE &&
      Number.isInteger(e.value) &&
      e.value >= 0 &&
      e.value <= MAX_EXTRA_HAND_INS,
  );
  if (!valid.length) return null;
  const last = valid[valid.length - 1];
  return {
    extra: last.value,
    reason: last.reason ?? null,
    by: last.overridden_by ?? null,
    at: last.overridden_at ?? null,
    history: valid.length,
  };
}

/**
 * The cap that applies to `login`, or `limit: null` when nothing caps them.
 *
 * For a group assignment the team shares one repository and so one count, and
 * the most generous allowance among its members applies to all of them - the
 * rule `effectiveDeadlineFor` applies to extensions, for the same reason:
 * capping the repository at anyone else's number would refuse the hand-in of
 * the student who was granted more.
 *
 * @param {{maxHandIns?: number|null, multiple?: boolean}|null} marker  readSubmissionMarker()
 * @param {string} login
 * @param {{overrides?: Map|Array, team?: {members?: string[]}}} [context]
 * @returns {{limit: number|null, base: number|null, extra: number,
 *            grantedTo: string|null, allowance: object|null}}
 */
export function handInLimitFor(marker, login, { overrides, team } = {}) {
  const base = marker && marker.multiple !== false ? readMaxHandIns(marker.maxHandIns) : null;
  if (base == null) return { limit: null, base: null, extra: 0, grantedTo: null, allowance: null };

  // Rebuilt from the documents rather than trusting a Map's keys: the SPA keys
  // its map by whatever spelling the row carried, and a login is compared
  // lowercased (lib/github-login.mjs).
  const index = indexOverrides(overrides instanceof Map ? [...overrides.values()] : overrides);

  const logins = new Set();
  if (login) logins.add(norm(login));
  for (const m of team?.members || []) if (m) logins.add(norm(m));

  let best = null;
  let grantedTo = null;
  for (const l of logins) {
    const a = allowanceFrom(index.get(l));
    if (!a || a.extra <= 0) continue;
    if (!best || a.extra > best.extra) {
      best = a;
      grantedTo = l;
    }
  }
  // Their OWN entry, revoked or not, when no teammate's grant is in force -
  // so the dialog can say "revoked by X" rather than "no exception".
  const own = allowanceFrom(index.get(norm(login)));
  const extra = best ? best.extra : 0;
  return { limit: base + extra, base, extra, grantedTo, allowance: best || own };
}

/**
 * The entry a grant or a revocation appends. `by` is the lecturer's login -
 * "admin-panel" said which surface wrote it and not who, which is the question
 * a dispute asks.
 */
export function allowanceEntry({ extra, reason, by, at = new Date().toISOString() }) {
  return {
    type: HAND_IN_ALLOWANCE,
    value: extra,
    reason: String(reason ?? "").trim(),
    overridden_by: by,
    overridden_at: at,
  };
}

/**
 * Why a grant cannot be written, or null. The dialog and the handler both ask
 * this, so the disabled button and the refusal cannot disagree.
 */
export function allowanceProblem({ extra, reason }) {
  if (!String(reason ?? "").trim()) return "A reason is required.";
  const n = typeof extra === "string" && extra.trim() !== "" ? Number(extra) : extra;
  if (!Number.isInteger(n) || n < 1) return "Extra hand-ins must be a whole number of at least 1.";
  if (n > MAX_EXTRA_HAND_INS) return `At most ${MAX_EXTRA_HAND_INS} extra hand-ins.`;
  return null;
}
