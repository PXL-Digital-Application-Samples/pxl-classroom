// Every assignment document in an org's control repository, as committed.
//
// The Roster page needs them whole: re-identifying a roster row rewrites the
// cohorts that hold it (lib/cohort-reidentify.mjs), and "add the students who
// accepted" offers one assignment at a time. A file that cannot be read or
// parsed is left out rather than failing the list, the same as the Admin Panel
// does; an unreadable DIRECTORY throws, because an empty list would then be a
// claim that the org has no assignments.

import { parse as parseYaml } from 'yaml'
import { getRepoContent, listRepoDir } from './api.js'
import { config } from './config.js'
import { ASSIGNMENTS_DIR } from '../../../lib/control-layout.mjs'

/** `[{ ...doc, id }]`, sorted by id. A 404 directory is no assignments yet. */
export async function loadAssignmentDocs(token, org) {
  return (await loadAssignmentDocsCounted(token, org)).docs
}

/**
 * The same, and how many files were left out because they could not be read
 * or parsed. Leaving one out is fine for a list; it is not for a change that
 * must reach EVERY assignment naming a student (re-identifying a roster row),
 * which needs to know the list is short.
 *
 * @returns {Promise<{docs: object[], unreadable: number}>}
 */
export async function loadAssignmentDocsCounted(token, org) {
  let files = []
  try {
    files = await listRepoDir(token, org, config.controlRepo, ASSIGNMENTS_DIR)
  } catch (e) {
    if (e?.status !== 404) throw e
  }
  const ymls = files.filter((f) => f.type === 'file' && f.name.endsWith('.yml'))
  const docs = await Promise.all(ymls.map(async (f) => {
    try {
      const text = await getRepoContent(token, org, config.controlRepo, f.path)
      if (!text) return null
      const doc = parseYaml(text)
      return { ...doc, id: doc?.id || f.name.replace(/\.yml$/, '') }
    } catch {
      return null
    }
  }))
  const read = docs.filter(Boolean)
  return {
    docs: read.sort((a, b) => String(a.id).localeCompare(String(b.id))),
    unreadable: docs.length - read.length,
  }
}
