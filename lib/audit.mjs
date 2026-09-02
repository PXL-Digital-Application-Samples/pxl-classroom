// PXL Classroom - shared audit engine.
//
// Runs read-only GitHub API checks against an org's PXL Classroom install.
// Same module is imported by the CLI (`pxl-classroom audit`) and the SPA
// (DashboardView's System Health panel) - the difference is what they pass
// as `request`. See ARCHITECTURE.md §12.
//
// request(method, path) -> { status, ok, data } (Promise)
//   CLI: wraps Octokit so it matches the lib/gh.mjs shape.
//   SPA: passes the existing ghApi() function directly.

// `#deployment`, never "./deployment.mjs" - this module is imported by the SPA
// (SetupView, DashboardView) and the Node reader pulls in node:fs / node:url.
// See the note in lib/archive-repo.mjs.
import { APP_CLIENT_ID, CONTROL_REPO, APP_SLUG, HUB_REPO } from "#deployment";

import { parseYaml } from "./yaml.mjs";
import { CONTROL_SCAFFOLD_DIRS } from "./control-layout.mjs";
import { LEGACY_ARCHIVE_REPO, archiveBranchName, resolveArchiveRepo } from "./archive-repo.mjs";
import { brokerRepoName } from "./broker-repo.mjs";

export { CONTROL_SCAFFOLD_DIRS };

export { CONTROL_REPO, APP_SLUG, HUB_REPO };
// Re-exported for compatibility. The archive is per assignment now
// (`pxl-classroom-archive-<id>`, lib/archive-repo.mjs); this constant names only
// the old per-org archive, which still holds everything preserved before that
// change. Nothing may build a NEW archive name out of it.
export const ARCHIVE_REPO = LEGACY_ARCHIVE_REPO;


// Where a lecturer goes to put the App on an organization. GitHub's own page is
// the org picker: it lists only accounts they can actually install on, with
// search - so the SPA never has to enumerate or filter organizations itself.
export const APP_INSTALL_URL = `https://github.com/apps/${APP_SLUG}/installations/new`;

// The App's public client id. Public by design (it is in the SPA bundle), and
// read here because an installation record carries `client_id` but not always a
// usable `app_slug`. It comes from deployment.yml rather than a literal: it was
// spelled out here AND in frontend/src/lib/config.js, so a fork had two copies
// to find and the two could disagree about which App this deployment is.
export { APP_CLIENT_ID };

// What an installation of THIS App's slug looks like. A prefix rather than an
// equality test because GitHub appends a disambiguator when a slug is already
// taken (`...-provisioner-2`), and derived from APP_SLUG rather than the
// literal "pxl-classroom" so a fork's own App still matches.
const APP_SLUG_PREFIX = String(APP_SLUG).split("-provisioner")[0];

/**
 * Pick this App's installation out of a GitHub installations response.
 *
 * Accepts BOTH shapes, because they are not the same and the difference was
 * silent. `/user/installations` answers `{ total_count, installations: [...] }`
 * - which one caller handled - while `/orgs/{org}/installations` was read as a
 * bare array, so `Array.isArray(data)` was false and the whole branch never
 * ran. It is the fallback for an org owner whose `/user/installations` does
 * not list the org, and the step after it (`/orgs/{org}/installation`,
 * singular) needs an App JWT and answers 401 to a user token. So when this one
 * quietly did nothing, System Health reported the App as NOT INSTALLED on an
 * org where it plainly was - a Tier 1 false negative, and CLAUDE.md already
 * records that a Tier 1 misattribution is what made the 2026-08-21 onboarding
 * failure take hours.
 *
 * Both shapes confirmed against the live API on 2026-08-24. Shared rather than
 * duplicated because the two copies had already drifted on exactly this.
 */
export function pickClassroomInstallation(data) {
  const list = Array.isArray(data)
    ? data
    : Array.isArray(data?.installations)
      ? data.installations
      : null;
  if (!list) return null;
  // NO `|| list[0]`. `/orgs/{org}/installations` lists EVERY App on the org, so
  // the fallback answered "the classroom App is installed, id N" with
  // dependabot's installation whenever ours was absent - and checkPermissions
  // then read dependabot's permissions and repository_selection as ours. That
  // is a Tier 1 misattribution, the failure mode CLAUDE.md records as what made
  // the 2026-08-21 onboarding take hours. The test below this function has
  // named the hazard since it was written ("taking [0] blindly would attribute
  // somebody else's installation") while the code still did it.
  //
  // Not installed is an answer. The callers already handle null by falling
  // through to `/orgs/{org}/installation` and then reporting `fail`.
  return (
    list.find((i) => i.app_slug?.startsWith(APP_SLUG_PREFIX) || i.client_id === APP_CLIENT_ID) ?? null
  );
}

// The central hub. Brokers read acceptance/invite-keys.json from it at ref main
// to verify invitations, so a diagnostic that wants to know whether a token can
// possibly verify has to look here (ARCHITECTURE 4.3.2).


