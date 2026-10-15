// A Retry after the deadline's lock does not give a student their access back
// (review 2026-10-15, R6-2).
//
// Provisioning granted the assignment's Student permission on every run. A
// Retry after the lock demoted the cohort therefore made a team member - whose
// manifest skips the frozen probe - or anyone on a free organization admin
// again, and an admin can switch a repository ruleset off: an unlock around
// Reopen's preservation check, with no record. Read is what the lock left, and
// a reopened repository gets the assignment's permission again.
//
// The rule is lib/permission-change.mjs `grantableAfterLock`; the second half
// spawns the real provisioning/provision.mjs against a stub of the API.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { grantableAfterLock } from "../lib/permission-change.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "provisioning", "provision.mjs");
const REPO = "Org/grp-alpha";

test("grantableAfterLock: read while a demotion holds the repository, the assignment's once it is reopened", () => {
  const demoted = { results: [{ repo_name: REPO, lock_method: "org-ruleset", demoted: true }] };
  assert.deepEqual(grantableAfterLock({ permission: "admin", repoName: REPO, lockRecord: demoted }), { permission: "pull", held: true });
  assert.deepEqual(grantableAfterLock({ permission: "admin", repoName: REPO, lockRecord: { results: [{ repo_name: REPO, lock_method: "demotion" }] } }).permission, "pull");
  // Reopened, for any member: one repository, one lock.
  assert.deepEqual(grantableAfterLock({ permission: "admin", repoName: REPO, lockRecord: demoted, reopenRecords: [{ repo_name: "org/GRP-ALPHA" }] }), { permission: "admin", held: false });
  // A ruleset that did not demote left them their permission: nothing to hold.
  assert.equal(grantableAfterLock({ permission: "admin", repoName: REPO, lockRecord: { results: [{ repo_name: REPO, lock_method: "org-ruleset" }] } }).permission, "admin");
  // Someone else's repository, or no lock at all.
  assert.equal(grantableAfterLock({ permission: "push", repoName: REPO, lockRecord: { results: [{ repo_name: "Org/other", demoted: true }] } }).permission, "push");
  assert.equal(grantableAfterLock({ permission: "push", repoName: REPO }).permission, "push");
});

async function withApi(fn) {
  const calls = [];
  const server = createServer((req, res) => {
    const send = (code, body) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(body === undefined ? "" : JSON.stringify(body));
    };
    const url = req.url.split("?")[0];
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      calls.push({ method: req.method, url, body });
      if (url === "/rate_limit") return send(200, { rate: { remaining: 5000 } });
      if (url === "/repos/Org/tpl" && req.method === "GET") return send(200, { id: 7, is_template: true, private: true, default_branch: "main" });
      // The team's repository is already there: a Retry of a member.
      if (url === "/repos/Org/grp-alpha" && req.method === "GET") return send(200, { id: 10, full_name: REPO, html_url: "https://github.com/Org/grp-alpha", default_branch: "main", template_repository: { full_name: "Org/tpl" } });
      if (url === "/repos/Org/grp-alpha/contents/" && req.method === "GET") return send(200, [{ name: "README.md", type: "file" }]);
      if (/\/collaborators\/ann$/.test(url) && req.method === "PUT") return send(204);
      return send(404, { message: "not stubbed: " + url });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`, calls);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

function provision(apiBase, { lockRecord = null, reopened = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pxl-provision-after-lock-"));
  mkdirSync(join(dir, "control", "assignments"), { recursive: true });
  writeFileSync(join(dir, "control", "assignments", "lab.yml"), stringify({ id: "lab", deadline_at: "2026-10-01T10:00:00Z" }));
  if (lockRecord) {
    mkdirSync(join(dir, "control", "lockdowns", "lab"), { recursive: true });
    writeFileSync(join(dir, "control", "lockdowns", "lab", "lockdown-record.json"), JSON.stringify(lockRecord));
  }
  if (reopened) {
    mkdirSync(join(dir, "control", "lockdowns", "lab", "unlocked"), { recursive: true });
    writeFileSync(join(dir, "control", "lockdowns", "lab", "unlocked", "bob.json"), JSON.stringify(reopened));
  }
  return new Promise((resolve, reject) => {
    const child = spawn("node", [script], {
      cwd: dir,
      env: {
        ...process.env, GITHUB_TOKEN: "stub-token", GITHUB_API_URL: apiBase, ORG: "Org", TEMPLATE_OWNER: "Org", TEMPLATE_REPO: "tpl",
        TEMPLATE_REPOSITORY_ID: "", TARGET_REPO: "grp-alpha", ASSIGNMENT_ID: "lab", STUDENT_LOGIN: "ann", STUDENT_PERMISSION: "admin",
        DRY_RUN: "0", RECREATE_EMPTY: "false", FEEDBACK_PR: "false", TEMPLATE_FULL_HISTORY: "false", PXL_FILL_WAIT_CHECKS: "2",
        GITHUB_OUTPUT: join(dir, "out.env"), GITHUB_STEP_SUMMARY: join(dir, "summary.md"),
      },
    });
    let log = "";
    child.stdout.on("data", (d) => (log += d));
    child.stderr.on("data", (d) => (log += d));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, log }));
  });
}

const granted = (calls) => {
  const put = calls.find((c) => c.method === "PUT" && /\/collaborators\/ann$/.test(c.url));
  return put ? JSON.parse(put.body || "{}").permission : null;
};

test("a Retry over a team repository the lock demoted grants read, and says so", async () => {
  const lockRecord = { results: [{ github_login: "ann", repo_name: REPO, lock_method: "org-ruleset", demoted: true }, { github_login: "bob", repo_name: REPO, lock_method: "org-ruleset", demoted: true }] };
  await withApi(async (api, calls) => {
    const r = await provision(api, { lockRecord });
    assert.equal(r.status, 0, r.log);
    assert.equal(granted(calls), "pull", r.log);
    assert.match(r.log, /granting read, not admin/);
  });
  // Reopened for a teammate: the repository is open, so the assignment's again.
  await withApi(async (api, calls) => {
    const r = await provision(api, { lockRecord, reopened: { github_login: "bob", repo_name: REPO } });
    assert.equal(r.status, 0, r.log);
    assert.equal(granted(calls), "admin");
  });
  // No lock yet: as before.
  await withApi(async (api, calls) => {
    const r = await provision(api);
    assert.equal(r.status, 0, r.log);
    assert.equal(granted(calls), "admin");
  });
});
