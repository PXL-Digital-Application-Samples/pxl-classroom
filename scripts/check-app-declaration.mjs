#!/usr/bin/env node
// Compare the live GitHub App's declared permissions against the manifest the
// SPA would create it with (MANIFEST_APP_PERMISSIONS).
//
// The manifest at /setup only applies at App *creation*. Widening it afterwards
// does nothing to an App that already exists, and no organization can approve a
// permission the App does not declare - so the drift is invisible until a
// lecturer trips over it. On 2026-08-21 that cost two hours of onboarding
// debugging (RUNBOOK.md section 6.7).
//
// GET /apps/{slug} is public; a token is used only for the higher rate limit.
//
// Env:
//   APP_SLUG      - App slug to inspect (default: pxl-classroom-provisioner)
//   GITHUB_TOKEN  - optional, raises the rate limit
//   GITHUB_API_URL- optional, defaults to https://api.github.com

import { APP_SLUG as DEFAULT_SLUG, missingManifestPermissions } from "../lib/audit.mjs";

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

if (missing.length === 0) {
  console.log(`The App "${slug}" declares every permission in the manifest.`);
  process.exit(0);
}

const labels = missing.map((m) => `${m.permission}=${m.actual ?? "missing"} (want ${m.expected})`).join(", ");
console.log(
  `::error::The App "${slug}" does not declare: ${labels}. ` +
    `MANIFEST_APP_PERMISSIONS in lib/audit.mjs has drifted from the live App - the manifest only applies at App creation. ` +
    `The App owner adds the permission under the App's Permissions & events, then every org owner approves the update. ` +
    `Until then org onboarding fails at its billing preflight and the weekly usage report skips those orgs. See RUNBOOK.md section 6.7.`,
);
process.exit(1);
