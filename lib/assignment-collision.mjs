// WHETHER A NEW ASSIGNMENT WOULD LAND ON TOP OF AN EXISTING ONE.
//
// The assignment id is not the collision key. `repository_name_pattern` is, and
// it is a separate field a lecturer can point anywhere - so `lab-3-v2` with the
// pattern `lab-3-{github_login}` collides with `lab-3` while looking like a
// different assignment, and `lab-3` recreated with a fresh pattern does not
// collide at all. lib/seed-teams.mjs has said so since it was written:
//
//   "Two assignments must never share a repository_name_pattern. Provisioning
//    is idempotent on repo *existence*, so a colliding pattern makes the second
//    assignment hand students the first assignment's repository - already
//    locked down, already preserved - instead of a fresh one."
//
// Nothing enforced it. This module is that enforcement, and it asks three
// questions - all about what EXISTS, never about what once happened:
//
//   1. Does a repository this pattern would produce already exist? Then a
//      returning student is handed it by provision.mjs (`alreadyExists ?
//      existing.data`), carrying the previous deadline's lockdown ruleset,
//      which nothing in this codebase can remove. BLOCKS.
//
//   2. Does another assignment already use this pattern? Same failure, arriving
//      the first time somebody accepts. BLOCKS.
//
//   3. Does the archive repository for this id still exist? It still holds
//      `refs/heads/preserved/<id>/<login>`, and preserve.mjs pushes WITHOUT
//      --force on purpose, so the new snapshot is a non-fast-forward and is
//      rejected - for every returning student, at the deadline. BLOCKS.
//
// And one that does NOT block, which is the distinction this module exists for:
//
//   4. `retired/<id>/` on its own. A delete writes it unconditionally, so an
//      assignment opened by mistake and deleted before anybody joined leaves a
//      record of nothing. "I changed my mind, nobody joined, let me start over
//      with the same name" is an ordinary Tuesday and must not be refused. It
//      is reported as a WARNING, because recreating the id means a later delete
//      overwrites that record - which matters only when it holds real grades.
//
// So a lecturer who deletes the repositories and the archive has genuinely
// freed the name, and is told so. The check probes; it does not consult
// history.
//
// Isomorphic and dependency-free: the Admin Panel reads it through
// `frontend/src/lib/assignment-collision.js`. Every function takes its evidence
// as a parameter rather than fetching, so a test runs it rather than describing
// it.

// What a placeholder can expand to. A GitHub login is
// `[A-Za-z0-9](-?[A-Za-z0-9])*`; a team slug is the same alphabet. Both are
// collapsed to one class rather than modelled precisely, because a name that is
// *nearly* a login still occupies the repository name we would want.
const PLACEHOLDER_CLASS = "[A-Za-z0-9-]+";
const PLACEHOLDERS = ["{github_login}", "{team_slug}"];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The literal characters a pattern contributes, placeholders removed.
 *
 * Used to rank two patterns that both match one repository name: the more
 * literal one is the more specific, and owns the name. `lab-3-2-alice` matches
 * both `lab-3-{github_login}` and `lab-3-2-{github_login}`, and attributing it
 * to the first would block the id `lab-3` forever because `lab-3-2` exists.
 *
 * @param {string} pattern
 * @returns {number}
 */
export function patternSpecificity(pattern) {
  if (typeof pattern !== "string") return 0;
  let literal = pattern;
  for (const p of PLACEHOLDERS) literal = literal.split(p).join("");
  return literal.length;
}

/**
 * A pattern as a matcher over repository names.
 *
 * Case-insensitive on purpose: GitHub treats `Lab-3-Alice` and `lab-3-alice` as
 * the same repository, so a case-sensitive match would report "free" for a name
 * that cannot be created.
 *
 * Returns null for a pattern with no placeholder rather than a matcher for a
 * literal name: such a pattern is already refused by the form, and turning it
 * into an exact-match rule here would quietly give it a meaning it must not
 * have (every student sharing one repository).
 *
 * @param {string} pattern
 * @returns {RegExp|null}
 */
