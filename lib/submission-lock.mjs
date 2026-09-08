// PXL Classroom - stopping writes to a submission ref.
//
// `late_policy: block` promised to refuse late pushes and did nothing: no code
// read the field. What lockdown did instead was demote every student to `pull`,
// which does not just remove push - it removes Actions, secrets, environments,
// runners and settings. On a course whose subject *is* those things, that
// confiscates the subject matter at the deadline.
//
// A repository ruleset takes only what is needed:
//
//   update           pushing to the submission ref
//   non_fast_forward force-push - closes the history-rewriting hole
//   deletion         deleting the branch
//
// with the Provisioner App in `bypass_actors` so the system can still write.
//
// Two properties were confirmed against a live repository before this shipped
// (ARCHITECTURE §11.2.1):
//
//   * The App pushes straight through an `active` ruleset when it is in
//     bypass_actors as `actor_type: "Integration"` - the remote answers
//     "Bypassed rule violations for refs/heads/main" and updates the ref.
//   * Nobody else does. Reading the same ruleset as an ORGANIZATION OWNER
//     returns `current_user_can_bypass: "never"` and a push is rejected with
//     GH013. A student is repo admin, strictly weaker than an org owner.
//
// Rulesets have no time conditions - `enforcement` is `disabled`/`active`/
// `evaluate` and nothing is date-aware - so the lock is a thing that gets
// flipped, not scheduled. The flip is one PUT with a partial body, which means
// it cannot accidentally rewrite the rules or the bypass list.
//
// HTTP-stack-agnostic like lib/gittree.mjs: every function takes a `request`
// shaped like lib/gh.mjs's `gh(method, path, body) -> {ok, status, data}`, so
// the CLI, a script and a workflow can all drive it.

import { APP_SLUG } from "./audit.mjs";

/** The one ruleset this system owns on a student repository. */
export const SUBMISSION_LOCK_NAME = "pxl-classroom-deadline";

/**
 * The ruleset body. `enforcement` is the only thing that changes over an
 * assignment's life.
 *
 * `bypass_actors` is required, not optional: a lock the App cannot bypass would
 * also block starter-code sync and any future unlock, and there is no way to
 * remove it afterwards except by deleting the ruleset. Callers must resolve the
 * App id first and fall back to demotion if they cannot.
 */
export function submissionLockRuleset({ submissionRef, appId, enforcement = "disabled" }) {
  return {
    name: SUBMISSION_LOCK_NAME,
    target: "branch",
    enforcement,
    bypass_actors: [{ actor_id: appId, actor_type: "Integration", bypass_mode: "always" }],
    conditions: { ref_name: { include: [submissionRef], exclude: [] } },
    rules: [{ type: "update" }, { type: "non_fast_forward" }, { type: "deletion" }],
  };
}

/**
 * The App's numeric id, which is what `bypass_actors` takes - the slug will not
 * do. `GET /apps/{slug}` is a public endpoint, so this works with an
 * installation token, but it is a network call that can fail; every caller must
 * treat null as "do not create a ruleset".
 */
export async function resolveAppId(request, { slug = APP_SLUG, appId = null } = {}) {
  if (appId) return Number(appId);
  const res = await request("GET", `/apps/${slug}`);
  if (!res?.ok || !res.data?.id) return null;
  return res.data.id;
}

/** This system's lock on a repository, or null. Parent (org) rulesets are not ours. */
export async function findSubmissionLock(request, { org, repo }) {
  const res = await request("GET", `/repos/${org}/${repo}/rulesets`);
  if (!res?.ok || !Array.isArray(res.data)) {
    return { ok: false, reason: `list rulesets HTTP ${res?.status}`, ruleset: null };
  }
  const ruleset = res.data.find(
    (r) => r?.name === SUBMISSION_LOCK_NAME && r?.source_type !== "Organization"
  );
  return { ok: true, ruleset: ruleset ?? null };
}

/**
 * Let go of the lock on one repository, without removing it.
 *
 * The inverse of `ensureSubmissionLock(… enforcement: "active")`, and it lives
 * here rather than beside its caller because a second place that knows how to
 * change this ruleset is a second place to get `bypass_actors` wrong.
 *
 * Two differences from calling ensureSubmissionLock with `disabled`, and both
 * are the reason this exists:
 *
 *   * It never CREATES. An absent ruleset means nothing is locked, and
 *     answering that by creating a disabled one leaves a ruleset on a
 *     repository nobody asked to have one, reported as a successful unlock.
 *     `action: "absent"` says so instead.
 *   * It never touches the rules or the bypass list. `enforcement` is the only
 *     field sent, so re-locking later is one more flip - where a delete and a
 *     re-create risks a ruleset the App cannot bypass, which locks this system
 *     out of the repository along with the student.
 *
 * @returns {{ok: boolean, action: "released"|"already"|"absent"|"failed",
 *            rulesetId: number|null, reason: string|null}}
 */
