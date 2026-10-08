// The moment a date-time box holds, said in 24-hour time and without
// day/month ambiguity.
//
// The box itself is the browser's: `<input type="datetime-local">` is drawn in
// the browser's own language, which a page cannot choose - MDN: "formatted
// according to the user's locale as reported by their operating system", and
// in Chrome it is the browser's UI language, whatever `lang` the page sets. A
// Chrome in English (US) shows "10/09/2026, 09:30 AM" - 12-hour, month first -
// in an app that shows 24-hour times everywhere else (asked 2026-10-08). So
// the line under the box says the same moment the way the rest of the app does.
//
// Pure: a box's value in, a sentence out.

// `hourCycle`, not `hour12: false`: Chrome renders midnight as "24:00" for a
// 12-hour default locale asked for 24-hour time that way.
const PARTS = { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }

/**
 * @param {string} local  the box's value, `YYYY-MM-DDTHH:mm`, in this computer's time
 * @param {{ studentTimeZone?: string|null, browserTimeZone?: string|null }} [zones]
 *   where students are shown it differs from this computer, the same moment
 *   there too
 * @returns {string} '' for an empty or unreadable value
 */
export function dateReadout(local, { studentTimeZone = null, browserTimeZone = null } = {}) {
  if (typeof local !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(local)) return ''
  // A date-time with no zone is read as this computer's time - which is the
  // zone the browser filled the box in.
  const at = new Date(local)
  if (Number.isNaN(at.getTime())) return ''
  const here = at.toLocaleString('en-GB', PARTS)
  if (!studentTimeZone || studentTimeZone === browserTimeZone) return here
  let there
  try {
    there = at.toLocaleString('en-GB', { ...PARTS, timeZone: studentTimeZone })
  } catch {
    return here
  }
  return there === here ? here : `${here} (${there} for students)`
}
