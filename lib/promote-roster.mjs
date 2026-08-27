// PXL Classroom - promote accepted students onto the roster.
//
// Under `roster_mode: open` (exams, and anything whose cohort isn't known up
// front) nobody is on the roster and any GitHub account inside the window may
// accept. Who actually turned up is then recorded per assignment in
// `acceptances/<id>/<login>.json` and goes no further: `students/roster.yml` is
// written only by a CSV import, so the next assignment starts from the same
// blank roster and the lecturer either re-collects usernames by hand or runs
// `open` again. Promotion closes that loop - it turns the acceptances of one
// assignment into roster entries a later assignment can enforce against.
//
// Pure and dependency-free - no fs, no fetch, no Node builtins, no YAML - so
// the SPA, the CLI and workflow scripts plan identically and differ only in how
// they read the inputs and write the result. Serialisation is deliberately the
// caller's: both surfaces already hold the `yaml` package, and keeping it out
// of here is what lets the planner be tested under plain Node.
//
// Three rules this module exists to hold:
//
//   1. MERGE, NEVER REPLACE. A CSV import replaces the roster wholesale, which
//      is why it confirms before removing anybody. Promotion is additive: an
//      entry that already exists is returned untouched, so a student who
//      accepts cannot lose the student_number, full_name, class_group or team
//      columns the lecturer imported for them.
//   2. NEVER INVENT AN IDENTITY. Under `open` the system learned a GitHub login
//      and nothing else. Deriving a full_name from the login would put a
//      guess in the field a lecturer grades from, and a synthesised
//      student_number would collide with the institutional numbering the real
//      import uses. Promoted entries carry `source: "accepted"` instead, and
//      the schema's required-field rule keys off it.
//   3. NO TEAM DATA. lib/seed-teams.mjs deliberately does not write team_slug
//      to the roster: membership is per assignment, a roster record goes stale
//      the moment a student switches team, and a CSV re-import replaces the
//      file wholesale and would wipe it. Promotion must not reintroduce
//      through the back door what seeding refuses to write through the front.

import { ROSTER_PATH, ROSTER_SCHEMA_VERSION, rosterKey } from "./roster-entries.mjs";
import { normalizeRosterMode, rosterGatesAcceptance } from "./roster-mode.mjs";

export { ROSTER_PATH };

function lower(s) {
  return String(s ?? "").trim().toLowerCase();
}

/** "@a, @b, @c and 4 more" - a 200-student cohort must stay readable. */
function formatLogins(logins, max = 8) {
  const shown = logins.slice(0, max).map((l) => `@${l}`);
  const rest = logins.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.join(", ");
}

function emptyStats() {
  return {
    acceptances: 0,
    added: 0,
    already_on_roster: 0,
    skipped: 0,
    roster_total: 0,
  };
}

function refuse(errors, extra = {}) {
  return {
    ok: false,
    errors,
    warnings: [],
    nextRoster: null,
    added: [],
    alreadyOnRoster: [],
    skipped: [],
    stats: emptyStats(),
    ...extra,
  };
}

/**
 * Plan a promotion. Returns
 * `{ ok, errors, warnings, nextRoster, added, alreadyOnRoster, skipped, stats }`.
 *
 * `ok === false` means nothing may be written: the errors describe a roster the
 * planner refuses to guess about, not per-student hiccups. Warnings are
 * informational - the plan is still safe to apply.
 *
 * `changes` is deliberately NOT returned. The roster is YAML and this module
 * holds no serialiser; callers build
 * `[{ path: ROSTER_PATH, content: stringifyYaml(plan.nextRoster) }]`.
 *
 * @param {object}   opts
 * @param {object[]} opts.acceptances Acceptance records for ONE assignment.
 * @param {object|null} opts.roster   Parsed students/roster.yml, or null when absent.
 * @param {object}   opts.assignment  The assignment being promoted from.
 * @param {string}   opts.now         ISO timestamp stamped on promoted entries.
 * @param {string}   opts.actor       Who ran it.
 */
