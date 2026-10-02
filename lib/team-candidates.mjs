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
// TEAMS STORE GITHUB LOGINS, so a roster row with no login yet (an address-only
// row under `claim`, before the student accepts) cannot be placed in a team and
// is not offered. That is an open question (BETA-UX.md), not a decision.
//
// Isomorphic and dependency-light: the SPA and the tests both import it.

import { cohortStudents } from "./cohort.mjs";
import { rosterGatesAcceptance } from "./roster-mode.mjs";

/**
 * @param {object} args
 * @param {{roster_mode?: unknown, cohort?: unknown}|null} args.assignment
 * @param {Array<{github_login?: string|null, full_name?: string|null, student_number?: string|null}>} [args.roster]
 * @param {Array<{github_login?: string|null, full_name?: string|null, student_number?: string|null, acceptance_state?: string|null}>} [args.accepted]
 *   the report's rows - students known to this assignment by an acceptance
 * @param {Array<{members?: unknown}>} [args.teams]
 * @returns {{all: Array<{github_login: string, full_name: string|null, student_number: string|null}>,
 *           unassigned: Array<{github_login: string, full_name: string|null, student_number: string|null}>}}
 */
export function teamCandidates({ assignment, roster = [], accepted = [], teams = [] }) {
  const byLogin = new Map();
  const add = (row) => {
    const login = typeof row?.github_login === "string" ? row.github_login.trim() : "";
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
    for (const row of cohortStudents(assignment, roster)) add(row);
  }
  for (const row of accepted || []) {
    if (row?.acceptance_state === "not-accepted") continue;
    add(row);
  }

  const inTeam = new Set();
  for (const t of teams || []) {
    for (const m of Array.isArray(t?.members) ? t.members : []) inTeam.add(String(m).toLowerCase());
  }
  const all = [...byLogin.values()];
  return { all, unassigned: all.filter((s) => !inTeam.has(s.github_login.toLowerCase())) };
}
