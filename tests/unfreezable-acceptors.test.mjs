// An accepted student who is an ORGANIZATION OWNER cannot be frozen at the
// deadline, and nothing warned about it until a live finalize rehearsal walked
// into it (2026-08-26).
//
// This is the sibling of tests/org-base-permission.test.mjs. That one covers
// `default_repository_permission`, the floor under every org MEMBER. An OWNER
// is not subject to a floor at all - GitHub grants owners admin on every
// repository - so lockdown's demote() writes `pull`, verifies, reads back
// `admin`, and records `verified: false`. The freeze does not hold, and the
// only place that said so was the record, after the deadline.
//
// The rules pinned here, in the order they cost something:
//   - unreadable is NOT evidence: no owner list yields NO check, never a green
//     one (the rule Tier 1 applies to /apps/{slug});
//   - a truncated owner list may not report `ok` - "one page is not the list";
//   - NO branch of this check is ever a failure. The first cut failed on any
//     owner but the signed-in viewer, which assumed a non-self owner would be a
//     student. It cannot be: provisioning adds students as repository
//     COLLABORATORS, so a student is only an owner if somebody promoted them,
//     and in practice every owner in an acceptance list is staff - the viewer,
//     or a colleague testing the assignment. Failing put a permanent red on a
//     live exam that nobody should act on, which is how a check stops being
//     read (the reason a third-party installation is a notice). The wording
//     still separates "that is you" from an account the reader may not know,
//     and still spells out the case that IS actionable;
//   - matching is case-insensitive (accept.mjs's gate is) but REPORTING uses
//     the caller's spelling, or a lecturer is sent after an account that, as
//     spelled, does not exist.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { unfreezableAcceptorsFinding } from "../lib/audit.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const ORG = "PXL-Automation-II";

test("an owner among the acceptors is named, and is never a failure", () => {
  // The real 2026-08-30 exam cohort, as measured: four plain collaborators and
  // two org owners, one of whom is the signed-in lecturer and the other a
  // colleague.
  const f = unfreezableAcceptorsFinding({
    acceptors: ["IlkayDuranPXL", "LowieSerneelsPXL", "afx42", "rayaneW", "tomccargo", "tomcoolpxl"],
    owners: ["afx42", "tomcoolpxl"],
    org: ORG,
    viewerLogin: "tomcoolpxl",
  });

  // NEVER a fail. A student cannot become an org owner on their own -
  // provisioning adds them as repository collaborators - so an owner in an
  // acceptance list is staff, and a red on a live exam that nobody should act
  // on is how a check stops being read.
  assert.equal(f.severity, "warn");
  assert.deepEqual(f.unfreezable, ["afx42"], "the other owner is still named");
  assert.deepEqual(f.self, ["tomcoolpxl"], "the viewer's own account is separated out");
  assert.match(f.message, /afx42/);
  assert.match(f.message, /Every actual student still freezes normally/,
    "a partial cohort still finalizes - the message must not read as a dead exam");
  assert.match(f.message, /If one of these IS a student/,
    "the genuinely actionable case still has to be spelled out");
});

test("no severity anywhere in this check is a failure", () => {
  // Pinning the rule itself rather than one branch of it: a later pass must not
  // reintroduce a red on a cohort that is behaving exactly as designed.
  const cases = [
    { acceptors: ["a"], owners: ["a"], viewerLogin: null },
    { acceptors: ["a"], owners: ["a"], viewerLogin: "a" },
    { acceptors: ["a", "b"], owners: ["a", "b"], viewerLogin: "a" },
    { acceptors: ["a"], owners: [], ownersComplete: false, viewerLogin: null },
    { acceptors: ["a"], owners: [], viewerLogin: null },
  ];
  for (const c of cases) {
    const f = unfreezableAcceptorsFinding({ org: ORG, ...c });
    assert.notEqual(f?.severity, "fail", `${JSON.stringify(c)} must not be a failure`);
  }
});

test("only the viewer's own account is a warn, never a fail", () => {
  // A lecturer accepting their own assignment to test it is the ordinary case.
  const f = unfreezableAcceptorsFinding({
    acceptors: ["studentA", "tomcoolpxl"],
    owners: ["tomcoolpxl"],
    org: ORG,
    viewerLogin: "tomcoolpxl",
  });
  assert.equal(f.severity, "warn");
  assert.deepEqual(f.unfreezable, []);
  assert.match(f.message, /expected for a test acceptance/);
});

