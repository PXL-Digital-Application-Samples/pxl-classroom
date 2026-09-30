// PXL Classroom - provision-empty-repo.test.mjs
//
// An EMPTY existing repository is not a reuse.
//
// Measured 2026-09-30 on PXL-Java-Essentials, where the App could see "selected
// repositories" only: `generate` answered `422 Could not clone: Cloning user
// does not have permission to view the clone repository` AFTER GitHub had
// created the repository, so 25 students each got an empty one. Provisioning
// reuses whatever exists at the name, so once the setting was fixed a retry
// would have handed each of them that empty repository back, reported
// `reused`, with no starter code in it.
//
// These spawn the real provisioning/provision.mjs against a stub of the API.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { emptyFromCommits } from "../lib/existing-repo.mjs";

const script = join(dirname(fileURLToPath(import.meta.url)), "..", "provisioning", "provision.mjs");

/**
 * `target`: "absent" | "empty" | "has-commits" | "unreadable" - what is at the
 * student's repository name before the run. `deleteStatus`: what DELETE answers.
 */
async function withApi(fn, { target = "absent", deleteStatus = 204 } = {}) {
  const calls = [];
  let state = target;
  const server = createServer((req, res) => {
    const send = (code, body) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(body === undefined ? "" : JSON.stringify(body));
    };
    const url = req.url.split("?")[0];
    calls.push(`${req.method} ${url}`);
    req.resume();

    if (url === "/rate_limit") return send(200, { rate: { remaining: 5000 } });
    if (url === "/repos/Org/tpl" && req.method === "GET") return send(200, { id: 7, is_template: true, private: true });
    if (url === "/repos/Org/tpl/generate") {
      if (state !== "absent") return send(422, { message: "Could not clone: Name already exists on this account" });
      state = "has-commits";
      return send(201, { id: 10, full_name: "Org/lab-ann", html_url: "https://github.com/Org/lab-ann" });
    }
    if (url === "/repos/Org/lab-ann" && req.method === "GET") {
      return state === "absent" ? send(404, { message: "Not Found" }) : send(200, { id: 9, full_name: "Org/lab-ann", html_url: "https://github.com/Org/lab-ann" });
    }
    if (url === "/repos/Org/lab-ann/commits") {
      if (state === "empty") return send(409, { message: "Git Repository is empty." });
      // 403, not a 5xx: a 5xx is retried with backoff, which only slows the test.
      if (state === "unreadable") return send(403, { message: "Resource not accessible by integration" });
      return send(200, [{ sha: "a".repeat(40) }]);
    }
    if (url === "/repos/Org/lab-ann" && req.method === "DELETE") {
      if (deleteStatus === 204) state = "absent";
      return send(deleteStatus, deleteStatus === 204 ? undefined : { message: "Must have admin rights to Repository." });
    }
    if (/\/collaborators\/ann$/.test(url) && req.method === "PUT") return send(204);
    return send(404, { message: "not stubbed: " + url });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`, calls);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

function provision(apiBase, { dryRun = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pxl-provision-"));
  return new Promise((resolve, reject) => {
    const child = spawn("node", [script], {
      cwd: dir,
      env: {
        ...process.env,
        GITHUB_TOKEN: "stub-token",
        GITHUB_API_URL: apiBase,
        ORG: "Org",
        TEMPLATE_OWNER: "Org",
        TEMPLATE_REPO: "tpl",
        TEMPLATE_REPOSITORY_ID: "",
        TARGET_REPO: "lab-ann",
        ASSIGNMENT_ID: "lab",
        STUDENT_LOGIN: "ann",
        STUDENT_PERMISSION: "push",
        DRY_RUN: dryRun ? "1" : "0",
        FEEDBACK_PR: "false",
        GITHUB_OUTPUT: join(dir, "out.env"),
        GITHUB_STEP_SUMMARY: join(dir, "summary.md"),
      },
    });
    let log = "";
    child.stdout.on("data", (d) => (log += d));
    child.stderr.on("data", (d) => (log += d));
    child.on("error", reject);
    child.on("close", (status) => {
      const out = join(dir, "out.env");
      resolve({ status, log, outputs: existsSync(out) ? readFileSync(out, "utf8") : "" });
    });
  });
}

test("emptyFromCommits: only GitHub's own 409 is empty; unreadable is not evidence", () => {
  assert.equal(emptyFromCommits({ status: 409, ok: false, data: { message: "Git Repository is empty." } }), true);
  assert.equal(emptyFromCommits({ status: 200, ok: true, data: [{ sha: "x" }] }), false);
  assert.equal(emptyFromCommits({ status: 200, ok: true, data: [] }), false);
  assert.equal(emptyFromCommits({ status: 403, ok: false }), null);
  assert.equal(emptyFromCommits({ status: 500, ok: false }), null);
  assert.equal(emptyFromCommits(null), null);
});

test("an empty repository a failed creation left behind is removed and created again", async () => {
  await withApi(async (api, calls) => {
    const res = await provision(api);
    assert.equal(res.status, 0, res.log);
    assert.match(res.outputs, /^outcome=created$/m, "not `reused` - the student gets the template");
    const del = calls.findIndex((c) => c === `DELETE /repos/Org/${"lab-ann"}`);
    const gen = calls.findIndex((c) => c === `POST /repos/Org/${"tpl"}/generate`);
    assert.ok(del > -1 && gen > del, `removed, then generated: ${calls.join(" | ")}`);
  }, { target: "empty" });
});

test("a repository with a commit is reused exactly as before, and never deleted", async () => {
  await withApi(async (api, calls) => {
    const res = await provision(api);
    assert.equal(res.status, 0, res.log);
    assert.match(res.outputs, /^outcome=reused$/m);
    assert.ok(!calls.some((c) => c.startsWith("DELETE /repos/Org/lab-ann")), "a repository with work in it is never removed");
    assert.ok(!calls.includes("POST /repos/Org/tpl/generate"));
  }, { target: "has-commits" });
});

test("a repository whose commits could not be read is not treated as empty", async () => {
  await withApi(async (api, calls) => {
    const res = await provision(api);
    assert.equal(res.status, 0, res.log);
    assert.match(res.outputs, /^outcome=reused$/m);
    assert.ok(!calls.some((c) => c.startsWith("DELETE ")), "unreadable is not evidence of empty");
  }, { target: "unreadable" });
});

test("an empty repository that cannot be removed fails, naming it - never reused", async () => {
  await withApi(async (api, calls) => {
    const res = await provision(api);
    assert.notEqual(res.status, 0);
    assert.match(res.log, /fail:create/);
    assert.match(res.log, /Org\/lab-ann exists and is empty/);
    assert.ok(!calls.includes("POST /repos/Org/tpl/generate"));
  }, { target: "empty", deleteStatus: 403 });
});

test("a dry run removes nothing", async () => {
  await withApi(async (api, calls) => {
    const res = await provision(api, { dryRun: true });
    assert.equal(res.status, 0, res.log);
    assert.ok(!calls.some((c) => c.startsWith("DELETE ") || c.startsWith("POST ") || c.startsWith("PUT ")), calls.join(" | "));
  }, { target: "empty" });
});

test("nothing at the name is created as always", async () => {
  await withApi(async (api, calls) => {
    const res = await provision(api);
    assert.equal(res.status, 0, res.log);
    assert.match(res.outputs, /^outcome=created$/m);
    assert.ok(!calls.includes("GET /repos/Org/lab-ann/commits"), "no extra read when there is nothing there");
  }, { target: "absent" });
});
