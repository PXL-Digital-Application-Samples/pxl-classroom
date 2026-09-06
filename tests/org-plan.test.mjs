// The organization's plan, and why a diagnostic watches it.
//
// GitHub Team is free for verified educators, so an organization on the paid
// tier and one that simply never applied look identical from the outside -
// nobody upgraded because nothing ever asked them to. Measured 2026-09-07
// against the live registry: FOUR of the twelve readable participating
// organizations answer `free`, one of them `PXLCloudAndAutomation`, and so does
// `pxl-classroom-testbed`, where the end-to-end flow is rehearsed.
//
// Nothing is broken on Free, which is why this is a warning. Every endpoint the
// system calls works there; group assignments never touch the org Teams
// feature; and acceptance costs no minutes, because brokers are public
// repositories. Two things degrade, both only at the deadline and both
// silently:
//
//   1. Rulesets are Team-and-above and do not apply to PRIVATE repositories on
//      Free. Student repositories are private, so `lockdown.mjs` falls back to
//      demotion - correct, recorded as `lock_method: "demotion"` so the unlock
//      still matches, but demotion also removes Actions, secrets, environments
//      and settings. On a cloud-and-automation course that is the subject
//      matter, confiscated at the deadline.
//   2. Protected branches are Team-and-above on private repositories too, so
//      the Feedback PR baseline is created unprotected and a student, who is
//      admin on their own repository, can force-push or delete it.
//
// The rule this file pins hardest is the sibling's: a value we could not READ
// is not evidence. `plan` is returned at the same access level as
// `default_repository_permission` - both come from one `GET /orgs/{org}` and
// both are visible only to an org admin - so an absent one must produce NO
// check rather than a green one.

import { test } from "node:test";
import assert from "node:assert/strict";

import { runDiagnostics } from "../lib/diagnostics.mjs";
import {
  organizationPlanFinding,
  FREE_PLAN,
  MANIFEST_APP_PERMISSIONS,
  APP_SLUG,
  EXPECTED_APP_PERMISSIONS,
  CONTROL_REPO,
} from "../lib/audit.mjs";

const ORG = "PXLCloudAndAutomation";

// --------------------------------------------------------------------------
// The judgement itself
// --------------------------------------------------------------------------

test("an unreadable plan is not evidence of a good one", () => {
  // The field needs org-admin access. A lecturer who does not have it must not
  // be told the organization is fine, and must not be told it is Free either.
  for (const value of [undefined, null, ""]) {
    assert.equal(organizationPlanFinding(value, { org: ORG }), null, JSON.stringify(value));
  }
});

test("free is a warning, never a failure - nothing here is broken", () => {
  const f = organizationPlanFinding("free", { org: ORG });
  assert.equal(f.severity, "warn");
  assert.equal(f.plan, "free");
});

test("the warning says what actually degrades, and what actually fixes it", () => {
  const { message } = organizationPlanFinding("free", { org: ORG });

  // The two consequences, in the lecturer's terms rather than the API's.
  assert.match(message, /Actions, secrets and environments/,
    "demotion takes more than push, and that is the whole reason this warns");
  assert.match(message, /Feedback PR baseline/);
  // The fix, which is free, and where to do it.
  assert.match(message, /free for verified\s+educators/);
  assert.match(message, /education\/teachers/);
  // AND THAT NOTHING BREAKS. A warning that only lists damage reads as an
  // outage and sends a lecturer to cancel an assignment that would have worked.
  assert.match(message, /Nothing\s+fails/);
});

test("the message never sends a lecturer to this repository's own documentation", () => {
  // DESIGN.md 1.6. The runbooks are for whoever operates a deployment; a
  // lecturer reading System Health is not that person.
  const { message } = organizationPlanFinding("free", { org: ORG });
  assert.doesNotMatch(message, /RUNBOOK|ARCHITECTURE|ADMIN\.md|LESSONS|§/);
});

test("a paid plan passes, and is named rather than merely approved", () => {
  // Measured live: `team` is what the upgraded PXL organizations answer.
  for (const plan of ["team", "enterprise", "business"]) {
    const f = organizationPlanFinding(plan, { org: ORG });
    assert.equal(f.severity, "ok", plan);
    assert.equal(f.plan, plan);
    assert.match(f.message, new RegExp(plan), "the check says WHICH plan it saw");
  }
});

test("the plan name is compared case-insensitively", () => {
  // The value is GitHub's, not ours, and a capitalisation change must not
  // silently turn the warning off.
  assert.equal(organizationPlanFinding("FREE", { org: ORG }).severity, "warn");
  assert.equal(organizationPlanFinding("Free", { org: ORG }).severity, "warn");
});

