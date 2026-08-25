#!/usr/bin/env node
// Which installed organizations have NOT approved the App's current permissions?
//
// Widening a GitHub App's permissions does not widen its existing
// installations. Every org owner has to accept the request, and until they do,
// that installation keeps the OLD set while `GET /apps/{slug}` already
// advertises the new one. So `check-app-declaration.mjs` passes, the App looks
// correct, and the feature is simply dead on the orgs nobody clicked through -
// indistinguishable from a bug until a lecturer trips over it.
//
// Nothing could answer this before. `GET /orgs/{org}/installations` works only
// for an owner OF THAT ORG, so verification meant asking every colleague by
// hand: on 2026-08-25's `members` + `organization_administration: write`
// rollout, 7 of 11 orgs could be confirmed and 4 could not be seen at all.
// `GET /app/installations` answers for every org at once, and needs the App
// JWT - which is why this runs on the hub, in the `provisioning` environment,
// and not from anybody's laptop.
//
// Env:
//   PXL_APP_CLIENT_ID   - App client id (repo secret; a client id is public by design)
//   PXL_APP_PRIVATE_KEY - App private key (environment secret, `provisioning`)
//   GITHUB_API_URL      - optional, defaults to https://api.github.com
//
// Exit 1 when an installation lags. Exit 0 - loudly - when the check could not
// run: a missing credential or an unreachable API is not evidence of drift, and
// reporting "all approved" off a failed read is the exact mistake this file
// exists to catch.

import { generateAppJwt } from "../lib/app-jwt.mjs";
import { installationApprovalGaps } from "../lib/audit.mjs";

const apiUrl = (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, "");
const clientId = process.env.PXL_APP_CLIENT_ID;
const privateKey = process.env.PXL_APP_PRIVATE_KEY;

function skip(reason) {
  console.log(`::warning::Installation approval check DID NOT RUN: ${reason}`);
  process.exit(0);
}

if (!clientId || !privateKey) {
  skip("PXL_APP_CLIENT_ID or PXL_APP_PRIVATE_KEY is not set. The job must declare `environment: provisioning` to read the private key.");
}

let jwt;
try {
  jwt = generateAppJwt(clientId, privateKey);
} catch (err) {
  skip(`could not mint an App JWT (${err.message}).`);
}

const headers = {
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  "user-agent": "pxl-classroom-installation-approvals",
  authorization: `Bearer ${jwt}`,
};

async function getJson(path) {
  const res = await fetch(`${apiUrl}${path}`, { headers });
  if (!res.ok) {
    const err = new Error(`GET ${path} -> HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// The App's own declaration, read as the App itself. `GET /app` cannot name a
// different App than the key signs for, which `/apps/{slug}` could.
let app;
try {
  app = await getJson("/app");
} catch (err) {
  skip(`could not read GET /app (${err.message}).`);
}

const slug = app.slug || "the App";
const declared = app.permissions || {};

// One page is not the list. Walk until a short page: reporting "every org has
// approved" off the first 100 installations would be a confident all-clear from
// a truncated read.
const installations = [];
try {
  for (let page = 1; ; page++) {
    const batch = await getJson(`/app/installations?per_page=100&page=${page}`);
    if (!Array.isArray(batch)) {
      skip(`GET /app/installations returned ${typeof batch}, not an array.`);
    }
    installations.push(...batch);
    if (batch.length < 100) break;
  }
} catch (err) {
  skip(`could not list installations (${err.message}).`);
}

const gaps = installationApprovalGaps(declared, installations);
const declaredLabel = Object.entries(declared)
  .map(([k, v]) => `${k}=${v}`)
  .sort()
  .join(", ");

if (gaps.length === 0) {
  console.log(
    `All ${installations.length} installation(s) of "${slug}" have approved its current permissions (${declaredLabel}).`,
  );
  process.exit(0);
}

for (const gap of gaps) {
  const missing = gap.missing
    .map((m) => `${m.permission}: has ${m.actual ?? "no access"}, App declares ${m.declared}`)
    .join("; ");
  console.log(
    `::error title=Unapproved App permissions on ${gap.account}::${gap.account} has not approved the current permission set for "${slug}" - ${missing}. ` +
      `An org owner accepts at https://github.com/organizations/${gap.account}/settings/installations -> ${slug} -> Review request. ` +
      `Until then that org keeps the old permissions and any feature relying on the new ones silently does nothing there. See RUNBOOK.md section 10.6.`,
  );
}

console.log(
  `${gaps.length} of ${installations.length} installation(s) of "${slug}" have not approved its current permissions.`,
);
process.exit(1);
