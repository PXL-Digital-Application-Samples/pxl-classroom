// GitHub answers installation lookups in two shapes, and reading one as the
// other fails SILENTLY - `Array.isArray(data)` is simply false and the branch
// never runs.
//
// Confirmed against the live API on 2026-08-24:
//
//   GET /user/installations       -> { total_count, installations: [...] }
//   GET /orgs/{org}/installations -> { total_count, installations: [...] }
//   GET /orgs/{org}/installation  -> 401 "A JSON web token could not be
//                                    decoded" for a user token (App JWT only)
//
// `checkInstallation` handled the first correctly and read the second as a
// bare array, so fallback #2 - the one whose own comment says "works for org
// owners with PAT" - never ran once. And the step after it can never work with
// a lecturer's token at all. So an org owner whose /user/installations does not
// list the org got "No PXL Classroom App installation found on this org" for an
// org where it plainly was: a Tier 1 false negative, which CLAUDE.md already
// records as the thing that made the 2026-08-21 onboarding failure take hours.

import { test } from "node:test";
import assert from "node:assert/strict";

import { pickClassroomInstallation, APP_CLIENT_ID, runAudit } from "../lib/audit.mjs";

const ORG = "PXL-CSMobile";
const INSTALL = {
  id: 87717962,
  app_slug: "pxl-classroom-provisioner",
  client_id: APP_CLIENT_ID,
  account: { login: ORG },
  repository_selection: "all",
  permissions: {},
};

// --- the shared picker -------------------------------------------------------

test("the object shape GitHub actually returns is understood", () => {
  const found = pickClassroomInstallation({ total_count: 1, installations: [INSTALL] });
  assert.equal(found?.id, INSTALL.id);
});

test("a bare array still works, because one caller may legitimately hold one", () => {
  assert.equal(pickClassroomInstallation([INSTALL])?.id, INSTALL.id);
});

test("this App is picked out of an org with several installed", () => {
  // Real orgs have more than one App. Taking [0] blindly would attribute
  // somebody else's installation - and its repository_selection - to us.
  const others = [
    { id: 1, app_slug: "dependabot", client_id: "other", account: { login: ORG } },
    { id: 2, app_slug: "renovate", client_id: "other2", account: { login: ORG } },
  ];
  const found = pickClassroomInstallation({ total_count: 3, installations: [...others, INSTALL] });
  assert.equal(found?.id, INSTALL.id, "matched on app_slug/client_id, not on position");
});

test("an installation known only by client_id is still ours", () => {
  const noSlug = { ...INSTALL, app_slug: undefined };
  assert.equal(pickClassroomInstallation({ installations: [noSlug] })?.id, INSTALL.id);
});

test("neither shape present is null, not a crash and not a wrong answer", () => {
  for (const bad of [null, undefined, {}, { installations: null }, { message: "Not Found" }, 42, "nope"]) {
    assert.equal(pickClassroomInstallation(bad), null, `${JSON.stringify(bad)} is not an installation list`);
  }
});

// --- the audit path it exists for --------------------------------------------

/**
 * A lecturer's token: /user/installations does not list the org (the case the
 * fallbacks exist for), /orgs/{org}/installations does, and the singular
 * endpoint 401s the way GitHub really does for a non-JWT caller.
 */
function requestForOrgOwner({ seen } = {}) {
  return async (method, path) => {
    seen?.push(path);
    if (path === "/user/installations") {
      return { status: 200, ok: true, data: { total_count: 0, installations: [] } };
    }
    if (path === `/orgs/${ORG}/installations`) {
      return { status: 200, ok: true, data: { total_count: 1, installations: [INSTALL] } };
    }
    if (path === `/orgs/${ORG}/installation`) {
      return { status: 401, ok: false, data: { message: "A JSON web token could not be decoded" } };
    }
    return { status: 404, ok: false, data: { message: "Not Found" } };
  };
}

test("an org owner is told the App IS installed, via the fallback that never ran", async () => {
  const seen = [];
  const res = await runAudit({ request: requestForOrgOwner({ seen }), org: ORG });
  const installed = res.checks.find((c) => c.id === "app-installed");

  assert.ok(installed, "the audit must report on installation");
  assert.equal(
    installed.severity,
    "ok",
    `reported "${installed.message}" for an org where the App is installed`,
  );
  assert.match(installed.message, /87717962/, "and names the installation it found");
  assert.ok(
    seen.includes(`/orgs/${ORG}/installations`),
    "the org-level list must actually be consulted",
  );
});

test("a genuinely uninstalled org is still reported as uninstalled", async () => {
  // The fix must not turn every org green. An empty list is an ANSWER.
  const request = async (method, path) => {
    if (path === "/user/installations") return { status: 200, ok: true, data: { total_count: 0, installations: [] } };
    if (path === `/orgs/${ORG}/installations`) return { status: 200, ok: true, data: { total_count: 0, installations: [] } };
    return { status: 404, ok: false, data: { message: "Not Found" } };
  };
  const res = await runAudit({ request, org: ORG });
  const installed = res.checks.find((c) => c.id === "app-installed");
  assert.equal(installed.severity, "fail");
});
