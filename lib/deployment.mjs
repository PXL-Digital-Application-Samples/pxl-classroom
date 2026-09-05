// PXL Classroom - the reader for deployment.yml.
//
// `deployment.yml` is the CONFIGURATION: plain data with comments, editable by
// anyone forking this software without touching a line of JavaScript. This file
// is the software that reads it, and the only place that knows its shape.
//
// YAML because that is already how this repository configures itself
// (`limits.yml`, `participating-orgs.yml`), and because a config file people
// are meant to edit should carry its own explanation - which JSON cannot.
//
// The SPA reads it too: Vite inlines the file as a string (`?raw`) at BUILD
// time and parses it with the `yaml` package the bundle already ships for the
// roster import. So there is one source file and no generated copy to drift.
//
// CHANGING A VALUE NEEDS A DEPLOY, because of that build-time inlining -
// `deploy-frontend.yml`'s path filter names deployment.yml so the edit actually
// reaches students. A config file the build reads but the filter does not name
// is a change that ships to main and reaches nobody, which has happened here
// before with the claim key list.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const config = parse(readFileSync(join(here, "..", "deployment.yml"), "utf8")) ?? {};

/**
 * Email domains a student may claim an address in, when an assignment does not
 * name its own `claim_domains`.
 *
 * An assignment may narrow this, or opt out entirely with `claim_domains: []` -
 * absent and empty are different answers, and lib/claim.mjs keeps them apart.
 */
export const CLAIM_DOMAINS = Object.freeze([...(config.claim_domains ?? [])]);

/**
 * The institution's name, long and short, as it appears in text a person reads.
 *
 * The hub needs it too: `accept.mjs`'s rejection reasons are read by a lecturer
 * and, for `no-claim`, are the sentence the student's page renders from the
 * published category. Same two forms and same fallbacks as the SPA's copy in
 * frontend/src/lib/deployment.js - one file, two readers, no third spelling.
 */
export const INSTITUTION = config.institution_name || "your institution";
export const INSTITUTION_SHORT =
  config.institution_short || config.institution_name || "institutional";

/**
 * The timezone assignment dates are DISPLAYED in by default.
 *
 * Display only. Every stored instant is UTC with an explicit `Z`, and nothing
 * in the finalize path reads this.
 */
export const TIMEZONE = config.timezone;

/** The account and repository holding the hub, which owns every workflow. */
export const HUB_OWNER = config.hub_owner;
export const HUB_REPO_NAME = config.hub_repo;

/** `owner/repo`, the spelling most callers actually want. */
export const HUB_REPO = `${config.hub_owner}/${config.hub_repo}`;

/**
 * The device-flow CORS proxy the SPA tries first - the PXL-owned Worker.
 *
 * Nothing in Node reads it; it is exported so the two readers keep IDENTICAL
 * export surfaces, which is the property that stops them drifting. Optional,
 * so an older or forked deployment.yml does not throw at import.
 */
export const DEVICE_FLOW_PROXY = config.device_flow_proxy ?? "";

/** The GitHub App slug, as in github.com/apps/<slug>. */
export const APP_SLUG = config.app_slug;

/**
 * The provisioning App's public client id (`Iv23...`), NOT the numeric App id.
 *
 * Not a secret - the device flow puts it in the public bundle. It lives here
 * because it was spelled out in lib/audit.mjs and again in
 * frontend/src/lib/config.js, and "which App is this deployment" is exactly the
 * kind of fact that must have one home.
 */
export const APP_CLIENT_ID = config.app_client_id;

/** The private per-organization repository holding a course's data. */
export const CONTROL_REPO = config.control_repo;

/** Preserved submissions live in `<prefix><assignment-id>`. */
export const ARCHIVE_REPO_PREFIX = config.archive_repo_prefix;

/**
 * The single per-organization archive used before archives became
 * per-assignment. Read, never derived; null on a fork with no history.
 */
export const LEGACY_ARCHIVE_REPO = config.legacy_archive_repo ?? null;

/**
 * Fail loudly at import time rather than producing `undefined` deep inside a
 * repository name or a permission check.
 *
 * A missing value becomes `"undefined/pxl-classroom"` or a request to
 * `/apps/undefined`, which comes back as a 404 - a deployment fault wearing the
 * costume of a missing App. `legacy_archive_repo` is the one optional key.
 */
for (const [key, value] of Object.entries({
  timezone: TIMEZONE,
  hub_owner: HUB_OWNER,
  hub_repo: HUB_REPO_NAME,
  app_slug: APP_SLUG,
  app_client_id: APP_CLIENT_ID,
  control_repo: CONTROL_REPO,
  archive_repo_prefix: ARCHIVE_REPO_PREFIX,
})) {
  if (value === undefined || value === null || value === "") {
    throw new Error(`deployment.yml is missing "${key}" - see lib/deployment.mjs`);
  }
}
if (!Array.isArray(config.claim_domains)) {
  throw new Error('deployment.yml "claim_domains" must be a list');
}
