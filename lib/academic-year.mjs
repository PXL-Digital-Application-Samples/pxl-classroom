// PXL Classroom - which academic year a date falls in.
//
// An academic year spans two calendar years, so "2026" names neither of them.
// The Flemish convention this deployment uses writes both, two digits each:
// **2627** is the year that begins in 2026. It is what tells one year's run of
// a lab from the next one's, and the collision refusal offers it as the usual
// way to distinguish a name - at either end, since a prefix sorts a year's
// repositories together and a suffix keeps the assignment's own name first.
//
// WHERE THE YEAR TURNS IS A DATE, NOT A MONTH. It was `academic_year_start_month`
// for one day, which put the whole of the first fortnight of September in the
// wrong year here: PXL's teaching year starts on the 15th, so an assignment
// opening on the 8th is the *previous* year's - resits and retakes, exactly the
// assignments most likely to reuse a name and meet the collision refusal. A
// month-granular boundary would have suggested 2627 to somebody running the
// 2526 resit.
//
// One field rather than two, because a month and a day that can be edited
// separately can disagree - somebody moving the start to February and leaving
// the day at 31 gets a boundary that is nothing. `deployment.yml` carries
// `academic_year_start: "09-15"`, and this module parses it.
//
// Isomorphic: it takes the start as a PARAMETER and does not import the
// reader - a `node:fs` import anywhere in the SPA's graph is a blank page.

const two = (n) => String(n % 100).padStart(2, "0");

// Days per month, with February at 29. The boundary is a (month, day) compared
// against a (month, day), never a real date in a real year, so a 29 February
// start is meaningful: in a non-leap year the year simply turns on 1 March.
// Rejecting it would refuse a legal configuration to guard against nothing.
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * `"MM-DD"` as a `{month, day}` pair, or null when it is not a usable date.
 *
 * Null rather than a default, so a deployment.yml typo produces *no* year in
 * the refusal rather than a confident wrong one. The refusal reads perfectly
 * well without it - it names the technique - and a silent fallback to
 * 1 September would be a boundary nobody configured.
 *
 * @param {string} start
 * @returns {{month: number, day: number}|null}
 */
export function parseAcademicYearStart(start) {
  if (typeof start !== "string") return null;
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(start.trim());
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > DAYS_IN_MONTH[month - 1]) return null;
  return { month, day };
}

/**
 * The academic-year label a date falls in.
 *
 * @param {Date|string|number} when
 * @param {string|{month: number, day: number}} start `"MM-DD"`, or an already-parsed pair
 * @returns {string|null} e.g. "2627", or null when either argument is unusable
 */
export function academicYearLabel(when, start) {
  // `new Date(null)` is the epoch, not an invalid date, so null would have
  // yielded a confident "6970" instead of no answer.
  if (when === null || when === undefined || when === "") return null;
  const d = when instanceof Date ? when : new Date(when);
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return null;

  const at = typeof start === "string" ? parseAcademicYearStart(start) : start;
  if (!at || !Number.isInteger(at.month) || !Number.isInteger(at.day)) return null;
  if (at.month < 1 || at.month > 12 || at.day < 1 || at.day > DAYS_IN_MONTH[at.month - 1]) return null;

  // getUTC*, because opens_at is stored in UTC and the label should describe
  // the same instant. Nothing turns on the hours: a teaching year starts weeks
  // from any date a lecturer picks.
  const month = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const started = month > at.month || (month === at.month && day >= at.day);
  const first = started ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  return `${two(first)}${two(first + 1)}`;
}

// There was a `withAcademicYear(id, label)` here that built `<year>-<id>` for
// the collision refusal to recommend by name. It is gone deliberately: a name
// this module composes is a name nothing has checked, and offering
// `2627-lab-3` as the way out is a claim about the organization's repository
// listing that neither function ever asked about - `2627-lab-3` can be taken
// too. The refusal names the technique and the year; what the lecturer types is
// checked again when they type it.
