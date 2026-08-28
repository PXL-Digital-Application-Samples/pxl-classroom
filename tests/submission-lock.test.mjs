// PXL Classroom - submission-lock.test.mjs
//
// The ruleset that stops pushes to a submission ref, unit-tested against a
// scripted `request`. The live behaviour it depends on was confirmed against a
// real repository (ARCHITECTURE §11.2.1) and is pinned here as shape:
//
//   * the App is in bypass_actors as actor_type "Integration" - without it the
//     lock also blocks starter-code sync and any future unlock, and there is no
//     way back except deleting the ruleset
//   * the flip sends ONLY enforcement, so it can never rewrite the rules or
//     drop the bypass list
//   * an unresolvable App id means no ruleset at all

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SUBMISSION_LOCK_NAME,
  ensureSubmissionLock,
  findSubmissionLock,
  resolveAppId,
  submissionLockRuleset,
} from "../lib/submission-lock.mjs";

const APP_ID = 4051936;

/** A `gh`-shaped request driven by a route table, recording every call. */
function stub(routes) {
  const calls = [];
  const request = async (method, path, body) => {
    calls.push({ method, path, body });
    for (const [pattern, handler] of routes) {
      if (pattern.test(`${method} ${path}`)) {
        const res = typeof handler === "function" ? handler(body) : handler;
        return { ok: res.status >= 200 && res.status < 300, status: res.status, data: res.data };
      }
    }
    return { ok: false, status: 404, data: { message: `not stubbed: ${method} ${path}` } };
  };
  return { request, calls };
}

const existing = (enforcement, id = 99) => ({
  id, name: SUBMISSION_LOCK_NAME, source_type: "Repository", enforcement,
});

// --- the ruleset body --------------------------------------------------------

test("the ruleset blocks push, force-push and deletion, and nothing else", () => {
  const rs = submissionLockRuleset({ submissionRef: "refs/heads/main", appId: APP_ID, enforcement: "active" });
  assert.deepEqual(rs.rules.map((r) => r.type).sort(), ["deletion", "non_fast_forward", "update"]);
  assert.deepEqual(rs.conditions.ref_name.include, ["refs/heads/main"]);
  assert.equal(rs.enforcement, "active");
  assert.equal(rs.target, "branch");
});

test("the App is in bypass_actors as an Integration", () => {
  // Confirmed live: with this entry the App's push answers "Bypassed rule
  // violations"; an org owner reading the same ruleset gets
  // current_user_can_bypass "never".
  const rs = submissionLockRuleset({ submissionRef: "refs/heads/main", appId: APP_ID });
  assert.deepEqual(rs.bypass_actors, [
    { actor_id: APP_ID, actor_type: "Integration", bypass_mode: "always" },
  ]);
});

test("a non-default submission ref is what gets locked", () => {
  const rs = submissionLockRuleset({ submissionRef: "refs/heads/submission", appId: APP_ID });
  assert.deepEqual(rs.conditions.ref_name.include, ["refs/heads/submission"]);
});

// --- resolving the App id ----------------------------------------------------

