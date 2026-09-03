// Who owns an organization - walked, not sampled.
//
// Two callers need this and for the same reason: an accepted student who is an
// organization OWNER keeps admin on every repository in it, so demoting their
// collaborator grant to `pull` changes nothing. GitHub grants the HIGHEST
// applicable permission. `lib/diagnostics.mjs` asks before the deadline so it
// can warn; `lockdown/lockdown.mjs` asks at the deadline so it can record what
// it could not freeze instead of failing the whole cohort.
//
// One request for the owner list rather than `GET /orgs/{org}/memberships/{login}`
// per acceptor: owners are few, acceptors are not, and per-student would be two
// hundred requests on a two-hundred-student cohort.
//
// A page is not the list. This walks, and it distinguishes three answers that
// callers must not collapse:
//
//   owners: [...], complete: true    the whole list
//   owners: [...], complete: false   a truncated read - a match found here is
//                                    real, but "not an owner" is not provable
//   owners: null                     nothing was read. NOT an empty list.
//
// That last distinction is the one that matters at a deadline. An unreadable
// owner list must never be treated as "nobody is an owner", because the
// conclusion drawn from it - "this student can be frozen, so failing to freeze
// them is an error" - is the opposite of the truth.

const PER_PAGE = 100;
const MAX_PAGES = 5;

/**
 * @param {(method: string, path: string) => Promise<{ok: boolean, data?: unknown}>} request
 * @param {string} org
 * @returns {Promise<{owners: string[]|null, complete: boolean}>}
 */
export async function fetchOrgOwners(request, org) {
  const owners = [];
  for (let page = 1; ; page++) {
    const res = await request("GET", `/orgs/${org}/members?role=admin&per_page=${PER_PAGE}&page=${page}`);
    if (!res.ok || !Array.isArray(res.data)) {
      // Nothing at all read is unreadable; a later page failing is a truncated
      // read that still carries the matches found so far.
      if (page === 1) return { owners: null, complete: false };
      return { owners, complete: false };
    }
    owners.push(...res.data.map((m) => m?.login).filter(Boolean));
    if (res.data.length < PER_PAGE) return { owners, complete: true };
    if (page >= MAX_PAGES) return { owners, complete: false };
  }
}

/**
 * Is this login provably an owner of that organization?
 *
 * Deliberately one-directional. `true` means the list said so. `false` means
 * "not proven", which covers both a genuine non-owner and a list nobody could
 * read - and every caller here treats those the same way, because the action
 * taken on `true` (excuse a student from the freeze) must require evidence.
 *
 * @param {string[]|null} owners
 * @param {string} login
 */
export function isKnownOwner(owners, login) {
  if (!Array.isArray(owners) || !login) return false;
  const want = String(login).toLowerCase();
  return owners.some((o) => String(o).toLowerCase() === want);
}
