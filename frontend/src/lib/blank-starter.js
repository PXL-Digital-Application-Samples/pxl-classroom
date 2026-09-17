// PXL Classroom - "students start from nothing" still needs a repository.
//
// A lecturer who has no starter code has no template either, and GitHub cannot
// copy nothing: `generate` on a repository with no commits is
// `HTTP 422 Could not clone: <owner>/<repo> is empty.` Both halves of that were
// learned the expensive way on 2026-09-17 - pxl-werkplekleren created a
// repository named `empty-template`, published an assignment on it, and both
// acceptances failed in provisioning (LESSONS.md, "A guess in the red banner
// outranked the real cause"), while on the same evening a second lecturer asked
// in as many words whether the template could be skipped, because GitHub
// Classroom let it be. It cannot be skipped here. What it can be is made in one
// click, correct by construction.
//
// MEASURED on pxl-classroom-testbed, 2026-09-17, with a GitHub App
// user-to-server token (`ghu_`) minted through the provisioning App's own
// device flow - the credential the Admin Panel holds, not a PAT:
//
//   POST /orgs/{org}/repos
//   { name, private: true, auto_init: true, is_template: true }
//        -> 201. `is_template: true` and `default_branch: main` come back on
//           the create call itself and survive a read-back; the repository has
//           one commit and one file, README.md. No App permission had to change
//           for this: the App already holds `administration: write` because
//           provisioning creates a repository every time a student accepts.
//   the same name again
//        -> 422 `Repository creation failed.`, with
//           errors[0] = { resource: "Repository", field: "name",
//                         message: "name already exists on this account" }
//   generate from an empty one (auto_init: false)
//        -> 422 `Could not clone: <owner>/<repo> is empty.`, and its
//           `commits?per_page=1` is 409 `Git Repository is empty.`
//
// The account that measured it was an org OWNER. A lecturer who is a plain
// member meets the organization's own "Members can create repositories"
// setting and is refused with a 403 - which is why the manual route beside the
// button stays exactly where it was.
//
// Pure: no fetch, no storage, no Vue. The caller makes the request and hands
// the answer back here to be judged.

/** The organization refused this account the create. */
export const CANNOT_CREATE = 'cannot-create'
/** A repository of that name is already there. Never adopted - see below. */
export const NAME_TAKEN = 'name-taken'
/** Anything else GitHub said. */
export const CREATE_FAILED = 'create-failed'

/**
 * What the blank starter for this assignment is called.
 *
 * `starter-<slug>` and nothing else, so the name says which assignment it
 * belongs to. It is derived from the slug rather than asked for because it is
 * a consequence, like `repository_name_pattern` - one more box on this form
 * would be one more decision for a lecturer who has already said the only
 * thing that matters, which is that there is no starter code.
 *
 * @param {unknown} slug the assignment's slug (`form.id`)
 * @returns {string} the repository name, or `''` when there is no slug yet
 */
export function blankStarterName(slug) {
  const clean = typeof slug === 'string' ? slug.trim() : ''
  return clean ? `starter-${clean}` : ''
}

/**
 * Judge what came back from `POST /orgs/{org}/repos`.
 *
 * A NAME THAT EXISTS IS REFUSED, NEVER ADOPTED, and that is the whole reason
 * this is a function rather than an `if`. `starter-<slug>` pins the SLUG, not
 * the assignment id, and slugs repeat: `portfolio` is what every year's
 * portfolio assignment is called. Handing this year's assignment the repository
 * that name already points at would hand a cohort last year's starter code
 * silently - the same shape as reusing `grp-{team_slug}` across assignments
 * (lib/existing-repo.mjs). The lecturer is told which repository is in the way
 * and can pick it in the list above if it really is the starter code they
 * meant; that is a decision, and a decision belongs to them.
 *
 * Takes the STATUS, not a boolean: 403 and 422 mean opposite things to the
 * person reading the message, and "the request failed" would collapse them.
 *
 * @param {object} response the `{ ok, status, data }` from the create call
 * @param {object} ctx
 * @param {string} ctx.org the organization the repository was asked for
 * @param {string} ctx.name the repository name that was asked for
 * @returns {{ok: true} | {ok: false, code: string, message: string}}
 */
export function blankStarterFailure(response, { org, name } = {}) {
  if (response?.ok) return { ok: true }
  const status = response?.status
  const full = `${org}/${name}`

  if (status === 403) {
    return {
      ok: false,
      code: CANNOT_CREATE,
      message:
        `Your account is not allowed to create repositories in ${org}, so this could not make ` +
        `${full}. An organization owner can, or you can create it on GitHub yourself.`,
    }
  }

  // 422 is how GitHub answers a name that is taken, and it is not the only
  // thing it answers 422 to - so the error row is what decides, not the status.
  // `errors` is an array of objects, except when it is missing, or a string, or
  // the body did not parse: everything here is read defensively and falls
  // through to the general message rather than throwing inside a click handler.
  const errors = Array.isArray(response?.data?.errors) ? response.data.errors : []
  const taken = errors.some(
    (e) => e?.field === 'name' && String(e?.message || '').includes('already exists'),
  )
  if (taken) {
    return {
      ok: false,
      code: NAME_TAKEN,
      message:
        `${full} already exists, so nothing was created and it has not been adopted - a ` +
        `repository with that name may belong to an earlier assignment with the same slug. ` +
        `Choose another slug, or pick it in the list above if it is the starter code you meant.`,
    }
  }

  // GitHub's top-level message for a refused create is the useless "Repository
  // creation failed."; the reason is in `errors[0].message` - "name is too long
  // (maximum is 100 characters)", which is reachable here with a long enough
  // title. Prefer the detail, or a lecturer is handed a status code and a
  // sentence that says nothing.
  const said = typeof response?.data?.message === 'string' ? response.data.message : ''
  const detail = errors.map((e) => (typeof e?.message === 'string' ? e.message : '')).find(Boolean) || ''
  const because = detail || said
  const tail = because ? `: ${because.endsWith('.') ? because : `${because}.`}` : '.'
  return {
    ok: false,
    code: CREATE_FAILED,
    message: `Could not create ${full}${status ? ` (HTTP ${status})` : ''}${tail} Nothing was changed.`,
  }
}