// The permissions declared in the SetupView App Manifest. Kept here so the
// audit engine and the manifest form share one source of truth. If you change
// these, also update frontend/src/views/SetupView.vue.
export const MANIFEST_APP_PERMISSIONS = Object.freeze({
  actions: "write",
  administration: "write",
  // Reading a grade out of CI. Both endpoints the grading sync uses -
  // `GET /repos/{o}/{r}/commits/{ref}/check-runs` and
  // `GET /repos/{o}/{r}/check-runs/{id}/annotations` - are gated by the Checks
  // permission (GitHub's "Permissions required for GitHub Apps" reference).
  //
  // It was never declared, and the SPA authenticates with a USER-TO-SERVER
  // token from this App, which is capped by what the App asks for. So every
  // grading sync 403'd and reported "API errors ... try again later" - advice
  // that could never come true. Reported live 2026-08-26 by a lecturer on
  // python-hacking-intro with 4,995 of 5,000 API calls still available, which
  // is what ruled out the rate limit the message implied.
  checks: "read",
  contents: "write",
  issues: "write",
  metadata: "read",
  // READ is what the code uses today - Enhanced Billing usage, and the
  // `default_repository_permission` field on GET /orgs/{org}. setup-org.yml
  // proves read suffices for billing: it mints a token with ONLY
  // `permission-organization-administration: read` and probes the usage API
  // with it. Nothing in this system writes org settings at all (no PATCH/PUT/
  // POST against /orgs/ anywhere in source), and creating repositories is the
  // REPOSITORY Administration permission, not this one.
  //
  // Declared at `write` anyway, and deliberately. ARCHITECTURE §11.2.1's
  // org-scoped lockdown - one org ruleset covering a whole cohort, flipped
  // with a single PUT - needs `organization_administration: write`, and that
  // document named this permission as its blocker. Measured 2026-08-31: the
  // live App already HAS write, so the feature is unblocked and the blocker
  // note was stale. Narrowing now would re-block a designed feature and cost
  // an approval round across twelve orgs to undo, where keeping it costs a
  // permission nothing currently calls. Revisit if org-scoped lockdown is
  // abandoned. Same shape as the `members` decision below.
  organization_administration: "write",
  pull_requests: "write",
  secrets: "write",
  workflows: "write",
  // publish-assignment.yml configures a broker with five `gh variable set`
  // calls (ASSIGNMENT_ID, CONTROL_ORG, INVITE_NONCE, INVITE_ENABLED,
  // INVITE_PUBKEY). The App has always held this and the manifest never named
  // it, which is exactly the gap excessDeclaredPermissions exists to expose:
  // an undeclared-but-required permission is indistinguishable from an
  // undeclared-and-unwanted one until the manifest is honest about both.
  actions_variables: "write",
  // REQUIRED at read, HELD at write, and the gap is deliberate.
  //
  // Required because `unfreezableAcceptorsFinding` lists
  // `GET /orgs/{org}/members?role=admin` to find acceptors who are org OWNERS,
  // whom lockdown cannot demote - GitHub grants owners admin on every
  // repository. That check exists because the case was found sitting in a real
  // exam cohort four days before its deadline. The 2026-08-31 review first
  // called this permission dead on the strength of `roster_mode: org_member`
  // having been deleted, and was wrong: that removed the ENROLMENT use, not the
  // diagnostic one. Dropping it would not even have gone red - an unreadable
  // owner list yields NO check rather than a failing one.
  //
  // Declared at `write` rather than the `read` the code needs, because
  // downgrading is a ONE-WAY door on a timescale that matters: a reduction
  // applies to all installations instantly, while going back up is an increase
  // that every one of the twelve org owners must approve before their org works
  // again. Restoring `org_member` - which enrolled by org INVITATION and so
  // genuinely needs write - would mean chasing twelve people. Tom's call on
  // 2026-08-31: keep the option open until that decision is actually made.
  //
  // Written down here rather than left to excessDeclaredPermissions, which
  // would otherwise report it every week for ever. A permanent amber beside
  // four real findings is how a check stops being read - so the exception is
  // explicit and the other four still speak.
  //
  // NOT a licence to widen anything else. Nothing in this codebase writes org
  // membership: swept three ways on 2026-08-31 (URL patterns, Octokit method
  // names, and the CLI's `octokit.request("VERB /path")` form) and the only
  // membership call in the whole source is the GET above.
  members: "write",
});

// The complete expected permission set on an INSTALLATION, which is the
// manifest set and nothing else: an installation never carries an account-level
// permission, so none may be added here. Account permissions live in
// ACCOUNT_APP_PERMISSIONS and are checked against `GET /apps/{slug}` instead.
export const EXPECTED_APP_PERMISSIONS = Object.freeze({
  ...MANIFEST_APP_PERMISSIONS,
});

const PERMISSION_RANK = Object.freeze({ read: 1, write: 2, admin: 3 });

export function permissionMeetsRequirement(actual, expected) {
  return (PERMISSION_RANK[actual] || 0) >= (PERMISSION_RANK[expected] || 0);
}

// Manifest permissions the live App does not declare. `declared` is the
// `permissions` object from GET /apps/{slug}.
export function missingManifestPermissions(declared) {
  const actual = declared || {};
  return Object.entries(MANIFEST_APP_PERMISSIONS)
    .filter(([perm, expected]) => !permissionMeetsRequirement(actual[perm], expected))
    .map(([permission, expected]) => ({ permission, expected, actual: actual[permission] ?? null }));
}

/**
 * The organization's base repository permission, judged.
 *
 * `default_repository_permission` is the floor every ORG MEMBER gets on every
 * repository in the org, private ones included. Today students are added as
 * repository **collaborators** (provisioning/provision.mjs), not members, so a
 * loose value costs nothing yet - which is exactly why nobody notices it.
 *
 * Two things make it load-bearing the moment membership enters the picture:
 *
 *   1. GitHub grants the HIGHEST applicable permission. Lockdown freezes a
 *      cohort by demoting the collaborator grant to `pull`
 *      (lockdown/lockdown.mjs). A base permission of `write` sits underneath
 *      that as a floor the demotion cannot go below, so the freeze reports
 *      success and the student can still push.
 *   2. It applies to PRIVATE repositories, and every org has one that matters:
 *      `pxl-classroom-control` holds the roster - names, student numbers,
 *      institutional emails - plus every report. At `read`, every org member
 *      can read all of it.
 *
 * Severity is proportionate rather than uniform: `read` is a latent exposure
 * (today's members are lecturers), `write`/`admin` would defeat a safety
 * mechanism outright. `undefined` means the caller could not see the field -
 * it is returned to org admins only - and is NOT evidence of a problem, so it
 * yields null rather than a guess.
 *
 * @returns {{severity: string, permission: string, message: string}|null}
 */
export function baseRepositoryPermissionFinding(value, { org = "the organization" } = {}) {
  if (value === undefined || value === null || value === "") return null;
  const permission = String(value);

  if (permission === "none") {
    return {
      severity: "ok",
      permission,
      message: `Base permission is "none" - organization members get no automatic access to repositories.`,
    };
  }

  const consequence =
    permission === "read"
      ? `every member can read every repository in ${org}, including the private ${CONTROL_REPO} - which holds the roster (names, student numbers, institutional emails) and every report`
      : `every member can write to every repository in ${org}. Lock-down freezes a cohort by demoting each student's collaborator grant to "pull", and GitHub grants the highest applicable permission - so this base permission is a floor underneath that demotion and the freeze would not actually stop anyone pushing`;

  return {
    severity: permission === "read" ? "warn" : "fail",
    permission,
    message:
      `Base permission is "${permission}": ${consequence}. ` +
      `It costs nothing today because students are added as repository collaborators rather than organization members, ` +
      `but it must be "none" before anyone is enrolled through organization membership. ` +
      `Fix under Settings -> Member privileges -> Base permissions.`,
  };
}

