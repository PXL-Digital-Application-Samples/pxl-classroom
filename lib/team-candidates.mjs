// Which students a lecturer may put in a team of this assignment.
//
// The Teams tab's "Add member" and "Create team" pickers, and its count of
// students with no team, offered every roster row with a GitHub login - the
// whole organization, other sections and previous years included (the roster
// keeps every student ever promoted into it). A lecturer could place someone in
// a team who was then refused at acceptance (`rejected:not-in-cohort`), and the
// count named students this assignment is not for (BETA-UX.md, 2026-10-02).
//
// So the candidates are this assignment's students, decided the way acceptance
// decides them:
//   * under `enforced` and `claim` the roster is the gate, so the roster rows
//     the assignment admits (lib/cohort.mjs `cohortStudents` - its selected
//     students, or the whole roster when it selects none);
//   * under `open` the roster gates nothing, so the roster is not the
//     population - only students who actually accepted are.
// Students who accepted are candidates under every mode: whoever holds an
// acceptance is in the assignment, whatever the roster says now.
//
// TEAMS STORE GITHUB LOGINS, so a roster row with no login cannot be placed in
// a team. Decided 2026-10-04 (BETA-UX.md): such a row is not hidden - it comes
// back in `waiting`, and the pickers show it greyed as "no GitHub username
// yet", because a student a lecturer cannot find is a student they assume is
// missing. A row whose address a claim has bound is placeable: `loginFor` is
// asked for the login the confirm-email link (or an acceptance) recorded, so a
// student who confirmed appears in the picker without anyone editing the roster.
//
// Isomorphic and dependency-light: the SPA and the tests both import it.

import { cohortStudents, cohortWithoutLogin } from "./cohort.mjs";
import { rosterGatesAcceptance } from "./roster-mode.mjs";

/**
 * @param {object} args
 * @param {{roster_mode?: unknown, cohort?: unknown}|null} args.assignment
 * @param {Array<{github_login?: string|null, full_name?: string|null, student_number?: string|null}>} [args.roster]
 * @param {Array<{github_login?: string|null, full_name?: string|null, student_number?: string|null, acceptance_state?: string|null}>} [args.accepted]
 *   the report's rows - students known to this assignment by an acceptance
 * @param {Array<{members?: unknown}>} [args.teams]
 * @param {(row: object) => (string|null|undefined)} [args.loginFor]  the login a
 *   claim binds to a roster row that has none of its own
 * @returns {{all: Array<{github_login: string, full_name: string|null, student_number: string|null}>,
 *           unassigned: Array<{github_login: string, full_name: string|null, student_number: string|null}>,
 *           waiting: Array<{full_name: string|null, student_number: string|null, email: string|null}>}}
 */
export function teamCandidates({ assignment, roster = [], accepted = [], teams = [], loginFor = null }) {
  const byLogin = new Map();
  const waiting = [];
  const loginOf = (row) => {
    const own = typeof row?.github_login === "string" ? row.github_login.trim() : "";
    if (own) return own;
    const bound = typeof loginFor === "function" ? loginFor(row) : null;
    return typeof bound === "string" ? bound.trim() : "";
  };
  const add = (row, login) => {
    if (!login) return;
    const key = login.toLowerCase();
    const prior = byLogin.get(key);
    byLogin.set(key, {
      github_login: prior?.github_login ?? login,
      full_name: prior?.full_name || row.full_name || null,
      student_number: prior?.student_number || row.student_number || null,
    });
  };

  if (rosterGatesAcceptance(assignment?.roster_mode)) {
    for (const row of cohortStudents(assignment, roster)) add(row, loginOf(row));
  }
  // Who has no username at all - not on the roster and not through a claim.
  // The rows come from the one rule the Progress tab also asks (lib/cohort.mjs).
  for (const row of cohortWithoutLogin(assignment, roster)) {
    if (loginOf(row)) continue;
    waiting.push({
      full_name: row?.full_name || null,
      student_number: row?.student_number || null,
      email: row?.email || null,
    });
  }
  for (const row of accepted || []) {
    if (row?.acceptance_state === "not-accepted") continue;
    add(row, typeof row?.github_login === "string" ? row.github_login.trim() : "");
  }

  const inTeam = new Set();
  for (const t of teams || []) {
    for (const m of Array.isArray(t?.members) ? t.members : []) inTeam.add(String(m).toLowerCase());
  }
  const all = [...byLogin.values()];
  return { all, unassigned: all.filter((s) => !inTeam.has(s.github_login.toLowerCase())), waiting };
}
