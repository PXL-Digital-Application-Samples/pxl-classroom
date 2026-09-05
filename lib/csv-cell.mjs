// PXL Classroom - one CSV cell, written and read back.
//
// THREE COPIES OF THIS EXISTED, byte-for-byte: `csvEscape` in RosterTab.vue,
// `csvCell` in AssignmentDetailView.vue and an inline lambda in report.mjs. Not
// one of them had an inverse, which is how the roster round trip came to be
// lossy without anybody writing it down - the Admin Panel now tells a lecturer
// to export the roster, fill in a column and import it back, and the importer
// had never been told what the exporter does.
//
// So the pair lives together. `csvCell` and `stripFormulaGuard` are exact
// inverses over every value this system writes, and `tests/csv-cell.test.mjs`
// asserts that rather than describing it.
//
// Pure and dependency-free: report.mjs imports it directly, both Vue components
// import it through `../../../lib/`.

/**
 * Values Excel, LibreOffice and Sheets will execute if a cell starts with one.
 *
 * A leading apostrophe is the standard defence: the spreadsheet treats the rest
 * as literal text and does not show the quote. It is also the ONLY defence that
 * works here - wrapping the field in double quotes does not help, because those
 * are CSV syntax and the parser strips them before the value is interpreted.
 */
const FORMULA_LEAD = /^[=+\-@]/;

/**
 * One value, ready to be written into a CSV row.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function csvCell(value) {
  if (value === null || value === undefined) return "";
  let str = Array.isArray(value) ? value.join("; ") : String(value);
  if (FORMULA_LEAD.test(str)) str = `'${str}`;
  return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

/**
 * Undo `csvCell`'s formula guard, and nothing else.
 *
 * ONLY WHEN WHAT FOLLOWS WOULD HAVE BEEN GUARDED. Stripping every leading
 * apostrophe is the obvious version and it is wrong in this country: `'t Hooft`,
 * `'s Jongers` and `'t Seyen` are ordinary Flemish surnames, and this runs over
 * `full_name` on a roster of Belgian students. The exporter never touches those
 * - `t` and `s` are not formula leads - so neither may the importer. Inverting
 * the exact rule is what keeps the pair honest; a looser one silently renames
 * people.
 *
 * Quote handling is not undone here because it never reaches this function: the
 * CSV parser has already resolved quoting into the value by the time a cell is
 * coerced.
 *
 * @param {unknown} value
 * @returns {unknown} unchanged unless it carries the guard
 */
export function stripFormulaGuard(value) {
  if (typeof value !== "string") return value;
  if (value[0] !== "'") return value;
  return FORMULA_LEAD.test(value.slice(1)) ? value.slice(1) : value;
}
