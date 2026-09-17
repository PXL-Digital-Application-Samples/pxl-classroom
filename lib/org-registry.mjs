// PXL Classroom - is this organization set up? Asked of the hub's registry.
//
// Setup Organization's LAST step appends the org to `participating-orgs.yml` on
// the hub's orphan `participating-orgs` branch, after the control repository
// exists. The hub is public, so this is the one answer to "has this org been set
// up" that does not depend on who is asking - which is exactly what the private
// control repository cannot give. GitHub returns 404 for a private repository you
// cannot see, so to anyone who is not an owner of the org "not set up" and "not
// yours" arrive identically.
//
// That ambiguity cost a real lecturer on 2026-09-17: an owner of the HUB org, and
// only an outside collaborator on the course org (through accepting her own test
// assignment), was told the course "needs its control repository", offered a
// Set up button, and ran Setup Organization twice over an organization that had
// been running for days. Both runs were no-ops; the screen was the defect.
//
// Three readers, one lookup: the dashboard and Admin Panel (why a 404), and the
// two diagnostics (lib/audit.mjs, lib/diagnostics.mjs), which had each written
// their own - with a hand-rolled `.toLowerCase()` and, in one, a 500 reported as
// "not found".
//
// Pure and isomorphic: the caller does the request and hands in the response.

import { parseYaml } from "./yaml.mjs";
import { sameLogin } from "./github-login.mjs";

export const REGISTRY_BRANCH = "participating-orgs";
export const REGISTRY_FILE = "participating-orgs.yml";

/** The Contents API path of the registry on the hub. */
export function registryContentsPath(hubOwner, hubRepo) {
  return `/repos/${hubOwner}/${hubRepo}/contents/${REGISTRY_FILE}?ref=${REGISTRY_BRANCH}`;
}

function decodeContents(data) {
  if (typeof data?.content === "string" && data.content) {
    const compact = data.content.replace(/\n/g, "");
    return new TextDecoder().decode(Uint8Array.from(atob(compact), (c) => c.charCodeAt(0)));
  }
  return typeof data?.raw === "string" ? data.raw : "";
}

/**
 * Look an organization up in the registry response.
 *
 * `listed`     - the org is in the file; `entry` is its row.
 * `unlisted`   - the file was read and the org is not in it. A 404 is also
 *                `unlisted`, with `reason: "no-registry"`: the branch or file does
 *                not exist, which is the state before any org is set up, and
 *                callers that want to warn about that can.
 * `unreadable` - anything else. NOT evidence either way: a failed read or a
 *                file that does not parse says nothing about this org.
 *
 * @param {{ ok?: boolean, status?: number, data?: any } | null | undefined} res
 * @param {string} org
 * @returns {{ state: "listed"|"unlisted"|"unreadable", entry: object|null,
 *             reason: null|"no-registry"|"http"|"parse", status: number|null, error: string|null }}
 */
export function lookupRegisteredOrg(res, org) {
  const status = typeof res?.status === "number" ? res.status : null;
  const result = (state, extra = {}) => ({ state, entry: null, reason: null, status, error: null, ...extra });

  if (status === 404) return result("unlisted", { reason: "no-registry" });
  if (!res?.ok) return result("unreadable", { reason: "http" });

  let doc;
  try {
    doc = parseYaml(decodeContents(res.data));
  } catch (e) {
    return result("unreadable", { reason: "parse", error: e?.message || String(e) });
  }

  // An empty file is a registry with nobody in it. A document of the wrong
  // shape is not - it is a file this code cannot read, and reading it as "not
  // listed" would offer Setup Organization over every org on the hub.
  if (doc === null || doc === undefined) return result("unlisted");
  if (typeof doc !== "object" || (doc.orgs !== undefined && doc.orgs !== null && !Array.isArray(doc.orgs))) {
    return result("unreadable", { reason: "parse", error: "orgs is not a list" });
  }

  const entry = (doc.orgs || []).find((o) => sameLogin(o?.login, org)) || null;
  return entry ? result("listed", { entry }) : result("unlisted");
}
