// The rules that replaced the acceptance concurrency group - see
// lib/acceptance-reservation.mjs for why the group had to go.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEADLINE_GRACE_MS,
  actedInTime,
  claimConcerns,
  contentDecides,
  decisionInputsChanged,
  teamConcerns,
  parseActedAt,
  parseIssueNumber,
  pathsToCommit,
  supersededBy,
} from "../lib/acceptance-reservation.mjs";
import { teammateAlreadyAdmitted } from "../lib/existing-repo.mjs";

const who = { assignmentId: "groepsindeling", login: "SabriKatogluPXL" };

test("a teammate admitted into this team makes the repository at its name ours", () => {
  const records = {
    ThomasBasyn: { team_slug: "fullhouse" },
    moved: { team_slug: "other" },
  };
  const acceptanceOf = (login) => records[login] ?? null;
  const ask = (members) => teammateAlreadyAdmitted({ members, login: "Fars", teamSlug: "fullhouse", acceptanceOf });

  assert.equal(ask(["ThomasBasyn", "Fars"]), true, "a teammate admitted into this team");
  assert.equal(ask(["seeded", "Fars"]), false, "a seeded teammate who has not accepted proves nothing");
  assert.equal(ask(["moved", "Fars"]), false, "a record for ANOTHER team proves nothing about this name");
  assert.equal(ask(["Fars"]), false, "the student themselves is not a teammate");
  assert.equal(ask(["fars", "FARS"]), false, "nor in another case");
  assert.equal(ask("ThomasBasyn"), false, "a manifest without a member list proves nothing");
  assert.equal(teammateAlreadyAdmitted({ members: ["ThomasBasyn"], login: "Fars", teamSlug: "", acceptanceOf }), false);
});

test("a decision is made again when another run touched anything it read", () => {
  // The case of 2026-10-02: a teammate joined the same team in between.
  assert.equal(decisionInputsChanged(["teams/groepsindeling/fullhouse.json"], who), true);
  // Any team of this assignment: one team per student, and a name taken.
  assert.equal(decisionInputsChanged(["teams/groepsindeling/other.json"], who), true);
  // Their own record, whatever the case of the file name.
  assert.equal(decisionInputsChanged(["acceptances/groepsindeling/sabrikatoglupxl.json"], who), true);
  // The roster and every claim binding, the assignment, extensions, the lock.
  for (const p of [
    "students/roster.yml",
    "students/claims/1.json",
    "assignments/groepsindeling.yml",
    "overrides/groepsindeling/x.json",
    "lockdowns/groepsindeling/lockdown-record.json",
  ]) {
    assert.equal(decisionInputsChanged([p], who), true, p);
  }
  // Something nobody listed is an input: deciding again is the safe direction.
  assert.equal(decisionInputsChanged(["something-new/file.json"], who), true);
});

test("another student accepting does not make this one decide again", () => {
  assert.equal(
    decisionInputsChanged(
      [
        "acceptances/groepsindeling/FarsAbdelrahmanMohamedWardaPXL.json",
        "repositories/groepsindeling/FarsAbdelrahmanMohamedWardaPXL.json",
        "observations/groepsindeling/x/2026.json",
        "reports/groepsindeling.json",
        "",
      ],
      who,
    ),
    false,
  );
  // Another ASSIGNMENT's acceptances are not this assignment's, and are inputs
  // only in the sense that nothing claims to know they are not.
  assert.equal(decisionInputsChanged(["acceptances/other-assignment/x.json"], who), true);
  // A nested path under acceptances/ is not a record; not guessed about.
  assert.equal(decisionInputsChanged(["acceptances/groepsindeling/sub/x.json"], who), true);
});

test("another team's change matters only when it concerns this student", () => {
  const me = { assignmentId: "groepsindeling", login: "eve", githubId: "5" };
  const team = (members) => JSON.stringify({ members });
  const concerns = (texts) => (path, kind) =>
    kind === "team" && texts.some((t) => teamConcerns(t, { login: "eve", teamSlug: "fullhouse", path }));

  // A join to a team that is neither ours nor ever listed us: replay, do not re-decide.
  assert.equal(
    decisionInputsChanged(["teams/groepsindeling/other.json"], me, { concerns: concerns([team(["a"]), team(["a", "b"])]) }),
    false,
  );
  // The team we are joining: always.
  assert.equal(
    decisionInputsChanged(["teams/groepsindeling/fullhouse.json"], me, { concerns: concerns([team(["a"])]) }),
    true,
  );
  // A team that listed us (we are leaving it) or now does (a lecturer moved us).
  assert.equal(decisionInputsChanged(["teams/groepsindeling/old.json"], me, { concerns: concerns([team(["eve"]), team([])]) }), true);
  // Unreadable or malformed concerns us - never a guess that it does not.
  assert.equal(teamConcerns("not json", { login: "eve", path: "teams/x/y.json" }), true);
  assert.equal(teamConcerns(JSON.stringify({}), { login: "eve", path: "teams/x/y.json" }), true);
  assert.equal(teamConcerns(null, { login: "eve", path: "teams/x/y.json" }), false, "absent at that version lists nobody");
  // Case of the login is not identity.
  assert.equal(teamConcerns(team(["EVE"]), { login: "eve", path: "teams/x/y.json" }), true);
});

