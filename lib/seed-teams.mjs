// PXL Classroom - team seeding planner.
//
// Carries group membership forward: turns the teams of an earlier group
// assignment (or the roster's team columns) into ready-to-write team manifests
// for a target assignment. Pure and dependency-free - no fs, no fetch, no Node
// builtins - so the SPA, the CLI and workflow scripts all plan the same way and
// only differ in how they read the inputs and write the result.
//
// The planner never mutates its inputs and never writes anything. Callers pass
// `plan.changes` to a multi-file commit (lib/gittree.mjs).
//
// Two invariants the planner exists to protect:
//
//   1. A login may appear in at most ONE team file per assignment. acceptance/
//      accept.mjs finds "the team I am already in" by scanning the directory and
//      taking the first match, so a duplicated member silently makes one of the
//      two team files authoritative at random.
//   2. Two assignments must never share a repository_name_pattern. Provisioning
//      is idempotent on repo *existence*, so a colliding pattern makes the second
//      assignment hand students the first assignment's repository - already
//      locked down, already preserved - instead of a fresh one.

export const SEED_SOURCES = ["assignment", "roster"];

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Default team size used everywhere group_config.max_team_size is absent. */
export const DEFAULT_MAX_TEAM_SIZE = 3;

function lower(s) {
  return String(s ?? "").toLowerCase();
}

/** "@a, @b, @c and 4 more" - long cohorts must stay readable in a toast/CLI. */
function formatLogins(logins, max = 8) {
  const shown = logins.slice(0, max).map((l) => `@${l}`);
  const rest = logins.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.join(", ");
}

function uniqueLogins(logins) {
  const seen = new Set();
  const out = [];
  for (const raw of logins || []) {
    const login = String(raw ?? "").trim();
    if (!login) continue;
    const key = login.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(login);
  }
  return out;
}

/**
 * Group roster entries into pseudo-teams using the roster's team columns.
 * Per-assignment mapping (`teams[assignmentId]`) wins over the course-wide
 * `team_slug`, matching acceptance/accept.mjs's resolution order.
 */
export function teamsFromRoster(rosterStudents, { assignmentId } = {}) {
  const bySlug = new Map();
  for (const s of rosterStudents || []) {
    if (!s || s.active === false) continue;
    const login = s.github_login;
    if (!login) continue;
    const slug = (assignmentId && s.teams?.[assignmentId]) || s.team_slug;
    if (!slug) continue;
    const key = lower(slug);
    if (!bySlug.has(key)) {
      bySlug.set(key, { team_slug: key, team_name: s.team_name || slug, members: [] });
    }
    const entry = bySlug.get(key);
    if (!entry.team_name && s.team_name) entry.team_name = s.team_name;
    entry.members.push(login);
  }
  return [...bySlug.values()]
    .map((t) => ({ ...t, members: uniqueLogins(t.members) }))
    .sort((a, b) => a.team_slug.localeCompare(b.team_slug));
}

/**
 * Plan a seed. Returns { ok, errors, warnings, teams, changes, skipped, stats }.
 *
 * `ok === false` means nothing may be written: the errors describe configuration
 * that would corrupt the target assignment, not per-team hiccups. Warnings are
 * informational - the plan is still safe to apply.
 */
