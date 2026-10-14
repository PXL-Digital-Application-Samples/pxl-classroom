// Provisioning records the start of GitHub's copy when it commits to it.
//
// 2026-10-14: on an assignment whose checks are defined in PXL Classroom and
// run on GitHub Actions, provisioning commits the grading workflow to every
// new repository. That is two commits from the first second, and the report's
// "one commit is the start" read every student who did nothing as handed in -
// "On time" - and the nightly graded the workflow's own run. The commit
// provisioning made is the start now (starter_sha / starter_commit_count),
// and it is not a full-history copy.
//
// Spawns the real provisioning/provision.mjs against a stub of the API.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "provisioning", "provision.mjs");
const INJECTED = "d".repeat(40);

async function withApi(fn, { templateGrades = false } = {}) {
  const calls = [];
  let generated = false;
  const server = createServer((req, res) => {
    const send = (code, body, headers = {}) => {
      res.writeHead(code, { "content-type": "application/json", ...headers });
      res.end(body === undefined ? "" : JSON.stringify(body));
    };
    const [url, query = ""] = req.url.split("?");
    calls.push(`${req.method} ${url}${query ? `?${query}` : ""}`);
    req.resume();
    if (url === "/rate_limit") return send(200, { rate: { remaining: 5000 } });
    if (url === "/repos/Org/tpl" && req.method === "GET") return send(200, { id: 7, is_template: true, private: true, default_branch: "main" });
    if (url === "/repos/Org/tpl/generate") {
      generated = true;
      return send(201, { id: 10, full_name: "Org/lab-ann", html_url: "https://github.com/Org/lab-ann", default_branch: "main" });
    }
    if (url === "/repos/Org/lab-ann" && req.method === "GET") return generated ? send(200, { id: 10, full_name: "Org/lab-ann", default_branch: "main" }) : send(404, { message: "Not Found" });
    if (url === "/repos/Org/lab-ann/contents/" && req.method === "GET") return send(200, [{ name: "README.md", type: "file" }]);
    if (/^\/repos\/Org\/lab-ann\/contents\/\.github\/workflows\/(autograding|classroom)\.yml$/.test(url) && req.method === "GET") {
      return templateGrades && url.endsWith("autograding.yml") ? send(200, { name: "autograding.yml" }) : send(404, { message: "Not Found" });
    }
    if (url === "/repos/Org/lab-ann/contents/.github/workflows/autograding.yml" && req.method === "PUT") {
      return send(201, { content: { path: ".github/workflows/autograding.yml" }, commit: { sha: INJECTED } });
    }
    if (url === "/repos/Org/lab-ann/commits") {
      // GitHub's one commit plus the workflow: the `last` page is 2.
      return send(200, [{ sha: INJECTED }], { link: `<http://x/repos/Org/lab-ann/commits?sha=${INJECTED}&per_page=1&page=2>; rel="last"` });
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

function provision(apiBase) {
  const dir = mkdtempSync(join(tmpdir(), "pxl-provision-inject-"));
  mkdirSync(join(dir, "control", "assignments"), { recursive: true });
  writeFileSync(join(dir, "control", "assignments", "lab.yml"), stringify({
    id: "lab", autograde: { enabled: true, execution_environment: "github_actions", tests: [{ id: "t", name: "t", run: "true", points: 1 }] },
  }));
  return new Promise((resolve, reject) => {
    const child = spawn("node", [script], {
      cwd: dir,
      env: {
        ...process.env, GITHUB_TOKEN: "stub-token", GITHUB_API_URL: apiBase, ORG: "Org", TEMPLATE_OWNER: "Org", TEMPLATE_REPO: "tpl",
        TEMPLATE_REPOSITORY_ID: "", TARGET_REPO: "lab-ann", ASSIGNMENT_ID: "lab", STUDENT_LOGIN: "ann", STUDENT_PERMISSION: "push",
        DRY_RUN: "0", RECREATE_EMPTY: "false", FEEDBACK_PR: "false", TEMPLATE_FULL_HISTORY: "false", PXL_FILL_WAIT_CHECKS: "2",
        GITHUB_OUTPUT: join(dir, "out.env"), GITHUB_STEP_SUMMARY: join(dir, "summary.md"),
      },
    });
    let log = "";
    child.stdout.on("data", (d) => (log += d));
    child.stderr.on("data", (d) => (log += d));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, log, outputs: existsSync(join(dir, "out.env")) ? readFileSync(join(dir, "out.env"), "utf8") : "" }));
  });
}

const output = (outputs, name) => {
  const lines = outputs.split("\n").filter((l) => l.startsWith(`${name}=`));
  return lines.length ? lines[lines.length - 1].slice(name.length + 1) : undefined;
};

test("GitHub's copy that provisioning committed the grading workflow to records that commit as its start", async () => {
  await withApi(async (api, calls) => {
    const r = await provision(api);
    assert.equal(r.status, 0, r.log);
    assert.ok(calls.some((c) => c.startsWith("PUT /repos/Org/lab-ann/contents/.github/workflows/autograding.yml")));
    assert.equal(output(r.outputs, "starter_sha"), INJECTED);
    assert.equal(output(r.outputs, "starter_commit_count"), "2");
    assert.equal(output(r.outputs, "full_history"), "false", "not a copy of the template's history");
  });
});

test("...and one provisioning added nothing to records none: one commit is the start, as ever", async () => {
  await withApi(async (api) => {
    const r = await provision(api);
    assert.equal(r.status, 0, r.log);
    assert.equal(output(r.outputs, "starter_sha"), "");
  }, { templateGrades: true });
});