test("FREE_PLAN is the literal GitHub actually returns", () => {
  // Observed 2026-09-07 on pxl-classroom-testbed, PXL-RP, pxl-grpro-csmobile,
  // PXLCloudAndAutomation and PXL-2TIN-NetAdv-26-27: `.plan.name == "free"`.
  // Pinned because the whole check turns off if this string stops matching,
  // and it would turn off SILENTLY - every org would read as upgraded.
  assert.equal(FREE_PLAN, "free");
  assert.equal(organizationPlanFinding(FREE_PLAN, { org: ORG }).severity, "warn");
});

// --------------------------------------------------------------------------
// Wired into System Health
// --------------------------------------------------------------------------

function makeReq({ orgOk = true, plan = "team", omitPlan = false } = {}) {
  return async (method, path) => {
    if (path === `/apps/${APP_SLUG}`) {
      return { status: 200, ok: true, data: { slug: APP_SLUG, permissions: { ...MANIFEST_APP_PERMISSIONS } } };
    }
    if (path === "/user") return { status: 200, ok: true, data: { login: "lecturer" } };
    if (path === "/user/installations") {
      return {
        status: 200, ok: true,
        data: {
          total_count: 1,
          installations: [
            { id: 1, account: { login: ORG }, repository_selection: "all", permissions: { ...EXPECTED_APP_PERMISSIONS } },
          ],
        },
      };
    }
    if (path === `/orgs/${ORG}`) {
      if (!orgOk) return { status: 403, ok: false, data: { message: "Forbidden" } };
      // The shape the real endpoint returns: the plan is an OBJECT with a
      // `name`, sitting beside the base permission in one response.
      const data = { login: ORG, default_repository_permission: "none" };
      if (!omitPlan) data.plan = { name: plan, seats: 18, filled_seats: 18 };
      return { status: 200, ok: true, data };
    }
    if (path === `/repos/${ORG}/${CONTROL_REPO}`) return { status: 200, ok: true, data: { private: true } };
    return { status: 404, ok: false, data: { message: "Not Found" } };
  };
}

async function planCheck(opts) {
  const res = await runDiagnostics({ request: makeReq(opts), org: ORG });
  return res.tiers.flatMap((t) => t.checks).find((c) => c.id === "org-plan") || null;
}

test("diagnostics: a free org is warned about, in tier 1", async () => {
  const c = await planCheck({ plan: "free" });
  assert.ok(c, "the check must run");
  assert.equal(c.severity, "warn");
  assert.equal(c.tierId, "tier-1-org");
  assert.equal(c.detail?.plan, "free");
  assert.match(c.detail?.upgrade_url, /education/);
});

test("diagnostics: being on free does not fail the tier - the org still works", async () => {
  // The distinction that matters. A `fail` here would tell a lecturer their
  // organization is broken on the morning of an exam that will run fine.
  //
  // Asserted as a COMPARISON rather than against a literal: this harness stubs
  // only what tier 1 reads about the organization, so other checks in the tier
  // fail on their own and a bare `notEqual(tier.severity, "fail")` would be
  // measuring those instead of this one. The plan must make no difference.
  const tierFor = async (plan) => {
    const res = await runDiagnostics({ request: makeReq({ plan }), org: ORG });
    return res.tiers.find((t) => t.id === "tier-1-org");
  };
  const free = await tierFor("free");
  const team = await tierFor("team");

  assert.equal(free.checks.find((c) => c.id === "org-plan").severity, "warn");
  assert.equal(team.checks.find((c) => c.id === "org-plan").severity, "ok");
  assert.equal(free.severity, team.severity, "the plan must not change the tier's verdict");
});

test("diagnostics: a team org passes and carries no fix to act on", async () => {
  const c = await planCheck({ plan: "team" });
  assert.equal(c.severity, "ok");
  assert.equal(c.detail, null);
});

test("diagnostics: an unreadable /orgs/{org} produces NO plan check", async () => {
  assert.equal(await planCheck({ orgOk: false }), null);
});

test("diagnostics: an org response with no plan field produces no check", async () => {
  assert.equal(await planCheck({ omitPlan: true }), null);
});

test("diagnostics: reading the plan costs no extra request", async () => {
  // It rides the response the base-permission check already fetched. A second
  // GET would be one more call on every System Health run for a field that was
  // already in hand.
  const calls = [];
  const base = makeReq({ plan: "free" });
  await runDiagnostics({
    request: async (method, path) => { calls.push(`${method} ${path}`); return base(method, path); },
    org: ORG,
  });
  assert.equal(calls.filter((c) => c === `GET /orgs/${ORG}`).length, 1);
});
