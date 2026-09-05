// PXL Classroom - which academic year a date falls in.
//
// An academic year spans two calendar years, so "2026" names neither of them.
// The Flemish convention this deployment uses writes both, two digits each:
// **2627** is September 2026 to August 2027. It is what tells one year's run of
// a lab from the next one's, and the collision refusal offers it as the usual
// way to distinguish a name - at either end, since a prefix sorts a year's
// repositories together and a suffix keeps the assignment's own name first.
//
// Where the year turns is institution-specific, so it is `academic_year_start_month`
// in deployment.yml and never a literal here. Isomorphic, so it takes that
// month as a PARAMETER and does not import the reader - a `node:fs` import
// anywhere in the SPA's graph is a blank page.

const two = (n) => String(n % 100).padStart(2, "0");

/**
 * The academic-year label a date falls in.
 *
 * @param {Date|string|number} when
 * @param {number} startMonth 1-12, the month the academic year begins
 * @returns {string|null} e.g. "2627", or null when `when` is not a date
 */
export function academicYearLabel(when, startMonth) {
  // `new Date(null)` is the epoch, not an invalid date, so null would have
  // yielded a confident "6970" instead of no answer.
  if (when === null || when === undefined || when === "") return null;
  const d = when instanceof Date ? when : new Date(when);
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return null;

  const month = Number(startMonth);
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;

  // getUTC*: an assignment's opens_at is stored in UTC, and a date an hour
  // either side of midnight must not land in a different academic year
  // depending on where the browser is.
  const first = d.getUTCMonth() + 1 >= month ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  return `${two(first)}${two(first + 1)}`;
}

// There was a `withAcademicYear(id, label)` here that built `<year>-<id>` for
// the collision refusal to recommend by name. It is gone deliberately: a name
// this module composes is a name nothing has checked, and offering
// `2627-lab-3` as the way out is a claim about the organization's repository
// listing that neither function ever asked about - `2627-lab-3` can be taken
// too. The refusal names the technique and the year; what the lecturer types is
// checked again when they type it.
