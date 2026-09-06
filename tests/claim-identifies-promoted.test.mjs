import test from "node:test";
import assert from "node:assert/strict";

import {
  planClaimPromotion,
  claimPromotionChangesAnything,
  claimPromoteCommitMessage,
} from "../lib/promote-roster.mjs";
import { PROMOTED_SOURCE } from "../lib/roster-entries.mjs";

// A row as "Add students who accepted" writes it: a login, and nothing else.
const promoted = (login, over = {}) => ({ github_login: login, source: PROMOTED_SOURCE, ...over });
const roster = (students) => ({ schema_version: 2, students });

const claim = (over = {}) => ({
  schema_version: 1,
  github_login: "rayaneW",
  github_id: 4711,
  email: "rayane.waddah@student.pxl.be",
  domain_allowed: true,
  claim_verified: true,
  claimed_at: "2026-09-01T10:00:00Z",
  claimed_via: "2526-examen-aut2-ek2",
  ...over,
});

const plan = (students, claims, opts = {}) =>
  planClaimPromotion({ roster: roster(students), claims, ...opts });

// ------------------------------------------------------------- the defect

test("THE DEFECT: a claim now fills in the address a promoted row never had", () => {
  // planClaimPromotion joined on `byEmail.get(entry.email)`. A promoted row has
  // no email, so it missed on every one of them - while the claim sitting there
  // carried the github_id AND the login that row is keyed by.
  const p = plan([promoted("rayaneW")], [claim()]);
  assert.equal(p.ok, true);
  assert.equal(p.identified.length, 1);
  assert.equal(p.nextRoster.students[0].email, "rayane.waddah@student.pxl.be");
  assert.equal(p.nextRoster.students[0].github_id, 4711, "and the immutable id with it");
});

test("…and the row keeps everything else it had", () => {
  // MERGE, NEVER REPLACE - rule 1 of this module.
  const p = plan([promoted("rayaneW", { class_group: "3A", student_number: "0123456" })], [claim()]);
  assert.deepEqual(p.nextRoster.students[0], {
    github_login: "rayaneW",
    source: PROMOTED_SOURCE,
    class_group: "3A",
    student_number: "0123456",
    email: "rayane.waddah@student.pxl.be",
    // WHERE IT CAME FROM, beside the value: a claim is an address GitHub
    // verified on the student's own account, and the harvest writes `commit`
    // into the same column for something worth far less.
    email_source: "claim",
    github_id: 4711,
  });
});

test("matched on github_id FIRST, because a login is the one thing a student can change", () => {
  // Renamed on GitHub between accepting and being folded.
  const p = plan(
    [promoted("rayane-new-name", { github_id: 4711 })],
    [claim({ github_login: "rayaneW" })],
  );
  assert.equal(p.identified.length, 1);
  assert.equal(p.nextRoster.students[0].email, "rayane.waddah@student.pxl.be");
});

test("the login is the fallback, matched case-insensitively", () => {
  const p = plan([promoted("RAYANEW")], [claim({ github_login: "rayanew" })]);
  assert.equal(p.identified.length, 1);
});

test("a row that already has an address is untouched by this path", () => {
  // The original join owns that case, and an address a lecturer set outranks
  // one read off a claim.
  const p = plan(
    [promoted("rayaneW", { email: "typed.by.hand@pxl.be" })],
    [claim()],
  );
  assert.deepEqual(p.identified, []);
  assert.equal(p.nextRoster.students[0].email, "typed.by.hand@pxl.be");
});

test("a row whose account no claim mentions is left alone", () => {
  const p = plan([promoted("somebody-else")], [claim()]);
  assert.deepEqual(p.identified, []);
  assert.equal(p.nextRoster.students[0].email, undefined);
});

test("an existing github_id is never overwritten", () => {
  // It is the binding. One already on the row was put there by provisioning or
  // by a lecturer.
  const p = plan([promoted("rayaneW", { github_id: 999 })], [claim({ github_id: 999 })]);
  assert.equal(p.nextRoster.students[0].github_id, 999);
});

// ------------------------------------------------------ what it refuses to do

test("UNVERIFIED is held when nobody is looking, and folded when somebody is", () => {
  // lib/claim.mjs: a typed address is worth nothing on its own. The nightly
  // runs verifiedOnly; a lecturer running it by hand is the human reviewing.
  const typed = [claim({ claim_verified: false })];
  const nightly = plan([promoted("rayaneW")], typed, { verifiedOnly: true });
  assert.deepEqual(nightly.identified, []);
  assert.equal(nightly.unverified.length, 1);
  assert.match(nightly.warnings.map((w) => w.code).join(), /claim-unverified/);

  const byHand = plan([promoted("rayaneW")], typed, { verifiedOnly: false });
  assert.equal(byHand.identified.length, 1);
});

