// HOW A TABLE COLUMN SORTS, for every table in the SPA that sorts.
//
// The Progress, Grading and Roster tables each carried their own comparator,
// three copies of "nulls last, numbers as numbers, the rest as text" that had
// already drifted: the Roster's sorted 3A before 12A and `3a` beside `3A`, the
// other two did neither. The Teams table needed a fourth. One rule now.
//
// A VIEW, NEVER A WRITE: sortRows returns a new array, so a caller sorting the
// list it is about to commit (the Roster's `students`) never reorders it.

/** No value: null, undefined, NaN or blank text. Sorts last in both directions. */
function isEmpty(v) {
  if (v == null) return true
  if (typeof v === 'number') return Number.isNaN(v)
  return String(v).trim() === ''
}

/**
 * Compare two column values. Empty last whichever way the arrow points: "the
 * ones with nothing" are a group of their own and belong at the end, not at the
 * top of a descending sort. Numbers compare as numbers; text with `numeric` so
 * 3A sorts before 12A, and `sensitivity: base` so a hand-typed `3a` sits beside
 * `3A` rather than after every uppercase one.
 *
 * @param {unknown} av
 * @param {unknown} bv
 * @param {boolean} [asc]
 */
export function compareSortValues(av, bv, asc = true) {
  const aEmpty = isEmpty(av)
  const bEmpty = isEmpty(bv)
  if (aEmpty && bEmpty) return 0
  if (aEmpty) return 1
  if (bEmpty) return -1
  const dir = asc ? 1 : -1
  if (typeof av === 'number' && typeof bv === 'number') return dir * (av - bv)
  return dir * String(av).trim().localeCompare(String(bv).trim(), undefined, { numeric: true, sensitivity: 'base' })
}

/**
 * A sorted copy of `rows`, by the value `valueOf` reads from each row.
 *
 * @template T
 * @param {T[]} rows
 * @param {(row: T) => unknown} valueOf
 * @param {boolean} [asc]
 * @returns {T[]}
 */
export function sortRows(rows, valueOf, asc = true) {
  return [...(rows || [])].sort((a, b) => compareSortValues(valueOf(a), valueOf(b), asc))
}

/**
 * Which column a table is sorted on, and which way, over two holders with a
 * `.value` (refs, in composables/useTableSort.js). Kept free of Vue so a test
 * can run it: `npm test` installs the hub's packages, not the SPA's.
 *
 * Pressing the sorted column flips it; pressing another sorts it ascending, or
 * descending for a column in `descFirst`.
 *
 * @param {{ value: string | null }} sortKey
 * @param {{ value: boolean }} sortAsc
 * @param {{ descFirst?: string[] }} [options]
 */
export function createTableSort(sortKey, sortAsc, { descFirst = [] } = {}) {
  const firstAsc = (key) => !descFirst.includes(key)
  sortAsc.value = firstAsc(sortKey.value)

  function sortBy(key) {
    if (sortKey.value === key) sortAsc.value = !sortAsc.value
    else { sortKey.value = key; sortAsc.value = firstAsc(key) }
  }

  /** 'asc' | 'desc' | null - what <SortIcon> reads. Null keeps a column quiet. */
  function sortDir(key) {
    if (sortKey.value !== key) return null
    return sortAsc.value ? 'asc' : 'desc'
  }

  /** The heading's own statement of the same thing, for a screen reader. */
  function ariaSort(key) {
    if (sortKey.value !== key) return 'none'
    return sortAsc.value ? 'ascending' : 'descending'
  }

  return { sortKey, sortAsc, sortBy, sortDir, ariaSort }
}

/** An ISO time as a sortable number, or null when there is none or it does not parse. */
export function timeValue(iso) {
  const t = iso ? new Date(iso).getTime() : NaN
  return Number.isFinite(t) ? t : null
}
