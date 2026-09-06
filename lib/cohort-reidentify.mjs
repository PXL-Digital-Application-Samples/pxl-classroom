// WHAT AN EDIT TO A ROSTER ROW DOES TO THE ASSIGNMENTS THAT NAME IT.
//
// A student number and a GitHub login are handed to this system. An address is
// TYPED - and a row that carries only an address is identified by it, because
// `rosterIdentities` has nothing else to offer. So correcting a typo in one
// re-identifies the row, and every cohort holding the old spelling stops
// matching: the student is out of the assignment, silently, through an edit
// whose whole intent was "same person, better address".
//
// That is a removal from a published cohort by the back door. The picker is
// deliberately add-only once an assignment is published - a lecturer cannot
// take a student out of a cohort that already handed out repositories - and an
// address edit walked straight past it without either half knowing.
//
// This module decides, and only decides. It reports which assignments would
// lose the row and what their cohorts should say instead; the caller confirms
// with the lecturer and does the writing. Pure, so a test can run it rather
// than describe it, and isomorphic like `cohort.mjs` itself.
//
// IT NEVER RE-SPELLS AN IDENTITY. Which strings name a row is `rosterIdentities`
// and nothing else, and which one a new pick records is `cohortIdentity` - the
// same two functions the gate and the picker ask, because a third opinion here
// is how the screen and the gate come to disagree.
import { rosterIdentities, cohortIdentity, assignmentCohort, normalizeCohortEntry } from "./cohort.mjs";

/**
 * Which assignments an edit would drop this student from, and what to write.
 *
 * @param {object|null} before the roster row as stored
 * @param {object|null} after  the roster row the edit would write
 * @param {object[]} assignments full assignment documents, with their `cohort`
 * @returns {{
 *   lost: string[],
 *   replacement: string|null,
 *   affected: {id: string, title: string, state: string, cohort: string[], orphaned: string[]}[],
 * }}
 *   `lost` is empty when the edit changes no identity, which is the ordinary
 *   case - a row with a student number keeps its key whatever its address says.
 *   `replacement` is null only when the edit would leave the row unnameable;
 *   the roster schema refuses that, and a caller seeing it should refuse too
 *   rather than write a cohort entry it cannot compute.
 */
export function planCohortRename({ before, after, assignments }) {
  const had = rosterIdentities(before);
  const has = new Set(rosterIdentities(after));
  const lost = had.filter((id) => !has.has(id));
  if (lost.length === 0) return { lost: [], replacement: null, affected: [] };

  const lostSet = new Set(lost);
  const replacement = cohortIdentity(after);
  const affected = [];

  for (const assignment of Array.isArray(assignments) ? assignments : []) {
    // AN EMPTY COHORT IS EVERY STUDENT ON THE ROSTER, not nobody. Such an
    // assignment names this row by nothing, so re-identifying it changes
    // nothing about who may accept - and rewriting a cohort onto it would
    // narrow an assignment that was deliberately open to the whole course.
    const cohort = assignmentCohort(assignment);
    if (cohort.size === 0) continue;

    const orphaned = [...cohort].filter((id) => lostSet.has(id));
    if (orphaned.length === 0) continue;

    // ALREADY NAMED ANOTHER WAY, so matching survives on its own. Matching is
    // ANY identity the row carries, so a cohort holding `num:0123456` beside
    // `email:old` still admits a row that kept its number - and the stale
    // address entry is reported by `danglingCohortEntries` where a lecturer can
    // see it, which is a better place for it than a dialog about something
    // else. Rewriting here would ask for confirmation of a no-op.
    if ([...has].some((id) => cohort.has(id))) continue;

    if (!replacement) {
      // Cannot be computed, so it is not guessed at. The caller refuses.
      affected.push({ ...describe(assignment), cohort: null, orphaned });
      continue;
    }

    // MERGE, NEVER REPLACE - and the entries that stay keep the spelling they
    // were stored with. Only the orphaned ones go, and only the replacement
    // arrives; anything else in that list belongs to another student.
    const next = [];
    for (const raw of assignment.cohort) {
      if (lostSet.has(normalizeCohortEntry(raw))) continue;
      next.push(raw);
    }
    // `uniqueItems` is in the schema, and the row may already be named the new
    // way by an entry that was added by hand.
    if (!next.some((raw) => normalizeCohortEntry(raw) === replacement)) next.push(replacement);

    affected.push({ ...describe(assignment), cohort: next, orphaned });
  }

  return { lost, replacement, affected };
}

function describe(assignment) {
  return {
    id: String(assignment?.id ?? ""),
    title: String(assignment?.title ?? assignment?.id ?? ""),
    state: String(assignment?.state ?? ""),
  };
}
