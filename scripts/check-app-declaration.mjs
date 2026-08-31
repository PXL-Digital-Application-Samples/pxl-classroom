#!/usr/bin/env node
// Compare the live GitHub App's declared permissions against the manifest the
// SPA would create it with (MANIFEST_APP_PERMISSIONS).
//
// The manifest at /setup only applies at App *creation*. Widening it afterwards
// does nothing to an App that already exists, and no organization can approve a
// permission the App does not declare - so the drift is invisible until a
// lecturer trips over it. On 2026-08-21 that cost two hours of onboarding
// debugging (ADMIN.md §3.1).
//
// GET /apps/{slug} is public; a token is used only for the higher rate limit.
//
// Env:
//   APP_SLUG      - App slug to inspect (default: pxl-classroom-provisioner)
//   GITHUB_TOKEN  - optional, raises the rate limit
//   GITHUB_API_URL- optional, defaults to https://api.github.com

import {
  APP_SLUG as DEFAULT_SLUG,
  missingManifestPermissions,
  missingAccountPermissions,
  excessDeclaredPermissions,
} from "../lib/audit.mjs";

const slug = process.env.APP_SLUG || DEFAULT_SLUG;
const apiUrl = (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, "");

const headers = { accept: "application/vnd.github+json", "user-agent": "pxl-classroom-app-declaration-check" };
if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

const res = await fetch(`${apiUrl}/apps/${slug}`, { headers });
if (!res.ok) {
  // An unreachable API is not evidence of drift - say so and stay quiet.
  console.log(`::warning::Could not read /apps/${slug} (HTTP ${res.status}). Skipping the App declaration check.`);
  process.exit(0);
}

const declared = (await res.json()).permissions || {};
const missing = missingManifestPermissions(declared);

// Account permissions FAIL now, and that is a deliberate change: they were a
// warning only while `emails` was declared ahead of the claim flow that would
// consume it. The claim is live, so a missing one is a shipped feature quietly
// degrading - every student falls back to the typed box and every binding
// records claim_verified: false, with nothing red anywhere to say why.
//
// They are still set by the App owner ALONE - no organization approval round -
// so unlike a manifest permission there is nobody to chase, and it can be
// fixed in one toggle.
const missingAccount = missingAccountPermissions(declared);
if (missingAccount.length) {
  const acct = missingAccount
    .map((m) => `${m.permission}=${m.actual ?? "missing"} (want ${m.expected})`)
    .join(", ");
  console.log(
    `::error::The App "${slug}" does not declare the account permission(s): ${acct}. ` +
      `Set them under the App's Permissions & events -> Account permissions - they are NOT part of ` +
      `the manifest and no organization owner has to approve them. ` +
      `Note the API reports this one as "emails" while the settings toggle is labelled ` +
      `"Email addresses". The claim flow needs it to show a student their own GitHub-verified ` +
      `addresses (a user-to-server read of /user/emails); without it every claim degrades to the ` +
      `typed box and records claim_verified: false. See INSTALL.md §2.`,
  );
}

// THE OTHER DIRECTION, which nothing checked. The two comparisons answer
// different questions and both matter: `missing` is a feature that cannot work,
// `excess` is blast radius on the credential the whole system rests on. The App
// private key is copied onto a repository secret wherever it has to be used, so
// every permission it carries is something an attacker who obtains it inherits -
// and `members: write` on an App that no longer has a membership-gated roster
// mode is exactly the kind of grant that survives because nobody could see it.
//
// It FAILS rather than warns, and the remedy runs both ways: narrow the App, or
// add the permission to MANIFEST_APP_PERMISSIONS with a comment naming what
// uses it. A permanent amber nobody can action is how a weekly check stops
// being read; this one always has an action.
const excess = excessDeclaredPermissions(declared);
if (excess.length) {
  const labels = excess
    .map((e) => `${e.permission}=${e.actual}${e.required ? ` (manifest asks for ${e.required})` : " (not required at all)"}`)
    .join(", ");
  const account = excess.filter((e) => e.accountLevel).map((e) => e.permission);
  console.log(
    `::error::The App "${slug}" declares permission(s) nothing in this repository asks for: ${labels}. ` +
      `Every one of them is inherited by anyone who obtains PXL_APP_PRIVATE_KEY, so an unused grant is ` +
      `pure blast radius. Fix it in ONE of two ways: remove the permission under the App's ` +
      `Permissions & events, or - if something really does use it - add it to MANIFEST_APP_PERMISSIONS ` +
      `in lib/audit.mjs with a comment naming the caller. ` +
      (account.length
        ? `${account.join(", ")} ${account.length === 1 ? "is" : "are"} account-level: the App owner clears ` +
          `${account.length === 1 ? "it" : "them"} alone, with no organization approval round. `
        : "") +
      `NARROWING is safe to do immediately - an installation never loses access it was not using. ` +
      `See ADMIN.md §3.1.`,
  );
}

if (missing.length === 0 && missingAccount.length === 0 && excess.length === 0) {
  console.log(
    `The App "${slug}" declares every permission in the manifest and every account permission, ` +
      `and declares nothing beyond them.`,
  );
  process.exit(0);
}
if (missing.length === 0) process.exit(1);

const labels = missing.map((m) => `${m.permission}=${m.actual ?? "missing"} (want ${m.expected})`).join(", ");
console.log(
  `::error::The App "${slug}" does not declare: ${labels}. ` +
    `MANIFEST_APP_PERMISSIONS in lib/audit.mjs has drifted from the live App - the manifest only applies at App creation. ` +
    `The App owner adds the permission under the App's Permissions & events, then every org owner approves the update. ` +
    `Until then org onboarding fails at its billing preflight and the weekly usage report skips those orgs. See ADMIN.md §3.1.`,
);
process.exit(1);
