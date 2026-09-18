// The System Health check "Lockdown record matches repo permissions".
//
// It read `r.login`, which a lockdown row does not have - the field is
// `github_login` and rows are additionalProperties: false - so it skipped every
// row and reported "all demoted" having checked nobody. Run through runAudit
// with a fake GitHub, because the check is not exported and must not be
// re-implemented here.

import { test } from "node:test";
import assert from "node:assert/strict";

import { runAudit, CONTROL_REPO } from "../lib/audit.mjs";

const ORG = "Org";
const ID = "lab1";

function fakeGitHub({ rows, permissions = {}, reopened = [] }) {
  const asked = [];
  const record = { schema_version: 1, assignment_id: ID, results: rows };
  const request = async (method, path) => {
    asked.push(path);
    if (path === `/repos/${ORG}/${CONTROL_REPO}/contents/lockdowns/${ID}/lockdown-record.json`) {
      return { ok: true, status: 200, data: { content: Buffer.from(JSON.stringify(record)).toString("base64") } };
    }
    const perm = path.match(/\/collaborators\/([^/]+)\/permission$/);
    if (perm) {
      const p = permissions[perm[1]];
      return p === undefined ? { ok: false, status: 500, data: {} } : { ok: true, status: 200, data: { permission: p } };
    }
    const unlocked = path.match(/\/unlocked\/([^/]+)\.json$/);
    if (unlocked) {
      return reopened.includes(unlocked[1]) ? { ok: true, status: 200, data: {} } : { ok: false, status: 404, data: {} };
    }
    return { ok: false, status: 404, data: {} };
  };
  return { request, asked };
}

async function lockdownCheck(gh) {
  const res = await runAudit({ request: gh.request, org: ORG, assignmentId: ID });
  return res.checks.find((c) => c.id === "assignment-lockdown");
}

const row = (login, extra = {}) => ({
  github_login: login,
  repo_name: `${ORG}/${ID}-${login}`,
  lock_method: "demotion",
  demoted: true,
  ...extra,
});

test("a demoted student who still has write is FOUND (it used to look at nobody)", async () => {
  const gh = fakeGitHub({ rows: [row("ann"), row("bob")], permissions: { ann: "read", bob: "write" } });
  const c = await lockdownCheck(gh);
  assert.equal(c.severity, "fail", c.message);
  assert.deepEqual(c.detail.mismatches, [{ login: "bob", expected: "read", got: "write" }]);
  assert.ok(gh.asked.some((p) => p.endsWith("/collaborators/ann/permission")), "it actually asked");
});

test("a ruleset lock is not a demotion, so write access there is not a mismatch", async () => {
  const gh = fakeGitHub({
    rows: [row("ann", { lock_method: "ruleset", demoted: false })],
    permissions: { ann: "write" },
  });
  const c = await lockdownCheck(gh);
  assert.equal(c.severity, "info", c.message);
  assert.ok(!gh.asked.some((p) => p.includes("/collaborators/")), "nothing to compare, nothing asked");
});

test("a repository a lecturer reopened afterwards is not a mismatch", async () => {
  const gh = fakeGitHub({ rows: [row("ann")], permissions: { ann: "write" }, reopened: ["ann"] });
  assert.equal((await lockdownCheck(gh)).severity, "ok");
});

test("an unreadable permission is not a pass", async () => {
  const gh = fakeGitHub({ rows: [row("ann")], permissions: {} });
  const c = await lockdownCheck(gh);
  assert.equal(c.severity, "warn", c.message);
  assert.match(c.message, /ann/);
});

test("all demoted is ok, and says how many it looked at", async () => {
  const gh = fakeGitHub({ rows: [row("ann"), row("bob")], permissions: { ann: "read", bob: "none" } });
  const c = await lockdownCheck(gh);
  assert.equal(c.severity, "ok");
  assert.match(c.message, /Sampled 2/);
});
