// PXL Classroom - auto-heal.test.mjs
//
// What the nightly does by itself since 2026-11-14 instead of waiting for a
// lecturer to read a log line:
//
//   * presses Retry for a student whose own attempt left a repository with no
//     record (scripts/dispatch-auto-retry.mjs; who is chosen is
//     tests/unrecorded-repos.test.mjs).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { retriesToDispatch } from "../scripts/dispatch-auto-retry.mjs";
import { AUTO_RETRY_MAX } from "../lib/unrecorded-repos.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const workflow = (name) => parse(readFileSync(join(root, ".github", "workflows", name), "utf8"));

test("retriesToDispatch: only the shapes the Retry workflow accepts, never more than a night's cap", () => {
  assert.deepEqual(retriesToDispatch('[{"assignment_id":"lab","login":"Ann-1"}]', "Org").valid, [{ assignment_id: "lab", login: "Ann-1" }]);
  const bad = retriesToDispatch('[{"assignment_id":"Lab X","login":"ann"},{"assignment_id":"lab","login":"-ann"},{"assignment_id":"lab","login":"ok"}]', "Org");
  assert.deepEqual(bad.valid.map((r) => r.login), ["ok"]);
  assert.equal(bad.dropped, 2);
  assert.deepEqual(retriesToDispatch("not json", "Org"), { valid: [], dropped: 1 });
  assert.equal(retriesToDispatch('[{"assignment_id":"lab","login":"ann"}]', "bad org!").valid.length, 0, "an org that is not a login presses nothing");
  const many = JSON.stringify(Array.from({ length: AUTO_RETRY_MAX + 4 }, (_, i) => ({ assignment_id: "lab", login: `s${i}` })));
  assert.equal(retriesToDispatch(many, "Org").valid.length, AUTO_RETRY_MAX);
  assert.deepEqual(retriesToDispatch("", "Org").valid, []);
});

test("the script dispatches the Retry workflow on main, once per student, with exactly the page's inputs", async () => {
  const calls = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      calls.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
      res.writeHead(req.url.includes("bob") ? 500 : 204);
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const log = await new Promise((resolve, reject) => {
      const child = spawn("node", [join(root, "scripts", "dispatch-auto-retry.mjs")], {
        env: {
          ...process.env,
          GITHUB_TOKEN: "stub",
          GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`,
          GITHUB_REPOSITORY: "Hub/pxl-classroom",
          ORG: "Org",
          RETRY: JSON.stringify([{ assignment_id: "lab", login: "ann" }]),
        },
      });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      child.on("error", reject);
      child.on("close", (status) => (status === 0 ? resolve(out) : reject(new Error(`exit ${status}: ${out}`))));
    });
    assert.deepEqual(calls, [{
      method: "POST",
      url: "/repos/Hub/pxl-classroom/actions/workflows/retry-acceptance.yml/dispatches",
      body: { ref: "main", inputs: { org: "Org", assignment_id: "lab", github_login: "ann" } },
    }]);
    assert.match(log, /pressed Retry for ann on lab in Org/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("the Retry workflow lets the hub's own workflows through and still refuses every other bot", () => {
  const guard = workflow("retry-acceptance.yml").jobs.retry.steps[0];
  assert.equal(guard.name, "Reject automated dispatch");
  assert.match(guard.if, /endsWith\(github\.actor, '\[bot\]'\)/);
  assert.match(guard.if, /github\.actor != 'github-actions\[bot\]'/);
  assert.match(guard.run, /exit 1/);
});

test("the nightly presses Retry only from the finder's own list, with the hub token, and never fails the leg over it", () => {
  const steps = workflow("daily-activity.yml").jobs.collect.steps;
  const press = steps.find((s) => s.run === "node scripts/dispatch-auto-retry.mjs");
  assert.ok(press, "the step exists");
  assert.equal(press.env.RETRY, "${{ steps.unrecorded.outputs.retry }}");
  assert.equal(press.env.GITHUB_TOKEN, "${{ secrets.GITHUB_TOKEN }}", "the hub's own token: an App token is refused by the guard");
  assert.equal(press["continue-on-error"], true);
  assert.equal(workflow("daily-activity.yml").jobs.collect.permissions.actions, "write");
});