export async function releaseSubmissionLock(request, { org, repo }) {
  const found = await findSubmissionLock(request, { org, repo });
  if (!found.ok) return { ok: false, action: "failed", rulesetId: null, reason: found.reason };
  if (!found.ruleset) {
    return { ok: false, action: "absent", rulesetId: null,
      reason: `no ${SUBMISSION_LOCK_NAME} ruleset on ${org}/${repo}` };
  }
  if (found.ruleset.enforcement === "disabled") {
    return { ok: true, action: "already", rulesetId: found.ruleset.id, reason: null };
  }

  const res = await request("PUT", `/repos/${org}/${repo}/rulesets/${found.ruleset.id}`, { enforcement: "disabled" });
  if (!res?.ok) {
    return { ok: false, action: "failed", rulesetId: found.ruleset.id,
      reason: `update ruleset HTTP ${res?.status} ${res?.data?.message ?? ""}`.trim() };
  }
  // Read it back off the response rather than assuming. This is the
  // verification that the student can actually push again, and it is the whole
  // value of the control - a button that reports an unlock it did not perform
  // sends somebody to argue with a student who still cannot hand in.
  if (res.data?.enforcement !== "disabled") {
    return { ok: false, action: "failed", rulesetId: found.ruleset.id,
      reason: `enforcement is still ${res.data?.enforcement ?? "unknown"}` };
  }
  return { ok: true, action: "released", rulesetId: found.ruleset.id, reason: null };
}

/**
 * Bring the lock on one repository to `enforcement`, creating it if absent.
 *
 * Idempotent and safe to re-run: an already-active lock reports `unchanged`.
 * The update sends only `enforcement`, so a flip can never rewrite the rules or
 * drop the App out of the bypass list.
 *
 * @returns {{ok: boolean, action: "created"|"updated"|"unchanged"|"failed",
 *            rulesetId: number|null, enforcement: string|null, reason: string|null}}
 */
export async function ensureSubmissionLock(request, { org, repo, submissionRef, appId, enforcement }) {
  if (!appId) {
    return { ok: false, action: "failed", rulesetId: null, enforcement: null,
      reason: "no App id - a ruleset the App cannot bypass would lock the system out too" };
  }

  const found = await findSubmissionLock(request, { org, repo });
  if (!found.ok) {
    return { ok: false, action: "failed", rulesetId: null, enforcement: null, reason: found.reason };
  }

  if (!found.ruleset) {
    const res = await request(
      "POST",
      `/repos/${org}/${repo}/rulesets`,
      submissionLockRuleset({ submissionRef, appId, enforcement })
    );
    if (!res?.ok) {
      return { ok: false, action: "failed", rulesetId: null, enforcement: null,
        reason: `create ruleset HTTP ${res?.status} ${res?.data?.message ?? ""}`.trim() };
    }
    return { ok: true, action: "created", rulesetId: res.data.id, enforcement: res.data.enforcement, reason: null };
  }

  if (found.ruleset.enforcement === enforcement) {
    return { ok: true, action: "unchanged", rulesetId: found.ruleset.id, enforcement, reason: null };
  }

  const res = await request(
    "PUT",
    `/repos/${org}/${repo}/rulesets/${found.ruleset.id}`,
    { enforcement }
  );
  if (!res?.ok) {
    return { ok: false, action: "failed", rulesetId: found.ruleset.id, enforcement: found.ruleset.enforcement,
      reason: `update ruleset HTTP ${res?.status} ${res?.data?.message ?? ""}`.trim() };
  }
  // Read the result back off the response rather than assuming: this is the
  // verification that the cohort is actually stopped.
  return { ok: res.data?.enforcement === enforcement, action: "updated",
    rulesetId: found.ruleset.id, enforcement: res.data?.enforcement ?? null,
    reason: res.data?.enforcement === enforcement ? null : `enforcement is ${res.data?.enforcement}` };
}

