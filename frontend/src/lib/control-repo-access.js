// Why an organization's control repository answered 404 - asked of the account
// that got the 404.
//
// GitHub returns 404, not 403, for a private repository you cannot see. So the
// same response means "this organization is not set up" to an owner of the org,
// and "not set up, OR set up and not yours" to everybody else. The dashboard and
// the Admin Panel each read that 404 and each picked the friendlier answer, and
// they must now agree on the honest one - so the judgement lives here, once.
//
// Three signals, each answering a different question:
//
//   orgAdmin     Can this account see every repository in the org? An owner
//                can, so an owner's 404 really is absence. `GET /orgs/{org}`
//                returns `default_repository_permission` to an owner and null
//                to everyone else (measured 2026-09-03).
//   hubWritable  Can this account RUN Setup Organization? Write on the hub is
//                what the dispatch needs. It says nothing about this org: an
//                owner of the hub org has it everywhere. Treating it as "staff
//                here" showed a hub admin who was only an outside collaborator
//                on PXL-Java-Essentials a Set up button over a running course
//                (2026-09-17), and she pressed it twice.
//   registry     Has this org been set up? lib/org-registry.mjs, read from the
//                public hub, so the answer does not depend on who asks.
//
// Every signal is POSITIVE: an unreadable owner check or hub check is `false`,
// and an unreadable registry is `unknown` - never "not set up".
//
// Takes `request` rather than importing api.js, so a Node test can run it.

import { lookupRegisteredOrg, registryContentsPath } from '../../../lib/org-registry.mjs'

/**
 * `not-set-up`    - the control repository is absent, as far as anyone can tell.
 * `no-access`     - an account with no staff capability here: not an owner, and
 *                   cannot run Setup Organization either. Usually a student who
 *                   accepted an assignment.
 * `no-org-access` - the org IS set up; this account can run Setup but cannot read
 *                   the course. Access comes from the org, not from the hub.
 * `unknown`       - the same account, with a registry that did not load.
 */
export const UNREADABLE_CONTROL_REPO_VERDICTS = Object.freeze([
  'not-set-up',
  'no-access',
  'no-org-access',
  'unknown',
])

/**
 * The decision, with no I/O.
 *
 * @param {{ orgAdmin: boolean, hubWritable: boolean, registry: null|'listed'|'unlisted'|'unreadable' }} signals
 *        `registry` is null when it was not read, which only happens where it
 *        cannot change the answer.
 */
export function judgeUnreadableControlRepo({ orgAdmin, hubWritable, registry }) {
  if (orgAdmin === true) return 'not-set-up'
  if (hubWritable !== true) return 'no-access'
  if (registry === 'listed') return 'no-org-access'
  if (registry === 'unlisted') return 'not-set-up'
  return 'unknown'
}

async function readOrgAdmin(request, org) {
  try {
    const res = await request('GET', `/orgs/${org}`)
    return Boolean(res?.ok && res.data?.default_repository_permission != null)
  } catch {
    return false
  }
}

async function readHubWritable(request, hubOwner, hubRepo) {
  try {
    const res = await request('GET', `/repos/${hubOwner}/${hubRepo}`)
    return Boolean(res?.ok && res.data?.permissions?.push)
  } catch {
    return false
  }
}

/** The registry row for `org`, as lib/org-registry.mjs judges the response. */
export async function readOrgRegistration(request, { org, hubOwner, hubRepo }) {
  try {
    return lookupRegisteredOrg(await request('GET', registryContentsPath(hubOwner, hubRepo)), org)
  } catch {
    return lookupRegisteredOrg({ ok: false, status: null }, org)
  }
}

/**
 * Read the signals and judge. The registry is read only where it can change
 * the answer: an owner's 404 is already absence, and an account that cannot
 * run Setup is refused whatever the registry says.
 *
 * @param {(method: string, path: string) => Promise<{ ok: boolean, status: number, data: any }>} request
 * @returns {Promise<{ verdict: string, orgAdmin: boolean, hubWritable: boolean, budgetOwner: string|null }>}
 */
export async function classifyUnreadableControlRepo(request, { org, hubOwner, hubRepo }) {
  const [hubWritable, orgAdmin] = await Promise.all([
    readHubWritable(request, hubOwner, hubRepo),
    readOrgAdmin(request, org),
  ])

  let registration = null
  if (!orgAdmin && hubWritable) {
    registration = await readOrgRegistration(request, { org, hubOwner, hubRepo })
  }

  const owner = registration?.entry?.budget_owner_login
  return {
    verdict: judgeUnreadableControlRepo({ orgAdmin, hubWritable, registry: registration?.state ?? null }),
    orgAdmin,
    hubWritable,
    budgetOwner: typeof owner === 'string' && owner.trim() ? owner.trim() : null,
  }
}