/**
 * Accepted students who cannot be frozen at the deadline, because they are
 * owners of the course organization.
 *
 * The sibling of baseRepositoryPermissionFinding above, and the case it does
 * not cover. That one watches `default_repository_permission`, the floor under
 * every ORGANIZATION MEMBER. An organization OWNER is not subject to a floor at
 * all: GitHub grants owners admin on every repository in the org, so
 * lockdown's `demote()` writes `pull`, verifies, reads back `admin` and
 * records `verified: false`. The freeze simply does not hold for them.
 *
 * Measured live 2026-08-26 during a full finalize rehearsal: the drill's only
 * student was an org owner, `PUT /collaborators` returned 204, the verify read
 * back `admin`, and lockdown reported `0/1 stopped`. Nothing was broken - the
 * verify-after-write did exactly its job - but nothing had WARNED either, and
 * the same shape was then found sitting in a real exam cohort two organizations
 * over, four days before its deadline.
 *
 * A cohort keeps running: the outcome is `partial`, which exits 0, so preserve
 * and report still run and every other student freezes correctly. What is lost
 * is silent, which is why it needs saying in advance rather than in the record
 * afterwards.
 *
 * `owners` null/undefined is UNREADABLE, and unreadable is not evidence - the
 * same rule Tier 1 applies to `/apps/{slug}` and this file already applies to
 * an absent base permission. It yields no check rather than a green one.
 *
 * Every owner is a WARN, never a FAIL, and that is a correction rather than a
 * softening. The first cut failed on any owner but the signed-in viewer, which
 * assumed a non-self owner would be a student. It cannot be: provisioning adds
 * students as repository COLLABORATORS, so a student only becomes an owner if
 * somebody deliberately promotes them. An owner among the acceptors is
 * therefore staff - the viewer, or a colleague testing the assignment - and
 * failing on it puts a permanent red on a live exam that nobody should act on.
 * That is the same reasoning that makes a third-party installation a notice.
 *
 * The finding still earns its place: it is what explains an `N/M stopped`
 * lockdown record in advance, and if a student really was promoted, the message
 * names the account and says what to change.
 */
export function unfreezableAcceptorsFinding({
  acceptors = [],
  owners,
  ownersComplete = true,
  org = "the organization",
  viewerLogin = null,
} = {}) {
  if (owners === null || owners === undefined) return null;

  const key = (s) => String(s).trim().toLowerCase();
  const ownerSet = new Set(owners.map(key));
  const me = viewerLogin ? key(viewerLogin) : null;

  // Report the caller's own spelling: a lecturer sent looking for a login as
  // lowercased by this function is being sent after an account that, as
  // spelled, does not exist.
  const matched = acceptors.filter((a) => ownerSet.has(key(a)));
  const self = matched.filter((a) => me && key(a) === me);
  const others = matched.filter((a) => !me || key(a) !== me);

  const why =
    `An organization owner holds admin on every repository in ${org}, and GitHub grants the highest ` +
    `applicable permission - so lock-down's demotion to "pull" is written and verified, reads back ` +
    `"admin", and the freeze does not hold. The lockdown record says so (verified: false), but only ` +
    `after the deadline has passed.`;

  if (others.length) {
    return {
      severity: "warn",
      unfreezable: others,
      self,
      message:
        `${others.length} accepted ${others.length === 1 ? "account is an owner" : "accounts are owners"} ` +
        `of ${org} and will not be frozen at the deadline: ${others.join(", ")}. ${why} ` +
        `Every actual student still freezes normally. This is normally a colleague testing the ` +
        `assignment: a student cannot become an owner on their own - provisioning adds students as ` +
        `repository collaborators - so an owner here is staff unless someone promoted them. ` +
        `If one of these IS a student, change their organization role from Owner to Member under ` +
        `People -> Role before the deadline.`,
    };
  }

  if (self.length) {
    return {
      severity: "warn",
      unfreezable: [],
      self,
      message:
        `Your own account (${self.join(", ")}) has accepted this assignment and is an owner of ${org}, ` +
        `so it will not be frozen at the deadline. ${why} This is expected for a test acceptance and ` +
        `costs nothing; every actual student still freezes normally.`,
    };
  }

  if (!ownersComplete) {
    return {
      severity: "warn",
      unfreezable: [],
      self: [],
      message:
        `Could not read the full list of ${org} owners, so this check is incomplete: none of the owners ` +
        `it did read have accepted, but an owner further down the list would not have been seen. ` +
        `An owner cannot be frozen at the deadline.`,
    };
  }

  return {
    severity: "ok",
    unfreezable: [],
    self: [],
    message:
      `All ${acceptors.length} accepted ${acceptors.length === 1 ? "student" : "students"} can be frozen ` +
      `at the deadline - none is an owner of ${org}.`,
  };
}

// Permissions that apply to USER authorization and never appear on an
// organization installation. `GET /apps/{slug}` lists them beside the org and
// repository ones, so comparing a declaration against an installation without
// removing these reports every org as permanently lagging on `plan` and
// `starring` - which is what the first live run of
// check-installation-approvals.mjs did: 14 of 14 installations "unapproved",
// burying the 5 that genuinely were. The same fact is already recorded above
// for starring. Both `plan` and `starring` were removed from the App itself on
// 2026-08-31 and are absent from MANIFEST_APP_PERMISSIONS and
// ACCOUNT_APP_PERMISSIONS - but they MUST stay in the list below, which is a
// taxonomy of every account-level name GitHub can report, not a claim that this
// App holds them. Dropping them reintroduces exactly the bug described above.
export const ACCOUNT_LEVEL_PERMISSIONS = Object.freeze([
  "blocking",
  "emails",
  "email_addresses",
  "followers",
  "gists",
  "git_ssh_keys",
  "gpg_keys",
  "interaction_limits",
  "keys",
  "plan",
  "profile",
  "starring",
  "watching",
]);

