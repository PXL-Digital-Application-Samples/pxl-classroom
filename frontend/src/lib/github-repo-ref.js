// PXL Classroom - "what repository is this?", from whatever got pasted.
//
// The Admin Panel's Template repository field wants `owner/repo`, and what a
// lecturer has on their clipboard is a browser address bar. Pasting it produced
// "Use the full name, e.g. <org>/linux-template" - a control refusing the most
// ordinary way to fill it in, then explaining itself. DESIGN.md §1.5 has one
// answer for that shape and it is not a better message: give the system the
// behaviour.
//
// The student half of this already exists. `parseInvitationLink` accepts a full
// Pages URL, a `/:org/i/:token` path, or `org/token`, for exactly this reason.
// This is its lecturer-side sibling. It is NOT a fork of it: they read two
// different formats (a Pages invitation link, a GitHub repository reference)
// and share nothing but the intent.
//
// GITHUB.COM ONLY. Normalising `gitlab.com/a/b` to `a/b` would hand back a
// value that looks valid for a repository that cannot exist - §1.5 once more,
// the UI asserting something the system does not have. A non-GitHub URL is left
// alone and the field's existing error is the right answer for it.
//
// What it deliberately does NOT do is decide whether the repository exists, is
// a template, or is reachable. `checkTemplateValidity` asks GitHub and reports
// what it says. So `https://github.com/orgs/PXL/repositories` normalises to
// `orgs/PXL` and is then answered with "Repository not found" - one authority
// on existence, rather than a hand-written list of reserved paths here that
// would also refuse a real org unlucky enough to be named `topics`.

// A repository reference is exactly two segments. Owner is GitHub's login
// charset; repo additionally allows `.` and `_` (`ps-02-ext_lab` is a real
// template on the pilot org and an underscore is the reason this is spelled
// out rather than reusing the login pattern).
const OWNER = String.raw`[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?`
const REPO = String.raw`[A-Za-z0-9._-]+`
const BARE = new RegExp(String.raw`^(${OWNER})/(${REPO})$`)

// Scheme and `www.` optional, so a half-copied address still lands.
const WEB = /^(?:https?:\/\/)?(?:www\.)?github\.com\/(.+)$/i

// `git@github.com:owner/repo.git`, and the ssh:// spelling that uses a slash.
const SSH = /^(?:ssh:\/\/)?git@github\.com[:/](.+)$/i

/**
 * `owner/repo` for anything recognisable, `null` for anything else.
 *
 * Returning null rather than the input is what lets the caller replace only
 * when it differs, so typing into the box is never fought: a value that is
 * already `owner/repo` comes back unchanged, and a value this cannot read is
 * left exactly as typed for the field's own validation to judge.
 */
export function normalizeRepoRef(input) {
  if (typeof input !== 'string') return null
  const clean = input.trim()
  if (!clean) return null

  const web = clean.match(WEB)
  const ssh = web ? null : clean.match(SSH)
  // Not a GitHub URL at all: accept a bare full name (so a paste with stray
  // whitespace is tidied) and refuse everything else, including `a/b/c` -
  // three segments are ambiguous, and the field's own error says so better
  // than a guess at which two were meant.
  if (!web && !ssh) {
    const bare = clean.match(BARE)
    return bare ? `${bare[1]}/${bare[2]}` : null
  }

  // Everything past the repository is dropped: `/tree/main`, a query, a
  // fragment, and above all `/generate` - the URL behind GitHub's own "Use this
  // template" button, which is the single likeliest thing to be on the
  // clipboard when someone is filling in this field.
  const path = (web ? web[1] : ssh[1]).split(/[?#]/)[0]
  const [owner, repo] = path.split('/')
  if (!owner || !repo) return null

  // GitHub refuses to create a repository whose name ends in `.git`, so this
  // can only be the clone-URL suffix.
  const trimmed = repo.replace(/\.git$/i, '')
  const match = `${owner}/${trimmed}`.match(BARE)
  return match ? `${match[1]}/${match[2]}` : null
}
