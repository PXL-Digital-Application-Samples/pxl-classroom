// The team join codes this browser has been given (lib/team-join-code.mjs).
//
// A code is made in the creator's browser and stored at the hub in a manifest
// no student can read, so the browser that made it - and the browser of anyone
// who joined with it - is the only place a student can see it again. The
// lecturer sees every team's code on the Teams tab, which is the answer for a
// code this browser does not have.
//
// localStorage, and every read and write may fail (a private window, blocked
// storage). So this page's own codes are also kept in memory: a creator whose
// browser refuses storage still sees the code they just made, until they leave.

import { normalizeLogin } from '../../../lib/github-login.mjs'
import { normalizeJoinCode } from '../../../lib/team-join-code.mjs'

export const JOIN_CODES_KEY = 'pxl_team_join_codes'

/** This page's codes, whatever storage does. Module state: one per tab. */
const inMemory = new Map()

const entryKey = (org, assignmentId, slug) =>
  `${normalizeLogin(org || '')}/${assignmentId || ''}/${String(slug || '').toLowerCase()}`

function readAll(storage) {
  if (!storage) return {}
  try {
    const parsed = JSON.parse(storage.getItem(JOIN_CODES_KEY) || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function writeAll(storage, all) {
  if (!storage) return
  try {
    storage.setItem(JOIN_CODES_KEY, JSON.stringify(all))
  } catch {
    // Not remembered; nothing else depends on it.
  }
}

// Reading the property can itself throw where storage is blocked outright.
const defaultStorage = () => {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

/** Remember the code sent for this team. */
export function rememberJoinCode(org, assignmentId, slug, code, storage = defaultStorage()) {
  const normalized = normalizeJoinCode(code)
  if (!normalized || !slug) return
  const key = entryKey(org, assignmentId, slug)
  inMemory.set(key, normalized)
  const all = readAll(storage)
  all[key] = normalized
  writeAll(storage, all)
}

/** The code this browser holds for this team, or ''. */
export function rememberedJoinCode(org, assignmentId, slug, storage = defaultStorage()) {
  if (!slug) return ''
  const key = entryKey(org, assignmentId, slug)
  return normalizeJoinCode(readAll(storage)[key]) || inMemory.get(key) || ''
}

/**
 * Forget a code that turned out not to be the team's - the attempt that sent
 * it was refused. Only that code: a later attempt may already have replaced it.
 */
export function forgetJoinCode(org, assignmentId, slug, code, storage = defaultStorage()) {
  if (!slug) return
  const key = entryKey(org, assignmentId, slug)
  const wanted = normalizeJoinCode(code)
  if (inMemory.get(key) === wanted) inMemory.delete(key)
  const all = readAll(storage)
  if (normalizeJoinCode(all[key]) !== wanted) return
  delete all[key]
  writeAll(storage, all)
}
