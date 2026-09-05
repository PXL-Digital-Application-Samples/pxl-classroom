// PXL Classroom - which academic year a date falls in.
//
// An academic year spans two calendar years, so "2026" names neither of them.
// The Flemish convention this deployment uses writes both, two digits each:
// **2627** is September 2026 to August 2027. A lab that runs every year is
// distinguished by that label and nothing else - `2627-lab-3` next to
// `2526-lab-3` - which is why the collision refusal recommends it as a prefix
// rather than a suffix: the repository listing then sorts by year, and one
// year's worth of an organization is one contiguous block.
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

/**
 * `<year>-<id>`, with any year label already on the front replaced rather than
 * stacked - a lecturer who reaches for this twice must not get `2627-2526-lab-3`.
 *
 * Only a leading `NNNN-` is treated as a year, and only when it looks like one:
 * `2526-lab-3` yes, `2026-report` no (that is a four-digit calendar year, and
 * removing it would rename somebody's assignment behind their back).
 *
 * @param {string} id
 * @param {string} yearLabel
 * @returns {string|null}
 */
export function withAcademicYear(id, yearLabel) {
  if (typeof id !== "string" || !id.trim()) return null;
  if (typeof yearLabel !== "string" || !/^\d{4}$/.test(yearLabel)) return null;
  const bare = id.trim().replace(/^(\d{2})(\d{2})-(?=.)/, (m, a, b) =>
    // A leading four digits is a year label only if the second pair follows the
    // first - 2526, 2627. 2026 does not, and stays.
    Number(b) === (Number(a) + 1) % 100 ? "" : m,
  );
  return `${yearLabel}-${bare}`;
}
