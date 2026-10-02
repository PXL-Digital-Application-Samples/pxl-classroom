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
import { STILL_FILLING_MS, emptyFromCommits, leftoverOfOwnAttempt, mayStillBeFilling } from "../lib/existing-repo.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "provisioning", "provision.mjs");

/**
 * `target`: "absent" | "empty" | "has-commits" | "unreadable" - what is at the
 * student's repository name before the run. `deleteStatus`: what DELETE answers.
 * `createdAt`: the existing repository's `created_at` - an hour ago by default,
 * so it is past the window in which another run may still be filling it
 * (lib/existing-repo.mjs `mayStillBeFilling`); `null` leaves it out.
 */
async function withApi(fn, { target = "absent", deleteStatus = 204, createdAt = new Date(Date.now() - 3600_000).toISOString() } = {}) {
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
      return state === "absent"
        ? send(404, { message: "Not Found" })
        : send(200, {
            id: 9,
            full_name: "Org/lab-ann",
            html_url: "https://github.com/Org/lab-ann",
            ...(createdAt ? { created_at: createdAt } : {}),
          });
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

/**
 * `recreateEmpty` is what acceptance passes (`own_earlier_attempt`): "true"
 * when a repository at the name is this assignment's own earlier work.
 */
function provision(apiBase, { dryRun = false, recreateEmpty = "true" } = {}) {
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
        RECREATE_EMPTY: recreateEmpty,
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

test("an EMPTY repository the student created themselves is kept - empty alone is never enough", async () => {
  // The first version (v1.5.2) removed every empty repository. A student can
  // create one and then accept, and "give them the existing repository" says
  // they keep it. Only acceptance knows whose it is; anything but an explicit
  // "true" keeps it.
  for (const recreateEmpty of ["false", "", "1", "TRUE"]) {
    await withApi(async (api, calls) => {
      const res = await provision(api, { recreateEmpty });
      assert.equal(res.status, 0, res.log);
      assert.match(res.outputs, /^outcome=reused$/m, `RECREATE_EMPTY="${recreateEmpty}"`);
      assert.ok(!calls.some((c) => c.startsWith("DELETE ")), `nothing is deleted with RECREATE_EMPTY="${recreateEmpty}"`);
      assert.ok(!calls.some((c) => c.endsWith("/generate")), "and nothing is generated over it");
    }, { target: "empty" });
  }
});

test("leftoverOfOwnAttempt: a prior acceptance that was not a reuse, or the team's own repository", () => {
  assert.equal(leftoverOfOwnAttempt({ status: "failed" }), true, "what a failed generate leaves");
  assert.equal(leftoverOfOwnAttempt({ status: "provisioned" }), true);
  assert.equal(leftoverOfOwnAttempt({ status: "provisioned", reused_existing_repo: true }), false, "they were given a repository they already had");
  assert.equal(leftoverOfOwnAttempt(null), false, "a first acceptance");
  assert.equal(leftoverOfOwnAttempt(undefined), false);
  assert.equal(leftoverOfOwnAttempt("garbage"), false, "an unreadable record is not evidence");
  assert.equal(leftoverOfOwnAttempt(null, { ownGroupRepo: true }), true, "the team's manifest already names it");
});

test("both workflows pass acceptance's answer to provisioning, and the action declares it", () => {
  for (const wf of ["acceptance-handler.yml", "retry-acceptance.yml"]) {
    const src = readFileSync(join(root, ".github", "workflows", wf), "utf8");
    assert.match(src, /recreate-empty: \$\{\{ steps\.accept\.outputs\.own_earlier_attempt \}\}/, wf);
  }
  const action = readFileSync(join(root, "provisioning", "action.yml"), "utf8");
  assert.match(action, /recreate-empty:[\s\S]*?default: "false"/, "absent means keep");
  assert.match(action, /RECREATE_EMPTY: \$\{\{ inputs\.recreate-empty \}\}/);
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

// NOTHING QUEUES ACCEPTANCES ANY MORE (lib/acceptance-reservation.mjs), so a
// teammate's run, or the same student's second attempt, can meet a repository
// the first run generated seconds ago - empty, because GitHub is still copying
// the template in. Removing it there deletes a repository another run is about
// to hand out.
test("an empty repository created minutes ago is kept - another run may still be filling it", async () => {
  await withApi(async (api, calls) => {
    const res = await provision(api);
    assert.equal(res.status, 0, res.log);
    assert.match(res.outputs, /^outcome=reused$/m);
    assert.ok(!calls.some((c) => c.startsWith("DELETE ")), `a young repository was removed: ${calls.join(" | ")}`);
    assert.match(res.log, /another run may still be filling it/);
  }, { target: "empty", createdAt: new Date(Date.now() - 60_000).toISOString() });
});

test("an empty repository whose age cannot be read is kept, not removed on a guess", async () => {
  await withApi(async (api, calls) => {
    const res = await provision(api);
    assert.equal(res.status, 0, res.log);
    assert.ok(!calls.some((c) => c.startsWith("DELETE ")), "unknown age is not evidence of an old leftover");
  }, { target: "empty", createdAt: null });
});

test("mayStillBeFilling: young is true, old is false, unreadable is unknown", () => {
  const now = new Date("2026-10-02T12:00:00Z");
  assert.equal(mayStillBeFilling("2026-10-02T11:58:00Z", now), true);
  assert.equal(mayStillBeFilling("2026-10-02T11:49:00Z", now), false);
  assert.equal(mayStillBeFilling(new Date(now.getTime() - STILL_FILLING_MS).toISOString(), now), false);
  assert.equal(mayStillBeFilling("not a date", now), null);
  assert.equal(mayStillBeFilling(undefined, now), null);
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
