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

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { generateAppJwt } from "../lib/app-jwt.mjs";
import { installationApprovalGaps } from "../lib/audit.mjs";
import { parseYaml } from "../lib/yaml.mjs";

const apiUrl = (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, "");
const PARTICIPATING_FILE = process.env.PARTICIPATING_FILE || "participating-orgs.yml";
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

// Which accounts are actually ours? The App is publicly listed - the hub-and-
// spoke model needs it to be, since each course org is a separate organization
// and a private App can only be installed on its owner - so ANY GitHub account
// can install it. One did on 2026-08-22. Reporting a stranger's org as
// "unapproved" every Sunday is a permanent false positive sitting beside the
// real ones, which is how a weekly check stops being read.
//
// An unreadable list must NOT downgrade a real gap to a footnote, so it fails
// safe the other way: treat every installation as participating and say the
// classification was unavailable. "Could not read it" is not "it is fine" -
// the same rule the App-declaration checks follow.
// Matched case-insensitively (an org login is case-preserving but not
// case-sensitive, and treating our own org as a stranger would silently
// downgrade a real gap) while REPORTING the spelling the file uses - naming a
// lowercased `forgotten` sends a lecturer looking for an org that, as spelled,
// does not exist.
let participating = null;
try {
  if (existsSync(PARTICIPATING_FILE)) {
    const doc = parseYaml(await readFile(PARTICIPATING_FILE, "utf8"));
    const entries = (doc?.orgs || [])
      .map((o) => String(o?.login ?? "").trim())
      .filter(Boolean)
      .map((login) => [login.toLowerCase(), login]);
    // An EMPTY list is an answer ("no orgs are enrolled yet" - the
    // participating-orgs branch really does start as `orgs: []`); only a failed
    // read is an absence. Conflating them would turn every installation into a
    // third party and silence every real approval gap.
    participating = new Map(entries);
  }
} catch {
  participating = null;
}
if (!participating) {
  console.log(
    `::warning::Could not read ${PARTICIPATING_FILE}, so installations cannot be split into participating and third-party. ` +
      `Every installation is reported as if it were ours - which over-reports rather than under-reports.`,
  );
}

const ours = (login) => participating === null || participating.has(String(login).toLowerCase());

const gaps = installationApprovalGaps(declared, installations);
const blocking = gaps.filter((g) => ours(g.account));
const thirdParty = gaps.filter((g) => !ours(g.account));

const declaredLabel = Object.entries(declared)
  .map(([k, v]) => `${k}=${v}`)
  .sort()
  .join(", ");

const describe = (gap) =>
  gap.missing.map((m) => `${m.permission}: has ${m.actual ?? "no access"}, App declares ${m.declared}`).join("; ");

// A participating org with NO installation at all cannot be provisioned for -
// nothing else in the system notices, and ADMIN.md §7 has carried it as
// a manual checklist item.
const installedAccounts = new Set(
  installations.map((i) => String(i?.account?.login ?? "").toLowerCase()).filter(Boolean),
);
const notInstalled = participating
  ? [...participating.entries()]
      .filter(([key]) => !installedAccounts.has(key))
      .map(([, login]) => login)
      .sort()
  : [];

for (const gap of blocking) {
  console.log(
    `::error title=Unapproved App permissions on ${gap.account}::${gap.account} has not approved the current permission set for "${slug}" - ${describe(gap)}. ` +
      `An org owner accepts at https://github.com/organizations/${gap.account}/settings/installations -> ${slug} -> Review request. ` +
      `Until then that org keeps the old permissions and any feature relying on the new ones silently does nothing there. See ADMIN.md §6.6.`,
  );
}

for (const org of notInstalled) {
  console.log(
    `::error title=App not installed on ${org}::${org} is in ${PARTICIPATING_FILE} but "${slug}" is not installed on it, ` +
      `so nothing can be provisioned there. Install it at https://github.com/apps/${slug}/installations/new.`,
  );
}

// Named, never silent - an installation we do not recognise is worth a look
// even though it grants its owner nothing of ours - but it does not fail the
// run, because we cannot make a stranger approve anything.
for (const gap of thirdParty) {
  console.log(
    `::notice title=Third-party installation: ${gap.account}::${gap.account} has "${slug}" installed but is not in ${PARTICIPATING_FILE}. ` +
      `It is on an older permission set (${describe(gap)}), which is not actionable by us. ` +
      `The App is publicly listed, so any account can install it; this grants them nothing in a PXL organization.`,
  );
}
if (participating) {
  const strangers = installations.filter((i) => !ours(i?.account?.login)).length;
  if (strangers > 0) {
    console.log(`${strangers} installation(s) are not in ${PARTICIPATING_FILE} (informational).`);
  }
}

const failures = blocking.length + notInstalled.length;
if (failures === 0) {
  const scope = participating ? `${participating.size} participating org(s)` : `all ${installations.length} installation(s)`;
  console.log(`${scope} have "${slug}" installed and have approved its current permissions (${declaredLabel}).`);
  process.exit(0);
}

console.log(
  `${blocking.length} participating org(s) have not approved the current permissions, ` +
    `and ${notInstalled.length} have no installation at all.`,
);
process.exit(1);
