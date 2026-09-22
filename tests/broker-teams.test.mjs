// The live team reconciliation, against the titles a broker ACTUALLY leaves.
//
// The bug this exists for: the reconciliation matched `issue.title` starting
// with `team:`, which is true of no issue on the live path - the SPA opens
// `pxl-accept:<signature> team:<slug>` and the broker redacts that to
// "Acceptance (processed)" seconds later. It reconciled zero teams for months,
// and nothing failed, because the logic sat inline in a .vue file where no test
// could call it.
//
// So the titles below are READ OUT OF THE BROKER TEMPLATE rather than typed
// here. A title spelled one way in the workflow and another in a test is the
// same defect one layer up, and it is the reason the first version of this
// check would have passed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  teamsFromBrokerIssues,
  ownAcceptanceIssue,
} from "../frontend/src/lib/broker-teams.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = readFileSync(join(ROOT, "acceptance/broker-workflow.yml"), "utf8");

/**
 * Every title the broker can leave on an issue after it has handled it.
 *
 * Derived: the `--title "..."` arguments in the template, with `$LABEL`
 * expanded over the `LABEL="..."` assignments beside them.
 */
function titlesTheBrokerLeaves() {
  const labels = [...TEMPLATE.matchAll(/LABEL="([^"]+)"/g)].map((m) => m[1]);
  const titles = [...TEMPLATE.matchAll(/--title "([^"]+)"/g)].map((m) => m[1]);
  assert.ok(labels.length > 0, "the template must still set LABEL for the redacted title");
  assert.ok(titles.length > 0, "the template must still redact the title with gh issue edit");

  const out = new Set();
  for (const title of titles) {
    if (title.includes("$LABEL")) {
      for (const label of labels) out.add(title.replaceAll("$LABEL", label));
    } else {
      out.add(title);
    }
  }
  return [...out];
}

const teamBody = (slug, name) => JSON.stringify({ team_slug: slug, team_name: name, team_action: "create" });

test("the broker really does leave titles that carry no team", () => {
  // If this ever fails, the premise of the test below is gone and the
  // reconciliation could go back to reading titles. It has not.
  for (const title of titlesTheBrokerLeaves()) {
    assert.ok(
      !title.startsWith("team:") && !title.startsWith("pxl-accept:"),
      `a redacted title must not look like an acceptance title, got ${JSON.stringify(title)}`,
    );
  }
});

test("a team is still found once the broker has redacted the title", () => {
  // THE REGRESSION. Every one of these returned nothing before 2026-09-22.
  for (const title of titlesTheBrokerLeaves()) {
    const rows = teamsFromBrokerIssues([
      { title, body: teamBody("rojaro", "Rojaro"), user: { login: "RobPolusPXL" } },
    ]);
    assert.deepEqual(
      rows,
      [{ team_slug: "rojaro", team_name: "Rojaro", members: ["RobPolusPXL"] }],
      `redacted title ${JSON.stringify(title)} must still yield its team`,
    );
  }
});

test("a team is found before redaction too, from the title the SPA opens", () => {
  const rows = teamsFromBrokerIssues([
    {
      title: "pxl-accept:a1.AQID.BAUG team:felmiroen",
      body: teamBody("felmiroen", "Felmiroen"),
      user: { login: "MietWelkenhuyzenPXL" },
    },
  ]);
  assert.deepEqual(rows, [
    { team_slug: "felmiroen", team_name: "Felmiroen", members: ["MietWelkenhuyzenPXL"] },
  ]);
});

test("the member is the issue's AUTHOR, never a login the body claims", () => {
  // Anyone may open an issue on a public broker. A body naming somebody else
  // must not show that person as a member of a team they never joined - a
  // student picks a team from what this list says.
  const rows = teamsFromBrokerIssues([
    {
      title: "Acceptance (processed)",
      body: JSON.stringify({ team_slug: "wim", team_name: "Wim", github_login: "victim" }),
      user: { login: "attacker" },
    },
  ]);
  assert.deepEqual(rows[0].members, ["attacker"]);
});

test("an issue that names no team contributes nothing", () => {
  const rows = teamsFromBrokerIssues([
    { title: "Acceptance (processed)", body: "", user: { login: "a" } },
    { title: "Acceptance (processed)", body: "not json", user: { login: "b" } },
    { title: "Acceptance (processed)", body: JSON.stringify({ hello: 1 }), user: { login: "c" } },
    // An individual acceptance: a real body, and deliberately no team.
    { title: "Acceptance (processed)", body: JSON.stringify({ claim: "x" }), user: { login: "d" } },
  ]);
  assert.deepEqual(rows, []);
});

test("a slug the acceptance gate would refuse is refused here too", () => {
  // Read through lib/team-payload.mjs, so this cannot drift from what
  // accept.mjs enforces before it touches teams/<id>/<slug>.json.
  const rows = teamsFromBrokerIssues([
    { title: "Acceptance (processed)", body: teamBody("Not A Slug", "x"), user: { login: "a" } },
    { title: "Acceptance (processed)", body: teamBody("../escape", "x"), user: { login: "b" } },
  ]);
  assert.deepEqual(rows, []);
});

test("nothing throws on the shapes a live list actually contains", () => {
  assert.deepEqual(teamsFromBrokerIssues(undefined), []);
  assert.deepEqual(teamsFromBrokerIssues([null, {}, { user: null }]), []);
});

test("a student finds their own issue although the title was redacted", () => {
  // The student who closed the tab and came back is the one this lookup exists
  // for, and a title match had already expired by the time they returned.
  const issues = [
    { number: 4, title: "Acceptance (processed)", user: { login: "d-ries" } },
    { number: 3, title: "Acceptance (processed)", user: { login: "RobPolusPXL" } },
  ];
  assert.equal(ownAcceptanceIssue(issues, "robpoluspxl").number, 3, "login match is case-insensitive");
  assert.equal(ownAcceptanceIssue(issues, "d-ries").number, 4);
  assert.equal(ownAcceptanceIssue(issues, "nobody"), null);
  assert.equal(ownAcceptanceIssue(issues, ""), null);
  assert.equal(ownAcceptanceIssue(issues, undefined), null);
});

test("the newest attempt wins, because the list is newest first", () => {
  const issues = [
    { number: 9, title: "Acceptance attempt (rejected)", user: { login: "sam" } },
    { number: 2, title: "Acceptance (processed)", user: { login: "sam" } },
  ];
  assert.equal(ownAcceptanceIssue(issues, "sam").number, 9);
});
