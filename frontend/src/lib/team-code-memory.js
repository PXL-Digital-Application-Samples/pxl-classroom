// The team join codes this browser has been given (lib/team-join-code.mjs).
//
// A code is made in the creator's browser and stored at the hub in a manifest
// no student can read, so the browser that made it - and the browser of anyone
// the hub let in with it - is the only place a student can see it again. The
// lecturer sees every team's code on the Teams tab, which is the answer for a
// code this browser does not have.
//
// PER GITHUB ACCOUNT. A lab computer is shared, and the sign-in on it changes
// hands; one student's codes are not the next one's (review, 2026-10-06).
//
// localStorage, and every read and write may fail (a private window, blocked
// storage). So this page's own codes are also kept in memory: a creator whose
// browser refuses storage still sees the code they just made, until they leave.

import { normalizeLogin } from '../../../lib/github-login.mjs'
import { normalizeJoinCode } from '../../../lib/team-join-code.mjs'

export const JOIN_CODES_KEY = 'pxl_team_join_codes'

/** This page's codes, whatever storage does. Module state: one per tab. */
const inMemory = new Map()

/**
 * @typedef {{org?: string, assignmentId?: string, slug?: string, login?: string}} CodeKey
 */

/** @param {CodeKey} key */
const entryKey = ({ org, assignmentId, slug, login }) =>
  [normalizeLogin(login || ''), normalizeLogin(org || ''), assignmentId || '', String(slug || '').toLowerCase()].join('/')

/** @param {CodeKey} key */
const usable = (key) => !!key?.slug && !!key?.login

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

/** Remember the code for this team. @param {CodeKey} key */
export function rememberJoinCode(key, code, storage = defaultStorage()) {
  const normalized = normalizeJoinCode(code)
  if (!normalized || !usable(key)) return
  const k = entryKey(key)
  inMemory.set(k, normalized)
  const all = readAll(storage)
  all[k] = normalized
  writeAll(storage, all)
}

/** The code this browser holds for this team, or ''. @param {CodeKey} key */
export function rememberedJoinCode(key, storage = defaultStorage()) {
  if (!usable(key)) return ''
  const k = entryKey(key)
  return normalizeJoinCode(readAll(storage)[k]) || inMemory.get(k) || ''
}

/**
 * Forget a code that turned out not to be the team's - the attempt that sent
 * it was refused. Only that code: a later attempt may already have replaced it.
 *
 * @param {CodeKey} key
 */
export function forgetJoinCode(key, code, storage = defaultStorage()) {
  if (!usable(key)) return
  const k = entryKey(key)
  const wanted = normalizeJoinCode(code)
  if (inMemory.get(k) === wanted) inMemory.delete(k)
  const all = readAll(storage)
  if (normalizeJoinCode(all[k]) !== wanted) return
  delete all[k]
  writeAll(storage, all)
}

/**
 * Forget whatever is kept for this team: a team this browser tried to make was
 * refused while the page was closed, so which code it sent is not known here.
 *
 * @param {CodeKey} key
 */
export function forgetAnyJoinCode(key, storage = defaultStorage()) {
  if (!usable(key)) return
  const k = entryKey(key)
  inMemory.delete(k)
  const all = readAll(storage)
  if (!(k in all)) return
  delete all[k]
  writeAll(storage, all)
}