/**
 * Account permissions the system needs the App to DECLARE.
 *
 * Kept apart from MANIFEST_APP_PERMISSIONS on purpose, and the separation is
 * load-bearing in two directions:
 *
 *   - MANIFEST_APP_PERMISSIONS is posted verbatim as the App manifest's
 *     `default_permissions` (SetupView), which does not take account-level
 *     names - measured for `starring`, which is why that one has always been
 *     added by hand. Putting one here instead keeps /setup working.
 *   - EXPECTED_APP_PERMISSIONS spreads MANIFEST and is compared against an
 *     INSTALLATION's permissions. An organization installation never carries
 *     an account permission, so a name in the wrong constant reports every org
 *     as permanently drifting - exactly the bug ACCOUNT_LEVEL_PERMISSIONS was
 *     written to fix for installationApprovalGaps, in the two Tier 1 drift
 *     loops that do not strip it.
 *
 * `GET /apps/{slug}` DOES list account permissions beside the rest - verified
 * live 2026-08-27, where the App reports `starring: "write"` and `plan: "read"`
 * - so that endpoint is where these are checked.
 *
 * `starring` is deliberately NOT here: acceptance stopped starring the broker
 * at §4.3.2 and nothing in the codebase stars anything. Requiring a permission
 * no code uses is how a checklist grows items nobody can justify.
 */
export const ACCOUNT_APP_PERMISSIONS = Object.freeze({
  // The claim flow asks a student to confirm one of their own GitHub-VERIFIED
  // email addresses, which is a user-to-server read of /user/emails. An
  // installation token cannot do it at all, and without this declaration the
  // SPA's user token is not scoped for it either.
  //
  // THE KEY IS `emails`, NOT `email_addresses`. The App settings UI calls it
  // "Email addresses", and this constant said so - but GET /apps/{slug}
  // reports it as `emails`, measured live 2026-08-27 the moment the permission
  // was actually granted. A constant naming a field the API does not use is a
  // check that can never pass: it warned "email_addresses=missing" while the
  // App plainly declared `emails: read`. Same shape as the scanner rule that
  // guarded `claim_token`, a name appearing nowhere in the repository.
  //
  // ACCOUNT_LEVEL_PERMISSIONS carries both spellings, which is why nothing
  // else tripped over it.
  emails: "read",
});

/**
 * Account permissions the live App does not declare.
 *
 * `declared` is the `permissions` object from GET /apps/{slug}. Same shape and
 * same fail-closed reading as missingManifestPermissions: a permission that is
 * absent, or present at too low a level, is missing.
 */
export function missingAccountPermissions(declared) {
  const actual = declared || {};
  return Object.entries(ACCOUNT_APP_PERMISSIONS)
    .filter(([perm, expected]) => !permissionMeetsRequirement(actual[perm], expected))
    .map(([permission, expected]) => ({ permission, expected, actual: actual[permission] ?? null }));
}

/**
 * Permissions the live App declares that nothing here asks for.
 *
 * THE DRIFT CHECK ONLY EVER LOOKED ONE WAY. missingManifestPermissions walks
 * MANIFEST_APP_PERMISSIONS and reports what the App LACKS, which catches a
 * feature that cannot work. Nothing walked the other direction, so a permission
 * the App holds and no code needs was invisible for as long as it existed - and
 * measured live 2026-08-31, five had accumulated:
 *
 *   members                     write   (roster_mode: org_member was REMOVED)
 *   starring                    write   (nothing in the codebase stars anything)
 *   organization_administration write   (the manifest asks for READ - billing)
 *   plan / organization_plan    read    (no caller found)
 *
 * That is not tidiness. The App's private key is the credential the whole
 * system rests on, and every permission on it is a line in the blast radius of
 * anything that ever obtains it - `members: write` alone is the ability to add
 * and remove organization members across every installed org. An over-grant
 * nobody can see is an over-grant nobody removes.
 *
 * Excess LEVEL counts as excess, not just an excess name: `write` where the
 * manifest asks for `read` is the whole `organization_administration` case, and
 * a name-only comparison reports that App as clean.
 *
 * Account-level names are tagged rather than skipped. They cannot be carried by
 * an organization installation - so they are not part of an org's approval
 * round and need no owner chased - but `starring: write` is exactly the kind of
 * thing that hides in that exemption, and the fix is one toggle by the App
 * owner. The tag routes the reader to the right settings page instead of
 * silencing the finding.
 *
 * The remedy is deliberately two-sided, because both directions are real: NARROW
 * the App, or ADD the permission to the constant with a comment saying what uses
 * it. `actions_variables: write` was the second kind - genuinely required by
 * publish-assignment.yml and simply never written down - and this check is what
 * forces the constant to become a truthful inventory rather than a partial one.
 *
 * @param {object} declared the `permissions` object from GET /apps/{slug}
 */
export function excessDeclaredPermissions(declared) {
  const actual = declared || {};
  const required = { ...MANIFEST_APP_PERMISSIONS, ...ACCOUNT_APP_PERMISSIONS };
  const accountLevel = new Set(ACCOUNT_LEVEL_PERMISSIONS);

  return Object.entries(actual)
    .filter(([permission, level]) => {
      const want = required[permission];
      // Not asked for at all, or asked for at a lower level than granted.
      return !want || !permissionMeetsRequirement(want, level);
    })
    .map(([permission, level]) => ({
      permission,
      actual: level,
      required: required[permission] ?? null,
      accountLevel: accountLevel.has(permission),
    }))
    .sort((a, b) => a.permission.localeCompare(b.permission));
}

/**
 * Installations that have not yet approved what the App now declares.
 *
 * Widening an App's permissions does NOT widen its existing installations:
 * every org owner has to accept the request, and until they do that
 * installation keeps the OLD set while `GET /apps/{slug}` already advertises
 * the new one. So the App looks correct, `check-app-declaration.mjs` passes,
 * and the feature is simply dead on the orgs that never clicked - which is
 * indistinguishable from a bug until someone thinks to ask.
 *
 * Compared against the App's own live declaration rather than
 * MANIFEST_APP_PERMISSIONS on purpose. The question is "has this org accepted
 * what the App asks for today?", so the target moves with the App and no
 * constant has to be bumped in lockstep - bumping the manifest first would
 * paint every org amber for a permission nobody had been asked to approve yet.
 *
 * ACCOUNT_LEVEL_PERMISSIONS are excluded: an organization installation cannot
 * carry them, so including them reports every org as permanently lagging.
 *
 * @param {object} declared      `permissions` from GET /apps/{slug} or GET /app.
 * @param {object[]} installations  Items from GET /app/installations.
 * @returns {{account: string, installationId: number|null,
 *            missing: {permission: string, declared: string, actual: string|null}[]}[]}
 *          one entry per lagging installation, sorted by account.
 */
