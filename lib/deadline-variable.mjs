// PXL Classroom - a student's own deadline, delivered to their own repository.
//
// A deadline extension lives in overrides/<id>/<login>.json in the control
// repository, which is private to staff. The student pages read it there with
// the student's own token and were answered 404, so an extended student never
// saw their extension: "Deadline passed" in red, and "Submitted late" for work
// pushed inside the time they were given - while the lock and the grading,
// which run as the App, honoured it (found by the live UI suite, 2026-10-15).
//
// DECIDED (2026-10-15): the deadline in force is written as an Actions variable
// on the student's repository when an extension is granted, and read there by
// their page. Only the student, their teammates and staff can read a private
// repository's variables, and never its reason, which is not written. The
// cohort's published data was the other option, refused because anyone with
// the invitation link could then see who was given more time.
//
// WHO CAN READ IT, measured (tests/live/variable-probe.mjs, 2026-10-15): a
// collaborator with push access - write, maintain or admin - reads it (200);
// triage and read are answered 404 for a variable that exists. So a locked,
// demoted student cannot read theirs, and a 404 means "no extension" only to a
// reader the repository says can push (`permissions.push`).
//
// Isomorphic: the SPA, provisioning and the tests import it; `request` is the
// caller's (method, path, body) -> {ok, status, data}.

import { effectiveDeadlineFor } from "./effective-deadline.mjs";

/** The variable's name on every student repository. */
export const DEADLINE_VARIABLE = "PXL_DEADLINE";

/**
 * What the repository should carry: the deadline in force when an extension
 * makes it later than the assignment's, as an ISO instant, or null for none.
 * A team repository carries the most generous member's (lib/effective-deadline.mjs).
 *
 * @param {{deadline_at?: string}} assignment
 * @param {string} login
 * @param {{overrides?: Map|Array, team?: {members?: string[]}}} [context]
 * @returns {string|null}
 */
export function deadlineVariableValue(assignment, login, context = {}) {
  const eff = effectiveDeadlineFor(assignment, login, context);
  return eff.extended && eff.deadline ? eff.deadline.toISOString() : null;
}

/** A stored value read back: a Date only for a well-formed ISO instant. */
export function parseDeadlineVariable(value) {
  const text = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text)) return null;
  const at = Date.parse(text);
  return Number.isFinite(at) ? new Date(at) : null;
}

/**
 * Write the value, or remove the variable for null.
 *
 * @param {(method: string, path: string, body?: object) => Promise<{ok: boolean, status: number}>} request
 * @param {{repoFullName: string, value: string|null}} args
 * @returns {Promise<{ok: boolean, status: number}>}
 */
export async function writeDeadlineVariable(request, { repoFullName, value }) {
  const at = `/repos/${repoFullName}/actions/variables`;
  if (value == null) {
    const res = await request("DELETE", `${at}/${DEADLINE_VARIABLE}`);
    return { ok: res.ok || res.status === 404, status: res.status };
  }
  // PATCH first: a repository that already carries one is the usual case for a
  // second extension, and POST on an existing name is a 409.
  const patched = await request("PATCH", `${at}/${DEADLINE_VARIABLE}`, { name: DEADLINE_VARIABLE, value });
  if (patched.ok) return { ok: true, status: patched.status };
  if (patched.status !== 404) return { ok: false, status: patched.status };
  const made = await request("POST", at, { name: DEADLINE_VARIABLE, value });
  return { ok: made.ok, status: made.status };
}

/**
 * What a student's own page will show as their deadline, against what it
 * should - for the lecturer's dialog, worked out from both each time it opens
 * (DESIGN.md §1.5) rather than remembered from the grant.
 *
 * @param {{ expected: string|null, expectedKnown?: boolean,
 *           read: {state: "set", at: Date} | {state: "none"} | {state: "unreadable"} | {state: "no-repo"} }} args
 *   `expected` is deadlineVariableValue's answer; `read` is readDeadlineVariable's,
 *   or `no-repo` for a student with no repository yet. `expectedKnown: false`
 *   when the extensions it is worked out from could not be read: then null is
 *   not "no extension", and a page showing one is not "behind" (review
 *   2026-10-15, R6-10: Send it to their page then deleted a real one).
 * @returns {{ state: "no-repo"|"unknown"|"none"|"current"|"behind", at: Date|null, expected: Date|null, expectedUnknown?: boolean }}
 *   `behind`: it shows another date, or none, or one no extension gives
 */
export function pageDeadlineState({ expected, read, expectedKnown = true }) {
  if (!expectedKnown) return { state: "unknown", at: null, expected: null, expectedUnknown: true };
  const want = parseDeadlineVariable(expected);
  if (read?.state === "no-repo") return { state: "no-repo", at: null, expected: want };
  if (read?.state !== "set" && read?.state !== "none") return { state: "unknown", at: null, expected: want };
  const at = read.state === "set" ? read.at : null;
  if (!want && !at) return { state: "none", at: null, expected: null };
  if (want && at && want.getTime() === at.getTime()) return { state: "current", at, expected: want };
  return { state: "behind", at, expected: want };
}

/**
 * Read it, as the student whose page this is.
 *
 * @param {(method: string, path: string) => Promise<{ok: boolean, status: number, data?: any}>} request
 * @param {{repoFullName: string, canPush: boolean|null}} args  `canPush`: the
 *   repository's own `permissions.push` for this reader, null when unknown
 * @returns {Promise<{state: "set", at: Date} | {state: "none"} | {state: "unreadable", status: number}>}
 *   `unreadable` includes a 404 to a reader who cannot push: the variable may
 *   well exist (a locked student, measured above).
 */
export async function readDeadlineVariable(request, { repoFullName, canPush }) {
  const res = await request("GET", `/repos/${repoFullName}/actions/variables/${DEADLINE_VARIABLE}`);
  if (res.ok) {
    const at = parseDeadlineVariable(res.data?.value);
    return at ? { state: "set", at } : { state: "unreadable", status: res.status };
  }
  if (res.status === 404 && canPush === true) return { state: "none" };
  return { state: "unreadable", status: res.status };
}
