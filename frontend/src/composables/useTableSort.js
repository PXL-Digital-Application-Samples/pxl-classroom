import { ref } from 'vue'

/**
 * Which column a table is sorted on, and which way - the state behind
 * <SortableTh>. Each sortable table holds one (Progress, Grading, Teams,
 * Roster); they had three hand-written copies of these four functions.
 *
 * Pressing the sorted column flips it; pressing another sorts it ascending,
 * or descending for a column in `descFirst` (usage: the biggest first is the
 * question). `initialKey` null leaves the rows in the order they came (the
 * Roster keeps the file's order until a lecturer asks for another).
 *
 * @param {string | null} [initialKey]
 * @param {{ descFirst?: string[] }} [options]
 */
export function useTableSort(initialKey = null, { descFirst = [] } = {}) {
  const firstAsc = (key) => !descFirst.includes(key)
  const sortKey = ref(initialKey)
  const sortAsc = ref(firstAsc(initialKey))

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
