// The student portal read one page of the student's repositories.
//
// HomeView matches every repo the signed-in student owns or collaborates on
// against every published assignment to build "My Assignments". It fetched
// `/user/repos?affiliation=owner,collaborator&per_page=100` and stopped - part
// of a deliberate "2 GitHub API calls total" optimisation - so a student past
// 100 repositories silently lost assignments from the list. No error and no
// empty state: the call SUCCEEDS, which is what makes this class invisible.
//
// Owner *and* collaborator, and every assignment in every course adds one, so
// 100 is not a hypothetical for a student in their third year. /user/repos
// sorts by full_name, so the ones that disappear are the alphabetically late
// ones, consistently - a student would see the same assignments missing every
// time and have no way to describe the pattern.
//
// Its sibling in the very same Promise.all, getInvitations, had already been
// fixed for exactly this. Only the repos half was left.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Block and line comments removed, so prose quoting a rule is not read as the rule. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}
const API = join(root, "frontend", "src", "lib", "api.js");
const HOME = join(root, "frontend", "src", "views", "HomeView.vue");

test("HomeView no longer reads /user/repos itself", () => {
  const src = readFileSync(HOME, "utf8");
  assert.ok(
    !/\/user\/repos/.test(src),
    "the portal must go through getUserRepos, which paginates - a bare read here is the bug",
  );
  assert.match(src, /getUserRepos\(/, "and it must actually call it");
});

test("an unreadable repository list is an ERROR, never 'no assignments'", () => {
  // This list IS the student's repositories. If GitHub does not answer, the
  // match loop produces nothing and the portal renders "No accepted
  // assignments yet" - telling a student with six repositories that they have
  // none. ghApi returns { ok: false } rather than throwing, so the catch never
  // saw it and nothing was red. Same shape as listOrgRepos reporting "this
  // organization has no template repositories" off a failed read.
  const src = stripComments(readFileSync(HOME, "utf8"));
  const fn = src.slice(src.indexOf("async function loadStudentAssignments"));
  const body = fn.slice(0, fn.indexOf("\nasync function ") + 1);

  assert.ok(
    /if \(!reposRes\.ok/.test(body),
    "loadStudentAssignments must check whether the repository read succeeded",
  );
  // The failure must reach the user, not just widen an empty array.
  const guardAt = body.indexOf("!reposRes.ok");
  const errorAt = body.indexOf("assignmentsError.value =", guardAt);
  assert.ok(errorAt > guardAt, "a failed repository read must set assignmentsError");
  assert.ok(
    !/const userRepos = \(reposRes\.ok[^\n]*: \[\]/.test(body),
    "collapsing a failed read to an empty list is the bug this test exists for",
  );
});

test("a failed INVITATIONS read still degrades gracefully", () => {
  // Deliberately different: invitations only decide the "Invitation pending"
  // badge, so losing them must not blank assignments the student has accepted.
  const src = stripComments(readFileSync(HOME, "utf8"));
  assert.match(
    src,
    /const userInvites = \(invitesRes\.ok/,
    "invitations should still fall back to an empty list rather than blocking the page",
  );
});

test("getUserRepos walks the Link header", () => {
  const src = readFileSync(API, "utf8");
  const fn = src.slice(src.indexOf("export async function getUserRepos"));
  const body = fn.slice(0, fn.indexOf("\n}") + 2);

  assert.match(body, /pagedGet\(/, "getUserRepos must use the shared paginator");
  assert.match(body, /affiliation=owner,collaborator/, "and keep both affiliations");
  assert.ok(
    /if \(!merged\) return res/.test(body),
    "a failed page must hand back the failure, never a partial list dressed as a whole one",
  );
});

test("there is ONE Link walker, not one per caller", () => {
  // getInvitations, getInstallations and listOrgRepos each had their own, and
  // /user/repos was about to become a fourth. The rel="next" parse is the thing
  // that must not fork.
  // Comments stripped first: both this fix and the existing one explain the
  // rule by quoting `rel="next"`, so a raw scan counts the prose as code - the
  // same reason the claim-mode and roster-entries guards strip before scanning.
  const src = stripComments(readFileSync(API, "utf8"));
  const walkers = [...src.matchAll(/rel="next"/g)].length;
  assert.ok(
    walkers <= 2,
    `expected the rel="next" parse in at most two places (pagedGet, and listOrgRepos' raw-fetch variant), found ${walkers}`,
  );
  assert.match(src, /async function pagedGet\(/, "the shared paginator must exist");

  // And the three ghApi-based callers must all route through it.
  for (const name of ["getInvitations", "getInstallations", "getUserRepos"]) {
    const fn = src.slice(src.indexOf(`export async function ${name}`));
    const body = fn.slice(0, fn.indexOf("\n}") + 2);
    assert.match(body, /pagedGet\(/, `${name} must use the shared paginator`);
  }
});

test("pagedGet stops on a short page, and cannot loop on a self-referential Link", () => {
  const src = readFileSync(API, "utf8");
  const fn = src.slice(src.indexOf("async function pagedGet("));
  const body = fn.slice(0, fn.indexOf("\n}\n") + 3);

  // A repeated URL must break rather than spin - a malformed Link header
  // pointing at itself is a hang, not an error.
  assert.match(body, /seen\.has\(path\)/, "must guard against a self-referential Link header");
  assert.match(body, /maxPages/, "and carry a page cap as the belt to that braces");
  assert.ok(
    /return \{ res, merged: null \}/.test(body),
    "a failed page must be reported as a failure, not as a short list",
  );
});

test("the e2e fixture exposes the link header, or pagination is untestable in the browser", () => {
  // Documented trap: a Playwright route that sets `link` must ALSO set
  // access-control-expose-headers, or CORS hides it from JS and the pagination
  // under test silently sees a single page - a green suite over a broken read.
  const fixture = readFileSync(join(root, "tests", "fixtures", "e2e-fixtures.mjs"), "utf8");
  if (!/['"]link['"]\s*:/i.test(fixture)) return; // no paginated mock yet, nothing to assert
  assert.match(
    fixture,
    /access-control-expose-headers/i,
    "a mocked link header must be exposed to JS or the pagination is not actually exercised",
  );
});