test("AN ADDRESS ANOTHER ROW ALREADY HOLDS is a conflict, not a write", () => {
  // `email` is what this module joins on. Two rows holding one address would
  // make that join ambiguous for good.
  const p = plan(
    [
      { student_number: "0123456", full_name: "Someone Else", email: "rayane.waddah@student.pxl.be" },
      promoted("rayaneW"),
    ],
    [claim()],
  );
  assert.deepEqual(p.identified, []);
  assert.equal(p.conflicts.length, 1);
  assert.match(p.conflicts[0].reason, /already holds this address/);
  assert.equal(p.nextRoster.students[1].email, undefined);
});

test("…and two promoted rows cannot both take one address in a single run", () => {
  // The second must see the first one's write, or the run creates the duplicate
  // it just refused to create.
  const p = plan(
    [promoted("rayaneW"), promoted("rayane-alt", { github_id: 4711 })],
    [claim(), claim({ github_login: "rayane-alt", github_id: 9999 })],
  );
  const emails = p.nextRoster.students.map((s) => s.email).filter(Boolean);
  assert.equal(new Set(emails).size, emails.length, "no address written twice");
});

test("AN ADDRESS OUTSIDE THE ALLOWED DOMAINS is recorded, not written", () => {
  // GitHub verified the account owns it, which does not make it the
  // institutional address the roster's `email` column is for.
  const p = plan([promoted("rayaneW")], [claim({ email: "rayane@gmail.com", domain_allowed: false })]);
  assert.deepEqual(p.identified, []);
  assert.equal(p.outsideDomains.length, 1);
  assert.equal(p.outsideDomains[0].email, "rayane@gmail.com");
  assert.match(p.warnings.map((w) => w.message).join(" "), /outside the allowed domains/);
  assert.match(p.warnings.map((w) => w.message).join(" "), /GitHub verified the account owns it/);
});

test("TWO CLAIMS FOR ONE ACCOUNT is ambiguous, and picks no winner", () => {
  const p = plan(
    [promoted("rayaneW")],
    [claim(), claim({ email: "other.address@student.pxl.be" })],
  );
  assert.deepEqual(p.identified, []);
  assert.equal(p.ambiguous.length, 1);
});

test("a claim with no address is not a claim for this purpose", () => {
  const p = plan([promoted("rayaneW")], [claim({ email: "" })]);
  assert.deepEqual(p.identified, []);
});

// -------------------------------------------------------- both directions

test("the two joins do not interfere: one run can link a login AND fill an address", () => {
  const p = plan(
    [
      // Has an address, no login: the original direction.
      { student_number: "0123456", full_name: "Lowie Serneels", email: "lowie.serneels@student.pxl.be" },
      // Has a login, no address: the new one.
      promoted("rayaneW"),
    ],
    [
      claim({ github_login: "LowieSerneelsPXL", github_id: 22, email: "lowie.serneels@student.pxl.be" }),
      claim(),
    ],
  );
  assert.equal(p.updated.length, 1, "one login linked");
  assert.equal(p.identified.length, 1, "one address filled in");
  assert.equal(p.nextRoster.students[0].github_login, "LowieSerneelsPXL");
  assert.equal(p.nextRoster.students[1].email, "rayane.waddah@student.pxl.be");
});

test("A RUN THAT ONLY IDENTIFIES STILL COMMITS", () => {
  // claimPromotionChangesAnything checked `updated` alone, so a run that only
  // filled in addresses would have written nothing - on exactly the cohort this
  // exists for.
  const p = plan([promoted("rayaneW")], [claim()]);
  assert.equal(p.updated.length, 0);
  assert.equal(claimPromotionChangesAnything(p), true);
  assert.match(claimPromoteCommitMessage(p), /1 address\(es\)/);
});

test("a run that does nothing still reports nothing to commit", () => {
  const p = plan([promoted("somebody-else")], [claim()]);
  assert.equal(claimPromotionChangesAnything(p), false);
});

test("the commit message names both halves when both happened", () => {
  const p = plan(
    [
      { student_number: "1", full_name: "A", email: "a@student.pxl.be" },
      promoted("rayaneW"),
    ],
    [claim({ github_login: "a-dev", github_id: 1, email: "a@student.pxl.be" }), claim()],
  );
  assert.match(claimPromoteCommitMessage(p), /1 claim binding\(s\) and 1 address\(es\)/);
});

test("the stats carry the new counts", () => {
  const p = plan([promoted("rayaneW")], [claim()]);
  assert.equal(p.stats.identified, 1);
  assert.equal(p.stats.outside_domains, 0);
});

test("the shape is unchanged for a caller that never sees a promoted row", () => {
  // Every new field is always present, so a caller reading `.identified` or
  // `.outsideDomains` never meets undefined.
  const p = plan([{ student_number: "1", full_name: "A", email: "a@student.pxl.be" }], []);
  assert.deepEqual(p.identified, []);
  assert.deepEqual(p.outsideDomains, []);
  assert.equal(p.stats.identified, 0);
});
