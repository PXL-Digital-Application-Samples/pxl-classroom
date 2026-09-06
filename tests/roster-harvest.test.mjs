import test from "node:test";
import assert from "node:assert/strict";

import {
  addsInformation,
  emailLocalPart,
  harvestFromReports,
  harvestPlan,
  applyHarvest,
} from "../lib/roster-harvest.mjs";
import { domainAllowed } from "../lib/claim.mjs";

const DOMAINS = ["student.pxl.be", "pxl.be"];
const allowed = (email) => domainAllowed(email, DOMAINS);

// The six rows this was built for, as PXL-Automation-II actually holds them on
// 2026-09-06. Kept verbatim rather than invented, because every rule below is
// here because of one of them.
const LIVE = {
  assignment_id: "2526-examen-aut2-ek2",
  students: [
    { github_login: "afx42", commit_count: 1, author_name: "maarten", author_email: null },
    { github_login: "IlkayDuranPXL", commit_count: 25, author_name: "ilkay", author_email: "IlkayDuranPXL@github.com" },
    { github_login: "LowieSerneelsPXL", commit_count: 49, author_name: "LowieSerneelsPXL", author_email: "lowie.serneels@student.pxl.be" },
    { github_login: "rayaneW", commit_count: 48, author_name: "rayaneW", author_email: "rayane.waddah@student.pxl" },
    { github_login: "tomccargo", commit_count: 2, author_name: "Tom Cool", author_email: null },
    { github_login: "tomcoolpxl", commit_count: 2, author_name: "Tom Cool", author_email: null },
  ],
};

const promotedRoster = () => ({
  schema_version: 2,
  students: LIVE.students.map((s) => ({ github_login: s.github_login, source: "promoted" })),
});

// ------------------------------------------------------- the login-echo rule

test("a value that repeats the login is not a hint", () => {
  // `IlkayDuranPXL@github.com` beside `@IlkayDuranPXL` is the login twice, and
  // an author_name of `rayaneW` is what a student who never set
  // `git config user.name` produces.
  assert.equal(addsInformation("rayaneW", "rayaneW"), false);
  assert.equal(addsInformation("LowieSerneelsPXL", "LowieSerneelsPXL"), false);
  assert.equal(addsInformation("IlkayDuranPXL", "IlkayDuranPXL"), false);
});

test("the comparison is case-insensitive, because a login comparison is", () => {
  assert.equal(addsInformation("RAYANEW", "rayaneW"), false);
  assert.equal(addsInformation("  rayanew  ", "rayaneW"), false);
});

test("a readable spelling of the same name IS a hint", () => {
  // Not stripped of separators on purpose: `Lowie Serneels` beside
  // `@LowieSerneelsPXL` is the same person spelled so a human can read it.
  assert.equal(addsInformation("Lowie Serneels", "LowieSerneelsPXL"), true);
  assert.equal(addsInformation("Tom Cool", "tomcoolpxl"), true);
  assert.equal(addsInformation("maarten", "afx42"), true);
});

test("nothing is not a hint", () => {
  assert.equal(addsInformation(null, "x"), false);
  assert.equal(addsInformation("", "x"), false);
  assert.equal(addsInformation("   ", "x"), false);
});

test("the local part is what an address is compared on", () => {
  assert.equal(emailLocalPart("IlkayDuranPXL@github.com"), "IlkayDuranPXL");
  assert.equal(emailLocalPart("lowie.serneels@student.pxl.be"), "lowie.serneels");
  assert.equal(emailLocalPart("no-at-sign"), "no-at-sign");
  assert.equal(emailLocalPart("@leading"), "@leading");
  assert.equal(emailLocalPart(null), "");
});

// ----------------------------------------------------------- gathering them

test("the report with the most commits wins", () => {
  // A student appears in every assignment they accepted. The one they actually
  // worked in carries their real git identity; one they never touched carries
  // only the GitHub profile fallback.
  const found = harvestFromReports([
    { assignment_id: "test-pe4", students: [{ github_login: "bob", commit_count: 0, author_name: "bob-profile" }] },
    { assignment_id: "exam", students: [{ github_login: "bob", commit_count: 40, author_name: "Bob Smith", author_email: "bob@student.pxl.be" }] },
  ]);
  assert.equal(found.get("bob").name, "Bob Smith");
  assert.equal(found.get("bob").assignmentId, "exam");
});

