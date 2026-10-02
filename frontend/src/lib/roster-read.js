// Reading the org's roster, for every surface that shows it.
//
// The roster is one file per organization (ROSTER_PATH), and two pages read it:
// the Roster page, which edits it, and the assignment editor, which says how
// many students it holds and offers its class groups to the cohort picker. They
// were one page until the roster became an org-level page of its own, and the
// editor read the count through the mounted roster tab; on separate pages each
// reads the file, through this one function.

import { parse as parseYaml } from 'yaml'
import { getRepoContent } from './api.js'
import { config } from './config.js'
import { ROSTER_PATH } from './roster.js'

/**
 * The committed roster: `{ doc, raw }`.
 *
 * `doc` is null when there is no roster file, which is a known answer (nobody is
 * on it), not a failure. `raw` is the bytes as read, so an editor can tell
 * "nothing changed under me" from "somebody else committed". Throws when the
 * file cannot be read - getRepoContent resolves null on a 404 only.
 */
export async function readRoster(token, org) {
  const raw = await getRepoContent(token, org, config.controlRepo, ROSTER_PATH)
  return { doc: raw ? parseYaml(raw) : null, raw: raw ?? null }
}