export function installationApprovalGaps(declared, installations) {
  const accountLevel = new Set(ACCOUNT_LEVEL_PERMISSIONS);
  const want = Object.entries(declared || {}).filter(([perm]) => !accountLevel.has(perm));
  const gaps = [];

  for (const inst of installations || []) {
    if (!inst || typeof inst !== "object") continue;
    const actual = inst.permissions || {};
    const missing = want
      .filter(([perm, level]) => !permissionMeetsRequirement(actual[perm], level))
      .map(([permission, level]) => ({
        permission,
        declared: level,
        actual: actual[permission] ?? null,
      }));
    if (missing.length === 0) continue;
    gaps.push({
      account: inst.account?.login ?? "(unknown account)",
      installationId: typeof inst.id === "number" ? inst.id : null,
      missing,
    });
  }

  return gaps.sort((a, b) => a.account.localeCompare(b.account));
}

// Files that must exist for the control repo scaffold to be considered intact.
// We don't enforce directory contents - just that the scaffold was bootstrapped.
const SCAFFOLD_PATHS = ["README.md", ...CONTROL_SCAFFOLD_DIRS];

// Severity ordering - used to compute the worst-case overall verdict.
const SEVERITY_RANK = { ok: 0, info: 1, warn: 2, fail: 3 };
const worse = (a, b) => (SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b);

function check(id, label, severity, message, detail) {
  return { id, label, severity, message, detail: detail ?? null };
}

// --- Individual checks -------------------------------------------------------

// The App Manifest at /setup only applies at App *creation*. Widening
// MANIFEST_APP_PERMISSIONS afterwards does nothing to an App that already
// exists, and no organization can approve a permission the App does not
// declare - which surfaces as identical "installation drift" on every org at
// once. Checking the App itself first puts the remediation in front of the
// only person who can act on it: the App owner. GET /apps/{slug} is public.
async function checkAppDeclaration(request) {
  const label = "App declares the manifest permissions";
  const res = await request("GET", `/apps/${APP_SLUG}`);
  if (!res.ok) {
    return {
      check: check("app-declaration", label, "info", `Skipped - could not read /apps/${APP_SLUG} (HTTP ${res.status}).`),
      declared: null,
    };
  }
  const declared = res.data?.permissions || {};
  const missing = missingManifestPermissions(declared);
  if (missing.length === 0) {
    return { check: check("app-declaration", label, "ok", "The App declares every permission in the manifest."), declared };
  }
  const labels = missing.map((m) => `${m.permission}=${m.actual ?? "missing"} (want ${m.expected})`).join(", ");
  return {
    check: check(
      "app-declaration",
      label,
      "fail",
      `The App itself does not declare: ${labels}. No organization can approve a permission the App does not declare - the App owner adds it under the App's Permissions & events, then every org owner approves the update.`,
      { missing },
    ),
    declared,
  };
}

// Provisioning creates repositories that did not exist when the App was
// installed. A "selected repositories" installation cannot see them, so every
// student repo 404s right after creation. The hub's own installation is
// deliberately scoped to pxl-classroom (ARCHITECTURE.md section 3.2).
function checkRepositoryAccess(installation, org, hubOwner) {
  const label = "App installed on all repositories";
  if (!installation) return check("app-repository-access", label, "info", "Skipped - no installation.");
  if (hubOwner && org.toLowerCase() === hubOwner.toLowerCase()) {
    return check("app-repository-access", label, "ok", "Hub installation - intentionally scoped to the hub repository.");
  }
  const selection = installation.repository_selection;
  if (!selection) return check("app-repository-access", label, "info", "Installation did not report repository_selection.");
  if (selection === "all") return check("app-repository-access", label, "ok", "Installed on all repositories.");
  return check(
    "app-repository-access",
    label,
    "fail",
    `Installation is scoped to selected repositories. Student repositories do not exist yet at install time, so the App cannot see them once provisioned - set Repository access to "All repositories" at https://github.com/organizations/${org}/settings/installations.`,
    { repository_selection: selection },
  );
}

async function checkInstallation(request, org) {
  // 1. Try GET /user/installations (works for App user-to-server tokens)
  const userInsts = await request("GET", "/user/installations");
  if (userInsts.ok) {
    const list = Array.isArray(userInsts.data?.installations) ? userInsts.data.installations : [];
    const inst = list.find((i) => i.account?.login?.toLowerCase() === org.toLowerCase());
    if (inst) {
      return {
        check: check("app-installed", "App installed on org", "ok", `Installation ID ${inst.id}.`, { installation_id: inst.id }),
        installation: inst,
      };
    }
  }

  // 2. Try GET /orgs/{org}/installations (works for org owners with PAT)
  const listRes = await request("GET", `/orgs/${org}/installations`);
  if (listRes.ok) {
    const inst = pickClassroomInstallation(listRes.data);
    if (inst) {
      return {
        check: check("app-installed", "App installed on org", "ok", `Installation ID ${inst.id}.`, { installation_id: inst.id }),
        installation: inst,
      };
    }
  }

  // 3. Try GET /orgs/{org}/installation (works for JWT/App auth)
  const res = await request("GET", `/orgs/${org}/installation`);
  if (res.status === 404) {
    return { check: check("app-installed", "App installed on org", "fail", "No PXL Classroom App installation found on this org."), installation: null };
  }
  if (!res.ok) {
    return { check: check("app-installed", "App installed on org", "warn", `Could not read installation (HTTP ${res.status}).`), installation: null };
  }
  return { check: check("app-installed", "App installed on org", "ok", `Installation ID ${res.data.id}.`, { installation_id: res.data.id }), installation: res.data };
}