// ---------------------------------------------------------------------------
// ORGANIZATION SCOPE
//
// The same lock, one level up. A repository ruleset lives in the student's own
// repository and the student is its admin, so they can delete it; an
// organization ruleset lists as `source_type: "Organization"` - visible to
// them, manageable only by an org owner. It is also ONE call for a whole
// cohort instead of two per repository, which is what matters at the instant a
// sentinel fires.
//
// TARGETED BY REPOSITORY ID, NEVER BY NAME PATTERN. Name globs collide in real
// data: `test-groepsopdracht-{team_slug}`, `test-groepsopdracht-2-{team_slug}`
// and `test-groepsopdracht-vervolg-{team_slug}` all live in one organization,
// all on `late_policy: block`, and `test-groepsopdracht-*` matches all three
// cohorts. The id also survives a rename, which is why §13 already calls it the
// primary external identifier.
//
// Measured against a live Team organization on 2026-09-08, because GitHub
// documents none of it:
//
//   repository_ids cap   >= 301 real ids - above the 250-student design target
//   PUT conditions       REPLACE, not merge, so removing one repository works
//   name length          accepted at 252, rejected at 262
//   dead id on CREATE    REJECTED 422 "repository selected does not exist"
//   dead id on UPDATE    ACCEPTED
//
// That asymmetry is the one thing this file has to be careful about, and
// `ensureOrgSubmissionLock` is where it is handled.

/** The organization ruleset covering one assignment's cohort. */
export const orgSubmissionLockName = (assignmentId) => `${SUBMISSION_LOCK_NAME}-${assignmentId}`;

/**
 * The organization ruleset body.
 *
 * `bypass_actors` is required for the same reason as the repository one: a lock
 * the App cannot bypass blocks starter-code sync and every future unlock, and
 * there is no way back except deleting the ruleset. A caller that cannot
 * resolve the App id must not create one.
 */
export function orgSubmissionLockRuleset({ assignmentId, submissionRef, appId, repositoryIds, enforcement = "disabled" }) {
  return {
    name: orgSubmissionLockName(assignmentId),
    target: "branch",
    enforcement,
    bypass_actors: [{ actor_id: appId, actor_type: "Integration", bypass_mode: "always" }],
    conditions: {
      repository_id: { repository_ids: [...repositoryIds] },
      ref_name: { include: [submissionRef], exclude: [] },
    },
    rules: [{ type: "update" }, { type: "non_fast_forward" }, { type: "deletion" }],
  };
}

/**
 * This assignment's organization ruleset, or null.
 *
 * BY NAME, NEVER BY A STORED ID. The sentinel's `STOP_ONLY` path deliberately
 * writes no lockdown record, so at the moment it fires there is no
 * `org_ruleset_id` to read - and a lookup that depended on one would silently
 * create a second ruleset every time a sentinel ran. The id on the record is a
 * convenience afterwards. Same rule `findSubmissionLock` already follows.
 */
export async function findOrgSubmissionLock(request, { org, assignmentId }) {
  const res = await request("GET", `/orgs/${org}/rulesets`);
  if (!res?.ok) {
    return { ok: false, reason: `list org rulesets HTTP ${res?.status}`, ruleset: null };
  }
  const name = orgSubmissionLockName(assignmentId);
  const hit = (Array.isArray(res.data) ? res.data : []).find((r) => r?.name === name);
  if (!hit) return { ok: true, reason: null, ruleset: null };

  // The list endpoint does not return `conditions`, and every caller here needs
  // the id list. One more read, and only when ours exists.
  const full = await request("GET", `/orgs/${org}/rulesets/${hit.id}`);
  if (!full?.ok) {
    return { ok: false, reason: `read org ruleset ${hit.id} HTTP ${full?.status}`, ruleset: null };
  }
  return { ok: true, reason: null, ruleset: full.data };
}

/** The repository ids an org ruleset currently targets. */
export function targetedRepositoryIds(ruleset) {
  const ids = ruleset?.conditions?.repository_id?.repository_ids;
  return Array.isArray(ids) ? ids.filter((n) => Number.isInteger(n)) : [];
}

/** Whatever GitHub said, flattened, for a reason string. */
function messageOf(res) {
  const errs = res?.data?.errors;
  return [res?.data?.message, ...(Array.isArray(errs) ? errs : [])].filter(Boolean).join(" ").trim();
}