export function planSeed({
  sourceTeams = [],
  existingTeams = [],
  targetAssignment,
  sourceAssignment = null,
  roster = null,
  now = new Date().toISOString(),
  actor = "lecturer",
  source = "assignment",
} = {}) {
  const errors = [];
  const warnings = [];
  const skipped = [];

  if (!targetAssignment?.id) {
    return {
      ok: false,
      errors: [{ code: "no-target", message: "no target assignment given" }],
      warnings, teams: [], changes: [], skipped, unplaced: [], stats: emptyStats(),
    };
  }

  const targetId = targetAssignment.id;
  const cfg = targetAssignment.group_config || {};
  const maxTeamSize = Number(cfg.max_team_size) || DEFAULT_MAX_TEAM_SIZE;
  const minTeamSize = Number(cfg.min_team_size) || 0;
  const pattern = targetAssignment.repository_name_pattern || "";

  // --- Configuration errors: these block the whole seed -------------------

  if (targetAssignment.assignment_type !== "group") {
    errors.push({
      code: "not-group",
      message: `${targetId} is not a group assignment - set Assignment type to Group before seeding teams.`,
    });
  }

  if (!pattern.includes("{team_slug}")) {
    errors.push({
      code: "pattern-missing-team-slug",
      message: `repository name pattern "${pattern}" has no {team_slug} - every team would provision the same repository.`,
    });
  }

  if (
    sourceAssignment?.repository_name_pattern &&
    pattern &&
    sourceAssignment.repository_name_pattern === pattern
  ) {
    errors.push({
      code: "pattern-collision",
      message:
        `${targetId} and ${sourceAssignment.id} share the repository name pattern "${pattern}". ` +
        `Seeding the same team slugs would hand students ${sourceAssignment.id}'s repositories instead of new ones. ` +
        `Give ${targetId} a distinct pattern first.`,
    });
  }

  // --- Normalise the source ----------------------------------------------

  const candidates = [];
  for (const t of sourceTeams || []) {
    if (!t) continue;
    if (t.vacant === true) {
      skipped.push({ team_slug: t.team_slug, reason: "vacant" });
      continue;
    }
    const slug = lower(t.team_slug);
    if (!SLUG_RE.test(slug)) {
      skipped.push({ team_slug: t.team_slug, reason: "invalid-slug" });
      warnings.push({
        code: "invalid-slug",
        message: `team "${t.team_slug}" has a slug that is not URL-safe and was skipped.`,
        teams: [t.team_slug],
      });
      continue;
    }
    const members = uniqueLogins(t.members);
    if (members.length === 0) {
      skipped.push({ team_slug: slug, reason: "no-members" });
      continue;
    }
    candidates.push({ team_slug: slug, team_name: t.team_name || slug, members });
  }

  if (candidates.length === 0 && errors.length === 0) {
    errors.push({
      code: "no-source-teams",
      message:
        source === "roster"
          ? "no roster entries carry a team_slug - fill the team_slug / team_name columns first."
          : `${sourceAssignment?.id ?? "the source assignment"} has no teams with members to carry over.`,
    });
  }

  // Over-capacity is an error, not a truncation: dropping a member silently
  // is worse than telling the lecturer to raise max_team_size.
  const overCapacity = candidates.filter((t) => t.members.length > maxTeamSize);
  if (overCapacity.length > 0) {
    errors.push({
      code: "over-capacity",
      message:
        `${overCapacity.length} team(s) have more members than ${targetId}'s maximum team size (${maxTeamSize}): ` +
        overCapacity.map((t) => `${t.team_slug} (${t.members.length})`).join(", ") +
        `. Raise the maximum team size or split the teams.`,
      teams: overCapacity.map((t) => t.team_slug),
    });
  }

  if (errors.length > 0) {
    return { ok: false, errors, warnings, teams: [], changes: [], skipped, unplaced: [], stats: emptyStats() };
  }

  // --- Reconcile against what the target already has ----------------------

  const existingBySlug = new Map();
  const claimedBy = new Map(); // login (lowercased) -> slug that already holds them
  for (const t of existingTeams || []) {
    if (!t?.team_slug) continue;
    const slug = lower(t.team_slug);
    existingBySlug.set(slug, t);
    for (const m of t.members || []) claimedBy.set(lower(m), slug);
  }

  const teams = [];
  const droppedMembers = [];
  const keptExisting = [];
  const strandedByKept = [];

  for (const cand of candidates) {
    const existing = existingBySlug.get(cand.team_slug);

    // A target team that students already joined is authoritative. Overwriting
    // it would revoke real membership on the strength of last term's grouping.
    if (existing && (existing.members || []).length > 0) {
      keptExisting.push(cand.team_slug);
      skipped.push({ team_slug: cand.team_slug, reason: "already-populated" });
      // Their team survived, but the rest of the source team lands nowhere -
      // silently, unless we say so here.
      for (const m of cand.members) {
        if (!claimedBy.has(lower(m))) strandedByKept.push(m);
      }
      continue;
    }

    // Invariant 1: never list a login in two team files of one assignment.
    const members = [];
    for (const m of cand.members) {
      const holder = claimedBy.get(lower(m));
      if (holder && holder !== cand.team_slug) {
        droppedMembers.push({ login: m, team_slug: cand.team_slug, held_by: holder });
        continue;
      }
      members.push(m);
    }

    if (members.length === 0) {
      skipped.push({ team_slug: cand.team_slug, reason: "all-members-already-teamed" });
      continue;
    }

    for (const m of members) claimedBy.set(lower(m), cand.team_slug);

    teams.push({
      schema_version: 1,
      assignment_id: targetId,
      team_slug: cand.team_slug,
      team_name: cand.team_name,
      members,
      max_members: maxTeamSize,
      created_at: now,
      created_by: actor,
      seeded_from: {
        source,
        ...(sourceAssignment?.id ? { assignment_id: sourceAssignment.id } : {}),
        ...(sourceAssignment?.title ? { assignment_title: sourceAssignment.title } : {}),
        seeded_at: now,
        seeded_by: actor,
      },
    });
  }

  teams.sort((a, b) => a.team_slug.localeCompare(b.team_slug));

  // --- Warnings -----------------------------------------------------------

  if (keptExisting.length > 0) {
    const stranded = uniqueLogins(strandedByKept);
    warnings.push({
      code: "existing-team-kept",
      message:
        `${keptExisting.length} team(s) already exist with members and were left untouched: ${keptExisting.join(", ")}.` +
        (stranded.length
          ? ` ${stranded.length} student(s) from those teams were therefore not placed: ${formatLogins(stranded)}.`
          : ""),
      teams: keptExisting,
      logins: stranded,
    });
  }

  if (droppedMembers.length > 0) {
    warnings.push({
      code: "member-already-teamed",
      message:
        `${droppedMembers.length} student(s) already belong to another team in ${targetId} and were not re-seeded: ` +
        droppedMembers.map((d) => `@${d.login} (in ${d.held_by})`).join(", ") + ".",
      logins: droppedMembers.map((d) => d.login),
    });
  }

  const seededLogins = teams.flatMap((t) => t.members);

  if (roster && targetAssignment.roster_mode !== "open") {
    const known = new Set(
      (roster.students || []).filter((s) => s.github_login).map((s) => lower(s.github_login))
    );
    const unknown = seededLogins.filter((l) => !known.has(lower(l)));
    if (unknown.length > 0) {
      warnings.push({
        code: "not-on-roster",
        message:
          `${unknown.length} carried-over student(s) are not on the roster and will be rejected when they accept: ` +
          unknown.map((l) => `@${l}`).join(", ") + ".",
        logins: unknown,
      });
    }
  }

  if (minTeamSize > 0) {
    const under = teams.filter((t) => t.members.length < minTeamSize);
    if (under.length > 0) {
      warnings.push({
        code: "under-capacity",
        message:
          `${under.length} team(s) are below the minimum team size (${minTeamSize}): ` +
          under.map((t) => `${t.team_slug} (${t.members.length})`).join(", ") + ".",
        teams: under.map((t) => t.team_slug),
      });
    }
  }

  const cap = Number(targetAssignment.max_acceptances) || 0;
  if (cap > 0 && seededLogins.length > cap) {
    warnings.push({
      code: "cap-exceeded",
      message:
        `${seededLogins.length} carried-over students exceed the acceptance cap of ${cap} - ` +
        `students past the cap will be rejected. Raise max_acceptances.`,
    });
  }

  // Who has no team at all once this is applied? After carrying a grouping
  // forward, this list IS the remaining manual work - the late enrollers, the
  // students whose whole group left, the ones nobody paired with. It is roster
  // relative, so it means nothing under roster_mode: open.
  let unplaced = [];
  if (roster && targetAssignment.roster_mode !== "open") {
    unplaced = (roster.students || [])
      .filter((s) => s.github_login && s.active !== false && !claimedBy.has(lower(s.github_login)))
      .map((s) => ({ github_login: s.github_login, full_name: s.full_name || null }));
    if (unplaced.length > 0) {
      warnings.push({
        code: "unplaced",
        message:
          `${unplaced.length} student(s) on the roster will still have no team: ` +
          `${formatLogins(unplaced.map((u) => u.github_login))}. ` +
          `They can form their own team unless the assignment pre-assigns groups.`,
        logins: unplaced.map((u) => u.github_login),
      });
    }
  }

  const changes = teams.map((t) => ({
    path: `teams/${targetId}/${t.team_slug}.json`,
    content: JSON.stringify(t, null, 2) + "\n",
  }));

  return {
    ok: true,
    errors,
    warnings,
    teams,
    changes,
    skipped,
    unplaced,
    stats: {
      teams: teams.length,
      students: seededLogins.length,
      skipped: skipped.length,
      source_teams: candidates.length,
      unplaced: unplaced.length,
    },
  };
}