test("an owner who is not the viewer is still reported, by name", () => {
  // Same data, different viewer. The SEVERITY does not turn on whose account it
  // is - both are warnings - but the wording does: one says "that is you", the
  // other names an account the reader may not recognise.
  const f = unfreezableAcceptorsFinding({
    acceptors: ["studentA", "tomcoolpxl"],
    owners: ["tomcoolpxl"],
    org: ORG,
    viewerLogin: "someone-else",
  });
  assert.equal(f.severity, "warn");
  assert.deepEqual(f.unfreezable, ["tomcoolpxl"]);
  assert.doesNotMatch(f.message, /Your own account/);
});

test("an unreadable owner list yields NO check, not a green one", () => {
  // The rule this repo applies everywhere: a fact the caller cannot see is not
  // a fact in our favour. A 403 on /orgs/{org}/members must not certify a
  // cohort as freezable.
  for (const owners of [null, undefined]) {
    assert.equal(
      unfreezableAcceptorsFinding({ acceptors: ["a", "b"], owners, org: ORG }),
      null,
      `owners=${owners} must produce no check at all`,
    );
  }
});

test("a truncated owner list may not report ok", () => {
  // "One page is not the list." A walk that stopped early and found nothing is
  // not evidence that there is nothing.
  const f = unfreezableAcceptorsFinding({
    acceptors: ["studentA"],
    owners: ["someone-not-in-the-cohort"],
    ownersComplete: false,
    org: ORG,
  });
  assert.equal(f.severity, "warn");
  assert.match(f.message, /incomplete/i);

  // ...but a truncated list that DID find an owner is still a finding: the
  // match is real regardless of what the unread pages hold.
  const hit = unfreezableAcceptorsFinding({
    acceptors: ["studentA"],
    owners: ["studentA"],
    ownersComplete: false,
    org: ORG,
  });
  assert.equal(hit.severity, "warn");
});

test("a clean cohort is ok, and says how many it checked", () => {
  const f = unfreezableAcceptorsFinding({
    acceptors: ["a", "b", "c"],
    owners: ["some-owner"],
    org: ORG,
  });
  assert.equal(f.severity, "ok");
  assert.match(f.message, /All 3 accepted students/);
});

test("matching is case-insensitive, reporting keeps the caller's spelling", () => {
  // accept.mjs's roster gate is case-insensitive, so this must be too, or an
  // owner escapes the check by the capitalisation GitHub happens to return.
  const f = unfreezableAcceptorsFinding({
    acceptors: ["TomCoolPXL"],
    owners: ["tomcoolpxl"],
    org: ORG,
    viewerLogin: null,
  });
  assert.equal(f.severity, "warn", "case must not let an owner through unreported");
  assert.deepEqual(f.unfreezable, ["TomCoolPXL"], "reported as the caller spelled it");
  assert.match(f.message, /TomCoolPXL/);
});

test("no viewer login still reports owners", () => {
  // viewerLogin is optional; without it there is no 'that's you' exemption to
  // apply, and the safe reading is that an owner is an owner.
  const f = unfreezableAcceptorsFinding({
    acceptors: ["tomcoolpxl"],
    owners: ["tomcoolpxl"],
    org: ORG,
  });
  assert.equal(f.severity, "warn");
});

test("an empty cohort is ok rather than a claim about nobody", () => {
  const f = unfreezableAcceptorsFinding({ acceptors: [], owners: ["x"], org: ORG });
  assert.equal(f.severity, "ok");
});

test("the demotion this check predicts is still the one lockdown performs", () => {
  // The finding asserts a specific mechanism: demote() writes `pull`, reads the
  // permission back, and only counts a target as locked when it reads `read`.
  // If lockdown ever stops verifying, this check would be describing behaviour
  // the system no longer has - UX_PLAN's C4, which this repo keeps re-learning.
  const src = readFileSync(join(root, "lockdown", "lockdown.mjs"), "utf8");
  const demote = src.slice(src.indexOf("async function demote("));
  const body = demote.slice(0, demote.indexOf("\n}\n"));

  assert.match(body, /permission:\s*"pull"/, "demote must still write pull");
  assert.match(body, /collaborators\/\$\{m\}\/permission/, "demote must still read the permission back");
  assert.match(body, /userPerm\s*!==\s*"read"/, "demote must still require read to call it locked");
});
