// Whether a student may still switch team themselves, and until when - the
// hub's own rule (acceptance/accept.mjs step 4, lib/acceptance-window.mjs):
// a self-service team the student may leave (`canChooseAnother`), on an
// assignment that is accepting now. Never the student's extension: the hub
// reads none for an acceptance, so a student with one was offered a switch
// until a date the hub refused it at (review 2026-10-14, T4). Moved out of the
// card so it can be tested (TS-1).
//
// A switch is an acceptance, so the acceptance deadline (`accepts_until`)
// closes it too: `until` is whichever of the two dates closes acceptance.

import { acceptanceClosesAt, acceptanceWindow } from '../../../lib/acceptance-window.mjs'

/**
 * @param {object} a
 * @param {boolean} a.canChooseAnother  self-service, and this student may leave their team
 * @param {{ state?: string, accepts_until?: string|null, deadline_at?: string|null }|null} a.assignment
 * @param {number} a.now  the card's ticking clock
 * @returns {{ can: boolean, until: string|null }} `until`: when acceptance closes (ISO), null when nothing closes it
 */
export function teamSwitchWindow({ canChooseAnother, assignment, now }) {
  const closes = acceptanceClosesAt(assignment)
  const until = closes ? new Date(Date.parse(closes)).toISOString() : null
  const can = Boolean(canChooseAnother) && acceptanceWindow(assignment, now).phase === 'accepting'
  return { can, until }
}
