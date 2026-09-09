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
//      existing.data`) - the previous cohort's work, and none of this year's
//      starter code. NOTES, and it used to block.
//
//      IT STOPPED BLOCKING ON 2026-09-09, and the reason is that this is the
//      one moment the question cannot be answered. The form holds the pattern
//      and the organization's repository listing; who will ACCEPT is not
//      knowable here, and without it "a repository exists" and "a student in
//      this cohort would be handed one" are different statements. Measured on a
//      real course: `portfolio-{github_login}` over an organization holding 300
//      portfolios from previous years, refused over 300 repositories of which
//      perhaps two belonged to a student who would accept - and the lecturer's
//      two options were to rename the assignment or delete 300 students' work.
//
//      The judgement moved to acceptance, where both halves are known - this
//      student, this name (`acceptance/accept.mjs` step 7, `lib/
//      existing-repo.mjs`). A repository frozen by an earlier deadline refuses
//      that one student there; an ordinary one follows the assignment's
//      `existing_repo_policy`, which is the question this note now carries.
//
//   2. Does another assignment already use this pattern? Same failure, arriving
//      the first time somebody accepts. BLOCKS - and it still does, because
//      unlike (1) it is fully answerable here: both assignments are on screen,
//      and acceptance cannot see it at all (the repository does not exist yet,
//      so there is nothing for step 7 to find).
//
//   3. Does the archive repository for this id still exist? It still holds
//      `refs/heads/preserved/<id>/<login>`, and preserve.mjs pushes WITHOUT
//      --force on purpose, so the new snapshot is a non-fast-forward and is
//      rejected - for every returning student, at the deadline. BLOCKS, for the
//      same reason: it is answerable here, and nothing downstream re-asks.
//
// And one more that does NOT block, which is the distinction this module was
// written for:
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

  // SHORT. This renders as red text under a form field, and the first cut ran
  // to about two hundred words - three findings each carrying its own
  // consequence clause, then three remedies of forty words. A wall of red is
  // read as "something went wrong", not as three specific things and what to
  // do about them.
  //
  // So each finding names the thing, and carries a consequence only where the
  // consequence is not obvious from the thing itself: repositories existing
  // says nothing about students being handed them, and a surviving archive
  // says nothing at all until the deadline. Two assignments sharing a pattern
  // explains itself once the other one is named. The long version is
  // RUNBOOK §5.1, and the UI does not send anyone there (DESIGN.md §1.6).
  const repos = (Array.isArray(existingRepos) ? existingRepos : []).filter(
    (r) => typeof r === "string" && r.trim(),
  );
  if (repos.length) {
    const shown = repos.slice(0, 3).join(", ") + (repos.length > 3 ? ", …" : "");
    findings.push({
      kind: "existing-repos",
      // The number, beside the sentence rather than only inside it. The form
      // asks a follow-up question when this is non-zero, and re-deriving the
      // count by parsing the prose back out would be a guard reading a string
      // its own module built.
      count: repos.length,
      // A NOTE, NOT A REFUSAL - see the head of this file. It says "in this
      // organization" rather than "here", and that is the sentence carrying the
      // whole change: the count is the organization's, not this cohort's, and a
      // lecturer looking at 300 has to be able to tell it is 300 of everybody
      // rather than 300 of theirs. "here" left them to infer which.
      blocking: false,
      // NO CONSEQUENCE CLAUSE, deliberately, and it is the only finding here
      // without one. What happens to a student who owns one is the question the
      // control directly beneath this note asks, so spelling it out here states
      // the premise of the next sentence the lecturer reads (DESIGN 1.9: say it
      // where they choose it). It also has to fit: with three names and an
      // ellipsis, 18 words leaves fourteen for the sentence.
      detail:
        `${repos.length} repositor${repos.length === 1 ? "y" : "ies"} in this organization already ` +
        `match${repos.length === 1 ? "es" : ""} this pattern: ${shown}`,
    });
  }

  for (const c of Array.isArray(clashes) ? clashes : []) {
    findings.push({
      kind: "pattern-clash",
      blocking: true,
      detail: `"${c.id}" already uses this repository name pattern`,
    });
  }

  if (archiveExists) {
    const n = Number(manifest?.preserved_submissions);
    findings.push({
      kind: "archive",
      blocking: true,
      detail:
        (Number.isFinite(n) && n > 0
          ? `the archive still exists, with ${n} preserved submission${n === 1 ? "" : "s"}`
          : "the archive still exists") + " - preservation would fail at the new deadline",
    });
  }

  // Last, and never blocking.
  if (manifest && typeof manifest === "object") {
    const when = typeof manifest.deleted_at === "string" ? manifest.deleted_at.slice(0, 10) : null;
    findings.push({
      kind: "retired-record",
      blocking: false,
      detail:
        `retired/${manifest.assignment_id}/ holds the report and grades` +
        `${when ? ` from ${when}` : ""} - a later delete would overwrite them`,
    });
  }

  return { clear: !findings.some((f) => f.blocking), findings };
}

