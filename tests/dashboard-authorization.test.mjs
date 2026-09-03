// A student reached the lecturer dashboard, badged "Lecturer".
//
// Reported live, 2026-09-03, with a screenshot: `tomccargo` - a test STUDENT
// account, not a member of PXL-Automation-II - signed into the SPA and was
// shown the organization in the switcher, a "Lecturer" tag beside their name,
// and an onboarding card reading:
//
//   "Almost there - PXL-Automation-II needs its control repository"
//   [ Open Setup Organization ]
//
// Two defects, and the second is what made the first alarming.
//
// 1. NO AUTHORIZATION CHECK ANYWHERE. The org list is built from
//    `/user/installations` filtered to organizations, so an org appears for
//    anyone whose installation access touches it - and accepting ONE assignment
//    is enough, because that grants collaborator access to a repository inside
//    an installation whose repository_selection is `all`. The page inferred
//    "the App is installed somewhere you can touch" as "you are staff here".
//
// 2. A 404 WAS READ AS "ABSENT". GitHub returns 404, not 403, for a private
//    repository you cannot see - so "the control repo does not exist" and "the
//    control repo exists and is not yours" arrive identically, and the code
//    picked the friendlier one. The repository existed the whole time.
//
// Nothing was exposed and nothing would have worked: every read behind that
// screen is the private control repo (404 for them) and every write - workflow
// dispatch, control-repo commit - is refused by GitHub. Verified the same day
// that no report, roster, team or student data is served from Pages. But a
// surface that hands a student a staff console and an admin button is its own
// defect (DESIGN.md §1.5), and it teaches them they have found a hole.
//
// The gate is now demonstrated capability, and it FAILS CLOSED.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = readFileSync(join(root, "frontend", "src", "views", "DashboardView.vue"), "utf8");

/** What the file executes, with the explanations stripped. */
const code = SRC.replace(/<!--[\s\S]*?-->/g, "")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

test("an unreadable control repo is not treated as an absent one", () => {
  // The whole bug in one line. A 404 may not select the onboarding state on its
  // own, because a student and a fresh organization produce the identical 404.
  const at = code.indexOf("repoRes.status === 404");
  assert.ok(at > 0, "the 404 branch must still exist - update this guard with it");
  const branch = code.slice(at, at + 2200);

  assert.match(
    branch,
    /dashState\.value = staff \? 'no-control-repo' : 'no-access'/,
    "a 404 must resolve through a capability check, not straight to onboarding",
  );
  assert.ok(
    !/dashState\.value = 'no-control-repo'\s*$/m.test(branch),
    "an unconditional onboarding state is the defect this test exists for",
  );
});

test("staff is EITHER hub write OR org administration, and both are positive", () => {
  // Hub write alone would have refused the persona the onboarding screen exists
  // for: a lecturer just made an org owner has none, and produces the identical
  // 404 as a student. GET /orgs/{org} separates them - it returns
  // `default_repository_permission` to an owner and null to everyone else,
  // measured 2026-09-03 and already relied on by lib/audit.mjs.
  const at = code.indexOf("repoRes.status === 404");
  const branch = code.slice(at, at + 2200);

  assert.match(branch, /const staff = hubWritable\.value \|\| orgAdmin/, "either signal admits");
  assert.match(
    branch,
    /orgAdmin = Boolean\(orgRes\.ok && orgRes\.data\?\.default_repository_permission != null\)/,
    "org administration is the presence of an owner-only field",
  );
  // Both must default to false and be set only by a successful read, so an
  // unreadable answer refuses rather than admits.
  assert.match(branch, /let orgAdmin = false/, "the org signal must default to refusing");
  assert.match(branch, /catch \{\s*orgAdmin = false/, "and stay refusing when the read throws");
});

test("the capability checks are read BEFORE the state they decide", () => {
  // `hubWritable` used to be fetched after the state was set, as decoration for
  // a button. Both are the gate now, so a state assigned above them would read
  // the previous value - false on a first load, which fails closed, and stale
  // on a second, which does not.
  const at = code.indexOf("repoRes.status === 404");
  const branch = code.slice(at, at + 2200);
  const hub = branch.indexOf("hubWritable.value = Boolean");
  const org = branch.indexOf("orgAdmin = Boolean");
  const decide = branch.indexOf("const staff =");
  assert.ok(hub > 0 && org > 0 && decide > 0, "all three must be in this branch");
  assert.ok(hub < decide && org < decide, "both checks must run before the state they decide");
});

test("the Lecturer badge is not asserted for an account with no access", () => {
  // It was unconditional. A label naming a role the system had never checked is
  // the same class as "GitHub has no repository for you and no invitation
  // waiting" - a confident statement about something nothing computed.
  assert.match(
    code,
    /v-if="dashState !== 'no-access'"[^>]*class="lecturer-tag/,
    "the Lecturer tag must be gated on the account not being refused",
  );
});

test("nothing staff-facing renders in the refused state", () => {
  // The onboarding card carries an "Open Setup Organization" button, and the
  // usage panel reads the org's billing. Neither may render to an account the
  // page has just refused.
  assert.match(
    code,
    /dashState === 'no-access'/,
    "there must be a dedicated refused state, not a silently empty dashboard",
  );
  const usage = code.match(/<UsagePanel v-if="[^"]+"/);
  assert.ok(usage, "the usage panel must still be conditional");
  assert.match(usage[0], /dashState !== 'no-access'/, "and hidden from a refused account");

  // The refused state must come FIRST in the chain, or the onboarding branch
  // above it wins and the student sees Setup Organization again.
  const refused = code.indexOf("dashState === 'no-access'");
  const onboarding = code.indexOf("dashState === 'no-control-repo'");
  assert.ok(refused > 0 && onboarding > 0, "both states must exist");
  assert.ok(refused < onboarding, "the refusal must be tested before the onboarding card");
});

test("the refusal explains why the org is even listed", () => {
  // Without that sentence the screen is a dead end that reads like a bug: the
  // organization is right there in the switcher, so "you have no access" looks
  // like the page contradicting itself.
  const at = SRC.indexOf(`dashState === 'no-access'`);
  const block = SRC.slice(at, SRC.indexOf("</template>", at));
  assert.match(block, /at least\s+one repository in it/, "say why it appears in the switcher");
  assert.match(block, /lecturer/i, "and what a real lecturer should do about it");
  assert.ok(
    !/Setup Organization/i.test(block),
    "the admin action must not be offered to an account that cannot run it",
  );
});

test("the status lamp for a refused org is a declared class", () => {
  // `lamp-${status}` composes a class name from data, and an undeclared class
  // renders unstyled with no build error and no console warning (DESIGN.md §7).
  assert.match(SRC, /\.lamp-no-access\s*\{/, "lamp-no-access must be declared");
  for (const fn of ["getOrgStatusTitle", "getOrgStatusLabel"]) {
    const at = code.indexOf(`function ${fn}`);
    assert.ok(at > 0, `${fn} must exist`);
    assert.match(
      code.slice(at, code.indexOf("\n}", at)),
      /'no-access'/,
      `${fn} must name the refused state rather than falling through to a loading message`,
    );
  }
});
