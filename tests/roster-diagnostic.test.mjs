// "The roster file exists" is not the question a lecturer is asking. The
// question is whether anybody can accept - and three rosters answer no while
// existing perfectly well.
//
// This matters because it is the check somebody runs to answer exactly that.
// The old success branch reported `ok` for all three, and named
// `rosters/<id>.csv` - a path the data model has never had, which the comment
// directly above it records as already fixed. It was fixed in the request and
// left in the message.
//
// The empty-roster case is not hypothetical: PXL-Automation-II's exam
// 2526-examen-aut2-ek2 sat on "Setting up your repository..." forever in July
// because that control repo's roster was `students: []`. Every acceptance
// rejected not-on-roster, zero accepted, and nothing surfaced why.

import { test } from "node:test";
import assert from "node:assert/strict";
import { stringify as toYaml } from "yaml";

import { runDiagnostics } from "../lib/diagnostics.mjs";
import { MANIFEST_APP_PERMISSIONS, APP_SLUG, EXPECTED_APP_PERMISSIONS, CONTROL_REPO } from "../lib/audit.mjs";

const ORG = "PXL-2TIN-NetAdv-26-27";
const ID = "net-advanced-guts-2627";

const assignmentDoc = (over = {}) => ({
  schema_version: 1,
  id: ID,
  title: ".NET Advanced GUTS",
  organization: ORG,
  state: "published",
  assignment_type: "individual",
  template: { owner: ORG, repository: "Guts-DotNetAdvanced-2627" },
  repository_name_pattern: `${ID}-{github_login}`,
  opens_at: "2026-08-24T13:37:00.000Z",
  deadline_at: "2027-01-30T23:00:00.000Z",
  ...over,
});

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

/** Enough of the world for Tier 3 to reach the roster check. */
function makeReq({ rosterBody, rosterStatus = 200, doc = assignmentDoc() }) {
  return async (method, path) => {
    if (path === `/apps/${APP_SLUG}`) {
      return { status: 200, ok: true, data: { slug: APP_SLUG, permissions: { ...MANIFEST_APP_PERMISSIONS } } };
    }
    if (path === "/user") return { status: 200, ok: true, data: { login: "lecturer" } };
    if (path === "/user/installations") {
      return {
        status: 200, ok: true,
        data: { total_count: 1, installations: [{ id: 1, account: { login: ORG }, repository_selection: "all", permissions: { ...EXPECTED_APP_PERMISSIONS } }] },
      };
    }
    if (path === `/repos/${ORG}/${CONTROL_REPO}`) return { status: 200, ok: true, data: { private: true } };
    if (path.endsWith(`/contents/assignments/${ID}.yml`)) {
      return { status: 200, ok: true, data: { content: b64(toYaml(doc)), encoding: "base64" } };
    }
    if (path.endsWith("/contents/students/roster.yml")) {
      if (rosterStatus !== 200) return { status: rosterStatus, ok: false, data: { message: "Not Found" } };
      return { status: 200, ok: true, data: { content: b64(rosterBody), encoding: "base64" } };
    }
    return { status: 404, ok: false, data: { message: "Not Found" } };
  };
}

async function rosterCheck(opts) {
  const res = await runDiagnostics({ request: makeReq(opts), org: ORG, assignmentId: ID });
  return res.tiers.flatMap((t) => t.checks).find((c) => c.id === "roster-check") || null;
}

const student = (n, login) => ({
  student_number: `012345${n}`,
  full_name: `Student ${n}`,
  email: `s${n}@student.pxl.be`,
  ...(login ? { github_login: login } : {}),
});

test("an empty roster on a published assignment is reported, not called ok", () => {
  // The July failure, in one assertion.
  return rosterCheck({ rosterBody: toYaml({ students: [] }) }).then((c) => {
    assert.ok(c, "the roster check must run for an enforced assignment");
    assert.equal(c.severity, "fail", `reported "${c.message}"`);
    assert.match(c.message, /nobody can accept/i);
    assert.match(c.message, /not-on-roster/);
    assert.equal(c.detail?.students, 0);
  });
});

test("a roster whose students have no github_login is reported", async () => {
  // github_login is the optional CSV column and the only field accept.mjs
  // matches on. "200 students on the roster" in green, and nobody can accept.
  const c = await rosterCheck({
    rosterBody: toYaml({ students: [student(1), student(2), student(3)] }),
  });
  assert.equal(c.severity, "fail");
  assert.match(c.message, /none has a github_login/i);
  assert.equal(c.detail?.students, 3);
  assert.equal(c.detail?.linked, 0);
});

test("a partially linked roster names how many are stranded", async () => {
  const c = await rosterCheck({
    rosterBody: toYaml({ students: [student(1, "alice"), student(2), student(3)] }),
  });
  assert.equal(c.severity, "warn");
  assert.match(c.message, /1 of 3/);
  assert.match(c.message, /other 2 cannot accept/i);
});

test("a roster acceptance cannot read at all is reported as such", async () => {
  // A hand-edited array-shaped roster parses fine as YAML, and accept.mjs
  // reads `roster?.students || []` - so it sees nobody.
  const c = await rosterCheck({ rosterBody: toYaml([student(1, "alice"), student(2, "bob")]) });
  assert.equal(c.severity, "fail");
  assert.match(c.message, /no `students:` list/);
});

test("an unparseable roster is distinguished from an empty one", async () => {
  const c = await rosterCheck({ rosterBody: "students: [\n  broken: : :\n" });
  assert.equal(c.severity, "warn");
  assert.match(c.message, /could not be parsed/i);
});

test("a healthy roster is ok, and says how many", async () => {
  const c = await rosterCheck({
    rosterBody: toYaml({ students: [student(1, "alice"), student(2, "bob")] }),
  });
  assert.equal(c.severity, "ok");
  assert.match(c.message, /2 student\(s\) on the roster/);
  assert.equal(c.detail?.linked, 2);
});

test("nothing mentions rosters/<id>.csv, which has never been a path", async () => {
  for (const body of [toYaml({ students: [] }), toYaml({ students: [student(1, "alice")] })]) {
    const c = await rosterCheck({ rosterBody: body });
    assert.ok(!/\.csv/.test(c.message), `sent the lecturer looking for a CSV: "${c.message}"`);
    assert.ok(!/\.csv/.test(c.label), `label still names a CSV: "${c.label}"`);
  }
});

test("a DRAFT with an empty roster warns rather than failing", async () => {
  // Nobody can be trying yet, so it is future work, not a live outage.
  const c = await rosterCheck({
    rosterBody: toYaml({ students: [] }),
    doc: assignmentDoc({ state: "draft" }),
  });
  assert.equal(c.severity, "warn");
});

test("open enrolment skips the roster check entirely", async () => {
  // There is no roster to be absent from (§15).
  const c = await rosterCheck({
    rosterBody: toYaml({ students: [] }),
    doc: assignmentDoc({ roster_mode: "open", max_acceptances: 50 }),
  });
  assert.equal(c, null);
});