test("a tie leaves the first report standing, so the walk order decides", () => {
  const found = harvestFromReports([
    { assignment_id: "first", students: [{ github_login: "bob", commit_count: 3, author_name: "First" }] },
    { assignment_id: "second", students: [{ github_login: "bob", commit_count: 3, author_name: "Second" }] },
  ]);
  assert.equal(found.get("bob").name, "First");
});

test("a row with neither name nor address is not gathered at all", () => {
  const found = harvestFromReports([
    { assignment_id: "a", students: [{ github_login: "bob", commit_count: 99 }] },
  ]);
  assert.equal(found.size, 0);
});

test("junk reports are skipped rather than thrown on", () => {
  assert.equal(harvestFromReports(null).size, 0);
  assert.equal(harvestFromReports([null, {}, { students: "no" }]).size, 0);
  assert.equal(harvestFromReports([{ students: [null, { github_login: "" }] }]).size, 0);
});

// ------------------------------------------------------------- the two rules

test("THE LIVE SIX: every row shows exactly what adds something", () => {
  const { hints } = harvestPlan({ roster: promotedRoster(), reports: [LIVE], emailAllowed: allowed });
  const shown = Object.fromEntries(hints.map((h) => [h.login, h.email || h.name]));
  assert.deepEqual(shown, {
    afx42: "maarten",
    IlkayDuranPXL: "ilkay",
    LowieSerneelsPXL: "lowie.serneels@student.pxl.be",
    rayaneW: "rayane.waddah@student.pxl",
    tomccargo: "Tom Cool",
    tomcoolpxl: "Tom Cool",
  });
  assert.equal(hints.length, 6, "six for six - none of them empty, none of them the login again");
});

test("…and the login-echoes are gone from it", () => {
  const { hints } = harvestPlan({ roster: promotedRoster(), reports: [LIVE], emailAllowed: allowed });
  const byLogin = Object.fromEntries(hints.map((h) => [h.login, h]));
  assert.equal(byLogin.IlkayDuranPXL.email, null, "IlkayDuranPXL@github.com is the login twice");
  assert.equal(byLogin.LowieSerneelsPXL.name, null, "author_name was just the login");
  assert.equal(byLogin.rayaneW.name, null, "author_name was just the login");
});

test("A TYPO'D DOMAIN IS STILL SHOWN - it is the string that names the person", () => {
  // `rayane.waddah@student.pxl` is missing `.be`. Hiding it because the domain
  // does not resolve would throw away the only useful thing on that row: a
  // lecturer recognises `rayane.waddah` instantly.
  const { hints, fillable } = harvestPlan({ roster: promotedRoster(), reports: [LIVE], emailAllowed: allowed });
  const rayane = hints.find((h) => h.login === "rayaneW");
  assert.equal(rayane.email, "rayane.waddah@student.pxl", "shown");
  assert.equal(rayane.emailAllowed, false, "but not writable");
  assert.ok(!fillable.some((f) => f.login === "rayaneW"), "and not in what would be written");
});

test("ONLY AN ALLOWED DOMAIN IS WRITABLE - a wrong address breaks claim matching", () => {
  // `email` is the join key: planClaimPromotion does byEmail.get(entry.email).
  // A wrong address there means a real claim never matches, and under
  // roster_mode: claim that student is rejected at acceptance.
  const { fillable } = harvestPlan({ roster: promotedRoster(), reports: [LIVE], emailAllowed: allowed });
  assert.deepEqual(fillable, [{ login: "LowieSerneelsPXL", email: "lowie.serneels@student.pxl.be" }]);
});