function checkPermissions(installation, declared) {
  if (!installation) return check("app-permissions", "App permissions match manifest", "info", "Skipped - no installation.");
  const actual = installation.permissions || {};
  const drift = [];
  for (const [perm, expected] of Object.entries(EXPECTED_APP_PERMISSIONS)) {
    const got = actual[perm];
    if (!permissionMeetsRequirement(got, expected)) {
      drift.push({
        permission: perm,
        expected,
        actual: got ?? null,
        // Undeclared upstream means approving at the org level is impossible,
        // not merely pending - a different person has to act.
        upstream: declared ? !permissionMeetsRequirement(declared[perm], expected) : false,
      });
    }
  }
  if (drift.length === 0) {
    return check("app-permissions", "App permissions match manifest", "ok", "All expected permissions present at the right level.");
  }
  const labels = drift.map((d) => `${d.permission}=${d.actual ?? "missing"} (want ${d.expected})`).join(", ");
  const upstream = drift.filter((d) => d.upstream);
  if (upstream.length && upstream.length === drift.length) {
    return check(
      "app-permissions",
      "App permissions match manifest",
      "fail",
      `Permission drift: ${labels}. Blocked upstream - the App does not declare ${upstream.length === 1 ? "this permission" : "these permissions"}, so there is nothing for an org owner to approve yet. Fix the App first (see the App declaration check).`,
      { drift },
    );
  }
  const partial = upstream.length
    ? ` ${upstream.map((d) => d.permission).join(", ")} must additionally be added to the App itself first.`
    : "";
  return check("app-permissions", "App permissions match manifest", "fail", `Permission drift: ${labels}. Re-approve the App with the manifest permissions.${partial}`, { drift });
}

async function checkControlRepo(request, org) {
  const repoRes = await request("GET", `/repos/${org}/${CONTROL_REPO}`);
  if (repoRes.status === 404) {
    return check("control-repo", "Control repo exists, private, scaffold intact", "fail", `${org}/${CONTROL_REPO} does not exist. Run Setup Organization.`);
  }
  if (!repoRes.ok) {
    return check("control-repo", "Control repo exists, private, scaffold intact", "warn", `Could not read ${CONTROL_REPO} (HTTP ${repoRes.status}).`);
  }
  if (!repoRes.data.private) {
    return check("control-repo", "Control repo exists, private, scaffold intact", "fail", `${CONTROL_REPO} is public. Data-only repos must be private.`);
  }
  const missing = [];
  for (const path of SCAFFOLD_PATHS) {
    const r = await request("GET", `/repos/${org}/${CONTROL_REPO}/contents/${path}`);
    if (r.status === 404) missing.push(path);
  }
  if (missing.length > 0) {
    return check("control-repo", "Control repo exists, private, scaffold intact", "warn", `Scaffold paths missing: ${missing.join(", ")}.`, { missing });
  }
  return check("control-repo", "Control repo exists, private, scaffold intact", "ok", `Private, all ${SCAFFOLD_PATHS.length} scaffold paths present.`);
}

async function checkParticipatingOrgs(request, org, hubOwner, hubRepo) {
  if (!hubOwner || !hubRepo) {
    return check("participating-orgs", "Org listed on participating-orgs branch", "info", "Skipped - hub repo not provided.");
  }
  const res = await request("GET", `/repos/${hubOwner}/${hubRepo}/contents/participating-orgs.yml?ref=participating-orgs`);
  if (res.status === 404) {
    return check("participating-orgs", "Org listed on participating-orgs branch", "warn", "participating-orgs.yml not found on the hub's participating-orgs branch.");
  }
  if (!res.ok) {
    return check("participating-orgs", "Org listed on participating-orgs branch", "warn", `Could not read participating-orgs.yml (HTTP ${res.status}).`);
  }
  let parsed;
  try {
    const raw = res.data?.content ? atobSafe(res.data.content) : (res.data?.raw || "");
    parsed = parseYaml(raw);
  } catch (e) {
    return check("participating-orgs", "Org listed on participating-orgs branch", "warn", `participating-orgs.yml could not be parsed: ${e.message}.`);
  }
  const entry = (parsed.orgs || []).find((o) => o.login?.toLowerCase() === org.toLowerCase());
  if (!entry) {
    return check("participating-orgs", "Org listed on participating-orgs branch", "fail", `${org} is missing from participating-orgs.yml. Weekly usage report will not include this org.`);
  }
  return check("participating-orgs", "Org listed on participating-orgs branch", "ok", `Listed (budget owner: @${entry.budget_owner_login}).`, { entry });
}

/**
 * Whether the person running this can actually publish.
 *
 * Publishing an assignment and retrying an acceptance both `workflow_dispatch`
 * on the hub using the LECTURER's own token, so they need write on the hub
 * repository. Without it the SPA raises a 403 at the moment of publishing -
 * after the assignment has already been written - and a 403 does not say which
 * of its several causes applies. Saying so up front is the whole point.
 *
 * The trap this exists to name: adding a lecturer to the hub ORGANIZATION does
 * not do it. That org's base permission is `read`, so a plain member lands on
 * read for the hub repository and every dispatch 403s - which reads as "I added
 * them and it still fails" rather than as a permission level. OPEN-ITEMS §4.
 *
 * `permissions` is returned for the authenticated user on any repository they
 * can see. Its ABSENCE means nobody is authenticated, which is not the same
 * answer as "no access" - so it yields no verdict rather than a green one or a
 * red one.
 */
async function checkHubDispatchAccess(request, hubOwner, hubRepo) {
  const label = "You can publish and retry from here";
  if (!hubOwner || !hubRepo) {
    return check("hub-dispatch", label, "info", "Skipped - hub repo not provided.");
  }

  const res = await request("GET", `/repos/${hubOwner}/${hubRepo}`);
  if (!res.ok) {
    return check("hub-dispatch", label, "warn",
      `Could not read ${hubOwner}/${hubRepo} (HTTP ${res.status}), so your access to the hub could not be checked.`);
  }

  const push = res.data?.permissions?.push;
  if (typeof push !== "boolean") {
    return check("hub-dispatch", label, "info",
      "GitHub did not report your permissions on the hub repository, so this could not be checked.");
  }

  if (push) {
    return check("hub-dispatch", label, "ok",
      `You have write access to ${hubOwner}/${hubRepo}, which is what Publish and Retry acceptance need.`,
      { push: true });
  }

  return check("hub-dispatch", label, "warn",
    `You do not have write access to ${hubOwner}/${hubRepo}. ` +
    `Creating and editing assignments still works - those are saved in your own control repository - but Publish and Retry acceptance will fail with a 403. ` +
    `Ask a hub administrator to add you as a collaborator with Write. ` +
    `Being a member of the ${hubOwner} organization is not enough on its own: its base permission is "read", and read cannot dispatch a workflow.`,
    { push: false });
}

