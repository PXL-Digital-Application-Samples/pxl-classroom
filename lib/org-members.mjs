// PXL Classroom - planning organization invitations from the roster.
//
// `roster_mode: org_member` gates acceptance on ACTIVE organization membership,
// which turns a list of student email addresses into a gate: the lecturer
// invites the addresses, GitHub performs the email-to-account binding, and
// acceptance asks for the result. This module plans the invitations.
//
// Pure and dependency-free - no fs, no fetch, no Node builtins - so the CLI and
// the SPA plan identically and differ only in how they read the inputs and
// write the result. Same precedent as lib/seed-teams.mjs and
// lib/promote-roster.mjs.
//
// THE MATCHING PROBLEM, stated plainly because it shapes everything here:
// GitHub hands us members as LOGINS WITH NO EMAIL, and pending invitations as
// EMAILS WITH NO LOGIN (`login` is null even when GitHub has resolved the
// address to an account internally - measured live 2026-08-25). There is no
// join between them. So:
//
//   * a roster entry can be matched to a MEMBER only through `github_login`;
//   * a roster entry can be matched to a PENDING INVITATION only through
//     `email`;
//   * a student with an email and no github_login who is ALREADY a member
//     cannot be recognised as one, and will be planned for invitation.
//
// That last case is not a defect this module can fix, and it is why the caller
// must treat GitHub's 422 "already a part of this organization" as the outcome
// `already-member` rather than as an error. Inviting an existing member is
// harmless - it is refused server-side - but reporting it as a failure would
// make a re-run look broken.

/** How GitHub answers a re-invite of an address that already belongs to a member. */
export const ALREADY_MEMBER_MESSAGE = /already a part of this organization/i;

function lower(s) {
  return String(s ?? "").trim().toLowerCase();
}

function emailOf(student) {
  return lower(student?.email);
}

/** "a@x, b@y and 4 more" - a 200-student cohort has to stay readable. */
function formatEmails(emails, max = 6) {
  const shown = emails.slice(0, max);
  const rest = emails.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.join(", ");
}

function emptyStats() {
  return {
    roster: 0,
    to_invite: 0,
    already_member: 0,
    pending: 0,
    bounced: 0,
    skipped: 0,
  };
}

function refuse(errors) {
  return {
    ok: false,
    errors,
    warnings: [],
    toInvite: [],
    alreadyMember: [],
    pending: [],
    bounced: [],
    skipped: [],
    stats: emptyStats(),
  };
}

/**
 * Plan which roster students still need an organization invitation.
 *
 * @param {object}   opts
 * @param {object|null} opts.roster    Parsed students/roster.yml, or null when absent.
 * @param {object[]} opts.members      `GET /orgs/{org}/members` - logins, no emails.
 * @param {object[]} opts.pending      `GET /orgs/{org}/invitations` - emails, login null.
 * @param {object[]} opts.failed       `GET /orgs/{org}/failed_invitations`.
 * @param {string}   opts.org          For messages only.
 * @returns {{ok, errors, warnings, toInvite, alreadyMember, pending, bounced, skipped, stats}}
 */
