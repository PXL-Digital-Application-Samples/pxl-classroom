// Account permissions are declared on the App and never on an installation, and
// putting one in the wrong constant breaks a different thing in each direction.
//
// MANIFEST_APP_PERMISSIONS is posted verbatim as the App manifest's
// `default_permissions`, which does not accept account-level names - measured
// for `starring`, which is why that one has always been added by hand. And
// EXPECTED_APP_PERMISSIONS spreads MANIFEST and is compared against an
// INSTALLATION, which never carries an account permission - so a name in the
// wrong place reports every organization as permanently drifting on something
// no org owner can ever approve. That is the bug ACCOUNT_LEVEL_PERMISSIONS was
// written to fix for installationApprovalGaps; the two Tier 1 drift loops in
// lib/audit.mjs and lib/diagnostics.mjs do NOT strip it, so the separation has
// to hold at the source.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ACCOUNT_APP_PERMISSIONS,
  ACCOUNT_LEVEL_PERMISSIONS,
  EXPECTED_APP_PERMISSIONS,
  MANIFEST_APP_PERMISSIONS,
  missingAccountPermissions,
} from "../lib/audit.mjs";

test("every account permission we require is recognised as account-level", () => {
  for (const perm of Object.keys(ACCOUNT_APP_PERMISSIONS)) {
    assert.ok(
      ACCOUNT_LEVEL_PERMISSIONS.includes(perm),
      `${perm} is required as an account permission but is not in ACCOUNT_LEVEL_PERMISSIONS, ` +
        `so installationApprovalGaps would report it against every org`,
    );
  }
});

test("no account permission leaks into the manifest or the installation set", () => {
  // The guard that matters. Adding email_addresses to MANIFEST_APP_PERMISSIONS
  // is the obvious-looking move and it is wrong twice over.
  const account = new Set(ACCOUNT_LEVEL_PERMISSIONS);
  const leaked = [
    ...Object.keys(MANIFEST_APP_PERMISSIONS).filter((p) => account.has(p)).map((p) => `MANIFEST:${p}`),
    ...Object.keys(EXPECTED_APP_PERMISSIONS).filter((p) => account.has(p)).map((p) => `EXPECTED:${p}`),
  ];
  assert.deepEqual(
    leaked,
    [],
    `account-level permissions must live in ACCOUNT_APP_PERMISSIONS only:\n${leaked.join("\n")}`,
  );
});

test("the claim flow's email read is declared", () => {
  // Phase D asks a student to confirm one of their own GitHub-verified
  // addresses. That is a user-to-server read of /user/emails; an installation
  // token cannot do it at all.
  assert.equal(ACCOUNT_APP_PERMISSIONS.email_addresses, "read");
});

test("starring is NOT required - acceptance stopped starring the broker", () => {
  // ARCHITECTURE records it as legacy and nothing in the codebase stars
  // anything. Requiring a permission no code uses is how a checklist grows
  // items nobody can justify, and this one has already outlived its feature.
  assert.equal(ACCOUNT_APP_PERMISSIONS.starring, undefined);
});

test("missingAccountPermissions fails closed on absent and on too-low", () => {
  assert.deepEqual(missingAccountPermissions({ email_addresses: "read" }), []);
  assert.deepEqual(missingAccountPermissions({ email_addresses: "write" }), [],
    "write satisfies a read requirement");

  assert.deepEqual(missingAccountPermissions({}), [
    { permission: "email_addresses", expected: "read", actual: null },
  ]);

  // An unreadable declaration is not evidence of compliance.
  assert.deepEqual(missingAccountPermissions(null), [
    { permission: "email_addresses", expected: "read", actual: null },
  ]);

  // A junk level is not a level.
  assert.deepEqual(missingAccountPermissions({ email_addresses: "sometimes" }), [
    { permission: "email_addresses", expected: "read", actual: "sometimes" },
  ]);
});

test("the live App's real shape would be judged correctly", () => {
  // Exactly what `gh api apps/pxl-classroom-provisioner --jq .permissions`
  // returned on 2026-08-27, which is what proves account permissions appear on
  // this endpoint at all: starring and plan are both account-level and both
  // present. email_addresses was not yet added, so this must report it.
  const live = {
    actions: "write", actions_variables: "write", administration: "write",
    checks: "read", contents: "write", issues: "write", members: "write",
    metadata: "read", organization_administration: "write",
    organization_plan: "read", plan: "read", pull_requests: "write",
    secrets: "write", starring: "write", workflows: "write",
  };
  assert.deepEqual(missingAccountPermissions(live), [
    { permission: "email_addresses", expected: "read", actual: null },
  ]);

  // ...and once it is added by hand, clean.
  assert.deepEqual(missingAccountPermissions({ ...live, email_addresses: "read" }), []);
});
