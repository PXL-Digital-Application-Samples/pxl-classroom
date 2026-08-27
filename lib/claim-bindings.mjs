// Who is bound to whom, and what a lecturer can do about it.
//
// A claim is one file per student at `students/claims/<github_id>.json`
// (lib/claim.mjs). The roster is a separate document. Neither points at the
// other: the join is the EMAIL ADDRESS, case-insensitively, exactly as
// `rosterEntryForEmail` joins it in the other direction when a student claims.
//
// That join is about to be written on four surfaces at once - the Roster tab's
// binding column, `pxl-classroom roster list`, the unclaimed diagnostic, and
// `roster promote` folding claims into the roster - which is precisely the
// shape that forked `diffRosters` into two implementations that disagreed on
// key order, and `deadline` into three that disagreed on which extension wins.
// So it is written once, here, dependency-free and isomorphic, and
// `tests/claim-bindings.test.mjs` fails if any consumer grows its own copy.
//
// The states are deliberately finer than "bound / not bound", because the
// lecturer actions differ and a column that collapses them is a column that
// cannot be acted on:
//
//   claimed      a claim record binds this entry. Nothing to do.
//   roster       no claim, but the roster carries a github_login. Under
//                `enforced` that IS the binding; under `claim` it is a
//                lecturer who pre-linked, which still works.
//   unclaimed    has an address, nobody has claimed it. The normal waiting
//                state early in a course, and the thing to chase late in one.
//   unclaimable  no email on the roster entry at all, so it can NEVER be
//                claimed - `rosterEntryForEmail` matches on email and nothing
//                else. Distinct from `unclaimed` because the fix is different:
//                re-import the roster with an address, not wait.
//   conflict     a claim binds this address to a DIFFERENT account than the
//                roster's github_login. First-come-wins means this is reachable
//                (ARCHITECTURE §15: two students sharing a mailbox, or a wrong
//                address typed), and it is the exact case `unlink` exists for.
//
// `conflict` is why this module exists rather than a boolean. GitHub Classroom's
// mistake was making a wrong binding unfixable; a wrong binding you cannot SEE
// is the same mistake one step earlier.

import { normalizeEmail } from "./claim.mjs";

export const BINDING_STATES = Object.freeze({
  CLAIMED: "claimed",
  ROSTER: "roster",
  UNCLAIMED: "unclaimed",
  UNCLAIMABLE: "unclaimable",
  CONFLICT: "conflict",
});