export function planInvitations({
  roster = null,
  members = [],
  pending = [],
  failed = [],
  org = "the organization",
} = {}) {
  const warnings = [];

  // --- Refuse to guess about the roster's shape --------------------------
  //
  // Identical rules to lib/promote-roster.mjs, and for the same reason: a
  // roster we could not read is not a roster with nobody in it.
  if (roster === null || roster === undefined) {
    return refuse([
      {
        code: "no-roster",
        message: `${org} has no students/roster.yml, so there are no email addresses to invite. Import a roster first.`,
      },
    ]);
  }
  if (Array.isArray(roster)) {
    return refuse([
      {
        code: "roster-array-shaped",
        message:
          `students/roster.yml is a bare list of students, not a document with a "students:" key. ` +
          `Wrap it as "schema_version: 2" + "students:" before inviting.`,
      },
    ]);
  }
  if (typeof roster !== "object") {
    return refuse([{ code: "roster-not-an-object", message: `students/roster.yml did not parse into a document.` }]);
  }
  const students = roster.students ?? [];
  if (!Array.isArray(students)) {
    return refuse([
      { code: "roster-students-not-a-list", message: `students/roster.yml has a "students" key that is not a list.` },
    ]);
  }

  // --- Index what the organization already knows -------------------------

  const memberLogins = new Set(
    (members || []).map((m) => lower(typeof m === "string" ? m : m?.login)).filter(Boolean),
  );
  const pendingByEmail = new Map();
  for (const inv of pending || []) {
    const email = lower(inv?.email);
    if (email) pendingByEmail.set(email, inv);
  }
  const failedByEmail = new Map();
  for (const inv of failed || []) {
    const email = lower(inv?.email);
    if (email) failedByEmail.set(email, inv);
  }

  // --- Sort the roster ----------------------------------------------------

  const toInvite = [];
  const alreadyMember = [];
  const pendingOut = [];
  const bounced = [];
  const skipped = [];
  const seen = new Set();

  for (const s of students) {
    if (!s || typeof s !== "object") {
      skipped.push({ email: null, reason: "malformed-entry" });
      continue;
    }
    // An inactive student is off the course; inviting them would put them back
    // in the organization the roster says they left.
    if (s.active === false) {
      skipped.push({ email: emailOf(s) || null, login: s.github_login ?? null, reason: "inactive" });
      continue;
    }

    const email = emailOf(s);
    const login = lower(s.github_login);

    // Matched to a MEMBER only through github_login - members carry no email.
    if (login && memberLogins.has(login)) {
      alreadyMember.push({ email: email || null, github_login: s.github_login });
      continue;
    }

    if (!email) {
      skipped.push({
        email: null,
        login: s.github_login ?? null,
        reason: "no-email",
      });
      continue;
    }
    if (seen.has(email)) {
      skipped.push({ email, reason: "duplicate-email" });
      continue;
    }
    seen.add(email);

    // A bounced address will bounce again. Surfacing it separately is the only
    // way a lecturer learns the CSV has a typo in it.
    if (failedByEmail.has(email)) {
      bounced.push({
        email,
        github_login: s.github_login ?? null,
        reason: failedByEmail.get(email)?.failed_reason ?? null,
      });
      continue;
    }

    // Re-inviting a pending address is idempotent server-side (verified live:
    // the same invitation id comes back), but it is still a write against a
    // ~80/min secondary limit and it tells the lecturer nothing new.
    if (pendingByEmail.has(email)) {
      pendingOut.push({
        email,
        github_login: s.github_login ?? null,
        invitation_id: pendingByEmail.get(email)?.id ?? null,
        created_at: pendingByEmail.get(email)?.created_at ?? null,
      });
      continue;
    }

    toInvite.push({ email, github_login: s.github_login ?? null, full_name: s.full_name ?? null });
  }

  // Deterministic, so a dry run and the run that follows list the same order.
  toInvite.sort((a, b) => a.email.localeCompare(b.email));
  pendingOut.sort((a, b) => a.email.localeCompare(b.email));
  bounced.sort((a, b) => a.email.localeCompare(b.email));

  // --- Warnings -----------------------------------------------------------

  const noEmail = skipped.filter((s) => s.reason === "no-email");
  if (noEmail.length > 0) {
    warnings.push({
      code: "no-email",
      message:
        `${noEmail.length} roster student(s) have no email address and cannot be invited. ` +
        `Add the email column to your CSV and re-import.`,
      logins: noEmail.map((s) => s.login).filter(Boolean),
    });
  }

  if (bounced.length > 0) {
    warnings.push({
      code: "bounced",
      message:
        `${bounced.length} address(es) previously failed and will fail again - check them for typos: ` +
        formatEmails(bounced.map((b) => b.email)) + ".",
      emails: bounced.map((b) => b.email),
    });
  }

  // Cannot be detected, only warned about: a student with an email and no
  // github_login who is already a member is indistinguishable from one who is
  // not, because members carry no email.
  const unlinkedInvites = toInvite.filter((t) => !t.github_login).length;
  if (unlinkedInvites > 0 && memberLogins.size > 0) {
    warnings.push({
      code: "unverifiable-membership",
      message:
        `${unlinkedInvites} student(s) have an email but no github_login on the roster, so it cannot be ` +
        `checked whether they are already in ${org} - GitHub reports members without their email addresses. ` +
        `Any who already are will be refused by GitHub and reported as "already a member", which is not an error.`,
    });
  }

  if (toInvite.length === 0 && students.length > 0) {
    warnings.push({
      code: "nothing-to-invite",
      message: `Every roster student is already a member, already invited, or has no address to invite.`,
    });
  }

  return {
    ok: true,
    errors: [],
    warnings,
    toInvite,
    alreadyMember,
    pending: pendingOut,
    bounced,
    skipped,
    stats: {
      roster: students.length,
      to_invite: toInvite.length,
      already_member: alreadyMember.length,
      pending: pendingOut.length,
      bounced: bounced.length,
      skipped: skipped.length,
    },
  };
}

/**
 * Plan the cancellation of pending invitations.
 *
 * `only` restricts to specific addresses; without it every pending invitation
 * is planned. Cancelling is destructive from the student's point of view -
 * their link stops working - so the caller confirms.
 */
export function planCancellations({ pending = [], only = null } = {}) {
  const wanted = only ? new Set([...only].map(lower)) : null;
  const toCancel = [];
  const notFound = [];

  for (const inv of pending || []) {
    if (!inv || typeof inv.id !== "number") continue;
    const email = lower(inv.email);
    if (wanted && !wanted.has(email)) continue;
    toCancel.push({ id: inv.id, email: inv.email ?? null, login: inv.login ?? null });
  }

  if (wanted) {
    const have = new Set(toCancel.map((c) => lower(c.email)));
    for (const e of wanted) if (!have.has(e)) notFound.push(e);
  }

  toCancel.sort((a, b) => String(a.email).localeCompare(String(b.email)));
  return { toCancel, notFound };
}

/** Did GitHub refuse this invitation because the person is already in? */
export function isAlreadyMemberError(err) {
  const message =
    err?.response?.data?.errors?.map?.((e) => e?.message).join(" ") ??
    err?.errors?.map?.((e) => e?.message).join(" ") ??
    "";
  const top = err?.response?.data?.message ?? err?.message ?? "";
  return ALREADY_MEMBER_MESSAGE.test(`${message} ${top}`);
}