function emptyStats() {
  return { teams: 0, students: 0, skipped: 0, source_teams: 0, unplaced: 0 };
}

/**
 * Plan the undo of a seed.
 *
 * Removable is deliberately narrow: a team only qualifies when it came from a
 * seed, owns no repository, and has no member who has accepted. Anything a
 * student has actually joined is their work now, and a team somebody created by
 * hand was never part of the seed - both are reported as kept rather than
 * quietly deleted. `acceptedLogins` is a Set/array of logins known to have
 * accepted; pass an empty one for a draft, where acceptance is impossible.
 */
export function planUnseed({ teams = [], acceptedLogins = [], assignmentId } = {}) {
  const accepted = new Set([...acceptedLogins].map(lower));
  const removable = [];
  const kept = [];

  for (const t of teams) {
    if (!t?.team_slug) continue;
    if (!t.seeded_from) continue;
    const claimed = !!t.repo_url || !!t.repo_id || (t.members || []).some((m) => accepted.has(lower(m)));
    (claimed ? kept : removable).push(t);
  }

  removable.sort((a, b) => String(a.team_slug).localeCompare(String(b.team_slug)));

  return {
    removable,
    kept,
    changes: removable.map((t) => ({
      path: `teams/${assignmentId}/${t.team_slug}.json`,
      content: null,
    })),
  };
}

/** One-line commit message for a plan. */
export function seedCommitMessage(plan, { targetId, sourceLabel }) {
  return `Seed ${plan.stats.teams} team(s) into ${targetId} from ${sourceLabel}`;
}