export function planPromotion({
  acceptances = [],
  roster = null,
  assignment = null,
  now = new Date().toISOString(),
  actor = "lecturer",
} = {}) {
  const errors = [];
  const warnings = [];
  const skipped = [];

  const assignmentId = assignment?.id;
  if (!assignmentId) {
    return refuse([{ code: "no-assignment", message: "no assignment given to promote from" }]);
  }

  // --- Refuse to guess about the roster's shape ---------------------------
  //
  // A roster that is absent is created. A roster the planner cannot read is
  // NOT overwritten: replacing a file whose contents we failed to understand
  // is how a hand-edited cohort gets deleted by a helper that meant well.

  let existingStudents = [];
  let rosterExisted = false;

  if (roster === null || roster === undefined) {
    warnings.push({
      code: "roster-created",
      message:
        `${assignment.title || assignmentId}'s organization has no ${ROSTER_PATH} yet - ` +
        `promoting creates it.`,
    });
  } else if (Array.isArray(roster)) {
    // The shape diagnostics Tier 3 flags: a hand-edited roster that is a bare
    // list of students. It parses, `roster.students` is undefined, and
    // accept.mjs's `roster?.students || []` therefore sees nobody. Rewriting it
    // into the object shape would be a fix, but it is not this command's fix to
    // make silently - the lecturer has to know their roster has been letting
    // nobody accept.
    errors.push({
      code: "roster-array-shaped",
      message:
        `${ROSTER_PATH} is a bare list of students, not a document with a "students:" key. ` +
        `Acceptance reads roster.students, so this roster currently lets nobody accept. ` +
        `Wrap it as "schema_version: 2" + "students:" before promoting.`,
    });
  } else if (typeof roster !== "object") {
    errors.push({
      code: "roster-not-an-object",
      message: `${ROSTER_PATH} did not parse into a document (got ${typeof roster}).`,
    });
  } else if (roster.students === null || roster.students === undefined) {
    // A scaffolded roster with the key omitted. Adding students is unambiguous.
    rosterExisted = true;
  } else if (!Array.isArray(roster.students)) {
    errors.push({
      code: "roster-students-not-a-list",
      message:
        `${ROSTER_PATH} has a "students" key that is not a list (got ${typeof roster.students}). ` +
        `Fix the file before promoting.`,
    });
  } else {
    rosterExisted = true;
    existingStudents = roster.students;
  }

  if (errors.length > 0) return refuse(errors);

  // --- Index what the roster already knows --------------------------------

  const knownLogins = new Set();
  for (const s of existingStudents) {
    if (!s || typeof s !== "object") continue;
    const login = lower(s.github_login);
    if (login) knownLogins.add(login);
  }

  // --- Normalise the acceptances ------------------------------------------

  const candidates = [];
  const seen = new Set();
  for (const record of acceptances || []) {
    if (!record || typeof record !== "object") {
      skipped.push({ login: null, reason: "malformed-record" });
      continue;
    }
    const login = String(record.github_login ?? "").trim();
    if (!login) {
      skipped.push({ login: null, reason: "no-login" });
      continue;
    }
    const key = lower(login);
    if (seen.has(key)) {
      // Same student twice in one assignment's acceptances - one file per login
      // makes this near-impossible, but a caller merging two assignments would
      // hit it and a duplicate roster entry is worse than a dropped one.
      skipped.push({ login, reason: "duplicate-acceptance" });
      continue;
    }
    seen.add(key);
    candidates.push({
      login,
      github_id: Number.isInteger(record.github_id) ? record.github_id : null,
      accepted_at: typeof record.accepted_at === "string" ? record.accepted_at : null,
    });
  }

  // --- Split into already-known and new -----------------------------------

  const alreadyOnRoster = [];
  const added = [];

  for (const cand of candidates) {
    if (knownLogins.has(lower(cand.login))) {
      // Rule 1. Untouched, deliberately: this entry may carry a student_number,
      // a full name and a class group that an acceptance record knows nothing
      // about, and "merge the fields we happen to have" is how those get
      // half-overwritten.
      alreadyOnRoster.push(cand.login);
      continue;
    }
    knownLogins.add(lower(cand.login));
    added.push({
      github_login: cand.login,
      ...(cand.github_id !== null ? { github_id: cand.github_id } : {}),
      source: "accepted",
      promoted_from: {
        assignment_id: assignmentId,
        ...(cand.accepted_at ? { accepted_at: cand.accepted_at } : {}),
        promoted_at: now,
        promoted_by: actor,
      },
    });
  }

  // Deterministic order, so promoting twice produces byte-identical YAML and
  // the second run has nothing to commit. Existing entries keep the lecturer's
  // ordering - reshuffling somebody else's roster is not promotion's business.
  added.sort((a, b) => lower(a.github_login).localeCompare(lower(b.github_login)));

  const nextRoster = {
    schema_version: (rosterExisted && roster.schema_version) || ROSTER_SCHEMA_VERSION,
    ...(rosterExisted ? withoutCoreKeys(roster) : {}),
    students: [...existingStudents, ...added],
  };

  // --- Warnings ------------------------------------------------------------

  // Only `enforced` implies everyone who accepted was on the roster, so only
  // there does a promoted student mean somebody was removed afterwards.
  const rosterMode = normalizeRosterMode(assignment.roster_mode);

  if (rosterGatesAcceptance(rosterMode) && added.length > 0) {
    // Everyone who accepted an enforced assignment passed the roster gate, so
    // a login that is not on the roster now was removed from it afterwards.
    // Re-adding is right - they hold a repository for this assignment - but
    // silently undoing a lecturer's removal is not.
    warnings.push({
      code: "readded-after-removal",
      message:
        `${added.length} student(s) accepted ${assignmentId} while it was roster-enforced but are ` +
        `no longer on the roster - they were removed after accepting. Promoting adds them back: ` +
        `${formatLogins(added.map((a) => a.github_login))}.`,
      logins: added.map((a) => a.github_login),
    });
  }

  if (assignment.assignment_type === "group" && added.length > 0) {
    // Said out loud because the acceptance records DO carry team_slug, so the
    // information visibly exists and its absence from the roster looks like a
    // bug rather than rule 3.
    warnings.push({
      code: "teams-not-promoted",
      message:
        `${assignmentId} is a group assignment. Team membership is not written to the roster - ` +
        `it belongs to the assignment, and a CSV re-import would wipe it. Carry teams forward ` +
        `with "teams seed" against the next assignment instead.`,
    });
  }

  if (candidates.length === 0) {
    warnings.push({
      code: "no-acceptances",
      message: `${assignmentId} has no acceptance records yet - nobody to promote.`,
    });
  } else if (added.length === 0) {
    warnings.push({
      code: "nothing-to-add",
      message:
        `All ${candidates.length} student(s) who accepted ${assignmentId} are already on the roster.`,
    });
  }

  if (skipped.length > 0) {
    warnings.push({
      code: "records-skipped",
      message:
        `${skipped.length} acceptance record(s) were skipped: ` +
        summariseSkips(skipped) + ".",
    });
  }

  return {
    ok: true,
    errors,
    warnings,
    nextRoster,
    added,
    alreadyOnRoster,
    skipped,
    stats: {
      acceptances: candidates.length,
      added: added.length,
      already_on_roster: alreadyOnRoster.length,
      skipped: skipped.length,
      roster_total: nextRoster.students.length,
    },
  };
}