export const COLLISION_LEAD = "This name cannot be used - the previous run is still here:";
// Number-neutral, because the list is one, two or three depending on what was
// found. It was "Three ways forward" over two, then "Ways forward" over one -
// a heading that counts is a colspan written by hand.
export const COLLISION_REMEDY_LEAD = "What to do:";

/**
 * What a lecturer can actually DO about it, derived from what was found.
 *
 * A refusal that only says no gets routed around. These are the real options,
 * with the one that costs nothing marked - and no option is offered for a
 * finding that is not there: deleting repositories is not a remedy for a
 * pattern shared with a live assignment, and nothing to delete must not read
 * as an invitation to delete something.
 *
 * The recommendation states the REQUIREMENT and the mechanism, and stops.
 * It went wrong twice in the same direction before it got here:
 *
 *   * `"Prefix the academic year - 2627-lab-3. It never collides."` A composed
 *     name is a name nothing has checked - `2627-lab-3` can be taken too - and
 *     "never collides" is a promise no wording can keep.
 *   * `"Add the academic year - 2627, in front or behind."` The same defect one
 *     step back. Nothing here knows that name is free either, and nothing here
 *     knows the organization does not already encode the year some other way.
 *
 * What is actually true is that the name has to be different, and that a prefix
 * or a suffix is how. Which one, and what it says, is the lecturer's call over
 * a listing they can see and this module cannot.
 *
 * @param {object} args
 * @param {{findings?: Array<{kind: string, blocking: boolean}>}} args.verdict
 * @returns {Array<{key: string, label: string, recommended: boolean}>}
 */
export function collisionRemedies({ verdict } = {}) {
  const kinds = new Set(blockingFindings(verdict).map((f) => f.kind));
  const out = [];

  // One line each. Three options of forty words is a paragraph pretending to
  // be a list - a lecturer reads the first, skims the second and stops.
  //
  // GENERIC, AND IT STAYS GENERIC. This said "Add the academic year - 2627, in
  // front or behind", which is the same defect as the composed `2627-lab-3` it
  // replaced, just one step back: nothing here knows `2627-lab-3` is free, and
  // nothing here knows the organization does not already encode the year some
  // other way. The requirement is that the name be DIFFERENT; a prefix or a
  // suffix is how, and which one and what it says is not this module's call.
  out.push({
    key: "distinguish",
    recommended: true,
    // A PREFIX, and no longer "a prefix or suffix". A suffix does not clear a
    // pattern clash, which is now one of the two things that still block: a
    // placeholder expands to `[A-Za-z0-9-]+`, so `lab-3-2026-{github_login}` is
    // still INSIDE `lab-3-{github_login}`'s namespace and clashes with it -
    // correctly, and the lecturer who took the advice is refused a second time
    // with no idea why. Found while writing the fixture for exactly that case,
    // 2026-09-09. It is still a shape rather than a name: nothing here knows
    // whether any particular prefix is free either.
    label: "The name has to be different - put something in front of it.",
  });

  // There was a "change only the repository name pattern" option here. It
  // said the same thing as the first one in a way that invites the id and the
  // pattern to drift apart, and the finding it answered already names the
  // pattern - a lecturer reading `"lab-3-old" already uses this repository
  // name pattern` is looking at the field two rows down.
  // `existing-repos` was the other half of this condition and can no longer
  // reach it - it stopped blocking, and this list is built from the blocking
  // findings. Removed rather than left as a harmless disjunct: a dead branch
  // here reads as an option the lecturer might still be offered, and the whole
  // reason it went is that "delete 300 students' repositories" must never again
  // be one of two things this screen suggests.
  if (kinds.has("archive")) {
    out.push({
      key: "delete",
      recommended: false,
      // The cost is named in the same breath, because this is the option that
      // cannot be undone and the other one costs nothing.
      label: "Delete the archive repository on GitHub - that destroys the preserved submissions.",
    });
  }

  // "Recommended" against the only option recommends nothing: the label exists
  // to distinguish, and there is nothing to distinguish it from.
  if (out.length === 1) out[0].recommended = false;

  return out;
}

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
  // Blockers only. The remedies say "delete what is listed above", and the
  // retired record is not something anyone has to delete - listing it here
  // would instruct a lecturer to destroy the evidence of the previous run.
  const list = blockingFindings(verdict).map((f) => f.detail).join("; ");
  const remedies = collisionRemedies({ verdict })
    .map((r) => r.label)
    .join(" ");
  return `${COLLISION_LEAD} ${list}. ${COLLISION_REMEDY_LEAD} ${remedies}`;
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