/**
 * Bring this assignment's organization lock to `enforcement` over exactly
 * `repositoryIds`, creating it if absent.
 *
 * THE DEAD-ID PROBLEM, AND WHY IT IS ONLY ON CREATE. A student can delete their
 * own repository. The control repo's `repositories/<id>/<login>.json` survives
 * that, so an id list derived from the records still carries the dead one -
 * and a CREATE carrying it is refused 422 for the whole cohort, while an UPDATE
 * carrying it is accepted (measured 2026-09-08). Verifying every repository
 * first would be N reads before the one time-critical call, which is the entire
 * thing this exists to avoid.
 *
 * So: attempt it, and on a 422 naming `repository_ids`, ask the organization
 * which of them still exist, drop the rest and try once more. `dropped` names
 * them, because a student silently missing from the lock is exactly the failure
 * this whole file is about - and a student with no repository has nothing to
 * lock, so dropping is right as long as somebody is told.
 *
 * @returns {{ok: boolean, action: "created"|"updated"|"unchanged"|"failed",
 *            rulesetId: number|null, enforcement: string|null,
 *            dropped: number[], reason: string|null}}
 */
export async function ensureOrgSubmissionLock(
  request,
  { org, assignmentId, submissionRef, appId, repositoryIds, enforcement },
) {
  if (!appId) {
    return { ok: false, action: "failed", rulesetId: null, enforcement: null, dropped: [],
      reason: "no App id - a ruleset the App cannot bypass would lock the system out too" };
  }
  const wanted = [...new Set((repositoryIds || []).filter((n) => Number.isInteger(n)))];
  if (wanted.length === 0) {
    // An empty list is refused by GitHub anyway, and a ruleset targeting
    // nothing is not a lock. Say so rather than creating one.
    return { ok: false, action: "failed", rulesetId: null, enforcement: null, dropped: [],
      reason: "no repository ids to target" };
  }

  const found = await findOrgSubmissionLock(request, { org, assignmentId });
  if (!found.ok) {
    return { ok: false, action: "failed", rulesetId: null, enforcement: null, dropped: [], reason: found.reason };
  }

  const body = (ids) => orgSubmissionLockRuleset({ assignmentId, submissionRef, appId, repositoryIds: ids, enforcement });

  if (!found.ruleset) {
    let res = await request("POST", `/orgs/${org}/rulesets`, body(wanted));
    let dropped = [];
    // ANY 422, not one whose wording we recognise. GitHub answers a create
    // carrying a deleted repository with "Invalid parameter repository_ids:
    // repository selected does not exist or is not in this organization" and
    // does not say which one - but matching that sentence would mean a reworded
    // error silently disables the recovery and the whole cohort fails to lock,
    // which is the shape of every guard in this repository that checked nothing.
    // A 422 here is unprocessable however it is worded, so re-deriving the live
    // ids and trying once more is strictly better than giving up. If the retry
    // fails too, the ORIGINAL reason is what gets reported.
    //
    // Note an id that never existed at all is silently ignored by GitHub rather
    // than refused (measured: 999999999 accepted, a real deleted repository
    // 422). Only the second is what a student deleting their repository leaves,
    // and it is the one this path is for.
    if (!res?.ok && res?.status === 422) {
      const firstReason = `create org ruleset HTTP 422 ${messageOf(res)}`.trim();
      const alive = await liveRepositoryIds(request, { org, ids: wanted });
      if (!alive.ok) {
        return { ok: false, action: "failed", rulesetId: null, enforcement: null, dropped: [],
          reason: `${alive.reason} (after ${firstReason})` };
      }
      dropped = wanted.filter((id) => !alive.ids.includes(id));
      if (alive.ids.length === 0) {
        return { ok: false, action: "failed", rulesetId: null, enforcement: null, dropped,
          reason: "none of the cohort's repositories still exist" };
      }
      if (dropped.length === 0) {
        // Every id is live, so the 422 was about something else entirely -
        // retrying with the same list would just fail the same way.
        return { ok: false, action: "failed", rulesetId: null, enforcement: null, dropped: [],
          reason: firstReason };
      }
      res = await request("POST", `/orgs/${org}/rulesets`, body(alive.ids));
      if (!res?.ok) {
        return { ok: false, action: "failed", rulesetId: null, enforcement: null, dropped,
          reason: `${firstReason}; retry without ${dropped.join(", ")} HTTP ${res?.status} ${messageOf(res)}`.trim() };
      }
    }
    if (!res?.ok) {
      return { ok: false, action: "failed", rulesetId: null, enforcement: null, dropped,
        reason: `create org ruleset HTTP ${res?.status} ${messageOf(res)}`.trim() };
    }
    return { ok: true, action: "created", rulesetId: res.data.id,
      enforcement: res.data.enforcement, dropped, reason: null };
  }

  const current = targetedRepositoryIds(found.ruleset);
  const sameIds = current.length === wanted.length && wanted.every((id) => current.includes(id));
  if (sameIds && found.ruleset.enforcement === enforcement) {
    return { ok: true, action: "unchanged", rulesetId: found.ruleset.id,
      enforcement: found.ruleset.enforcement, dropped: [], reason: null };
  }

  // Conditions are REPLACED, not merged (measured), which is what makes
  // removing a reopened student's repository work at all.
  const res = await request("PUT", `/orgs/${org}/rulesets/${found.ruleset.id}`, {
    enforcement,
    conditions: body(wanted).conditions,
  });
  if (!res?.ok) {
    return { ok: false, action: "failed", rulesetId: found.ruleset.id, enforcement: found.ruleset.enforcement,
      dropped: [], reason: `update org ruleset HTTP ${res?.status} ${messageOf(res)}`.trim() };
  }
  const applied = res.data?.enforcement === enforcement;
  return { ok: applied, action: "updated", rulesetId: found.ruleset.id,
    enforcement: res.data?.enforcement ?? null, dropped: [],
    reason: applied ? null : `enforcement is ${res.data?.enforcement}` };
}

