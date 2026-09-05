// PXL Classroom - deployment configuration, in the SPA.
//
// Reads the SAME `deployment.yml` the hub reads. There is one source file and
// no generated copy, because a generated copy is a thing that drifts.
//
// Vite inlines the file as a string at BUILD time (`?raw`) and it is parsed
// with the `yaml` package the bundle already ships for the roster import. The
// Node-side reader is lib/deployment.mjs, which cannot be used here because it
// reaches for `node:fs`.
//
// CHANGING A VALUE NEEDS A DEPLOY, precisely because of that build-time
// inlining. `deploy-frontend.yml`'s path filter names deployment.yml so an edit
// actually reaches students - a config file the build reads but the filter does
// not name is a change that ships to main and reaches nobody.

import { parse } from 'yaml'
import raw from '../../../deployment.yml?raw'

const config = parse(raw) ?? {}

/** Email domains a student may claim an address in, by default. */
export const CLAIM_DOMAINS = Object.freeze([...(config.claim_domains ?? [])])

/**
 * The institution's name, long and short, as a student reads it.
 *
 * Both forms come from the file rather than being trimmed from one another: a
 * fork whose name does not split into "<word> <ACRONYM>" would get nonsense
 * from any rule we invented. Neither is derivable from `claim_domains` - see
 * deployment.yml.
 *
 * They fall back to the domain-free wording rather than to "PXL", so a fork
 * that forgets to set them says something true instead of something branded.
 */
export const INSTITUTION = config.institution_name || 'your institution'
export const INSTITUTION_SHORT = config.institution_short || config.institution_name || 'institutional'

/** The timezone assignment dates are displayed in when one is not set. */
export const TIMEZONE = config.timezone

/** The account and repository holding the hub. */
export const HUB_OWNER = config.hub_owner
export const HUB_REPO_NAME = config.hub_repo
export const HUB_REPO = `${config.hub_owner}/${config.hub_repo}`

/**
 * The device-flow CORS proxy tried FIRST - the PXL-owned Worker.
 *
 * Not a secret: it is baked into a public bundle and visible to anyone who
 * opens the page. It is here rather than in `VITE_*` so the ORDER is a property
 * of the deployment file people read, not of which of two similarly-named
 * secrets happened to be set to which value. See auth.js for what the ordering
 * decides, and deployment.yml for why it changed.
 *
 * Optional: absent yields "", which auth.js skips as unusable and falls through
 * to the configured secondary rather than failing sign-in.
 */
export const DEVICE_FLOW_PROXY = config.device_flow_proxy ?? ''

/** The GitHub App slug, as in github.com/apps/<slug>. */
export const APP_SLUG = config.app_slug

/**
 * The provisioning App's public client id (`Iv23...`), NOT the numeric App id.
 *
 * Not a secret - the device flow puts it in this bundle. It is here because it
 * was spelled out in lib/audit.mjs and again in frontend/src/lib/config.js, and
 * two copies of "which App is this deployment" is one too many.
 */
export const APP_CLIENT_ID = config.app_client_id

/** The private per-organization repository holding a course's data. */
export const CONTROL_REPO = config.control_repo

/** Preserved submissions live in `<prefix><assignment-id>`. */
export const ARCHIVE_REPO_PREFIX = config.archive_repo_prefix

/** The per-organization archive used before archives became per-assignment. */
export const LEGACY_ARCHIVE_REPO = config.legacy_archive_repo ?? null