async function checkAssignmentLockdown(request, org, assignmentId) {
  const lockdownRes = await request("GET", `/repos/${org}/${CONTROL_REPO}/contents/lockdowns/${assignmentId}/lockdown-record.json`);
  if (lockdownRes.status === 404) {
    return check("assignment-lockdown", `Lockdown record matches repo permissions (${assignmentId})`, "info", "No lockdown record yet - deadline may not have passed.");
  }
  if (!lockdownRes.ok) {
    return check("assignment-lockdown", `Lockdown record matches repo permissions (${assignmentId})`, "warn", `Could not read lockdown record (HTTP ${lockdownRes.status}).`);
  }
  let record;
  try {
    const raw = lockdownRes.data?.content ? atobSafe(lockdownRes.data.content) : "";
    record = JSON.parse(raw);
  } catch (e) {
    return check("assignment-lockdown", `Lockdown record matches repo permissions (${assignmentId})`, "warn", `Lockdown record unparseable: ${e.message}.`);
  }
  const mismatches = [];
  const results = Array.isArray(record.results) ? record.results : [];
  // Sample up to 10 students rather than hammering the API on a large class.
  const sample = results.slice(0, 10);
  for (const r of sample) {
    if (!r.repo_name || !r.login) continue;
    const repoOnly = r.repo_name.includes("/") ? r.repo_name.split("/")[1] : r.repo_name;
    const permRes = await request("GET", `/repos/${org}/${repoOnly}/collaborators/${r.login}/permission`);
    if (!permRes.ok) continue;
    const got = permRes.data?.permission ?? "unknown";
    if (got !== "read" && got !== "none") {
      mismatches.push({ login: r.login, expected: "read", got });
    }
  }
  if (mismatches.length > 0) {
    return check("assignment-lockdown", `Lockdown record matches repo permissions (${assignmentId})`, "fail", `${mismatches.length} student(s) still have write access after lockdown.`, { mismatches });
  }
  return check("assignment-lockdown", `Lockdown record matches repo permissions (${assignmentId})`, "ok", `Sampled ${sample.length} student(s); all demoted to read or less.`);
}

async function checkAssignmentArchive(request, org, assignmentId) {
  const reportRes = await request("GET", `/repos/${org}/${CONTROL_REPO}/contents/reports/${assignmentId}.json`);
  if (reportRes.status === 404) {
    return check("assignment-archive", `Archive branches exist for reported submissions (${assignmentId})`, "info", "No report yet - preservation may not have run.");
  }
  if (!reportRes.ok) {
    return check("assignment-archive", `Archive branches exist for reported submissions (${assignmentId})`, "warn", `Could not read report (HTTP ${reportRes.status}).`);
  }
  let report;
  try {
    const raw = reportRes.data?.content ? atobSafe(reportRes.data.content) : "";
    report = JSON.parse(raw);
  } catch (e) {
    return check("assignment-archive", `Archive branches exist for reported submissions (${assignmentId})`, "warn", `Report unparseable: ${e.message}.`);
  }
  const submitters = (report.students || []).filter((s) => s.preservation_status === "preserved" && s.github_login);
  if (submitters.length === 0) {
    return check("assignment-archive", `Archive branches exist for reported submissions (${assignmentId})`, "info", "No preserved submissions in the report.");
  }
  const missing = [];
  const sample = submitters.slice(0, 10);
  for (const s of sample) {
    // Both the repository and the ref come off the report row. Archives are per
    // assignment now, and deriving either would report every submission
    // preserved before that change as a missing branch - a Tier-level FAIL on a
    // cohort that is perfectly intact. The reconstruction below is the fallback
    // for rows written before the fields were propagated; it uses the team slug
    // where there is one, because a group is preserved under its team.
    const branchName = archiveBranchName({
      assignmentId,
      login: s.github_login,
      teamSlug: s.team_slug,
      recordedRef: s.archive_ref,
    });
    const repo = resolveArchiveRepo({ org, recorded: s.archive_repo });
    if (!branchName || !repo) continue;
    const br = await request("GET", `/repos/${repo}/branches/${encodeURIComponent(branchName)}`);
    if (br.status === 404) missing.push(s.github_login);
  }
  if (missing.length > 0) {
    return check("assignment-archive", `Archive branches exist for reported submissions (${assignmentId})`, "fail", `${missing.length} archive branch(es) missing.`, { missing });
  }
  return check("assignment-archive", `Archive branches exist for reported submissions (${assignmentId})`, "ok", `Sampled ${sample.length} student(s); all archive branches present.`);
}

/**
 * Every published assignment in the org, against its broker.
 *
 * The per-assignment check below is thorough and answers for ONE assignment,
 * which means somebody has to already suspect that assignment. Nothing looked
 * across the org, so a published assignment with no broker was invisible: not
 * on the dashboard, not in System Health, and silent until a lecturer happened
 * to reopen its Admin panel and read the banner. Two of them sat that way, and
 * the only thing that found them repo-wide was a script written by hand after
 * the fact (2026-09-02, OPEN-ITEMS §4's sibling).
 *
 * A student cannot accept such an assignment. The invitation link resolves to
 * nothing, which is the most expensive silence in the system.
 *
 * Two rules it obeys deliberately:
 *
 * - **Unreadable is not evidence.** An assignment whose YAML or broker could
 *   not be read is counted separately and BLOCKS an `ok`. Reporting "all
 *   brokers present" while three were unreadable is worse than reporting
 *   nothing, because it is the answer somebody acts on.
 * - **A directory listing is a page.** The contents API returns at most 1000
 *   entries for a directory and does not paginate, so a cohort larger than that
 *   would be silently truncated. Far beyond any real course, and named here so
 *   the assumption is visible rather than implied.
 */
