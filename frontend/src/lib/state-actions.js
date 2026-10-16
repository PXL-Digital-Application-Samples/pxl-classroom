/**
 * What an assignment's state button offers, from the state it is in.
 *
 * The state is a button in the assignment's header, reachable from every tab,
 * so closing an exam is not a matter of finding a form section (BETA-UX.md,
 * 2026-10-02). These are the transitions the editor's Lifecycle section always
 * offered, plus the assignment page's own two (stop or reopen acceptance, and
 * lock everyone out once the deadline has passed), in one list.
 *
 * Which page carries each one out is the page's business: the header only says
 * which was asked for. Destructive ones are last and marked, and Delete is
 * offered only where it was before - a draft, or an assignment that no longer
 * accepts.
 *
 * EACH LINE SAYS WHAT IT DOES NOW, not what the stored state would do on its
 * own (live UI suite, 2026-10-15): a finished, locked, archived assignment
 * still `published` offered "Stop accepting - nobody new can accept" (nobody
 * could since the deadline) and "Lock everyone out now" over "All student
 * work is archived" - a lock that had already run, and that skips whatever a
 * lecturer reopened (lockdown.mjs), so it could change nothing.
 *
 * @param {{state?: string|null, deadlinePassed?: boolean, everPublished?: boolean, lockRan?: boolean}} args
 *   `lockRan`: the deadline's lock has run (the report says when)
 * @returns {Array<{key: string, label: string, sub: string, danger?: boolean}>}
 */
export function stateActions({ state, deadlinePassed = false, everPublished = false, lockRan = false }) {
  // Not "cannot be undone": a student can be let back in from their row.
  const freeze = deadlinePassed && !lockRan
    ? [{ key: 'freeze', label: 'Lock everyone out now', sub: 'Runs the deadline\'s lock now for every student whose deadline has passed, and archives their work. Asks for confirmation first.', danger: true }]
    : []
  // REOPENING NEEDS A DEADLINE IN THE FUTURE. Past it, every acceptance is
  // refused as too late, and a publish of an assignment that was locked at its
  // deadline is refused outright (lib/finished-assignment.mjs) - so "Reopen"
  // would be a control that cannot do what it says (DESIGN.md §1.5). What a
  // lecturer reopening a finished assignment has to do first is say so.
  const reopen = deadlinePassed
    ? { key: 'edit-deadline', label: 'Move the deadline…', sub: 'The deadline has passed. Reopening needs a new one first.' }
    : { key: 'reopen', label: 'Reopen for acceptance', sub: 'Students with the link can accept again' }
  switch (state) {
    case 'draft':
      // A draft that was PUBLISHED BEFORE (Back to draft) has a broker, maybe
      // students and their repositories. "Delete draft" removed the file and
      // nothing else - the public broker kept its key with nothing left to
      // close it - and said nobody had accepted. Such a draft gets the full
      // delete, which removes the broker and keeps a record.
      return [
        { key: 'publish', label: 'Publish', sub: 'Creates the invitation and lets students accept' },
        everPublished
          ? { key: 'delete', label: 'Delete assignment…', sub: 'It was published before. Asks for confirmation first', danger: true }
          : { key: 'delete-draft', label: 'Delete draft', sub: 'Removes this draft. It was never published.', danger: true },
      ]
    case 'published':
      return [
        deadlinePassed
          ? { key: 'close', label: 'Stop accepting', sub: 'Marks it closed. Nobody could accept after the deadline anyway; repositories are unaffected' }
          : { key: 'close', label: 'Stop accepting', sub: 'Nobody new can accept; existing repositories are unaffected' },
        deadlinePassed
          ? { key: 'draft', label: 'Back to draft', sub: 'Takes it off the student pages' }
          : { key: 'draft', label: 'Back to draft', sub: 'The invitation link stops working' },
        { key: 'archive', label: 'Archive', sub: 'Leaves the student-facing list and day-to-day tracking' },
        ...freeze,
      ]
    case 'closed':
      return [
        reopen,
        // Closed has stopped the link already (R6-37): what is left to say is
        // what Back to draft does now.
        { key: 'draft', label: 'Back to draft', sub: 'Takes it off the student pages' },
        { key: 'archive', label: 'Archive', sub: 'Leaves the student-facing list and day-to-day tracking' },
        ...freeze,
        { key: 'delete', label: 'Delete assignment…', sub: 'Asks for confirmation first', danger: true },
      ]
    case 'archived':
      return [
        reopen,
        { key: 'delete', label: 'Delete assignment…', sub: 'Asks for confirmation first', danger: true },
      ]
    default:
      return []
  }
}

// Was this assignment ever published? One rule with the finalize queue, which
// closes the broker of one archived or sent back to draft (R7-11).
export { everPublished } from '../../../lib/finalize-scope.mjs'
