// Whether a student may still switch team themselves, and until when - the
// hub's own rule (acceptance/accept.mjs step 4): a self-service team the
// student may leave (`canChooseAnother`), on an assignment that is accepting,
// before the ASSIGNMENT'S deadline. Never the student's extension: the hub reads
// none for an acceptance, so a student with one was offered a switch until a
// date the hub refused it at (review 2026-10-14, T4). Moved out of the card so
// it can be tested (TS-1).

/**
 * @param {object} a
 * @param {boolean} a.canChooseAnother  self-service, and this student may leave their team
 * @param {{ state?: string, deadline_at?: string|null }|null} a.assignment
 * @param {number} a.now  the card's ticking clock
 * @returns {{ can: boolean, until: string|null }} `until`: the assignment's deadline (ISO), null when it has none
 */
export function teamSwitchWindow({ canChooseAnother, assignment, now }) {
  const deadline = Date.parse(assignment?.deadline_at ?? '')
  const until = Number.isFinite(deadline) ? new Date(deadline).toISOString() : null
  const can = Boolean(canChooseAnother) && assignment?.state === 'published' && !(until && now > deadline)
  return { can, until }
}
