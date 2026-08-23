// PXL Classroom - lockdown-late-policy.test.mjs
//
// `late_policy: block` promised to refuse late pushes and no code read the
// field; `lock_down_enabled` promised to demote at the deadline and no code read
// that either - lockdown demoted everyone on every assignment regardless. Two
// controls, neither wired, both shipped as defaults.
//
// They are separate decisions now and this pins both, plus the reconstruction
// that makes `block` mean anything when the lock fires at the nightly rather
// than at the deadline itself.
//
// Driven against the real lockdown.mjs over a stub GitHub API that records every
// request, so "the ruleset was applied" is observed rather than asserted about
// the source.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const lockdownScript = join(here, "..", "lockdown", "lockdown.mjs");

const APP_ID = 4051936;
const HEAD_SHA = "9".repeat(40);        // the late commit, on HEAD
const ON_TIME_SHA = "1".repeat(40);     // what ?until= should pick
const DEADLINE = new Date(Date.now() - 4 * 3600_000).toISOString();
const PUSHED_LATE = new Date(Date.now() - 3600_000).toISOString();   // after the deadline
const PUSHED_EARLY = new Date(Date.now() - 5 * 3600_000).toISOString(); // before it

/**
 * Stub GitHub API.
 *   pushedAt      - what the repository object reports
 *   untilCommits  - what GET /commits?until= returns ([] means "nothing on time")
 *   rulesets      - existing rulesets per repo name
 *   denyRulesets  - 403 every ruleset write, to exercise the demotion fallback
 *   appIdStatus   - HTTP status for GET /apps/<slug>
 */
