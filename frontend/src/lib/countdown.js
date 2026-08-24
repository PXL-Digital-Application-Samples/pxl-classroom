// How long until a deadline. Its own module, and deliberately dependency-free
// (no config, no `import.meta.env`), so tests/deadline-countdown.test.mjs can
// import it under plain Node the way tests/invite-token.test.mjs imports
// lib/invite-token-format.mjs.
//
// It exists because there were already two byte-identical copies of this -
// AssignmentView and GroupAcceptanceCard - and UX_PLAN WS5 needed a third for
// the Admin Panel's cohort card.

/**
 * The duration between `now` and a deadline, as parts rather than a sentence.
 *
 * The caller supplies the words around it, because the same number reads
 * differently to the two audiences: a student is told the window "Closes in
 * 6d 23h", a lecturer that the deadline is "6d 23h" away.
 *
 * `now` is a parameter so a ticking clock ref can drive it; a helper reaching
 * for Date.now() itself would make that ref decorative.
 *
 * @returns {{ passed: boolean, duration: string, at: Date } | null}
 */
export function countdownParts(deadline, now = new Date()) {
  if (!deadline) return null
  const at = deadline instanceof Date ? deadline : new Date(deadline)
  if (Number.isNaN(at.getTime())) return null
  const nowMs = now instanceof Date ? now.getTime() : Number(now)
  if (Number.isNaN(nowMs)) return null

  const diffMs = at.getTime() - nowMs
  const mins = Math.floor(Math.abs(diffMs) / 60000)
  const hours = Math.floor(mins / 60)
  const days = Math.floor(hours / 24)

  let duration
  if (days > 0) duration = `${days}d ${hours % 24}h`
  else if (hours > 0) duration = `${hours}h ${mins % 60}m`
  else duration = `${mins}m`

  // `<= 0`: a deadline that is exactly now has closed. The student view gates
  // its Accept button on this, and "0m left" would still offer it.
  return { passed: diffMs <= 0, duration, at }
}

/**
 * The student-facing sentence. Past the deadline it names the moment rather
 * than the elapsed time - "3d ago" is not what a student who has just missed
 * a hand-in needs to read.
 */
export function formatDeadlineCountdown(deadline, now = new Date()) {
  const parts = countdownParts(deadline, now)
  if (!parts) return null
  if (parts.passed) {
    const when = parts.at.toLocaleDateString(undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    })
    return `Deadline passed (${when})`
  }
  return `Closes in ${parts.duration}`
}
