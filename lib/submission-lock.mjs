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
// (UX_PLAN §10 risk 2):
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