export function repoNameMatcher(pattern) {
  if (typeof pattern !== "string" || !pattern.trim()) return null;
  if (!PLACEHOLDERS.some((p) => pattern.includes(p))) return null;

  // Split on the placeholders, escape every literal run between them.
  const parts = pattern.split(/(\{github_login\}|\{team_slug\})/g);
  const body = parts
    .map((part) => (PLACEHOLDERS.includes(part) ? PLACEHOLDER_CLASS : escapeRe(part)))
    .join("");
  try {
    return new RegExp(`^${body}$`, "i");
  } catch {
    return null;
  }
}

/**
 * Which of `repoNames` this pattern would produce - excluding the ones another
 * assignment explains better.
 *
 * `others` are the live assignments, as `{id, repository_name_pattern}`. A name
 * matched by both this pattern and a MORE SPECIFIC one belongs to that
 * assignment, not to this collision. A name matched by an equally or less
 * specific other is still ours: the other one is the ambiguity, and
 * `clashingAssignments` reports it separately.
 *
 * @param {string} pattern
 * @param {string[]} repoNames
 * @param {Array<{id: string, repository_name_pattern?: string}>} [others]
 * @returns {string[]} matching names, in the order given
 */
export function collidingRepoNames(pattern, repoNames, others = []) {
  const mine = repoNameMatcher(pattern);
  if (!mine) return [];
  const myScore = patternSpecificity(pattern);

  const rivals = (Array.isArray(others) ? others : [])
    .map((a) => ({
      id: a?.id,
      re: repoNameMatcher(a?.repository_name_pattern),
      score: patternSpecificity(a?.repository_name_pattern),
    }))
    .filter((r) => r.re && r.score > myScore);

  return (Array.isArray(repoNames) ? repoNames : [])
    .filter((n) => typeof n === "string" && n.trim())
    .filter((n) => mine.test(n))
    .filter((n) => !rivals.some((r) => r.re.test(n)));
}

/**
 * Live assignments whose pattern would produce the same repository names.
 *
 * Not a string comparison: `lab-3-{github_login}` and `lab-3-{team_slug}`
 * produce the same names from different inputs, and two patterns can overlap
 * without being equal. Two patterns clash when either one's matcher accepts a
 * name the other would generate - approximated by rendering each with a probe
 * value, which is exact for the single-placeholder patterns the form produces
 * and conservative for anything hand-written.
 *
 * @param {string} pattern
 * @param {Array<{id: string, repository_name_pattern?: string}>} assignments
 * @param {string|null} [selfId] the assignment being edited, never its own clash
 * @returns {Array<{id: string, pattern: string}>}
 */
export function clashingAssignments(pattern, assignments, selfId = null) {
  const mine = repoNameMatcher(pattern);
  if (!mine) return [];
  const self = typeof selfId === "string" ? selfId.toLowerCase() : null;

  const render = (p) => {
    let out = p;
    for (const ph of PLACEHOLDERS) out = out.split(ph).join("probe");
    return out;
  };
  const myRendered = render(pattern);

  const out = [];
  for (const a of Array.isArray(assignments) ? assignments : []) {
    const other = a?.repository_name_pattern;
    if (typeof other !== "string" || !other.trim()) continue;
    if (self && String(a.id ?? "").toLowerCase() === self) continue;
    const theirs = repoNameMatcher(other);
    if (!theirs) continue;
    if (mine.test(render(other)) || theirs.test(myRendered)) {
      out.push({ id: a.id, pattern: other });
    }
  }
  return out;
}

/**
 * @param {object} args
 * @param {string[]} [args.existingRepos]   repository names CONFIRMED to exist and to be ours
 * @param {Array<{id: string, pattern: string}>} [args.clashes]
 * @param {boolean} [args.archiveExists]
 * @param {object|null} [args.manifest]     `retired/<id>/manifest.json`, or null
 * @returns {{clear: boolean, findings: Array<{kind: string, blocking: boolean, detail: string}>}}
 */
