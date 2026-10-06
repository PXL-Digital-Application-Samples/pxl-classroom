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
 * @param {{state?: string|null, deadlinePassed?: boolean, everPublished?: boolean}} args
 * @returns {Array<{key: string, label: string, sub: string, danger?: boolean}>}
 */
export function stateActions({ state, deadlinePassed = false, everPublished = false }) {
  // Not "cannot be undone": a student can be let back in from their row.
  const freeze = deadlinePassed
    ? [{ key: 'freeze', label: 'Lock everyone out now', sub: 'Takes away every student\'s write access and archives their work. Asks for confirmation first.', danger: true }]
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
        { key: 'close', label: 'Stop accepting', sub: 'Nobody new can accept; existing repositories are unaffected' },
        { key: 'draft', label: 'Back to draft', sub: 'The invitation link stops working' },
        { key: 'archive', label: 'Archive', sub: 'Leaves the student-facing list and day-to-day tracking' },
        ...freeze,
      ]
    case 'closed':
      return [
        reopen,
        { key: 'draft', label: 'Back to draft', sub: 'The invitation link stops working' },
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

/**
 * Was this assignment ever published? Publishing writes the invitation fields
 * (`invite_*`, publish-assignment.yml) and nothing removes them, so a draft
 * that carries one went live at some point and may have a broker and students.
 *
 * @param {object|null|undefined} assignment the stored document
 */
export function everPublished(assignment) {
  const a = assignment || {}
  return a.state === 'published' || a.state === 'closed' || a.state === 'archived'
    || ['invite_key', 'invite_pubkey', 'invite_nonce', 'invite_token'].some((f) => typeof a[f] === 'string' && a[f] !== '')
}
