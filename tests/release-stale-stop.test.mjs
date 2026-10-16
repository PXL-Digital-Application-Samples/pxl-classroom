// scripts/release-stale-stop.mjs: the stop a moved deadline no longer wants
// (review 2026-10-16, R7-1). The sentinel stopped the cohort at the old
// instant, the lecturer moved the deadline later before any lock record, and
// the publish their save dispatched lets go of the stop. Driven over a stub
// GitHub with the real lib/stop-release.mjs and lib/submission-lock.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { parse } from "yaml";
import { staleStop } from "../scripts/release-stale-stop.mjs";
import { CONTROL_REPO } from "../lib/deployment.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "scripts", "release-stale-stop.mjs");
const PAST = new Date(Date.now() - 600_000).toISOString();
const LATER = new Date(Date.now() + 3600_000).toISOString();
const fired = { outcome: "fired", deadline_at: PAST, stop: "done" };

test("staleStop: only a deadline ahead, no lock record and a sentinel that fired", () => {
  const a = { deadline_at: LATER };
  assert.equal(staleStop({ assignment: a, lockRecordExists: false, timelines: [fired] }).stale, true);
  assert.equal(staleStop({ assignment: { deadline_at: PAST }, lockRecordExists: false, timelines: [fired] }).stale, false, "a deadline still passed is the finalize's");
  assert.equal(staleStop({ assignment: a, lockRecordExists: true, timelines: [fired] }).stale, false, "a lock record is Reopen's");
  assert.equal(staleStop({ assignment: a, lockRecordExists: false, timelines: [] }).stale, false, "no sentinel, no stop");
  assert.equal(staleStop({ assignment: a, lockRecordExists: false, timelines: [{ outcome: "gave-up:runtime", deadline_at: PAST }] }).stale, false);
  assert.equal(staleStop({ assignment: a, lockRecordExists: false, timelines: [{ ...fired, due: false }] }).stale, false, "fired for its group, not for this one");
  assert.equal(staleStop({ assignment: a, lockRecordExists: false, timelines: [{ ...fired, stop: "failed" }] }).stale, true, "a failed stop may have stopped some before it failed");
});

/**
 * GitHub as it stands after the stop: `orgIds` in the organization ruleset
 * (null: a free organization, 403), `repoLocked` with a repository ruleset on,
 * `demoted` at read, `gone` repositories deleted, `refuse` writes answered 403.
 */