test("a lookalike domain is refused, because domainAllowed matches the whole label", () => {
  // The local part must differ from the login, or the echo rule suppresses it
  // before the domain is ever looked at - which is itself the right order.
  const reports = [{ assignment_id: "a", students: [
    { github_login: "eve", commit_count: 5, author_email: "eva.dubois@notstudent.pxl.be" },
  ] }];
  const roster = { students: [{ github_login: "eve" }] };
  const { hints, fillable } = harvestPlan({ roster, reports, emailAllowed: allowed });
  assert.equal(hints[0].email, "eva.dubois@notstudent.pxl.be", "still shown");
  assert.equal(hints[0].emailAllowed, false);
  assert.deepEqual(fillable, []);
});

test("BLANKS ONLY: a value already on the row is never touched or offered", () => {
  // A value a lecturer typed or a CSV imported outranks a git config field.
  const roster = { students: [{
    github_login: "LowieSerneelsPXL",
    full_name: "Lowie Serneels",
    email: "l.serneels@pxl.be",
  }] };
  const { hints, fillable } = harvestPlan({ roster, reports: [LIVE], emailAllowed: allowed });
  assert.deepEqual(hints, []);
  assert.deepEqual(fillable, []);
});

test("a half-filled row is offered only the half it is missing", () => {
  const roster = { students: [{ github_login: "afx42", email: "maarten@student.pxl.be" }] };
  const { hints } = harvestPlan({ roster, reports: [LIVE], emailAllowed: allowed });
  assert.equal(hints.length, 1);
  assert.equal(hints[0].name, "maarten");
  assert.equal(hints[0].email, null, "the address it already has is not re-offered");
});

test("a roster row with no login, and a login no report mentions, are both skipped", () => {
  const roster = { students: [{ student_number: "0123456" }, { github_login: "nobody" }] };
  assert.deepEqual(harvestPlan({ roster, reports: [LIVE], emailAllowed: allowed }).hints, []);
});

test("with no domain check supplied, nothing is writable", () => {
  // Fails closed: the default refuses every address rather than accepting one.
  const { hints, fillable } = harvestPlan({ roster: promotedRoster(), reports: [LIVE] });
  assert.equal(hints.length, 6, "still shown");
  assert.deepEqual(fillable, [], "nothing written without a check");
});

// ------------------------------------------------------------- applying it

test("applying MERGES - it never rebuilds the row", () => {
  // A document rebuilt field-by-field drops whatever nobody listed (CLAUDE.md).
  const roster = { schema_version: 2, extra_key: "kept", students: [
    { github_login: "LowieSerneelsPXL", source: "promoted", class_group: "3A", team_slug: "alpha" },
  ] };
  const next = applyHarvest(roster, [{ login: "LowieSerneelsPXL", email: "lowie.serneels@student.pxl.be" }]);
  assert.deepEqual(next.students[0], {
    github_login: "LowieSerneelsPXL",
    source: "promoted",
    class_group: "3A",
    team_slug: "alpha",
    email: "lowie.serneels@student.pxl.be",
    // Marked as self-declared, because that is what a git author address is.
    email_source: "commit",
  });
  assert.equal(next.extra_key, "kept");
  assert.equal(roster.students[0].email, undefined, "the input is not mutated");
});

test("applying re-checks the field is still empty", () => {
  // The plan was built against a roster read earlier; the one being written may
  // have gained the address in between.
  const roster = { students: [{ github_login: "bob", email: "typed.by.hand@pxl.be" }] };
  const next = applyHarvest(roster, [{ login: "bob", email: "bob@student.pxl.be" }]);
  assert.equal(next.students[0].email, "typed.by.hand@pxl.be");
});

test("applying nothing returns the roster untouched", () => {
  const roster = { students: [{ github_login: "bob" }] };
  assert.equal(applyHarvest(roster, []), roster);
  assert.equal(applyHarvest(roster, null), roster);
});

test("logins are matched case-insensitively when applying", () => {
  const roster = { students: [{ github_login: "LowieSerneelsPXL" }] };
  const next = applyHarvest(roster, [{ login: "lowieserneelspxl", email: "l@student.pxl.be" }]);
  assert.equal(next.students[0].email, "l@student.pxl.be");
});
