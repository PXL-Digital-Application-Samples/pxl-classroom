// A student who renamed their account, at a deadline that takes access away.
//
// Measured on PXL-Java-Essentials, 2026-10-30: GitHub answers the old login with
// 404 `<old> is not a user` on /collaborators, while the student still has their
// access. Lockdown read that as "no longer has access - nothing to take away",
// skipped them, and wrote them down as stopped with push access intact.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { studentPresence } from "../lib/permission-change.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const lockdownScript = join(root, "lockdown", "lockdown.mjs");
const DEADLINE = "2026-01-01T00:00:00.000Z";
const OLD = "old-name";
const NEW = "NewNamePXL";

async function withStub(fn, { lookup = { [77]: NEW }, accounts = [NEW] } = {}) {
  const calls = [];
  const server = createServer((req, res) => {
    const send = (code, body) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const url = req.url.split("?")[0];
    calls.push(`${req.method} ${url}`);
    if (url === "/rate_limit") return send(200, { rate: { remaining: 5000 } });
    const byId = url.match(/^\/user\/(\d+)$/)?.[1];
    if (byId) {
      if (typeof lookup[byId] === "number") return send(lookup[byId], { message: "refused" });
      return lookup[byId] ? send(200, { login: lookup[byId] }) : send(404, { message: "Not Found" });
    }
    const byName = url.match(/^\/users\/([^/]+)$/)?.[1];
    if (byName) return accounts.includes(byName) ? send(200, { login: byName }) : send(404, { message: "Not Found" });
    if (/^\/repos\/[^/]+\/[^/]+$/.test(url)) return send(200, { id: 42, default_branch: "main", pushed_at: "2025-12-31T00:00:00Z" });
    if (/\/commits\/main$/.test(url)) return send(200, { sha: "a".repeat(40) });
    if (url === "/orgs/TestOrg/members") return send(200, []);
    if (/\/invitations$/.test(url)) return send(200, []);
    const perm = url.match(/\/collaborators\/([^/]+)\/permission$/)?.[1];
    if (perm) return accounts.includes(perm) ? send(200, { permission: "read" }) : send(404, { message: `${perm} is not a user` });
    const who = url.match(/\/collaborators\/([^/]+)$/)?.[1];
    if (who) {
      if (!accounts.includes(who)) return send(404, { message: `${who} is not a user` });
      res.writeHead(204);
      return res.end();
    }
    return send(404, { message: "not stubbed: " + url });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`, calls);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

function control({ acceptance = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pxl-lockdown-renamed-"));
  const put = (path, text) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  put("assignments/exam.yml", `state: published\ndeadline_at: "${DEADLINE}"\nsubmission_ref: refs/heads/main\n`);
  put(`repositories/exam/${OLD}.json`, JSON.stringify({ github_login: OLD, repo_name: `TestOrg/exam-${OLD}`, repo_id: 42 }));
  if (acceptance) put(`acceptances/exam/${OLD}.json`, JSON.stringify({ github_login: OLD, github_id: 77, assignment_id: "exam" }));
  return dir;
}

function run(dir, api) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [lockdownScript], {
      env: {
        ...process.env, GITHUB_TOKEN: "stub-token", GITHUB_API_URL: api, ORG: "TestOrg", ASSIGNMENT_ID: "exam",
        DATA_DIR: dir, GITHUB_OUTPUT: join(dir, "out.env"), GITHUB_STEP_SUMMARY: join(dir, "summary.md"),
      },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", reject);
    child.on("close", (status) => {
      const path = join(dir, "lockdowns", "exam", "lockdown-record.json");
      resolve({ status, out, record: existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null });
    });
  });
}

test("the deadline takes access from the account, whatever the record calls it", async () => {
  await withStub(async (api, calls) => {
    const res = await run(control(), api);
    assert.ok(calls.includes(`PUT /repos/TestOrg/exam-${OLD}/collaborators/${NEW}`), `${calls.join("\n")}\n${res.out}`);
    const row = res.record.results.find((r) => r.github_login === OLD);
    assert.ok(row, "the record keeps the login it has: the next nightly moves it");
    assert.equal(row.verified, true, res.out);
    assert.equal(row.permission_after, "read", res.out);
  });
});

test("GitHub not saying who the account is: said as not stopped, never as nothing to take away", async () => {
  await withStub(async (api) => {
    const res = await run(control(), api);
    const row = res.record.results.find((r) => r.github_login === OLD);
    assert.equal(row.verified, false, res.out);
    assert.match(String(row.permission_after), /^error-/, res.out);
    assert.doesNotMatch(res.out, /no longer has access/);
  }, { lookup: { 77: 403 } });
});

// Review 2026-10-30: read as "could not stop", these failed a lock over nobody.
test("a deleted account has nothing to take away", async () => {
  await withStub(async (api, calls) => {
    const res = await run(control(), api);
    assert.match(res.out, /no longer has access/);
    assert.ok(!calls.some((c) => c.startsWith("PUT ")), calls.join("\n"));
    assert.notEqual(res.record.results.find((r) => r.github_login === OLD).verified, false, res.out);
  }, { lookup: {} });
});

test("a name with no record behind it, a typo in a seeded team, has nothing to take away", async () => {
  await withStub(async (api, calls) => {
    const res = await run(control({ acceptance: false }), api);
    assert.match(res.out, /no longer has access/);
    assert.ok(!calls.some((c) => c.startsWith("PUT ")), calls.join("\n"));
  }, { lookup: {} });
});

test("studentPresence: only a name somebody holds can be gone", async () => {
  const answering = (users) => async (_method, path) => {
    if (path.includes("/invitations")) return { ok: true, status: 200, data: [] };
    if (path.includes("/collaborators/")) return { ok: false, status: 404 };
    return { status: users[path] ?? 500 };
  };
  const repo = "Org/r";
  assert.equal(await studentPresence(answering({ "/users/gone": 200 }), { repo, login: "gone" }), "gone");
  assert.equal(await studentPresence(answering({ "/users/renamed": 404 }), { repo, login: "renamed" }), "no-account");
  assert.equal(await studentPresence(async (_m, path) => {
    if (path.includes("/invitations")) return { ok: true, status: 200, data: [] };
    if (path.includes("/collaborators/")) return { ok: false, status: 404 };
    throw new Error("down");
  }, { repo, login: "x" }), "unreadable");
});