async function withApi(fn, { orgIds = [], repoLocked = [], demoted = [], gone = [], refuse = [], lockRecord = 404, controlRepo = 200 } = {}) {
  const writes = [];
  const calls = [];
  let ids = orgIds ? [...orgIds] : null;
  let enforcement = "active";
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = req.url.split("?")[0];
      const send = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(body === undefined ? "" : JSON.stringify(body)); };
      calls.push(`${req.method} ${url}`);
      const body = raw ? JSON.parse(raw) : null;
      if (req.method !== "GET") writes.push({ method: req.method, url, body });
      if (refuse.some((r) => url.includes(r)) && req.method !== "GET") return send(403, { message: "Resource not accessible by integration" });
      // The lock record as the control repository holds it now (R7-21).
      if (url === `/repos/O/${CONTROL_REPO}/contents/lockdowns/exam/lockdown-record.json`) {
        return lockRecord === 200 ? send(200, { content: Buffer.from("{}").toString("base64"), encoding: "base64" }) : send(lockRecord, { message: "Not Found" });
      }
      if (url === `/repos/O/${CONTROL_REPO}`) return send(controlRepo, controlRepo === 200 ? { name: CONTROL_REPO } : { message: "Not Found" });
      if (url === "/orgs/O/rulesets") {
        return ids === null ? send(403, { message: "Upgrade to GitHub Team to enable this feature." }) : send(200, [{ id: 7, name: "pxl-classroom-deadline-exam" }]);
      }
      if (url === "/orgs/O/rulesets/7" && req.method === "GET") {
        return send(200, { id: 7, name: "pxl-classroom-deadline-exam", enforcement, conditions: { repository_id: { repository_ids: ids }, ref_name: { include: ["refs/heads/main"], exclude: [] } } });
      }
      if (url === "/orgs/O/rulesets/7" && req.method === "PUT") {
        if (body?.conditions?.repository_id) ids = body.conditions.repository_id.repository_ids;
        if (body?.enforcement) enforcement = body.enforcement;
        return send(200, { id: 7, enforcement, conditions: { repository_id: { repository_ids: ids } } });
      }
      const rs = url.match(/^\/repos\/O\/([^/]+)\/rulesets$/);
      if (rs) {
        if (gone.includes(rs[1])) return send(404, { message: "Not Found" });
        if (ids === null) return send(403, { message: "Upgrade to GitHub Pro or make this repository public to enable this feature." });
        return send(200, repoLocked.includes(rs[1]) ? [{ id: 9, name: "pxl-classroom-deadline", enforcement: "active", source_type: "Repository" }] : []);
      }
      if (/^\/repos\/O\/[^/]+\/rulesets\/9$/.test(url) && req.method === "PUT") return send(200, { id: 9, enforcement: "disabled" });
      const perm = url.match(/^\/repos\/O\/([^/]+)\/collaborators\/([^/]+)\/permission$/);
      if (perm) {
        if (gone.includes(perm[1])) return send(404, { message: "Not Found" });
        const read = demoted.includes(perm[2]);
        return send(200, { permission: read ? "read" : "admin", role_name: read ? "read" : "admin" });
      }
      if (/\/collaborators\/[^/]+$/.test(url)) { res.writeHead(204); return res.end(); }
      return send(404, { message: `not stubbed: ${url}` });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`, { writes, calls, ids: () => ids, enforcement: () => enforcement });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

/** The publish's checkout: the moved deadline, the records, the fired timeline, no lock record. */
function checkout({ records, deadline = LATER, timelines = [fired], lockRecord = false, permission = "admin" }) {
  const dir = mkdtempSync(join(tmpdir(), "pxl-release-"));
  mkdirSync(join(dir, "assignments"), { recursive: true });
  writeFileSync(join(dir, "assignments", "exam.yml"), `state: published\ndeadline_at: "${deadline}"\nstudent_permission: ${permission}\n`);
  mkdirSync(join(dir, "repositories", "exam"), { recursive: true });
  for (const r of records) writeFileSync(join(dir, "repositories", "exam", `${r.login}.json`), JSON.stringify({ github_login: r.login, repo_name: `O/${r.repo}`, repo_id: r.id }));
  mkdirSync(join(dir, "lockdowns", "exam"), { recursive: true });
  timelines.forEach((t, i) => writeFileSync(join(dir, "lockdowns", "exam", `sentinel-k${i}.json`), JSON.stringify(t)));
  if (lockRecord) writeFileSync(join(dir, "lockdowns", "exam", "lockdown-record.json"), "{}");
  return dir;
}

function run(dir, api, mode) {
  return new Promise((resolve, reject) => {
    const out = join(dir, `out-${mode}.env`);
    const child = spawn("node", [script, mode], {
      env: { ...process.env, GITHUB_TOKEN: "stub", GITHUB_API_URL: api, ORG: "O", ASSIGNMENT_ID: "exam", DATA_DIR: dir, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: join(dir, "summary.md") },
    });
    let log = "";
    child.stdout.on("data", (d) => (log += d));
    child.stderr.on("data", (d) => (log += d));
    child.on("error", reject);
    child.on("close", (status) => {
      let output = "";
      try { output = readFileSync(out, "utf8"); } catch { /* none */ }
      resolve({ status, log, output });
    });
  });
}

const cohort = [{ login: "alice", repo: "exam-alice", id: 1 }, { login: "bob", repo: "exam-bob", id: 2 }];

test("check: says stale for the moved deadline, and asks GitHub nothing", async () => {
  await withApi(async (api, { calls }) => {
    const res = await run(checkout({ records: cohort }), api, "check");
    assert.equal(res.status, 0, res.log);
    assert.match(res.output, /^stale=true$/m);
    assert.deepEqual(calls, []);
  });
});

test("check: a lock record, a passed deadline or no sentinel is not stale", async () => {
  await withApi(async (api) => {
    for (const opts of [{ lockRecord: true }, { deadline: PAST }, { timelines: [] }]) {
      const res = await run(checkout({ records: cohort, ...opts }), api, "check");
      assert.equal(res.status, 0, res.log);
      assert.match(res.output, /^stale=false$/m, JSON.stringify(opts));
    }
  });
});

test("release (Team): everyone out of the organization's stop, which switches off; repository rulesets off; demoted members back", async () => {
  await withApi(async (api, state) => {
    const dir = checkout({ records: cohort });
    const res = await run(dir, api, "release");
    assert.equal(res.status, 0, res.log);
    // The last id out switches the ruleset off rather than empty it
    // (removeRepoFromOrgLock): disabled, it stops nobody.
    assert.deepEqual(state.ids(), [2], "alice's id out");
    assert.equal(state.enforcement(), "disabled", "and the stop off for bob");
    assert.ok(state.writes.some((w) => w.url === "/repos/O/exam-bob/rulesets/9" && w.body?.enforcement === "disabled"));
    assert.ok(state.writes.some((w) => w.url === "/repos/O/exam-alice/collaborators/alice" && w.body?.permission === "admin"), "alice back at the assignment's permission");
    assert.equal(state.writes.some((w) => w.url.endsWith("/collaborators/bob")), false, "bob was never demoted: not touched");
    assert.match(readFileSync(join(dir, "summary.md"), "utf8"), /2 repositories let go/);
  }, { orgIds: [1, 2], repoLocked: ["exam-bob"], demoted: ["alice"] });
});

test("release (free plan): the 403s are the plan's gate, not failures; the demotion is what is given back", async () => {
  await withApi(async (api, { writes }) => {
    const dir = checkout({ records: cohort });
    const res = await run(dir, api, "release");
    assert.equal(res.status, 0, res.log);
    assert.deepEqual(writes.map((w) => `${w.method} ${w.url}`), ["PUT /repos/O/exam-alice/collaborators/alice", "PUT /repos/O/exam-bob/collaborators/bob"]);
  }, { orgIds: null, demoted: ["alice", "bob"] });
});

test("release: a team's repository once, every member who accepted given back", async () => {
  await withApi(async (api, { writes }) => {
    const res = await run(checkout({ records: [{ login: "ann", repo: "grp-a", id: 5 }, { login: "ben", repo: "grp-a", id: 5 }] }), api, "release");
    assert.equal(res.status, 0, res.log);
    assert.equal(writes.filter((w) => w.url === "/orgs/O/rulesets/7").length, 1, "one id, removed once");
    assert.deepEqual(writes.filter((w) => w.url.includes("/collaborators/")).map((w) => w.url).sort(), ["/repos/O/grp-a/collaborators/ann", "/repos/O/grp-a/collaborators/ben"]);
  }, { orgIds: [5], demoted: ["ann", "ben"] });
});

test("release: a repository deleted since is nothing to release, not a failure", async () => {
  await withApi(async (api) => {
    const res = await run(checkout({ records: cohort }), api, "release");
    assert.equal(res.status, 0, res.log);
  }, { orgIds: [1], gone: ["exam-bob"] });
});

test("release: a stop that will not come off fails the run and names it; running again releases it", async () => {
  await withApi(async (api, state) => {
    const dir = checkout({ records: cohort });
    const first = await run(dir, api, "release");
    assert.equal(first.status, 1, first.log);
    assert.match(first.log, /::error::Published, but 1 stop\(s\) on exam could not be let go.*exam-alice/);
    assert.ok(state.writes.some((w) => w.url === "/repos/O/exam-bob/collaborators/bob"), "the rest is still released");
  }, { orgIds: [], demoted: ["alice", "bob"], refuse: ["/collaborators/alice"] });
  await withApi(async (api) => {
    const again = await run(checkout({ records: cohort }), api, "release");
    assert.equal(again.status, 0, again.log);
  }, { orgIds: [], demoted: ["alice"] });
});

// R7-21 (review 2026-10-16): the finalize commits its record minutes after it
// locks; a publish over a checkout from in between released what the record
// then said held.
test("release: a lock record the finalize wrote since this checkout keeps every stop", async () => {
  await withApi(async (api, { writes }) => {
    const res = await run(checkout({ records: cohort }), api, "release");
    assert.equal(res.status, 0, res.log);
    assert.deepEqual(writes, [], "nothing let go");
    assert.match(res.log, /wrote its lock record after this checkout/);
  }, { orgIds: [1, 2], demoted: ["alice"], lockRecord: 200 });
});

test("release: whether it was locked meanwhile, unread, releases nothing and fails the run", async () => {
  for (const opts of [{ lockRecord: 502 }, { controlRepo: 404 }]) {
    await withApi(async (api, { writes }) => {
      const res = await run(checkout({ records: cohort }), api, "release");
      assert.equal(res.status, 1, res.log);
      assert.deepEqual(writes, [], JSON.stringify(opts));
      assert.match(res.log, /could not be read, so no stop was let go.*Publish again to retry/);
    }, { orgIds: [1, 2], demoted: ["alice"], ...opts });
  }
});

test("the workflow runs it last, mints its token only when stale, and the token row exists", () => {
  const wf = parse(readFileSync(join(root, ".github/workflows/publish-assignment.yml"), "utf8"));
  const steps = wf.jobs.publish.steps;
  const names = steps.map((s) => s.name);
  assert.deepEqual(names.slice(-3), ["Look for a stop the deadline no longer wants", "Mint App token for the stop release", "Release the stop"], "last: a failure skips nothing");
  const mint = steps.find((s) => s.id === "release_token");
  assert.match(mint.if, /steps\.stale_stop\.outputs\.stale == 'true'/);
  assert.equal(steps.find((s) => s.name === "Release the stop").env.GITHUB_TOKEN, "${{ steps.release_token.outputs.token }}");
  assert.equal(steps.find((s) => s.name === "Release the stop").env.READ_TOKEN, "${{ steps.token.outputs.token }}", "the control repository is read with a token that can");
});
