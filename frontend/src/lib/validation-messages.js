// Lecturer-facing text for the AJV errors an assignment form can actually
// produce (ARCHITECTURE §10.4).
//
// `AdminView.validate()` rendered them verbatim - so a lecturer who typed
// `Task 1` as a test id was told
//
//     /autograde/tests/0/id must match pattern "^[a-z0-9][a-z0-9-]{0,63}$"
//
// which names a JSON Pointer, a keyword and a regex, and not one of the three
// is on their screen. `RosterTab`'s `formatRosterValidationError` already
// solves this shape for the roster importer; this is its sibling and follows
// the same rule:
//
//   ANYTHING UNMAPPED FALLS THROUGH TO THE RAW STRING.
//
// A mapping nobody wrote is still an error the lecturer has to see. Swallowing
// it would leave a disabled Save button and no reason for it - the same failure
// as an error that is computed and never rendered.

const TEST_PATH = /^\/autograde\/tests\/(\d+)(?:\/([a-zA-Z0-9_]+))?$/

/** The raw AJV rendering, kept as the fallback for everything unmapped. */
export function rawValidationError(e) {
  return `${e.instancePath || '(root)'} ${e.message}`
}

/**
 * Name a test the way the lecturer sees it: by its own id when it has one,
 * by position when it does not. For an id-pattern failure the invalid id IS
 * the thing to point at, so it is not hidden.
 */
function testLabel(doc, idx) {
  const t = doc?.autograde?.tests?.[idx]
  const id = typeof t?.id === 'string' ? t.id.trim() : ''
  return id ? `Test "${id}"` : `Test ${idx + 1}`
}

export function formatAssignmentValidationError(e, doc) {
  const path = e.instancePath || ''

  // --- autograding -------------------------------------------------------
  if (path === '/autograde/tests' && e.keyword === 'minItems') {
    return 'Autograding is on but no tests are defined. Add one, or turn autograding off.'
  }

  const test = TEST_PATH.exec(path)
  if (test) {
    const idx = Number(test[1])
    const field = test[2]
    const label = testLabel(doc, idx)

    if (field === 'id' && e.keyword === 'pattern') {
      const blank = !doc?.autograde?.tests?.[idx]?.id
      return blank
        ? `Test ${idx + 1}: give it an ID - lowercase letters, numbers and dashes.`
        : `${label}: the ID must be lowercase letters, numbers and dashes - no spaces, capitals or underscores.`
    }
    if (field === 'points' && (e.keyword === 'minimum' || e.keyword === 'type')) {
      return `${label}: points must be a number and cannot be negative.`
    }
    if (field === 'timeout_s') {
      return `${label}: the timeout must be a whole number of seconds between 1 and 600.`
    }
    if (!field && e.keyword === 'required') {
      const missing = e.params?.missingProperty
      if (missing === 'script') {
        return `${label}: a python test needs a script - it is the only thing it runs.`
      }
      if (missing === 'points') return `${label}: give it a points value.`
      if (missing === 'id') return `Test ${idx + 1}: give it an ID.`
      if (missing === 'type') return `${label}: choose what kind of test it is.`
    }
    if (!field && e.keyword === 'additionalProperties') {
      return `${label}: "${e.params?.additionalProperty}" is not a field a test can have.`
    }
    if (field) return `${label}: "${field}" ${e.message}.`
  }

  // --- group configuration -----------------------------------------------
  if (path === '/group_config/max_team_size' && e.keyword === 'minimum') {
    return `Maximum team size must be at least ${e.params?.limit}.`
  }
  if (path === '/group_config/min_team_size' && e.keyword === 'minimum') {
    return `Minimum team size must be at least ${e.params?.limit}.`
  }

  // --- guardrails ---------------------------------------------------------
  if (path === '' && e.keyword === 'required' && e.params?.missingProperty === 'max_acceptances') {
    return 'Open enrollment requires a maximum number of acceptances - without the roster gate it is the only limit on who can claim a repo.'
  }
  if (path === '/max_acceptances' && e.keyword === 'minimum') {
    return 'Max acceptances must be at least 1 - leave the field empty for no cap.'
  }

  return rawValidationError(e)
}
