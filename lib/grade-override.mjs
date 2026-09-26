// What a LECTURER decided about one student's grade, over the rules.
//
// Two decisions, kept in overrides/<id>/<login>.json beside the extensions and
// hand-in allowances:
//
//   submission_sha - grade this student on THIS commit. For the late hand-in,
//                    the one past the cap, the version before a mistake. The
//                    rules (deadline, cap, which hand-in counts) are skipped for
//                    them; the score is still read from that commit's grading
//                    run, and a commit with none is not graded at all.
//   manual_score   - this is the score. Wins over any grading result.
//
// Precedence is manual score > chosen commit > the rules, and each is revoked
// by appending the same type with value null - the list is append-only, the
// last entry of a type is in force, and the history stays readable in a dispute.
//
// STORED, not applied once. A choice that lived only in the summary it
// produced was reverted by the next "Re-grade all", the nightly, or the CLI -
// all three read through here. For a team repository the Admin Panel writes the
// decision on every member (one repository, one submission); a member without
// one of their own takes the newest among their teammates.
//
// ISOMORPHIC: no `node:` imports.

import { indexOverrides } from "./effective-deadline.mjs";

export const CHOSEN_COMMIT = "submission_sha";
export const MANUAL_SCORE = "manual_score";

const norm = (login) => (typeof login === "string" ? login.toLowerCase() : "");
const SHA = /^[0-9a-f]{40}$/;

/** The entry of `type` in force in one document: the last valid one, or null (none, or revoked). */
function lastOf(doc, type, valid) {
  const entries = Array.isArray(doc?.overrides) ? doc.overrides : [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e?.type !== type) continue;
    if (e.value === null) return null; // revoked
    if (valid(e.value)) return e;
    // A malformed entry is skipped rather than trusted, so a hand-edited file
    // cannot erase an earlier valid decision.
  }
  return null;
}

const validSha = (v) => typeof v === "string" && SHA.test(v);
const validScore = (v) =>
  v && typeof v === "object" && Number.isFinite(v.earned) && Number.isFinite(v.total) && v.total > 0 && v.earned >= 0 && v.earned <= v.total;

/**
 * The decision in force for `login`, or null for "the rules".
 *
 * @param {string} login
 * @param {{ overrides?: Map|Array|null, team?: {members?: string[]}|null }} [ctx]
 * @returns {null | { kind: "score", earned: number, total: number, by: string, at: string, reason: string }
 *                | { kind: "commit", sha: string, by: string, at: string, reason: string }}
 */
export function gradeDecisionFor(login, { overrides = null, team = null } = {}) {
  const index = indexOverrides(overrides instanceof Map ? [...overrides.values()] : overrides);
  const pick = (type, valid) => {
    const own = lastOf(index.get(norm(login)), type, valid);
    // Their own entry decides whenever they have ANY entry of this type -
    // including a revocation, which must not be undone by a teammate's copy.
    const ownDoc = index.get(norm(login));
    const hasOwn = Array.isArray(ownDoc?.overrides) && ownDoc.overrides.some((e) => e?.type === type);
    if (hasOwn) return own;
    let best = null;
    for (const m of team?.members || []) {
      if (norm(m) === norm(login)) continue;
      const e = lastOf(index.get(norm(m)), type, valid);
      if (e && (!best || String(e.overridden_at) > String(best.overridden_at))) best = e;
    }
    return best;
  };
  const score = pick(MANUAL_SCORE, validScore);
  if (score) {
    return { kind: "score", earned: score.value.earned, total: score.value.total, by: score.overridden_by, at: score.overridden_at, reason: score.reason };
  }
  const commit = pick(CHOSEN_COMMIT, validSha);
  if (commit) return { kind: "commit", sha: commit.value, by: commit.overridden_by, at: commit.overridden_at, reason: commit.reason };
  return null;
}

/** The summary row's `decided_by`, from a decision. */
export function decisionRecord(decision) {
  return decision ? { kind: decision.kind, by: decision.by, at: decision.at, reason: decision.reason } : null;
}

/**
 * Why a decision cannot be written, or null. The dialog and the handler ask
 * the same function, so a disabled button and a refusal cannot disagree.
 */
export function decisionProblem({ type, value, reason }) {
  if (!String(reason ?? "").trim()) return "Give a reason - it is recorded with the grade.";
  if (value === null) return null; // a revocation
  if (type === CHOSEN_COMMIT && !validSha(value)) return "That is not a full commit id.";
  if (type === MANUAL_SCORE) {
    if (!value || !Number.isFinite(value.earned) || !Number.isFinite(value.total)) return "Enter both the score and the total.";
    if (!(value.total > 0)) return "The total has to be more than 0.";
    if (value.earned < 0) return "The score cannot be negative.";
    if (value.earned > value.total) return "The score cannot be more than the total.";
  }
  if (type !== CHOSEN_COMMIT && type !== MANUAL_SCORE) return `Unknown decision "${type}".`;
  return null;
}

/** The entry a decision (or, with value null, its revocation) appends. */
export function decisionEntry({ type, value, reason, by, at = new Date().toISOString() }) {
  return { type, value, reason: String(reason ?? "").trim(), overridden_by: by, overridden_at: at };
}