// Carry through any sibling keys the roster document holds, so promotion never
// drops a field a future schema version adds. `schema_version` and `students`
// are set explicitly by the caller of this helper.
function withoutCoreKeys(roster) {
  const out = {};
  for (const [k, v] of Object.entries(roster)) {
    if (k === "schema_version" || k === "students") continue;
    out[k] = v;
  }
  return out;
}

function summariseSkips(skipped) {
  const counts = new Map();
  for (const s of skipped) counts.set(s.reason, (counts.get(s.reason) ?? 0) + 1);
  return [...counts.entries()].map(([reason, n]) => `${n} ${reason}`).join(", ");
}

/** Did this plan actually change anything? Nothing to add is nothing to commit. */
export function promotionChangesAnything(plan) {
  return !!plan?.ok && plan.added.length > 0;
}

/** One-line commit message for a plan. */
export function promoteCommitMessage(plan, { assignmentId }) {
  return `Promote ${plan.stats.added} accepted student(s) from ${assignmentId} onto the roster`;
}

/**
 * Roster keys the planner produced, for callers that want to show a diff.
 * Exported so a surface does not re-derive the identity rule.
 */
export function promotedKeys(plan) {
  return (plan?.added ?? []).map((s) => rosterKey(s));
}

/**
 * Fold claim bindings into the roster.
 *
 * The other direction from planPromotion, and deliberately a separate function
 * rather than a mode flag on it, because the operation is the opposite one.
 * Promotion ADDS entries for logins the roster has never heard of. Folding
 * UPDATES entries the roster already has: under `claim` the student was always
 * on the roster - matched by address - and what the claim adds is the GitHub
 * account, which is precisely the column the mode exists to avoid asking the
 * lecturer for up front.
 *
 * Why do it at all, when the claim already governs acceptance: it makes the
 * roster self-contained, so the NEXT assignment can run `enforced` against a
 * cohort whose usernames are now known, and so an exported CSV carries them.
 *
 * Rule 1 above still holds, in its sharper form: **a github_login the lecturer
 * already set is never overwritten.** A claim that disagrees with it is a
 * conflict (lib/claim-bindings.mjs), one of the two is wrong, and only a human
 * knows which - so it is reported for `unlink` rather than resolved by
 * whichever ran last.
 *
 * Rule 2 holds too: nothing else is copied off the claim. `email` is already
 * the join, and `claim_verified` is evidence about one acceptance rather than a
 * roster fact.
 *
 * @param {object} opts
 * @param {object[]} opts.claims  Claim records (students/claims/<github_id>.json).
 * @param {object|null} opts.roster Parsed students/roster.yml.
 */