export function assignmentCollisions({
  existingRepos = [],
  clashes = [],
  archiveExists = false,
  manifest = null,
} = {}) {
  const findings = [];

  const repos = (Array.isArray(existingRepos) ? existingRepos : []).filter(
    (r) => typeof r === "string" && r.trim(),
  );
  if (repos.length) {
    const shown = repos.slice(0, 3).join(", ");
    findings.push({
      kind: "existing-repos",
      blocking: true,
      detail:
        `${repos.length} repositor${repos.length === 1 ? "y" : "ies"} this pattern would produce already ` +
        `exist${repos.length === 1 ? "s" : ""} (${shown}${repos.length > 3 ? ", …" : ""}) - ` +
        `a student would be handed the old one, still locked down`,
    });
  }

  for (const c of Array.isArray(clashes) ? clashes : []) {
    findings.push({
      kind: "pattern-clash",
      blocking: true,
      detail: `"${c.id}" already uses the repository name pattern ${c.pattern} - two assignments sharing one pattern hand out each other's repositories`,
    });
  }

  if (archiveExists) {
    const n = Number(manifest?.preserved_submissions);
    findings.push({
      kind: "archive",
      blocking: true,
      detail:
        Number.isFinite(n) && n > 0
          ? `the archive repository still exists, holding ${n} preserved submission${n === 1 ? "" : "s"} - preservation would be rejected at the new deadline`
          : "the archive repository still exists - preservation would be rejected at the new deadline",
    });
  }

  // Last, and never blocking.
  if (manifest && typeof manifest === "object") {
    const when = typeof manifest.deleted_at === "string" ? manifest.deleted_at.slice(0, 10) : null;
    findings.push({
      kind: "retired-record",
      blocking: false,
      detail:
        `retired/${manifest.assignment_id}/ holds the report and grades kept` +
        `${when ? ` when it was deleted on ${when}` : " when it was deleted"} - ` +
        `deleting this assignment later would overwrite them`,
    });
  }

  return { clear: !findings.some((f) => f.blocking), findings };
}

export const COLLISION_LEAD = "This would land on top of an existing assignment:";
export const COLLISION_CONSEQUENCE =
  "Change the repository name pattern, or delete what is listed above on GitHub first - " +
  "the check will then let it through.";

// Shown when nothing blocks but something is worth knowing. Not a refusal.
export const COLLISION_WARNING_LEAD = "This name was used before. Nothing is in the way, but:";

/**
 * The whole refusal as one string, or null when nothing blocks.
 *
 * A warning-only verdict returns null: a string with nowhere to go but an error
 * slot would read as a refusal.
 *
 * @param {{clear: boolean, findings: Array<{detail: string}>}} verdict
 * @returns {string|null}
 */
export function describeCollisions(verdict) {
  if (!verdict || verdict.clear) return null;
  // Blockers only. The consequence line says "delete what is listed above", and
  // the retired record is not something anyone has to delete - listing it here
  // would instruct a lecturer to destroy the evidence of the previous run.
  const list = blockingFindings(verdict).map((f) => f.detail).join("; ");
  return `${COLLISION_LEAD} ${list}. ${COLLISION_CONSEQUENCE}`;
}

/** The findings that stop the save. @param {{findings?: Array}} verdict */
export function blockingFindings(verdict) {
  return (verdict?.findings || []).filter((f) => f.blocking);
}

/** The findings worth knowing that do not stop anything. */
export function noteFindings(verdict) {
  return (verdict?.findings || []).filter((f) => !f.blocking);
}

/**
 * The distinct repository names a retired report says were provisioned.
 *
 * Kept as a hint, not as the answer: the org listing is authoritative and finds
 * repositories from runs whose record was deleted. This narrows the probe when
 * the org is large.
 *
 * A group assignment writes one row per member over a shared repository, so the
 * names are deduplicated.
 *
 * @param {object|null} retiredReport
 * @returns {string[]}
 */
export function reposInRetiredReport(retiredReport) {
  const students = retiredReport?.students;
  if (!Array.isArray(students)) return [];
  const seen = new Set();
  for (const s of students) {
    const name = typeof s?.repo_name === "string" ? s.repo_name.trim() : "";
    if (name) seen.add(name);
  }
  return [...seen];
}
