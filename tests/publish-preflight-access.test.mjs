// PXL Classroom - publish-preflight-access.test.mjs
//
// Publishing refuses when the App cannot see every repository in the org.
//
// Measured 2026-09-30 on PXL-Java-Essentials: the installation was on "Only
// select repositories", the assignment published green, and every one of 25
// acceptances over two days failed `422 Could not clone: Cloning user does not
// have permission to view the clone repository`, each leaving an empty
// repository. The preflight holds the credential that can answer this before
// the first student accepts, and did not ask.
//
// These spawn the real scripts/check-publish-preflight.mjs against a stub API.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "check-publish-preflight.mjs");

async function preflight({ selection = "all", accessStatus = 200, org = "PXL-Java-Essentials" } = {}) {
  const calls = [];
  const server = createServer((req, res) => {
    const send = (code, body) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const url = req.url.split("?")[0];
    calls.push(`${req.method} ${url}`);
    if (url === "/installation/repositories") {
      return accessStatus === 200
        ? send(200, { total_count: 3, repository_selection: selection, repositories: [] })
        : send(accessStatus, { message: "boom" });
    }
    if (url === `/repos/${org}/tpl`) return send(200, { id: 7, private: true, is_template: true, default_branch: "main" });
    if (url === `/repos/${org}/tpl/commits`) return send(200, [{ sha: "a".repeat(40) }]);
    if (url === `/orgs/${org}`) return send(200, { plan: { name: "team" } });
    return send(404, { message: "not stubbed: " + url });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const dir = mkdtempSync(join(tmpdir(), "pxl-preflight-"));
  const file = join(dir, "lab.yml");
  writeFileSync(
    file,
    `organization: ${org}\ntemplate:\n  owner: ${org}\n  repository: tpl\nsubmission_ref: refs/heads/main\nstate: published\n`,
  );
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn("node", [script, file], {
        env: { ...process.env, GITHUB_TOKEN: "stub", GITHUB_API_URL: `http://127.0.0.1:${server.address().port}` },
      });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      child.on("error", reject);
      child.on("close", (status) => resolve({ status, out, calls }));
    });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test("an installation on selected repositories refuses the publish, naming the setting", async () => {
  const res = await preflight({ selection: "selected" });
  assert.equal(res.status, 1, res.out);
  assert.match(res.out, /::error::PXL Classroom cannot create student repositories in PXL-Java-Essentials/);
  assert.match(res.out, /All repositories/);
  assert.match(res.out, /organizations\/PXL-Java-Essentials\/settings\/installations/);
  // Asked FIRST: with a narrowed installation the template read is a misleading 404.
  assert.equal(res.calls[0], "GET /installation/repositories");
  assert.ok(!res.calls.some((c) => c.includes("/repos/")), "refused before the template is read");
});

test("an installation on all repositories publishes as before", async () => {
  const res = await preflight({ selection: "all" });
  assert.equal(res.status, 0, res.out);
  assert.match(res.out, /\[template\] ok/);
});

test("the hub's own organization is scoped on purpose and is not refused", async () => {
  const res = await preflight({ selection: "selected", org: "PXL-Digital-Application-Samples" });
  assert.equal(res.status, 0, res.out);
});

test("an unreadable answer warns and does not refuse - it is not evidence of a narrowed installation", async () => {
  const res = await preflight({ accessStatus: 500 });
  assert.equal(res.status, 0, res.out);
  assert.match(res.out, /::warning::Could not check which repositories PXL Classroom can see/);
});