async function withStubApi(fn, opts = {}) {
  const {
    pushedAt = PUSHED_LATE,
    untilCommits = [{ sha: ON_TIME_SHA }],
    denyRulesets = false,
    appIdStatus = 200,
  } = opts;
  const calls = [];
  const rulesetsByRepo = new Map();
  let nextRulesetId = 500;

  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const send = (code, body) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      const [path, query] = req.url.split("?");
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
      calls.push({ line: `${req.method} ${path}`, query: query ?? "", body });

      if (path === "/rate_limit") return send(200, { rate: { remaining: 5000 } });
      if (path.startsWith("/apps/")) {
        return appIdStatus === 200 ? send(200, { id: APP_ID }) : send(appIdStatus, { message: "nope" });
      }

      const rs = path.match(/^\/repos\/[^/]+\/([^/]+)\/rulesets(?:\/(\d+))?$/);
      if (rs) {
        const [, repo, id] = rs;
        if (req.method === "GET" && !id) return send(200, rulesetsByRepo.get(repo) ?? []);
        if (denyRulesets) return send(403, { message: "Resource not accessible by integration" });
        if (req.method === "POST") {
          const created = { id: nextRulesetId++, name: body.name, source_type: "Repository", enforcement: body.enforcement };
          rulesetsByRepo.set(repo, [...(rulesetsByRepo.get(repo) ?? []), created]);
          return send(201, created);
        }
        if (req.method === "PUT") {
          const list = rulesetsByRepo.get(repo) ?? [];
          const found = list.find((r) => String(r.id) === id);
          if (found) found.enforcement = body.enforcement;
          return send(200, found ?? { id: Number(id), enforcement: body.enforcement });
        }
      }

      if (/^\/repos\/[^/]+\/[^/]+\/commits$/.test(path)) return send(200, untilCommits);
      if (/\/commits\/main$/.test(path)) return send(200, { sha: HEAD_SHA });
      if (/^\/repos\/[^/]+\/[^/]+$/.test(path)) return send(200, { id: 42, default_branch: "main", pushed_at: pushedAt });
      if (/\/collaborators\/[^/]+\/permission$/.test(path)) return send(200, { permission: "read" });
      if (/\/collaborators\/[^/]+$/.test(path) && req.method === "PUT") {
        res.writeHead(204);
        return res.end();
      }
      return send(404, { message: "not stubbed: " + path });
    });
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`, calls, rulesetsByRepo);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

function makeControlDir({ latePolicy = null, lockDownEnabled = null, logins = ["alice"] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pxl-lockdown-policy-"));
  const id = "exam";
  mkdirSync(join(dir, "assignments"), { recursive: true });
  writeFileSync(
    join(dir, "assignments", `${id}.yml`),
    `state: published\ndeadline_at: "${DEADLINE}"\nsubmission_ref: refs/heads/main\n` +
      (latePolicy ? `late_policy: ${latePolicy}\n` : "") +
      (lockDownEnabled === null ? "" : `lock_down_enabled: ${lockDownEnabled}\n`),
  );
  mkdirSync(join(dir, "repositories", id), { recursive: true });
  for (const login of logins) {
    writeFileSync(
      join(dir, "repositories", id, `${login}.json`),
      JSON.stringify({ github_login: login, repo_name: `TestOrg/${id}-${login}`, repo_id: 42 }),
    );
  }
  return dir;
}

function runLockdown(dir, apiBase) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [lockdownScript], {
      env: {
        ...process.env,
        GITHUB_TOKEN: "stub-token",
        GITHUB_API_URL: apiBase,
        ORG: "TestOrg",
        ASSIGNMENT_ID: "exam",
        DATA_DIR: dir,
        GITHUB_OUTPUT: join(dir, "out.env"),
        GITHUB_STEP_SUMMARY: join(dir, "summary.md"),
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (status) => {
      const recordPath = join(dir, "lockdowns", "exam", "lockdown-record.json");
      const outPath = join(dir, "out.env");
      resolve({
        status, stdout, stderr,
        record: existsSync(recordPath) ? JSON.parse(readFileSync(recordPath, "utf8")) : null,
        outputs: existsSync(outPath) ? readFileSync(outPath, "utf8") : "",
      });
    });
  });
}

const rowFor = (record, login) => record.results.find((r) => r.github_login === login);
const demotions = (calls) => calls.filter((c) => /^PUT .*\/collaborators\//.test(c.line));
const rulesetWrites = (calls) => calls.filter((c) => /\/rulesets/.test(c.line) && !c.line.startsWith("GET "));

// --- block: the ruleset ------------------------------------------------------

test("late_policy block stops the ref with a ruleset, not a demotion", async () => {
  await withStubApi(async (api, calls) => {
    const dir = makeControlDir({ latePolicy: "block", lockDownEnabled: false });
    const res = await runLockdown(dir, api);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.record.lock_method, "ruleset");
    assert.equal(rowFor(res.record, "alice").lock_method, "ruleset");
    assert.deepEqual(
      demotions(calls).map((c) => c.line),
      [],
      "the student keeps their Actions, secrets and runners - that is the point",
    );
    assert.ok(rulesetWrites(calls).length >= 1, "a ruleset was written");
  });
});

test("the ruleset it creates is active and blocks force-push and deletion too", async () => {
  await withStubApi(async (api, calls) => {
    const dir = makeControlDir({ latePolicy: "block", lockDownEnabled: false });
    await runLockdown(dir, api);
    const created = calls.find((c) => c.line === "POST /repos/TestOrg/exam-alice/rulesets");
    assert.ok(created, "the lock is created when the repository has none");
    assert.equal(created.body.enforcement, "active");
    assert.deepEqual(created.body.rules.map((r) => r.type).sort(), ["deletion", "non_fast_forward", "update"]);
    assert.equal(created.body.bypass_actors[0].actor_id, APP_ID);
    assert.equal(created.body.bypass_actors[0].actor_type, "Integration");
  });
});

test("a ruleset that cannot be applied degrades to a demotion, not to no lock", async () => {
  await withStubApi(
    async (api, calls) => {
      const dir = makeControlDir({ latePolicy: "block", lockDownEnabled: false });
      const res = await runLockdown(dir, api);
      assert.equal(res.status, 0, res.stderr);
      assert.equal(rowFor(res.record, "alice").lock_method, "demotion");
      assert.equal(rowFor(res.record, "alice").verified, true);
      assert.ok(demotions(calls).length >= 1, "the old behaviour is the floor, not nothing");
      assert.match(res.stdout, /falling back to demotion/);
    },
    { denyRulesets: true },
  );
});

test("an unresolvable App id means demotion - never a lock the system cannot bypass", async () => {
  await withStubApi(
    async (api, calls) => {
      const dir = makeControlDir({ latePolicy: "block", lockDownEnabled: false });
      const res = await runLockdown(dir, api);
      assert.equal(res.record.lock_method, "demotion");
      assert.deepEqual(rulesetWrites(calls), []);
      assert.match(res.stdout, /could not resolve the App id/);
    },
    { appIdStatus: 502 },
  );
});

// --- block: reconstructing the deadline state --------------------------------

test("a push after the deadline is filtered out of the submission", async () => {
  await withStubApi(async (api, calls) => {
    const dir = makeControlDir({ latePolicy: "block", lockDownEnabled: false });
    const res = await runLockdown(dir, api);
    const alice = rowFor(res.record, "alice");
    assert.equal(alice.snapshot_sha, ON_TIME_SHA, "HEAD holds the late commit; the submission must not");
    assert.equal(alice.reconstructed, true);
    const q = calls.find((c) => c.line === "GET /repos/TestOrg/exam-alice/commits");
    assert.ok(q, "the ?until= query must actually be made");
    assert.match(decodeURIComponent(q.query), new RegExp(`until=${DEADLINE}`));
  });
});

test("nothing committed before the deadline is a no-submission, not an error", async () => {
  await withStubApi(
    async (api) => {
      const dir = makeControlDir({ latePolicy: "block", lockDownEnabled: false });
      const res = await runLockdown(dir, api);
      assert.equal(res.status, 0, res.stderr);
      const alice = rowFor(res.record, "alice");
      assert.equal(alice.snapshot_sha, null);
      assert.equal(alice.no_submission, true);
      assert.equal(res.record.error_count, 0, "one slacker must not turn the cohort's run amber");
      assert.match(res.outputs, /no_submission_count=1/);
      assert.match(res.outputs, /outcome=locked/);
    },
    { untilCommits: [] },
  );
});

test("a repository whose last push was before the deadline costs no extra call", async () => {
  await withStubApi(
    async (api, calls) => {
      const dir = makeControlDir({ latePolicy: "block", lockDownEnabled: false });
      const res = await runLockdown(dir, api);
      const alice = rowFor(res.record, "alice");
      assert.equal(alice.snapshot_sha, HEAD_SHA, "HEAD is the deadline state");
      assert.equal(alice.reconstructed, undefined);
      assert.deepEqual(
        calls.filter((c) => c.line === "GET /repos/TestOrg/exam-alice/commits"),
        [],
        "pushed_at already answers the question",
      );
    },
    { pushedAt: PUSHED_EARLY },
  );
});

test("an extension widens the reconstruction window to the student's own deadline", async () => {
  // After the assignment deadline (4h ago), before the late push (1h ago): so
  // the extension has run out, alice is locked, and the push still lands after
  // the window she was actually given.
  const granted = new Date(Date.now() - 2 * 3600_000).toISOString();
  await withStubApi(async (api, calls) => {
    const dir = makeControlDir({ latePolicy: "block", lockDownEnabled: false });
    mkdirSync(join(dir, "overrides", "exam"), { recursive: true });
    writeFileSync(
      join(dir, "overrides", "exam", "alice.json"),
      JSON.stringify({
        schema_version: 1, assignment_id: "exam", github_login: "alice",
        overrides: [{
          type: "deadline_extension", value: granted, reason: "medical",
          overridden_by: "admin-panel", overridden_at: new Date().toISOString(),
        }],
      }),
    );
    await runLockdown(dir, api);
    const q = calls.find((c) => c.line === "GET /repos/TestOrg/exam-alice/commits");
    assert.ok(q, "the extension has expired, so alice is locked and reconstructed");
    assert.match(
      decodeURIComponent(q.query),
      new RegExp(`until=${granted}`),
      "the window must be the extension, not the assignment deadline",
    );
  });
});

// --- report: late work counts ------------------------------------------------

test("late_policy report keeps the late commit as the submission", async () => {
  await withStubApi(async (api, calls) => {
    const dir = makeControlDir({ latePolicy: "report" });
    const res = await runLockdown(dir, api);
    const alice = rowFor(res.record, "alice");
    assert.equal(alice.snapshot_sha, HEAD_SHA, "under report a late commit is part of the submission");
    assert.deepEqual(calls.filter((c) => c.line.endsWith("/commits")), [], "no ?until= filtering");
    assert.deepEqual(rulesetWrites(calls), [], "and nothing is blocked");
  });
});

// --- the two switches are independent ----------------------------------------

test("lock_down_enabled defaults to true, so an assignment without it still demotes", async () => {
  // Every assignment created before this shipped was demoted at the deadline.
  // Inferring "no lock" from a missing field would silently stop freezing live
  // cohorts.
  await withStubApi(async (api, calls) => {
    const dir = makeControlDir({});
    const res = await runLockdown(dir, api);
    assert.equal(res.record.lock_method, "demotion");
    assert.ok(demotions(calls).length >= 1);
    assert.equal(rowFor(res.record, "alice").verified, true);
  });
});

test("report + lock_down_enabled false stops nothing at all", async () => {
  await withStubApi(async (api, calls) => {
    const dir = makeControlDir({ latePolicy: "report", lockDownEnabled: false });
    const res = await runLockdown(dir, api);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.record.lock_method, "none");
    assert.deepEqual(demotions(calls), []);
    assert.deepEqual(rulesetWrites(calls), []);
    assert.equal(res.record.error_count, 0, "not stopping is the policy, not a failure");
    // The submission is still recorded and preserved - only the guarantee is absent.
    assert.equal(rowFor(res.record, "alice").snapshot_sha, HEAD_SHA);
  });
});

test("block + lock_down_enabled true locks the ref AND takes admin, in that order", async () => {
  await withStubApi(async (api, calls) => {
    const dir = makeControlDir({ latePolicy: "block", lockDownEnabled: true });
    const res = await runLockdown(dir, api);
    assert.equal(res.record.lock_method, "ruleset");
    assert.equal(rowFor(res.record, "alice").demoted, true);

    const lines = calls.map((c) => c.line);
    const ruleset = lines.findIndex((l) => /rulesets$/.test(l) && l.startsWith("POST"));
    const snapshot = lines.findIndex((l) => l.includes("/commits"));
    const demotion = lines.findIndex((l) => /^PUT .*\/collaborators\//.test(l));
    assert.ok(ruleset < snapshot, "stop first");
    assert.ok(snapshot < demotion, "the snapshot is taken while the student still has their access");
  });
});
