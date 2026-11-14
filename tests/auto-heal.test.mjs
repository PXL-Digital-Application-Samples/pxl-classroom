// PXL Classroom - auto-heal.test.mjs
//
// What the nightly does by itself since 2026-11-14 instead of waiting for a
// lecturer to read a log line:
//
//   * presses Retry for a student whose own attempt left a repository with no
//     record (scripts/dispatch-auto-retry.mjs; who is chosen is
//     tests/unrecorded-repos.test.mjs), and
//   * tells the lecturer about a repository the records name and GitHub no
//     longer has (lib/missing-repos.mjs), which was only a `[FAIL]` line in a
//     green collect job when PXL-2TIN-DevOps-2627 lost a team's repository.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { retriesToDispatch } from "../scripts/dispatch-auto-retry.mjs";
import { missingRepoNotice } from "../lib/missing-repos.mjs";
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

test("missingRepoNotice: one entry per repository, a team's members together, a stable key", () => {
  assert.equal(missingRepoNotice([]), null);
  assert.equal(missingRepoNotice(null), null);
  const notice = missingRepoNotice([
    { assignmentId: "grp", login: "julie", repo: "Org/grp-friends" },
    { assignmentId: "grp", login: "ann", repo: "Org/GRP-friends" },
    { assignmentId: "lab", login: "bob", repo: "Org/lab-bob" },
  ]);
  assert.equal(notice.count, 2);
  assert.match(notice.details, /^2 student repositories that PXL Classroom has on record no longer exist/);
  assert.match(notice.details, /- `Org\/grp-friends` \(assignment `grp`\) - students `julie`, `ann`/);
  assert.match(notice.details, /- `Org\/lab-bob` \(assignment `lab`\) - student `bob`/);
  assert.match(notice.details, /restore it for 90 days/);
  // The page itself, and every click GitHub asks for (measured on the testbed,
  // 2026-11-14: same id, same name, pending invitation kept).
  assert.match(notice.details, /Open https:\/\/github\.com\/organizations\/Org\/settings\/deleted_repositories, click \*\*Restore\*\* beside it, then \*\*I understand, restore this repository\*\*/);
  assert.match(notice.details, /same name and id and its pending invitations/);
  assert.match(
    missingRepoNotice([{ assignmentId: "lab", login: "bob", repo: "lab-bob" }]).details,
    /Open the organization's \*\*Settings\*\*, \*\*Deleted repositories\*\*, click \*\*Restore\*\*/,
    "a bare name names no organization: the page in words, never a guessed link",
  );
  assert.match(notice.dedup, /^missing-[0-9a-f]{16}$/);
  const reordered = missingRepoNotice([
    { assignmentId: "lab", login: "bob", repo: "Org/lab-bob" },
    { assignmentId: "grp", login: "julie", repo: "Org/grp-friends" },
  ]);
  assert.equal(reordered.dedup, notice.dedup, "the same repositories are the same notice, updated rather than posted again");
  assert.match(missingRepoNotice([{ assignmentId: "lab", login: "bob", repo: "Org/lab-bob" }]).details, /^A student repository that PXL Classroom has on record no longer exists/);
});

test("the nightly posts the collector's missing-repository notice as unexpected-deletion", () => {
  const steps = workflow("daily-activity.yml").jobs.collect.steps;
  const post = steps.find((s) => s.name === "Tell the lecturer about repositories that are gone");
  assert.ok(post);
  assert.equal(post.uses, "./notify");
  assert.equal(post.with["event-type"], "unexpected-deletion");
  assert.equal(post.with.details, "${{ steps.collect_action.outputs.missing_details }}");
  assert.equal(post.with["dedup-key"], "${{ steps.collect_action.outputs.missing_dedup }}");
  assert.equal(post["continue-on-error"], true);
});