/**
 * Which of these repository ids the organization still has.
 *
 * One request per id, and that is acceptable ONLY because this runs on the
 * 422 recovery path - never in the ordinary case, which is the whole point of
 * one PUT. An unreadable answer is not "gone": it fails, because dropping a
 * repository we merely could not read would leave that student unlocked.
 */
export async function liveRepositoryIds(request, { org, ids }) {
  const alive = [];
  for (const id of ids) {
    const res = await request("GET", `/repositories/${id}`);
    if (res?.ok) {
      // A repository that exists but has been transferred out of the org can
      // no longer be covered by this org's ruleset, and GitHub refuses it for
      // that reason too. Judged on the owner rather than on existence alone.
      const owner = res.data?.owner?.login ?? "";
      if (owner.toLowerCase() === String(org).toLowerCase()) alive.push(id);
      continue;
    }
    if (res?.status === 404) continue;  // gone - the case this exists for
    return { ok: false, ids: [], reason: `read repository ${id} HTTP ${res?.status}` };
  }
  return { ok: true, ids: alive, reason: null };
}

/**
 * Stop covering ONE repository, leaving the rest of the cohort locked.
 *
 * This is the inverse §11.2.4 needs: reopening one student under an
 * organization-scoped lock is removing one id, not flipping a flag. The ruleset
 * is RE-READ immediately before the write rather than taken from a caller's
 * copy - two lecturers reopening two students in the same window is vanishingly
 * rare on cohorts of six, and a fresh read costs one call and removes the
 * question entirely.
 *
 * Removing the LAST id would leave a ruleset targeting nothing, which GitHub
 * refuses; the whole ruleset is disabled instead, which is the same outcome
 * (nothing is locked) expressed in a way the API accepts.
 */
export async function removeRepoFromOrgLock(request, { org, assignmentId, repositoryId }) {
  const found = await findOrgSubmissionLock(request, { org, assignmentId });
  if (!found.ok) return { ok: false, action: "failed", reason: found.reason };
  if (!found.ruleset) {
    return { ok: false, action: "absent",
      reason: `no ${orgSubmissionLockName(assignmentId)} ruleset on ${org}` };
  }

  const current = targetedRepositoryIds(found.ruleset);
  if (!current.includes(repositoryId)) {
    return { ok: true, action: "already", reason: null };
  }
  const remaining = current.filter((id) => id !== repositoryId);

  if (remaining.length === 0) {
    const res = await request("PUT", `/orgs/${org}/rulesets/${found.ruleset.id}`, { enforcement: "disabled" });
    if (!res?.ok || res.data?.enforcement !== "disabled") {
      return { ok: false, action: "failed",
        reason: `disable org ruleset HTTP ${res?.status} ${res?.data?.enforcement ?? ""}`.trim() };
    }
    return { ok: true, action: "disabled", reason: null };
  }

  const res = await request("PUT", `/orgs/${org}/rulesets/${found.ruleset.id}`, {
    conditions: {
      repository_id: { repository_ids: remaining },
      ref_name: found.ruleset.conditions?.ref_name ?? { include: [], exclude: [] },
    },
  });
  if (!res?.ok) {
    return { ok: false, action: "failed",
      reason: `update org ruleset HTTP ${res?.status} ${messageOf(res)}`.trim() };
  }
  // Verified off the response, not assumed. This is what tells a lecturer the
  // student can push again, and a control that reports an unlock it did not
  // perform sends somebody to argue with a student who still cannot hand in.
  if (targetedRepositoryIds(res.data).includes(repositoryId)) {
    return { ok: false, action: "failed", reason: "the repository is still covered by the organization ruleset" };
  }
  return { ok: true, action: "removed", reason: null };
}
