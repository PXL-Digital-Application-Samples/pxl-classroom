// PXL Classroom - provision-team-switch.test.mjs
//
// A switch that leaves a team empty, whose repository holds nothing anybody
// pushed: acceptance removes the team and passes REMOVE_PREVIOUS_REPO, and
// provisioning deletes the repository - after asking AGAIN, because seconds
// pass between the decision and this step (asked 2026-10-08: a student's typo
// team stayed behind until a lecturer deleted it by hand).
//
// Spawns the real provisioning/provision.mjs against a stub of the API, as
// tests/provision-empty-repo.test.mjs does.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "provisioning", "provision.mjs");

const GENERATED_ROOT = {
  sha: "a".repeat(40), parents: [],
  author: { login: "pxl-classroom-provisioner[bot]" }, committer: { login: "web-flow" },
  commit: { verification: { verified: true } },
};
const PUSHED = {
  sha: "b".repeat(40), parents: [{ sha: "a".repeat(40) }],
  author: { login: "ann" }, committer: { login: "ann" },
  commit: { verification: { verified: false } },
};

/** `oldCommits`: what the team left behind holds when provisioning asks. */
async function withApi(fn, { oldCommits = [GENERATED_ROOT] } = {}) {
  const calls = [];
  let created = false;
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
      created = true;
      return send(201, { id: 10, full_name: "Org/grp-right", html_url: "https://github.com/Org/grp-right" });
    }
    if (url === "/repos/Org/grp-right" && req.method === "GET") {
      return created ? send(200, { id: 10, full_name: "Org/grp-right", html_url: "https://github.com/Org/grp-right" }) : send(404, { message: "Not Found" });
    }
    if (url === "/repos/Org/grp-right/contents/") return send(200, [{ name: "README.md", type: "file" }]);
    if (/^\/repos\/Org\/grp-right\/collaborators\/ann$/.test(url) && req.method === "PUT") return send(204);
    // The team left behind.
    if (url === "/repos/Org/grp-typo/collaborators/ann" && req.method === "DELETE") return send(204);
    if (url === "/repos/Org/grp-typo/invitations") return send(200, []);
    if (url === "/repos/Org/grp-typo/branches") return send(200, [{ name: "main" }]);
    if (url === "/repos/Org/grp-typo/commits") return send(200, oldCommits);
    if (url === "/repos/Org/grp-typo" && req.method === "DELETE") return send(204);
    return send(404, { message: "not stubbed: " + url });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`, calls);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

function provision(apiBase, { removePrevious = "true" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pxl-provision-switch-"));
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
        TARGET_REPO: "grp-right",
        ASSIGNMENT_ID: "lab",
        STUDENT_LOGIN: "ann",
        STUDENT_PERMISSION: "push",
        DRY_RUN: "0",
        RECREATE_EMPTY: "false",
        FEEDBACK_PR: "false",
        PREVIOUS_REPO: "grp-typo",
        REMOVE_PREVIOUS_REPO: removePrevious,
        PXL_FILL_WAIT_CHECKS: "2",
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

test("the team left behind still holds only what GitHub generated: its repository is deleted, after the student's access is removed", async () => {
  await withApi(async (api, calls) => {
    const res = await provision(api);
    assert.equal(res.status, 0, res.log);
    // Request lines the stub recorded, not names in the code.
    const REVOKE = ["DELETE", "/repos/Org/grp-typo/collaborators/ann"].join(" ");
    const REMOVE = ["DELETE", "/repos/Org/grp-typo"].join(" ");
    const revoke = calls.findIndex((c) => c === REVOKE);
    const remove = calls.findIndex((c) => c === REMOVE);
    assert.ok(revoke >= 0, res.log);
    assert.ok(remove > revoke, `deleted after the access was removed:\n${calls.join("\n")}`);
    assert.match(res.log, /remove-old-repo - deleted grp-typo/);
  });
});

test("something was pushed to it since the decision: kept, and the acceptance still succeeds", async () => {
  await withApi(async (api, calls) => {
    const res = await provision(api);
    assert.equal(res.status, 0, res.log);
    assert.equal(calls.includes("DELETE /repos/Org/grp-typo"), false);
    assert.match(res.log, /remove-old-repo - kept grp-typo: something was pushed to it since/);
  }, { oldCommits: [PUSHED, GENERATED_ROOT] });
});

test("without the flag nothing is asked and nothing is deleted - only the access is removed, as before", async () => {
  await withApi(async (api, calls) => {
    const res = await provision(api, { removePrevious: "" });
    assert.equal(res.status, 0, res.log);
    assert.ok(calls.includes("DELETE /repos/Org/grp-typo/collaborators/ann"));
    assert.equal(calls.includes("GET /repos/Org/grp-typo/commits"), false);
    assert.equal(calls.includes("DELETE /repos/Org/grp-typo"), false);
  });
});