/** Logins compare case-insensitively, exactly as accept.mjs's roster gate does. */
function sameLogin(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function rosterLogin(entry) {
  const value = entry?.github_login;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Index a list of claim records by the address they bind.
 *
 * Later records do not overwrite earlier ones: a duplicate address across two
 * files is a real fault (accept.mjs refuses to create one - `rejected:claim-taken`
 * - so it means a hand-edited or restored file), and silently keeping whichever
 * happened to be read last would hide it. Both are kept and reported.
 *
 * @param {Array<object>} claims
 * @returns {{byEmail: Map<string, object>, duplicates: Array<{email: string, claims: Array<object>}>}}
 */
export function indexClaims(claims) {
  const byEmail = new Map();
  const collisions = new Map();

  for (const claim of Array.isArray(claims) ? claims : []) {
    const email = normalizeEmail(claim?.email);
    if (!email) continue;
    if (byEmail.has(email)) {
      const list = collisions.get(email) || [byEmail.get(email)];
      list.push(claim);
      collisions.set(email, list);
      continue;
    }
    byEmail.set(email, claim);
  }

  return {
    byEmail,
    duplicates: [...collisions.entries()].map(([email, list]) => ({ email, claims: list })),
  };
}

/**
 * The binding state of one roster entry.
 *
 * @param {object} entry roster entry
 * @param {{byEmail: Map<string, object>}} index from indexClaims
 * @returns {{state: string, claim: object|null, login: string|null, verified: boolean, rosterLogin: string|null}}
 */
export function bindingForEntry(entry, index) {
  const email = normalizeEmail(entry?.email);
  const onRoster = rosterLogin(entry);
  const claim = email ? index?.byEmail?.get(email) ?? null : null;

  if (claim) {
    const claimed = typeof claim.github_login === "string" ? claim.github_login : null;
    // A claim whose account disagrees with the roster's own github_login. The
    // claim is what actually governs acceptance, so it is reported as the
    // binding - and flagged, because one of the two is wrong and only a human
    // knows which.
    const state = onRoster && !sameLogin(onRoster, claimed) ? BINDING_STATES.CONFLICT : BINDING_STATES.CLAIMED;
    return {
      state,
      claim,
      login: claimed,
      verified: Boolean(claim.claim_verified),
      rosterLogin: onRoster,
    };
  }

  if (onRoster) {
    return { state: BINDING_STATES.ROSTER, claim: null, login: onRoster, verified: false, rosterLogin: onRoster };
  }

  // No address means no claim is possible, ever - a different problem from
  // nobody having claimed yet, and a different fix.
  const state = email ? BINDING_STATES.UNCLAIMED : BINDING_STATES.UNCLAIMABLE;
  return { state, claim: null, login: null, verified: false, rosterLogin: null };
}

/**
 * Every roster entry with its binding, in roster order.
 *
 * @param {object} roster parsed students/roster.yml
 * @param {Array<object>} claims
 * @returns {Array<{entry: object, binding: object}>}
 */
export function rosterBindings(roster, claims) {
  const index = indexClaims(claims);
  const students = Array.isArray(roster?.students) ? roster.students : [];
  return students.map((entry) => ({ entry, binding: bindingForEntry(entry, index) }));
}

/**
 * Claims that match no roster entry.
 *
 * Never deleted automatically. A student removed from the roster mid-course,
 * a roster re-imported without an address column, an address corrected in the
 * CSV - all land here, and all are a lecturer's decision (ARCHITECTURE §15:
 * "Claim orphaned - reported, never silently deleted").
 *
 * @returns {Array<object>} the orphaned claim records
 */
export function orphanClaims(roster, claims) {
  const students = Array.isArray(roster?.students) ? roster.students : [];
  const addresses = new Set(students.map((s) => normalizeEmail(s?.email)).filter(Boolean));
  return (Array.isArray(claims) ? claims : []).filter((c) => {
    const email = normalizeEmail(c?.email);
    return email ? !addresses.has(email) : true;
  });
}

/**
 * Counts for a diagnostic or a header line.
 *
 * `bound` is what a lecturer means by "how many of my students are connected":
 * claimed plus pre-linked, because both can accept. `conflicts` is counted
 * separately rather than folded into either - it is bound AND wrong, and
 * averaging it into a healthy number is how it stops being chased.
 */
export function claimSummary(roster, claims) {
  const rows = rosterBindings(roster, claims);
  const count = (state) => rows.filter((r) => r.binding.state === state).length;
  const claimed = count(BINDING_STATES.CLAIMED);
  const conflicts = count(BINDING_STATES.CONFLICT);
  const preLinked = count(BINDING_STATES.ROSTER);
  return {
    students: rows.length,
    claimed,
    conflicts,
    pre_linked: preLinked,
    unclaimed: count(BINDING_STATES.UNCLAIMED),
    unclaimable: count(BINDING_STATES.UNCLAIMABLE),
    bound: claimed + conflicts + preLinked,
    orphans: orphanClaims(roster, claims).length,
    duplicates: indexClaims(claims).duplicates.length,
  };
}

/**
 * One line describing a binding, for a CLI column or a title attribute.
 *
 * Never "undefined undefined" - the failure `describeRosterEntry` shipped for
 * promoted entries, which have no student_number and no full_name.
 */
export function describeBinding(binding) {
  switch (binding?.state) {
    case BINDING_STATES.CLAIMED:
      return `@${binding.login}${binding.verified ? "" : " (unverified)"}`;
    case BINDING_STATES.CONFLICT:
      return `@${binding.login} != roster @${binding.rosterLogin}`;
    case BINDING_STATES.ROSTER:
      return `@${binding.login} (from roster)`;
    case BINDING_STATES.UNCLAIMABLE:
      return "no email on roster";
    default:
      return "not claimed";
  }
}