test("another account's binding matters only when it holds our address", () => {
  assert.equal(claimConcerns(JSON.stringify({ email: "Eve.Smith@student.pxl.be " }), "eve.smith@student.pxl.be"), true);
  assert.equal(claimConcerns(JSON.stringify({ email: "bob@student.pxl.be" }), "eve.smith@student.pxl.be"), false);
  assert.equal(claimConcerns(JSON.stringify({ email: "bob@student.pxl.be" }), null), false, "we hold no address");
  assert.equal(claimConcerns("{", "eve@x"), true, "unreadable concerns us");
  assert.equal(claimConcerns(null, "eve@x"), false);

  const me = { assignmentId: "a", login: "eve", githubId: "5" };
  // Our own binding and our own counter are always inputs.
  assert.equal(decisionInputsChanged(["students/claims/5.json"], me, { concerns: () => false }), true);
  assert.equal(decisionInputsChanged(["students/claim-attempts/5.json"], me, { concerns: () => false }), true);
  // Somebody else's counter never is.
  assert.equal(decisionInputsChanged(["students/claim-attempts/6.json"], me), false);
  // Without a way to read contents, every binding is an input: the safe direction.
  assert.equal(decisionInputsChanged(["students/claims/6.json"], me), true);
  assert.equal(contentDecides("students/claims/6.json", me), "claim");
  assert.equal(contentDecides("students/roster.yml", me), null);
  assert.equal(contentDecides("teams/a/sub/x.json", me), null, "a nested path is not a manifest");
});

test("what each outcome commits", () => {
  assert.deepEqual([...pathsToCommit("accepted")], ["acceptances", "teams", "students"]);
  assert.deepEqual([...pathsToCommit("already-accepted")], ["acceptances", "teams", "students"]);
  assert.deepEqual([...pathsToCommit("confirmed")], ["acceptances", "teams", "students"]);
  assert.deepEqual([...pathsToCommit("superseded")], []);
  assert.deepEqual([...pathsToCommit("rejected:team-full")], ["students"]);
  assert.deepEqual([...pathsToCommit("rejected:team-full", { persistRefusals: false })], []);
  assert.equal(pathsToCommit("fail:exception"), null);
  assert.equal(pathsToCommit(""), null);
  assert.equal(pathsToCommit("something-new"), null);
});

test("only a DECIDED newer attempt supersedes", () => {
  assert.equal(supersededBy({ issue_number: 70 }, 60), 70);
  assert.equal(supersededBy({ issue_number: 60 }, 60), null, "the same attempt delivered twice is not superseded");
  assert.equal(supersededBy({ issue_number: 50 }, 60), null);
  assert.equal(supersededBy({}, 60), null, "a record from before the field");
  assert.equal(supersededBy(null, 60), null);
  assert.equal(supersededBy({ issue_number: 70 }, null), null, "a Retry has no attempt of its own");
  assert.equal(supersededBy({ issue_number: "70" }, 60), null, "only an integer is a stored attempt");
});

test("a request made before the deadline is in time when GitHub started late - within limits", () => {
  const deadline = new Date("2026-10-02T23:59:00Z");
  const before = new Date("2026-10-02T23:58:00Z");
  const at = (min) => new Date(deadline.getTime() + min * 60_000);

  assert.equal(actedInTime({ deadline, now: at(10), actedAt: before, lockRan: false }), true);
  assert.equal(actedInTime({ deadline, now: at(60), actedAt: before, lockRan: false }), true, "an hour exactly");
  assert.equal(actedInTime({ deadline, now: at(61), actedAt: before, lockRan: false }), false, "past the grace");
  assert.equal(actedInTime({ deadline, now: at(10), actedAt: before, lockRan: true }), false, "the lock has run");
  assert.equal(actedInTime({ deadline, now: at(10), actedAt: at(1), lockRan: false }), false, "asked after the deadline");
  assert.equal(actedInTime({ deadline, now: at(10), actedAt: at(20), lockRan: false }), false, "a time in the future is no evidence");
  assert.equal(actedInTime({ deadline, now: at(10), actedAt: null, lockRan: false }), false, "no time, no grace");
  assert.equal(actedInTime({ deadline, now: at(10), actedAt: deadline, lockRan: false }), true, "at the deadline is on time");
  assert.equal(DEADLINE_GRACE_MS, 3_600_000);
});

test("the attempt is parsed strictly", () => {
  assert.equal(parseIssueNumber("66"), 66);
  assert.equal(parseIssueNumber(66), 66);
  for (const bad of ["", "0", "-1", "6.6", "66 ", " 66x", "1e3", null, undefined]) {
    if (bad === "66 ") continue; // trimmed on purpose
    assert.equal(parseIssueNumber(bad), null, JSON.stringify(bad));
  }
  assert.equal(parseActedAt("2026-10-02T10:22:06Z")?.toISOString(), "2026-10-02T10:22:06.000Z");
  for (const bad of ["", "2026-10-02", "2026-10-02T10:22:06+02:00", "yesterday", null, 5]) {
    assert.equal(parseActedAt(bad), null, JSON.stringify(bad));
  }
});