async function checkPublishedBrokers(request, org) {
  const label = "Every published assignment has a broker";

  const list = await request("GET", `/repos/${org}/${CONTROL_REPO}/contents/assignments`);
  if (list.status === 404) {
    return check("published-brokers", label, "info", "No assignments directory yet.");
  }
  if (!list.ok) {
    return check("published-brokers", label, "warn",
      `Could not list assignments (HTTP ${list.status}), so this could not be checked.`);
  }

  const files = (Array.isArray(list.data) ? list.data : []).filter(
    (f) => f?.type === "file" && typeof f.name === "string" && f.name.endsWith(".yml"),
  );

  const missing = [];
  const unreadable = [];
  let published = 0;

  for (const f of files) {
    const id = f.name.replace(/\.yml$/, "");
    const docRes = await request("GET", `/repos/${org}/${CONTROL_REPO}/contents/assignments/${f.name}`);
    if (!docRes.ok) { unreadable.push(`${f.name} (HTTP ${docRes.status})`); continue; }

    let doc;
    try {
      doc = parseYaml(docRes.data?.content ? atobSafe(docRes.data.content) : (docRes.data?.raw || ""));
    } catch {
      unreadable.push(`${f.name} (unparseable)`);
      continue;
    }
    if (doc?.state !== "published") continue;
    published++;

    const brokerName = brokerRepoName({ assignment: doc, assignmentId: doc?.id || id });
    if (!brokerName) { unreadable.push(`${f.name} (no assignment id)`); continue; }

    const brokerRes = await request("GET", `/repos/${org}/${brokerName}`);
    if (brokerRes.ok) continue;
    if (brokerRes.status === 404) missing.push({ id: doc?.id || id, broker: brokerName });
    else unreadable.push(`${brokerName} (HTTP ${brokerRes.status})`);
  }

  const detail = { published, missing, unreadable };

  if (missing.length > 0) {
    const names = missing.map((m) => m.id).join(", ");
    return check("published-brokers", label, "fail",
      `${missing.length} published assignment(s) have no acceptance broker: ${names}. ` +
      `Students cannot accept them - the invitation link resolves to nothing. ` +
      `Open each in the Admin Panel and use "Complete Setup / Create Broker Now".` +
      (unreadable.length ? ` A further ${unreadable.length} could not be checked.` : ""),
      detail);
  }

  if (unreadable.length > 0) {
    return check("published-brokers", label, "warn",
      `${unreadable.length} assignment(s) could not be checked, so this is not a clean result: ${unreadable.join(", ")}.`,
      detail);
  }

  if (published === 0) {
    return check("published-brokers", label, "info", "No published assignments yet.", detail);
  }

  return check("published-brokers", label, "ok", `All ${published} published assignment(s) have a broker.`, detail);
}

async function checkAssignmentBroker(request, org, assignmentId) {
  const ymlRes = await request("GET", `/repos/${org}/${CONTROL_REPO}/contents/assignments/${assignmentId}.yml`);
  if (ymlRes.status === 404) {
    return check("assignment-broker", `Acceptance broker exists (${assignmentId})`, "info", `assignments/${assignmentId}.yml not found in control repo.`);
  }
  if (!ymlRes.ok) {
    return check("assignment-broker", `Acceptance broker exists (${assignmentId})`, "warn", `Could not read assignment ${assignmentId}.yml (HTTP ${ymlRes.status}).`);
  }
  let doc;
  try {
    const raw = ymlRes.data?.content ? atobSafe(ymlRes.data.content) : (ymlRes.data?.raw || "");
    doc = parseYaml(raw);
  } catch (e) {
    return check("assignment-broker", `Acceptance broker exists (${assignmentId})`, "warn", `Assignment ${assignmentId}.yml unparseable: ${e.message}.`);
  }
  if (doc?.state !== "published") {
    return check("assignment-broker", `Acceptance broker exists (${assignmentId})`, "info", `Assignment state is "${doc?.state || 'draft'}" - broker not required.`);
  }

  const brokerName = brokerRepoName({ assignment: doc, assignmentId });
  const brokerRes = await request("GET", `/repos/${org}/${brokerName}`);
  if (brokerRes.status === 404) {
    return check(
      "assignment-broker",
      `Acceptance broker exists (${assignmentId})`,
      "fail",
      `Assignment is published, but broker repo ${org}/${brokerName} does not exist. Run Publish/Republish from the Admin Panel.`,
      { broker_repo: brokerName }
    );
  }
  if (!brokerRes.ok) {
    return check("assignment-broker", `Acceptance broker exists (${assignmentId})`, "warn", `Could not check broker ${brokerName} (HTTP ${brokerRes.status}).`);
  }
  return check("assignment-broker", `Acceptance broker exists (${assignmentId})`, "ok", `Published and broker ${brokerName} exists.`);
}

// --- Public API --------------------------------------------------------------

export async function runAudit({ request, org, assignmentId = null, hubOwner = null, hubRepo = null }) {
  if (typeof request !== "function") throw new Error("runAudit requires a request(method, path) function");
  if (!org) throw new Error("runAudit requires an org");

  const checks = [];

  // Core org-level checks
  const { check: declarationCheck, declared } = await checkAppDeclaration(request);
  checks.push(declarationCheck);
  const { check: installCheck, installation } = await checkInstallation(request, org);
  checks.push(installCheck);
  checks.push(checkPermissions(installation, declared));
  checks.push(checkRepositoryAccess(installation, org, hubOwner));
  checks.push(await checkControlRepo(request, org));
  checks.push(await checkParticipatingOrgs(request, org, hubOwner, hubRepo));
  checks.push(await checkHubDispatchAccess(request, hubOwner, hubRepo));
  checks.push(await checkPublishedBrokers(request, org));

  // Optional per-assignment deep checks
  if (assignmentId) {
    checks.push(await checkAssignmentBroker(request, org, assignmentId));
    checks.push(await checkAssignmentLockdown(request, org, assignmentId));
    checks.push(await checkAssignmentArchive(request, org, assignmentId));
  }

  const overall = checks.reduce((acc, c) => worse(acc, c.severity), "ok");
  return {
    schema_version: 1,
    org,
    assignment_id: assignmentId,
    generated_at: new Date().toISOString(),
    overall,
    checks,
  };
}

// Tiny base64 decode that works in both Node and the browser. Used to read
// Contents API responses; the GitHub API returns base64-encoded `content`.
function atobSafe(b64) {
  const compact = String(b64).replace(/\n/g, "");
  if (typeof atob === "function") {
    return new TextDecoder().decode(Uint8Array.from(atob(compact), (c) => c.charCodeAt(0)));
  }
  return Buffer.from(compact, "base64").toString("utf8");
}