export function planClaimPromotion({ claims = [], roster = null, now = new Date().toISOString(), actor = "lecturer" } = {}) {
  const errors = [];
  const warnings = [];

  // A claim can only exist because it matched a roster entry, so an absent or
  // unreadable roster here is not the "create it" case promotion has - it means
  // the roster went away underneath the bindings, and folding into a file we
  // would have to invent is exactly the guess this module refuses to make.
  if (roster === null || roster === undefined) {
    return refuse([{
      code: "no-roster",
      message: `${ROSTER_PATH} does not exist, so there are no entries to fold claims into. Import the roster first.`,
    }]);
  }
  if (Array.isArray(roster)) {
    return refuse([{
      code: "roster-array-shaped",
      message:
        `${ROSTER_PATH} is a bare list of students, not a document with a "students:" key. ` +
        `Acceptance reads roster.students, so this roster currently lets nobody accept. ` +
        `Wrap it as "schema_version: ${ROSTER_SCHEMA_VERSION}" + "students:" before folding claims into it.`,
    }]);
  }
  if (!Array.isArray(roster.students)) {
    return refuse([{
      code: "roster-unreadable",
      message: `${ROSTER_PATH} has no "students:" list, so there is nothing to fold claims into.`,
    }]);
  }

  const byEmail = new Map();
  for (const c of claims) {
    const email = lower(c?.email);
    // A duplicate address means two files bind one address - accept.mjs refuses
    // to create that, so it is a hand-edited or restored file. Folding either
    // one would pick a winner silently.
    if (!email || !c?.github_login) continue;
    if (byEmail.has(email)) {
      byEmail.set(email, "__ambiguous__");
      continue;
    }
    byEmail.set(email, c);
  }

  const updated = [];
  const unchanged = [];
  const conflicts = [];
  const ambiguous = [];

  const students = roster.students.map((entry) => {
    const claim = byEmail.get(lower(entry?.email));
    if (!claim) return entry;
    if (claim === "__ambiguous__") {
      ambiguous.push({ email: entry.email, full_name: entry.full_name ?? null });
      return entry;
    }

    const existing = lower(entry.github_login);
    if (existing && existing !== lower(claim.github_login)) {
      conflicts.push({
        email: entry.email,
        full_name: entry.full_name ?? null,
        roster_login: entry.github_login,
        claim_login: claim.github_login,
      });
      return entry;
    }
    if (existing) {
      unchanged.push(entry);
      return entry;
    }

    updated.push({ ...entry, github_login: claim.github_login, github_id: claim.github_id });
    return { ...entry, github_login: claim.github_login, github_id: claim.github_id };
  });

  if (conflicts.length) {
    warnings.push({
      code: "claim-conflicts",
      message:
        `${conflicts.length} claim(s) name a different account than the roster's own github_login ` +
        `(${formatLogins(conflicts.map((c) => c.claim_login))}). Left untouched - unlink the wrong one.`,
    });
  }
  if (ambiguous.length) {
    warnings.push({
      code: "claim-ambiguous",
      message: `${ambiguous.length} address(es) are claimed by more than one account and were left untouched.`,
    });
  }

  return {
    ok: true,
    errors,
    warnings,
    nextRoster: {
      schema_version: roster.schema_version ?? ROSTER_SCHEMA_VERSION,
      ...withoutCoreKeys(roster),
      students,
    },
    updated,
    unchanged,
    conflicts,
    ambiguous,
    // Recorded but unused by the plan itself, so a caller can show who ran it.
    meta: { now, actor },
    stats: {
      claims: claims.length,
      updated: updated.length,
      unchanged: unchanged.length,
      conflicts: conflicts.length,
      ambiguous: ambiguous.length,
      roster_total: students.length,
    },
  };
}

/** Nothing to write is nothing to commit. */
export function claimPromotionChangesAnything(plan) {
  return !!plan?.ok && plan.updated.length > 0;
}

export function claimPromoteCommitMessage(plan) {
  return `Fold ${plan.stats.updated} claim binding(s) into the roster`;
}
