// The organization's base repository permission, and why a diagnostic watches it.
//
// `default_repository_permission` is the floor every ORG MEMBER gets on every
// repository, private ones included. Today students are repository
// COLLABORATORS, not members (provisioning/provision.mjs), so a loose value
// costs nothing - which is precisely why nobody looks at it. Six of seven
// readable PXL orgs are `none`; PXL-CSMobile was `read`, set when the org was
// created in 2024, a year before pxl-classroom existed.
//
// Two things make it load-bearing the moment membership is used for enrolment:
//
//   1. GitHub grants the HIGHEST applicable permission, so a base of `write`
//      sits underneath lockdown's demotion-to-`pull` as a floor it cannot go
//      below. The freeze reports success and the student can still push.
//   2. It applies to PRIVATE repositories, and `pxl-classroom-control` is one:
//      the roster (names, student numbers, institutional emails) plus every
//      report, readable by every member at `read`.
//
// The rule this file pins hardest: a value we could not READ is not evidence
// of anything. The field is returned to org admins only, so an absent one must
// produce no check at all rather than a green one.

import { test } from "node:test";
import assert from "node:assert/strict";

import { runDiagnostics } from "../lib/diagnostics.mjs";
import {
  baseRepositoryPermissionFinding,
  MANIFEST_APP_PERMISSIONS,
  APP_SLUG,
  EXPECTED_APP_PERMISSIONS,
  CONTROL_REPO,
} from "../lib/audit.mjs";

const ORG = "PXL-CSMobile";

// --------------------------------------------------------------------------
// The judgement itself
// --------------------------------------------------------------------------

test("none is the safe value and reports ok", () => {
  const f = baseRepositoryPermissionFinding("none", { org: ORG });
  assert.equal(f.severity, "ok");
  assert.equal(f.permission, "none");
});

test("read is a WARNING and names the control repo it exposes", () => {
  // Not a failure: today's members are lecturers. But the exposure is the
  // roster, so the message has to say which repository and what is in it.
  const f = baseRepositoryPermissionFinding("read", { org: ORG });
  assert.equal(f.severity, "warn");
  assert.match(f.message, new RegExp(CONTROL_REPO));
  assert.match(f.message, /student numbers/);
});

test("write is a FAILURE and names the lock-down floor", () => {
  // This is the one that breaks a safety mechanism rather than leaking data.
  const f = baseRepositoryPermissionFinding("write", { org: ORG });
  assert.equal(f.severity, "fail");
  assert.match(f.message, /highest applicable permission/);
  assert.match(f.message, /pull/);
});

test("admin is a failure too, not an unrecognised value", () => {
  assert.equal(baseRepositoryPermissionFinding("admin", { org: ORG }).severity, "fail");
});

test("every non-none value says the setting must be none before membership enrolment", () => {
  for (const v of ["read", "write", "admin"]) {
    assert.match(
      baseRepositoryPermissionFinding(v, { org: ORG }).message,
      /must be "none" before anyone is enrolled through organization membership/,
      `${v} must state the precondition`,
    );
  }
});

test("every non-none value names where to change it", () => {
  for (const v of ["read", "write", "admin"]) {
    assert.match(baseRepositoryPermissionFinding(v, { org: ORG }).message, /Member privileges/);
  }
});

test("an UNREADABLE value yields no finding at all - not a green one", () => {
  // The field is returned to org admins only. Treating absent as "none" would
  // be a green light produced by a permission gap.
  assert.equal(baseRepositoryPermissionFinding(undefined), null);
  assert.equal(baseRepositoryPermissionFinding(null), null);
  assert.equal(baseRepositoryPermissionFinding(""), null);
});

test("the org name is interpolated so the message says which org", () => {
  assert.match(baseRepositoryPermissionFinding("read", { org: "PXL-CSMobile" }).message, /PXL-CSMobile/);
});

// --------------------------------------------------------------------------
// Wired into Tier 1
// --------------------------------------------------------------------------

// `omitField` rather than `basePermission: undefined`: a default parameter
// fires on an explicit undefined, so that spelling silently tested "none" and
// the absent-field case was never reached.
function makeReq({ orgOk = true, basePermission = "none", omitField = false } = {}) {
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
      const data = { login: ORG };
      if (!omitField) data.default_repository_permission = basePermission;
      return { status: 200, ok: true, data };
    }
    if (path === `/repos/${ORG}/${CONTROL_REPO}`) return { status: 200, ok: true, data: { private: true } };
    return { status: 404, ok: false, data: { message: "Not Found" } };
  };
}

async function baseCheck(opts) {
  const res = await runDiagnostics({ request: makeReq(opts), org: ORG });
  return res.tiers.flatMap((t) => t.checks).find((c) => c.id === "org-base-permission") || null;
}

test("diagnostics: a none org gets an ok check", async () => {
  const c = await baseCheck({ basePermission: "none" });
  assert.ok(c, "the check must run");
  assert.equal(c.severity, "ok");
  assert.equal(c.tierId, "tier-1-org");
});

test("diagnostics: PXL-CSMobile's read is surfaced as a warning", async () => {
  const c = await baseCheck({ basePermission: "read" });
  assert.equal(c.severity, "warn");
  assert.equal(c.detail?.permission, "read");
  assert.match(c.detail?.settings_url, /organizations\/PXL-CSMobile\/settings\/member_privileges/);
});

test("diagnostics: write fails the tier", async () => {
  const res = await runDiagnostics({ request: makeReq({ basePermission: "write" }), org: ORG });
  const tier = res.tiers.find((t) => t.id === "tier-1-org");
  assert.equal(tier.checks.find((c) => c.id === "org-base-permission").severity, "fail");
  assert.equal(tier.severity, "fail", "a failing check must carry the tier with it");
});

test("diagnostics: an unreadable /orgs/{org} produces NO check, not a passing one", async () => {
  // A lecturer who is not an org admin, or an installation without the
  // permission, must not be told the setting is fine.
  assert.equal(await baseCheck({ orgOk: false }), null);
});

test("diagnostics: an org whose response omits the field produces no check", async () => {
  assert.equal(await baseCheck({ omitField: true }), null);
});

test("diagnostics: an ok check carries no fix detail to act on", async () => {
  const c = await baseCheck({ basePermission: "none" });
  assert.equal(c.detail, null);
});
