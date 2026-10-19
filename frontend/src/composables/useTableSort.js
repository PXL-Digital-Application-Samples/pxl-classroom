import { ref } from 'vue'
import { createTableSort } from '../lib/table-sort.js'

/**
 * Which column a table is sorted on, and which way - the state behind
 * <SortableTh>. Each sortable table holds one (Progress, Grading, Teams,
 * Roster, both usage tables); they had six hand-written copies of it.
 *
 * The rules are lib/table-sort.js `createTableSort`, over two refs and nothing
 * else. `initialKey` null leaves the rows in the order they came (the Roster
 * keeps the file's order until a lecturer asks for another).
 *
 * @param {string | null} [initialKey]
 * @param {{ descFirst?: string[] }} [options]
 */
export function useTableSort(initialKey = null, options = {}) {
  return createTableSort(ref(initialKey), ref(true), options)
}
