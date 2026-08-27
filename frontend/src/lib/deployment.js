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

/** The timezone assignment dates are displayed in when one is not set. */
export const TIMEZONE = config.timezone

/** The account and repository holding the hub. */
export const HUB_OWNER = config.hub_owner
export const HUB_REPO_NAME = config.hub_repo
export const HUB_REPO = `${config.hub_owner}/${config.hub_repo}`

/** The GitHub App slug, as in github.com/apps/<slug>. */
export const APP_SLUG = config.app_slug

/** The private per-organization repository holding a course's data. */
export const CONTROL_REPO = config.control_repo

/** Preserved submissions live in `<prefix><assignment-id>`. */
export const ARCHIVE_REPO_PREFIX = config.archive_repo_prefix

/** The per-organization archive used before archives became per-assignment. */
export const LEGACY_ARCHIVE_REPO = config.legacy_archive_repo ?? null
