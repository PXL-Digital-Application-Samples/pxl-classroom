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
  //
  // The capability checks themselves - owner, hub write, and since 2026-09-17
  // the hub registry - live in frontend/src/lib/control-repo-access.js and are
  // RUN by tests/control-repo-access.test.mjs. This guards the wiring.
  const at = code.indexOf("repoRes.status === 404");
  assert.ok(at > 0, "the 404 branch must still exist - update this guard with it");
  const end = code.indexOf("orgStatusMap.value.set", at);
  assert.ok(end > at, "the 404 branch must still end by recording the org's status");
  const branch = code.slice(at, end);

  assert.match(
    branch,
    /await classifyUnreadableControlRepo\(/,
    "a 404 must resolve through the shared judge, not straight to onboarding",
  );
  assert.match(
    branch,
    /dashState\.value = DASH_STATE_FOR_VERDICT\[access\.verdict\]/,
    "and the state must be the judge's verdict",
  );
  assert.ok(
    !/dashState\.value = '[a-z-]+'/.test(branch),
    "an unconditional state in this branch is the defect this test exists for",
  );
  const judged = branch.indexOf("classifyUnreadableControlRepo(");
  const decided = branch.indexOf("dashState.value =");
  assert.ok(judged < decided, "the judge must run before the state it decides");
});

test("every verdict the judge can return renders a state of its own", async () => {
  // Two spellings in two files: the verdicts in control-repo-access.js and the
  // states this template switches on. A verdict with no row renders
  // `dashState = undefined` - the unexplained "Nothing to show" fallback.
  const { UNREADABLE_CONTROL_REPO_VERDICTS } = await import("../frontend/src/lib/control-repo-access.js");
  const map = code.match(/const DASH_STATE_FOR_VERDICT = Object\.freeze\(\{([\s\S]*?)\}\)/);
  assert.ok(map, "DASH_STATE_FOR_VERDICT must exist");
  const rows = Object.fromEntries(
    [...map[1].matchAll(/'?([a-z-]+)'?\s*:\s*'([a-z-]+)'/g)].map((m) => [m[1], m[2]]),
  );
  assert.deepEqual(Object.keys(rows).sort(), [...UNREADABLE_CONTROL_REPO_VERDICTS].sort());
  for (const [verdict, state] of Object.entries(rows)) {
    assert.match(code, new RegExp(`dashState === '${state}'`), `${verdict} -> ${state} must be rendered`);
  }
});

test("hub write alone is not staff on an org that is set up", () => {
  // Reported 2026-09-17: an owner of the hub org, only an outside collaborator
  // on PXL-Java-Essentials, got the onboarding card and a Set up button over a
  // running course and ran Setup Organization twice. Its own state must offer
  // neither the button nor the Lecturer tag.
  const at = SRC.indexOf(`dashState === 'no-org-access'`);
  assert.ok(at > 0, "the set-up-but-not-yours state must exist");
  const block = SRC.slice(at, SRC.indexOf("</template>", at));
  assert.ok(!/runSetupOrg|Set up \{\{/.test(block), "no Set up button");
  assert.match(block, /owner of/, "and it says who grants access");

  const unknown = SRC.indexOf(`dashState === 'registry-unknown'`);
  assert.ok(unknown > 0, "an unreadable registry must have a state of its own");
  const unknownBlock = SRC.slice(unknown, SRC.indexOf("</template>", unknown));
  assert.ok(!/runSetupOrg/.test(unknownBlock), "unknown is not an invitation to set up");
});

test("the Lecturer badge is not asserted for an account with no access", () => {
  // It was unconditional. A label naming a role the system had never checked is
  // the same class as "GitHub has no repository for you and no invitation
  // waiting" - a confident statement about something nothing computed.
  assert.match(
    code,
    /v-if="staffHere"[^>]*class="lecturer-tag/,
    "the Lecturer tag must be gated on the account being able to read this org",
  );
  const set = code.match(/const CANNOT_READ_ORG = new Set\(\[([^\]]*)\]\)/);
  assert.ok(set, "the states that withhold it must be one named set");
  for (const state of ["no-access", "no-org-access", "registry-unknown"]) {
    assert.ok(set[1].includes(`'${state}'`), `${state} must withhold the Lecturer tag`);
  }
  assert.match(code, /const staffHere = computed\(\(\) => !CANNOT_READ_ORG\.has\(dashState\.value\)\)/);
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
  assert.match(usage[0], /&& staffHere/, "and hidden from an account that cannot read the org");

  // The refused states must come FIRST in the chain, or the onboarding branch
  // above them wins and Setup Organization is offered again.
  const onboarding = code.indexOf("dashState === 'no-control-repo'");
  assert.ok(onboarding > 0, "the onboarding state must exist");
  for (const state of ["no-access", "no-org-access", "registry-unknown"]) {
    const refused = code.indexOf(`dashState === '${state}'`);
    assert.ok(refused > 0, `${state} must exist`);
    assert.ok(refused < onboarding, `${state} must be tested before the onboarding card`);
  }
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