test("the App id comes from the slug, and an override skips the call", async () => {
  const { request, calls } = stub([[/^GET \/apps\//, { status: 200, data: { id: APP_ID } }]]);
  assert.equal(await resolveAppId(request), APP_ID);
  assert.match(calls[0].path, /^\/apps\/pxl-classroom-provisioner$/);

  const pre = stub([]);
  assert.equal(await resolveAppId(pre.request, { appId: "1234" }), 1234);
  assert.deepEqual(pre.calls, [], "an override must not cost a request");
});

test("an unreadable App declaration resolves to null rather than guessing", async () => {
  const { request } = stub([[/^GET \/apps\//, { status: 502, data: {} }]]);
  assert.equal(await resolveAppId(request), null);
});

// --- finding ours ------------------------------------------------------------

test("an organization ruleset of the same name is not ours to flip", async () => {
  const { request } = stub([
    [/^GET .*\/rulesets$/, { status: 200, data: [
      { id: 1, name: SUBMISSION_LOCK_NAME, source_type: "Organization", enforcement: "active" },
    ] }],
  ]);
  const found = await findSubmissionLock(request, { org: "o", repo: "r" });
  assert.equal(found.ok, true);
  assert.equal(found.ruleset, null);
});

// --- ensure ------------------------------------------------------------------

test("no App id means no ruleset - a lock the system cannot bypass is worse than none", async () => {
  const { request, calls } = stub([]);
  const res = await ensureSubmissionLock(request, {
    org: "o", repo: "r", submissionRef: "refs/heads/main", appId: null, enforcement: "active",
  });
  assert.equal(res.ok, false);
  assert.equal(res.action, "failed");
  assert.match(res.reason, /App id/);
  assert.deepEqual(calls, [], "and it must not have tried");
});

test("a repository with no lock yet gets one created at the asked-for enforcement", async () => {
  const { request, calls } = stub([
    [/^GET .*\/rulesets$/, { status: 200, data: [] }],
    [/^POST .*\/rulesets$/, (body) => ({ status: 201, data: { id: 7, enforcement: body.enforcement } })],
  ]);
  const res = await ensureSubmissionLock(request, {
    org: "o", repo: "r", submissionRef: "refs/heads/main", appId: APP_ID, enforcement: "active",
  });
  assert.equal(res.ok, true);
  assert.equal(res.action, "created");
  assert.equal(res.rulesetId, 7);
  assert.equal(calls.at(-1).body.bypass_actors[0].actor_id, APP_ID);
});

test("an existing lock is flipped with enforcement alone", async () => {
  // The rules and the bypass list must not be resent: a partial body cannot
  // accidentally rewrite what the lock is while turning it on.
  const { request, calls } = stub([
    [/^GET .*\/rulesets$/, { status: 200, data: [existing("disabled")] }],
    [/^PUT .*\/rulesets\/99$/, (body) => ({ status: 200, data: { id: 99, enforcement: body.enforcement } })],
  ]);
  const res = await ensureSubmissionLock(request, {
    org: "o", repo: "r", submissionRef: "refs/heads/main", appId: APP_ID, enforcement: "active",
  });
  assert.equal(res.ok, true);
  assert.equal(res.action, "updated");
  assert.deepEqual(Object.keys(calls.at(-1).body), ["enforcement"]);
});

test("an already-active lock is left alone", async () => {
  const { request, calls } = stub([
    [/^GET .*\/rulesets$/, { status: 200, data: [existing("active")] }],
  ]);
  const res = await ensureSubmissionLock(request, {
    org: "o", repo: "r", submissionRef: "refs/heads/main", appId: APP_ID, enforcement: "active",
  });
  assert.equal(res.action, "unchanged");
  assert.equal(res.ok, true);
  assert.equal(calls.length, 1, "idempotent, and it costs one read");
});

test("a flip that did not take is reported as not ok", async () => {
  // The read-back IS the verification that the cohort is stopped. Trusting the
  // 200 would report a lock that is not enforcing.
  const { request } = stub([
    [/^GET .*\/rulesets$/, { status: 200, data: [existing("disabled")] }],
    [/^PUT .*\/rulesets\/99$/, { status: 200, data: { id: 99, enforcement: "evaluate" } }],
  ]);
  const res = await ensureSubmissionLock(request, {
    org: "o", repo: "r", submissionRef: "refs/heads/main", appId: APP_ID, enforcement: "active",
  });
  assert.equal(res.ok, false);
  assert.match(res.reason, /evaluate/);
});

test("a failed create and an unreadable list both report why", async () => {
  const denied = stub([
    [/^GET .*\/rulesets$/, { status: 200, data: [] }],
    [/^POST .*\/rulesets$/, { status: 403, data: { message: "Resource not accessible by integration" } }],
  ]);
  const a = await ensureSubmissionLock(denied.request, {
    org: "o", repo: "r", submissionRef: "refs/heads/main", appId: APP_ID, enforcement: "active",
  });
  assert.equal(a.ok, false);
  assert.match(a.reason, /403/);
  assert.match(a.reason, /not accessible/);

  const unreadable = stub([[/^GET .*\/rulesets$/, { status: 500, data: {} }]]);
  const b = await ensureSubmissionLock(unreadable.request, {
    org: "o", repo: "r", submissionRef: "refs/heads/main", appId: APP_ID, enforcement: "active",
  });
  assert.equal(b.ok, false);
  assert.match(b.reason, /500/);
});
