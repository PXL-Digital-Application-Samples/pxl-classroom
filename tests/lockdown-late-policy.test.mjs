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
    // Repository ids GitHub no longer has: an org ruleset naming one is a 422,
    // and GET /repositories/<id> is a 404 (lib/submission-lock.mjs).
    goneIds = [],
    // ...and the same repositories by name: every /repos/TestOrg/<name> route 404s.
    goneNames = [],
    // Logins that are neither a collaborator nor invited any more.
    noAccess = [],
    // The installation's "repository access": "all", or "selected", where a
    // repository outside the selection answers 404 like a deleted one.
    installationSelection = "all",
    // When GitHub says the student repository was created.
    repoCreatedAt = "2026-09-01T08:00:00Z",
    // An org ruleset create WITHOUT a gone id (the retry after the 422)
    // answers this status instead of succeeding.
    orgRetryStatus = null,
    // A status other than 200 for the repository object itself, and for the
    // `?until=` commit listing.
    repoStatus = 200,
    untilStatus = 200,
    // What GET /commits/main answers: the branch head.
    headRow = { sha: HEAD_SHA },
    // Logins GitHub keeps admin whatever their grant (an organization owner),
    // and the organization's owners.
    failDemote = [],
    owners = [],
    // Organization rulesets already there when the run starts.
    seedOrgRulesets = [],
    // A status for ONE repository's object, by name.
    repoStatusFor = {},
  } = opts;
  const calls = [];
  const rulesetsByRepo = new Map();
  const orgRulesets = [...seedOrgRulesets];
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
      if (path === "/installation/repositories") return send(200, { total_count: 1, repository_selection: installationSelection, repositories: [] });
      if (goneNames.some((n) => path === `/repos/TestOrg/${n}` || path.startsWith(`/repos/TestOrg/${n}/`))) {
        return send(404, { message: "Not Found" });
      }
      if (path.startsWith("/apps/")) {
        return appIdStatus === 200 ? send(200, { id: APP_ID }) : send(appIdStatus, { message: "nope" });
      }

      // ORGANIZATION rulesets, which the default under `block` now creates.
      // Kept in the same recorded-call stub as the repository ones so a test can
      // say which of the two was written, rather than only that something was.
      const ors = path.match(/^\/orgs\/([^/]+)\/rulesets(?:\/(\d+))?$/);
      if (ors) {
        const [, , id] = ors;
        if (req.method === "GET" && !id) {
          return send(200, orgRulesets.map((r) => ({ id: r.id, name: r.name })));
        }
        if (denyRulesets) return send(403, { message: "Resource not accessible by integration" });
        if (req.method === "GET" && id) {
          const hit = orgRulesets.find((r) => String(r.id) === id);
          return hit ? send(200, hit) : send(404, {});
        }
        if (req.method === "POST") {
          const ids = body?.conditions?.repository_id?.repository_ids ?? [];
          if (ids.some((id) => goneIds.includes(id))) {
            return send(422, { message: "Invalid parameter repository_ids: repository selected does not exist or is not in this organization" });
          }
          if (orgRetryStatus) return send(orgRetryStatus, { message: "Server Error" });
          const created = { id: nextRulesetId++, source_type: "Organization", ...body };
          orgRulesets.push(created);
          return send(201, created);
        }
        if (req.method === "PUT") {
          const hit = orgRulesets.find((r) => String(r.id) === id);
          if (!hit) return send(404, {});
          Object.assign(hit, body);
          return send(200, hit);
        }
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

      const byId = path.match(/^\/repositories\/(\d+)$/);
      if (byId) {
        return goneIds.includes(Number(byId[1])) ? send(404, { message: "Not Found" }) : send(200, { id: Number(byId[1]), owner: { login: "TestOrg" } });
      }
      if (/^\/repos\/[^/]+\/[^/]+\/commits$/.test(path)) return untilStatus === 200 ? send(200, untilCommits) : send(untilStatus, { message: "Bad Gateway" });
      if (/\/commits\/main$/.test(path)) return send(200, headRow);
      if (/^\/repos\/[^/]+\/[^/]+$/.test(path)) {
        const one = repoStatusFor[path.split("/").pop()];
        if (one) return send(one, { message: "Bad Gateway" });
        if (repoStatus !== 200) return send(repoStatus, { message: "Bad Gateway" });
        return send(200, { id: 42, default_branch: "main", pushed_at: pushedAt, created_at: repoCreatedAt });
      }
      const presence = path.match(/^\/repos\/[^/]+\/[^/]+\/collaborators\/([^/]+)$/);
      if (presence && req.method === "GET") {
        if (noAccess.includes(presence[1])) return send(404, { message: "Not Found" });
        res.writeHead(204);
        return res.end();
      }
      if (/^\/repos\/[^/]+\/[^/]+\/invitations$/.test(path)) return send(200, []);
      if (path === "/orgs/TestOrg/members") return send(200, owners.map((login) => ({ login })));
      const asked = path.match(/\/collaborators\/([^/]+)\/permission$/);
      if (asked) return send(200, { permission: failDemote.includes(asked[1]) ? "admin" : "read" });
      if (/\/collaborators\/[^/]+$/.test(path) && req.method === "PUT") {
        res.writeHead(204);
        return res.end();
      }
      return send(404, { message: "not stubbed: " + path });
    });
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`, calls, rulesetsByRepo, orgRulesets);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

function makeControlDir({ latePolicy = null, lockDownEnabled = null, orgScopedLock = null, logins = ["alice"], record = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pxl-lockdown-policy-"));
  const id = "exam";
  mkdirSync(join(dir, "assignments"), { recursive: true });
  writeFileSync(
    join(dir, "assignments", `${id}.yml`),
    `state: published\ndeadline_at: "${DEADLINE}"\nsubmission_ref: refs/heads/main\n` +
      (latePolicy ? `late_policy: ${latePolicy}\n` : "") +
      (lockDownEnabled === null ? "" : `lock_down_enabled: ${lockDownEnabled}\n`) +
      // ABSENT MEANS ORGANIZATION SCOPE since 2026-09-09, so the repository-scoped
      // cases below opt out EXPLICITLY. They are not legacy: `false` is the way
      // back, and a repository ruleset is still the rung the organization one
      // degrades to when it cannot be created.
      (orgScopedLock === null ? "" : `org_scoped_lock: ${orgScopedLock}\n`),
  );
  mkdirSync(join(dir, "repositories", id), { recursive: true });
  for (const login of logins) {
    writeFileSync(
      join(dir, "repositories", id, `${login}.json`),
      JSON.stringify({ github_login: login, repo_name: `TestOrg/${id}-${login}`, repo_id: 42, ...record }),
    );
  }
  return dir;
}

function runLockdown(dir, apiBase, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [lockdownScript], {
      env: {
        ...process.env,
        ...extraEnv,
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
    const dir = makeControlDir({ latePolicy: "block", lockDownEnabled: false, orgScopedLock: false });
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
    const dir = makeControlDir({ latePolicy: "block", lockDownEnabled: false, orgScopedLock: false });
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
      const dir = makeControlDir({ latePolicy: "block", lockDownEnabled: false, orgScopedLock: false });
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
      const dir = makeControlDir({ latePolicy: "block", lockDownEnabled: false, orgScopedLock: false });
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
    const dir = makeControlDir({ latePolicy: "block", lockDownEnabled: false, orgScopedLock: false });
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
      const dir = makeControlDir({ latePolicy: "block", lockDownEnabled: false, orgScopedLock: false });
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

test("A7: the starting point by the deadline is a no-submission, not the starter archived as their work", async () => {
  // Review 2026-10-14: what a repository was given always predates the
  // deadline, so a student who pushed only after it reconstructed to the
  // starter and read On time.
  // The recorded start (a copy provisioning added to, or a full-history copy):
  await withStubApi(
    async (api) => {
      const dir = makeControlDir({ latePolicy: "block", lockDownEnabled: false, orgScopedLock: false, record: { starter_sha: ON_TIME_SHA, starter_commit_count: 2 } });
      const res = await runLockdown(dir, api);
      assert.equal(res.status, 0, res.stderr);
      const alice = rowFor(res.record, "alice");
      assert.equal(alice.snapshot_sha, null);
      assert.equal(alice.no_submission, true);
      assert.match(res.stdout, /held only what the repository was given - no submission/);
    },
  );
  // GitHub's generated first commit, where no start was recorded:
  await withStubApi(
    async (api) => {
      const dir = makeControlDir({ latePolicy: "block", lockDownEnabled: false, orgScopedLock: false });
      const res = await runLockdown(dir, api);
      assert.equal(rowFor(res.record, "alice").no_submission, true);
    },
    {
      untilCommits: [{
        sha: ON_TIME_SHA, parents: [], author: { login: "pxl-classroom-provisioner[bot]" },
        committer: { login: "web-flow" }, commit: { verification: { verified: true } },
      }],
    },
  );
});

test("LD4: after the sentinel's confirmed stop at the deadline, HEAD is the deadline state - nothing is rebuilt", async () => {
  // Review 2026-10-14: `pushed_at` moves for a push to any branch or tag, and
  // rebuilding from committer dates dropped an on-time commit whose clock ran
  // fast, although the lock proves it was in on time.
  await withStubApi(async (api, calls) => {
    const dir = makeControlDir({ latePolicy: "block", lockDownEnabled: false, orgScopedLock: false });
    mkdirSync(join(dir, "lockdowns", "exam"), { recursive: true });
    writeFileSync(
      join(dir, "lockdowns", "exam", "sentinel-x.json"),
      // Sampling alice's repository, as the watch whose stop covered it does (R6-25).
      JSON.stringify({ outcome: "fired", due: true, deadline_at: DEADLINE, stop: "done", samples: [{ observed_at: DEADLINE, pushed_at: { "exam-alice": DEADLINE } }] }),
    );
    const res = await runLockdown(dir, api);
    assert.equal(res.status, 0, res.stderr);
    const alice = rowFor(res.record, "alice");
    assert.equal(alice.snapshot_sha, HEAD_SHA, "the branch could not move after the stop");
    assert.equal(alice.reconstructed, undefined);
    assert.deepEqual(calls.filter((c) => c.line === "GET /repos/TestOrg/exam-alice/commits"), [], "no ?until=");
  });
  // A stop that FAILED proves nothing: rebuilt as before.
  await withStubApi(async (api) => {
    const dir = makeControlDir({ latePolicy: "block", lockDownEnabled: false, orgScopedLock: false });
    mkdirSync(join(dir, "lockdowns", "exam"), { recursive: true });
    writeFileSync(join(dir, "lockdowns", "exam", "sentinel-x.json"), JSON.stringify({ outcome: "fired", due: true, deadline_at: DEADLINE, stop: "failed" }));
    const res = await runLockdown(dir, api);
    assert.equal(rowFor(res.record, "alice").snapshot_sha, ON_TIME_SHA);
  });
});

test("P2-27: a repository made after the sentinel's stop is not its deadline state: rebuilt, and locked by this run, not at the stop", async () => {
  // Review 2026-10-14: a lecturer's Retry after the stop provisions a
  // repository nothing stopped, so its HEAD can hold pushes from after the
  // deadline; HEAD was read as the deadline state, and the row said it was
  // locked at the stop's instant.
  const after = new Date(new Date(DEADLINE).getTime() + 10 * 60_000).toISOString();
  await withStubApi(
    async (api, calls) => {
      const dir = makeControlDir({ latePolicy: "block", lockDownEnabled: false, orgScopedLock: false });
      mkdirSync(join(dir, "lockdowns", "exam"), { recursive: true });
      writeFileSync(join(dir, "lockdowns", "exam", "sentinel-x.json"), JSON.stringify({ outcome: "fired", due: true, deadline_at: DEADLINE, stop: "done" }));
      const res = await runLockdown(dir, api);
      assert.equal(res.status, 0, res.stderr);
      const alice = rowFor(res.record, "alice");
      assert.equal(alice.snapshot_sha, ON_TIME_SHA, "rebuilt as of the deadline");
      assert.equal(alice.reconstructed, true);
      assert.ok(calls.some((c) => c.line === "GET /repos/TestOrg/exam-alice/commits" && /until=/.test(c.query)), "with ?until=");
      assert.notEqual(alice.lockdown_at, DEADLINE, "not locked at the stop it did not exist for");
    },
    { repoCreatedAt: after },
  );
});

test("R6-30: a repository deleted after its lock keeps its frozen row where it was preserved, and only there", async () => {
  // The record is rewritten whole, so a later pass dropped the row of what was
  // frozen for a student who deleted their repository afterwards.
  const frozen = (login, sha) => ({
    github_login: login, repo_name: `TestOrg/exam-${login}`, repo_id: login === "bob" ? 77 : 78, snapshot_sha: sha,
    snapshot_ref: "refs/heads/main", lockdown_at: DEADLINE, lock_method: "org-ruleset", verified: true, permission_after: null,
  });
  await withStubApi(
    async (api) => {
      const dir = makeControlDir({ latePolicy: "block", lockDownEnabled: false, logins: ["alice"] });
      for (const [login, id] of [["bob", 77], ["cy", 78]]) {
        writeFileSync(join(dir, "repositories", "exam", `${login}.json`), JSON.stringify({ github_login: login, repo_name: `TestOrg/exam-${login}`, repo_id: id }));
      }
      mkdirSync(join(dir, "lockdowns", "exam"), { recursive: true });
      writeFileSync(join(dir, "lockdowns", "exam", "lockdown-record.json"), JSON.stringify({
        schema_version: 1, assignment_id: "exam", outcome: "locked", results: [frozen("bob", "b".repeat(40)), frozen("cy", "c".repeat(40))],
      }));
      // bob's submission is in the archive; cy's never got there.
      mkdirSync(join(dir, "observations", "exam", "bob"), { recursive: true });
      writeFileSync(join(dir, "observations", "exam", "bob", "preservation.json"), JSON.stringify({ verified: true }));
      const res = await runLockdown(dir, api);
      assert.equal(res.status, 0, res.stdout + res.stderr);
      assert.equal(rowFor(res.record, "bob")?.snapshot_sha, "b".repeat(40), "kept: it is history");
      assert.equal(rowFor(res.record, "cy"), undefined, "nothing can preserve it now");
      assert.equal(res.record.gone_count, 2);
    },
    { goneIds: [77, 78], goneNames: ["exam-bob", "exam-cy"] },
  );
});

test("LD5: a record naming a deleted repository does not fail the sentinel's stop", async () => {
  // Review 2026-10-14: the dead id was retried as a repository ruleset and a
  // demotion, both 404, counted as a missed stop - and the stop-only run's
  // failure marked the stop FAILED for every assignment at that instant.
  await withStubApi(
    async (api) => {
      const dir = makeControlDir({ latePolicy: "block", lockDownEnabled: false, logins: ["alice"] });
      writeFileSync(
        join(dir, "repositories", "exam", "bob.json"),
        JSON.stringify({ github_login: "bob", repo_name: "TestOrg/exam-bob", repo_id: 77 }),
      );
      const res = await runLockdown(dir, api, { STOP_ONLY: "1" });
      assert.equal(res.status, 0, res.stdout + res.stderr);
      assert.match(res.outputs, /error_count=0/);
      assert.match(res.outputs, /locked_count=1/, "alice is stopped");
      assert.match(res.stdout, /no longer exists - nothing to lock/);
    },
    { goneIds: [77], goneNames: ["exam-bob"] },
  );
});

test("P2-26: on the repository-ruleset and demotion paths a deleted repository is not a missed stop either - but one the App may not see stays one", async () => {
  // Review 2026-10-14: only the organization ruleset's own answer marked a
  // deleted repository, so on the other paths it failed both and failed the
  // sentinel's stop for every assignment at that instant.
  const setups = [
    ["repository ruleset", { latePolicy: "block", lockDownEnabled: false, orgScopedLock: false }, {}],
    ["report, then read-only", { latePolicy: "report", lockDownEnabled: true }, {}],
    ["rulesets refused, so a demotion", { latePolicy: "block", lockDownEnabled: false, orgScopedLock: false }, { denyRulesets: true }],
  ];
  for (const [label, control, stub] of setups) {
    for (const selection of ["all", "selected"]) {
      await withStubApi(
        async (api) => {
          const dir = makeControlDir({ ...control, logins: ["alice"] });
          writeFileSync(
            join(dir, "repositories", "exam", "bob.json"),
            JSON.stringify({ github_login: "bob", repo_name: "TestOrg/exam-bob", repo_id: 77 }),
          );
          const res = await runLockdown(dir, api, { STOP_ONLY: "1" });
          if (selection === "all") {
            assert.equal(res.status, 0, `${label}: ${res.stdout}${res.stderr}`);
            assert.match(res.outputs, /error_count=0/, label);
            assert.match(res.stdout, /no longer exists - nothing to lock/, label);
          } else {
            // Under "Only select repositories" a 404 is also a repository the
            // App was not given: excusing it would be silent. Still missed.
            assert.match(res.outputs, /error_count=1/, `${label}, selected: ${res.stdout}`);
          }
        },
        { goneIds: [77], goneNames: ["exam-bob"], installationSelection: selection, ...stub },
      );
    }
  }
});

test("TV-7: the finalize's record counts a repository deleted before the lock as gone, not an error - on every path, and only where the App sees every repository", async () => {
  // Live 2026-10-15 (drill-20261015-0150, --repo-lock --delete-one): the stop
  // called it gone and the record still said `error_count: 1`, so a finalize
  // that locked everybody else was `partial`.
  const setups = [
    ["organization ruleset", { latePolicy: "block", lockDownEnabled: false }, {}],
    ["repository ruleset, then read-only", { latePolicy: "block", lockDownEnabled: true, orgScopedLock: false }, {}],
    ["rulesets refused, so a demotion", { latePolicy: "block", lockDownEnabled: false, orgScopedLock: false }, { denyRulesets: true }],
  ];
  for (const [label, control, stub] of setups) {
    for (const selection of ["all", "selected"]) {
      await withStubApi(
        async (api) => {
          const dir = makeControlDir({ ...control, logins: ["alice"] });
          writeFileSync(
            join(dir, "repositories", "exam", "bob.json"),
            JSON.stringify({ github_login: "bob", repo_name: "TestOrg/exam-bob", repo_id: 77 }),
          );
          const res = await runLockdown(dir, api);
          assert.equal(res.status, 0, `${label}: ${res.stdout}${res.stderr}`);
          assert.ok(!res.record.results.some((r) => r.github_login === "bob"), `${label}: no row for a repository that is gone`);
          assert.equal(res.record.locked_count, 1, `${label}: alice is locked`);
          if (selection === "all") {
            assert.deepEqual([res.record.error_count, res.record.gone_count], [0, 1], label);
            assert.match(res.outputs, /outcome=locked/, label);
            assert.match(res.stdout, /1 gone, 0 err/, label);
          } else {
            // A 404 the App may simply not be given is still an error.
            assert.deepEqual([res.record.error_count, res.record.gone_count], [1, 0], `${label}, selected`);
            assert.match(res.outputs, /outcome=partial/, `${label}, selected`);
          }
        },
        { goneIds: [77], goneNames: ["exam-bob"], installationSelection: selection, ...stub },
      );
    }
  }
});

test("TL-2: the organization ruleset failing on its retry without a deleted repository still stops everyone else, and the deleted one is not a missed stop", async () => {
  // The create carrying the deleted id is refused 422, the retry without it
  // fails too: lockdown falls back to repository rulesets for the cohort, and
  // the repository the retry dropped is gone, not a stop that failed.
  await withStubApi(
    async (api, calls, rulesetsByRepo) => {
      const dir = makeControlDir({ latePolicy: "block", lockDownEnabled: false, logins: ["alice"] });
      writeFileSync(
        join(dir, "repositories", "exam", "bob.json"),
        JSON.stringify({ github_login: "bob", repo_name: "TestOrg/exam-bob", repo_id: 77 }),
      );
      const res = await runLockdown(dir, api, { STOP_ONLY: "1" });
      assert.equal(res.status, 0, res.stdout + res.stderr);
      assert.match(res.outputs, /error_count=0/);
      assert.match(res.outputs, /locked_count=1/, "alice is stopped");
      assert.equal(calls.filter((c) => c.line === "POST /orgs/TestOrg/rulesets").length, 2, "the create, then the retry without the deleted id");
      assert.equal((rulesetsByRepo.get("exam-alice") ?? []).length, 1, "alice's own repository ruleset is the fallback");
      // Said, by name, and the closing line says what happened rather than
      // "org-ruleset applied to 2".
      assert.match(res.stdout, /org-lock bob - repository no longer exists - nothing to lock/);
      assert.match(res.stdout, /phase 1 - stop - org-ruleset planned at \S+: 1 by ruleset, 1 gone/);
      assert.match(res.stdout, /1\/2 stopped, 1 no longer exists/);
    },
    { goneIds: [77], goneNames: ["exam-bob"], orgRetryStatus: 500 },
  );
});

test("TL-3: a repository or ?until read that fails leaves a locked row saying what was not read, never HEAD and never no row", async () => {
  for (const [label, stub, reason] of [
    ["the repository object", { repoStatus: 502 }, /repo HTTP 502/],
    ["the commits as of the deadline", { untilStatus: 502 }, /commits\?until HTTP 502/],
  ]) {
    await withStubApi(
      async (api) => {
        const dir = makeControlDir({ latePolicy: "block", lockDownEnabled: false, orgScopedLock: false });
        const res = await runLockdown(dir, api);
        const alice = rowFor(res.record, "alice");
        assert.ok(alice, `${label}: the student keeps a row`);
        assert.equal(alice.snapshot_sha, null, `${label}: not HEAD`);
        assert.match(alice.snapshot_unread ?? "", reason, label);
        assert.ok(alice.lockdown_at, `${label}: locked all the same`);
        // R6-24: and the row says so - Reopen read `verified: false` as "the
        // run did not lock it".
        assert.equal(alice.verified, true, `${label}: the stop held`);
      },
      stub,
    );
  }
});

test("TL-4: a team repository still at its start is no submission for every member, from whichever record holds the start, read off HEAD or rebuilt", async () => {
  // Two member records name one repository; only bob's carries the start the
  // App recorded (alice accepted before it was read). Both rows are read
  // against it: the start is one answer for one repository.
  const team = (dir, record = {}) => {
    for (const [login, extra] of [["alice", {}], ["bob", { starter_sha: ON_TIME_SHA, starter_commit_count: 1 }]]) {
      writeFileSync(
        join(dir, "repositories", "exam", `${login}.json`),
        JSON.stringify({ github_login: login, team_slug: "team-a", repo_name: "TestOrg/exam-team-a", repo_id: 42, ...extra, ...record }),
      );
    }
  };
  // Rebuilt: a push after the deadline, and by the deadline only the start.
  await withStubApi(
    async (api) => {
      const dir = makeControlDir({ latePolicy: "block", lockDownEnabled: false, orgScopedLock: false, logins: [] });
      team(dir);
      const res = await runLockdown(dir, api);
      assert.equal(res.status, 0, res.stderr);
      for (const login of ["alice", "bob"]) {
        const row = rowFor(res.record, login);
        assert.equal(row.snapshot_sha, null, `${login}: the start is not their work`);
        assert.equal(row.no_submission, true, login);
      }
    },
    { untilCommits: [{ sha: ON_TIME_SHA }] },
  );
  // Read off HEAD: nobody pushed after the deadline, and HEAD is the start.
  await withStubApi(
    async (api) => {
      const dir = makeControlDir({ latePolicy: "block", lockDownEnabled: false, orgScopedLock: false, logins: [] });
      team(dir);
      const res = await runLockdown(dir, api);
      assert.equal(res.status, 0, res.stderr);
      for (const login of ["alice", "bob"]) {
        assert.equal(rowFor(res.record, login).snapshot_sha, null, `${login}: HEAD at the start is no submission either`);
        assert.equal(rowFor(res.record, login).no_submission, true, login);
      }
      assert.match(res.stdout, /holds only what the repository was given - no submission/);
    },
    { pushedAt: PUSHED_EARLY, headRow: { sha: ON_TIME_SHA } },
  );
  // GitHub's own generated first commit, no start recorded: the same answer.
  const generated = { sha: ON_TIME_SHA, parents: [], committer: { login: "web-flow" }, author: { login: "pxl-classroom[bot]" }, commit: { verification: { verified: true } } };
  await withStubApi(
    async (api) => {
      const dir = makeControlDir({ latePolicy: "block", lockDownEnabled: false, orgScopedLock: false });
      const res = await runLockdown(dir, api);
      assert.equal(rowFor(res.record, "alice").no_submission, true);
    },
    { pushedAt: PUSHED_EARLY, headRow: generated },
  );
  // A head that is the student's own commit is still their submission.
  await withStubApi(
    async (api) => {
      const dir = makeControlDir({ latePolicy: "block", lockDownEnabled: false, orgScopedLock: false, logins: [] });
      team(dir);
      const res = await runLockdown(dir, api);
      assert.equal(rowFor(res.record, "alice").snapshot_sha, HEAD_SHA);
      assert.equal(rowFor(res.record, "alice").no_submission, undefined);
    },
    { pushedAt: PUSHED_EARLY },
  );
});

test("LD8: the demotion never re-invites a student whose access was removed", async () => {
  // Review 2026-10-14: a PUT on somebody with no access SENDS an invitation -
  // an email, and access a lecturer took away (or a team switch removed) back.
  await withStubApi(
    async (api, calls) => {
      const dir = makeControlDir({ latePolicy: "report", lockDownEnabled: true, logins: ["alice", "bob"] });
      const res = await runLockdown(dir, api);
      assert.equal(res.status, 0, res.stderr);
      const puts = demotions(calls).map((c) => c.line);
      assert.ok(puts.some((l) => l.endsWith("/collaborators/alice")), "alice still has access and is demoted");
      assert.ok(!puts.some((l) => l.endsWith("/collaborators/bob")), "bob is not re-invited");
      assert.match(res.stdout, /no longer has access - nothing to take away, not re-invited/);
    },
    { noAccess: ["bob"] },
  );
});

test("a repository whose last push was before the deadline costs no extra call", async () => {
  await withStubApi(
    async (api, calls) => {
      const dir = makeControlDir({ latePolicy: "block", lockDownEnabled: false, orgScopedLock: false });
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
    const dir = makeControlDir({ latePolicy: "block", lockDownEnabled: false, orgScopedLock: false });
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

test("TL-1: the sentinel's stop proves nothing for a student whose extension ran past it, and a stop not yet confirmed proves nothing at all", async () => {
  // The stop at the assignment deadline covered students due then. Alice's
  // extension ran on after it, so her HEAD is not her deadline state: rebuilt
  // at her own deadline, never read off HEAD because some stop happened.
  const granted = new Date(Date.now() - 2 * 3600_000).toISOString();
  const extension = (dir) => {
    mkdirSync(join(dir, "overrides", "exam"), { recursive: true });
    writeFileSync(
      join(dir, "overrides", "exam", "alice.json"),
      JSON.stringify({
        schema_version: 1, assignment_id: "exam", github_login: "alice",
        overrides: [{ type: "deadline_extension", value: granted, reason: "medical", overridden_by: "admin-panel", overridden_at: new Date().toISOString() }],
      }),
    );
  };
  const timeline = (dir, stop) => {
    mkdirSync(join(dir, "lockdowns", "exam"), { recursive: true });
    writeFileSync(join(dir, "lockdowns", "exam", "sentinel-x.json"), JSON.stringify({ outcome: "fired", due: true, deadline_at: DEADLINE, stop }));
  };
  await withStubApi(async (api, calls) => {
    const dir = makeControlDir({ latePolicy: "block", lockDownEnabled: false, orgScopedLock: false });
    extension(dir);
    timeline(dir, "done");
    const res = await runLockdown(dir, api);
    assert.equal(res.status, 0, res.stderr);
    const q = calls.find((c) => c.line === "GET /repos/TestOrg/exam-alice/commits");
    assert.ok(q, "rebuilt, not read off HEAD");
    assert.match(decodeURIComponent(q.query), new RegExp(`until=${granted}`), "at her own deadline");
    const alice = rowFor(res.record, "alice");
    assert.equal(alice.snapshot_sha, ON_TIME_SHA);
    assert.equal(alice.reconstructed, true);
  });
  // A stop still `pending` (the sentinel has not said it held) credits nothing:
  // a student due at the deadline is rebuilt as if no sentinel ran.
  await withStubApi(async (api, calls) => {
    const dir = makeControlDir({ latePolicy: "block", lockDownEnabled: false, orgScopedLock: false });
    timeline(dir, "pending");
    const res = await runLockdown(dir, api);
    assert.equal(res.status, 0, res.stderr);
    assert.ok(calls.some((c) => c.line === "GET /repos/TestOrg/exam-alice/commits" && /until=/.test(c.query)), "rebuilt");
    assert.equal(rowFor(res.record, "alice").snapshot_sha, ON_TIME_SHA);
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
    const dir = makeControlDir({ latePolicy: "block", lockDownEnabled: true, orgScopedLock: false });
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

// --- the default under `block`, since 2026-09-09 -----------------------------
//
// ABSENT MEANS ORGANIZATION SCOPE. The repository-scoped cases above now say
// `org_scoped_lock: false` out loud, which is what a lecturer opting out writes
// and what the degradation rung still produces.

test("AN ASSIGNMENT THAT SAYS NOTHING GETS ORGANIZATION SCOPE", async () => {
  // The reinterpretation, observed rather than asserted about the source: no
  // `org_scoped_lock` in the document at all, and one ORG ruleset comes out.
  await withStubApi(async (api, calls, byRepo, orgRulesets) => {
    const dir = makeControlDir({ latePolicy: "block", lockDownEnabled: false });
    const res = await runLockdown(dir, api);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.record.lock_method, "org-ruleset");
    assert.equal(rowFor(res.record, "alice").lock_method, "org-ruleset");
    assert.equal(orgRulesets.length, 1, "one ruleset for the whole cohort");
    assert.deepEqual(orgRulesets[0].conditions.repository_id.repository_ids, [42]);
    assert.equal(orgRulesets[0].enforcement, "active");
    // And NOT one per repository - that is the whole difference.
    assert.deepEqual(
      calls.filter((c) => /^POST \/repos\/.*\/rulesets$/.test(c.line)).map((c) => c.line),
      [],
    );
    assert.deepEqual(demotions(calls).map((c) => c.line), [], "they keep Actions and secrets");
  });
});

test("THE DEFAULT ORGANIZATION SCOPE + lock_down_enabled true takes admin as well", async () => {
  // The case above opts out with `org_scoped_lock: false`, and it was given that
  // opt-out when organization scope became the default - which kept it green
  // while the default path stopped demoting altogether. Phase 4 compared the
  // run's method with "ruleset", so `block` + "the repository becomes
  // read-only" left every student admin. This is that combination with the
  // field absent, as a lecturer's document carries it.
  await withStubApi(async (api, calls, byRepo, orgRulesets) => {
    const dir = makeControlDir({ latePolicy: "block", lockDownEnabled: true });
    const res = await runLockdown(dir, api);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.record.lock_method, "org-ruleset");
    assert.equal(orgRulesets.length, 1);
    const alice = rowFor(res.record, "alice");
    assert.equal(alice.lock_method, "org-ruleset", "the ruleset is still what the reopen releases");
    assert.equal(alice.demoted, true, "and the demotion is recorded beside it, so the reopen restores that too");
    assert.deepEqual(demotions(calls).map((c) => c.line), ["PUT /repos/TestOrg/exam-alice/collaborators/alice"]);

    const lines = calls.map((c) => c.line);
    const ruleset = lines.findIndex((l) => /^POST \/orgs\/[^/]+\/rulesets$/.test(l));
    const snapshot = lines.findIndex((l) => l.includes("/commits"));
    const demotion = lines.findIndex((l) => /^PUT .*\/collaborators\//.test(l));
    assert.ok(ruleset >= 0 && ruleset < snapshot, "stop first");
    assert.ok(snapshot < demotion, "the snapshot is taken while the student still has their access");
  });
});

test("a repository that degraded to a demotion is demoted once, not recorded twice", async () => {
  // Per repository: phase 1 already took everything, so phase 4 has nothing
  // left to take, and `demoted: true` beside `lock_method: demotion` would read
  // as a second thing that happened.
  await withStubApi(
    async (api, calls) => {
      const dir = makeControlDir({ latePolicy: "block", lockDownEnabled: true });
      const res = await runLockdown(dir, api);
      assert.equal(res.status, 0, res.stderr);
      const alice = rowFor(res.record, "alice");
      assert.equal(alice.lock_method, "demotion");
      assert.equal(alice.demoted, undefined);
      assert.equal(demotions(calls).length, 1);
    },
    { denyRulesets: true },
  );
});

test("THE RUN LOG SAYS WHICH MECHANISM APPLIED, and that it was the default", async () => {
  // A default that reinterprets documents nobody edited has to be legible
  // afterwards. `lock_method: org-ruleset` alone cannot tell a lecturer's own
  // choice from ours.
  await withStubApi(async (api) => {
    const dir = makeControlDir({ latePolicy: "block", lockDownEnabled: false });
    const res = await runLockdown(dir, api);
    assert.match(res.stdout, /lock scope/);
    assert.match(res.stdout, /default under/);
  });
});

test("an explicit opt-out says so in the log, and creates NO org ruleset", async () => {
  await withStubApi(async (api, calls, byRepo, orgRulesets) => {
    const dir = makeControlDir({ latePolicy: "block", lockDownEnabled: false, orgScopedLock: false });
    const res = await runLockdown(dir, api);
    assert.match(res.stdout, /opts out/);
    assert.equal(orgRulesets.length, 0);
    assert.equal(res.record.lock_method, "ruleset");
  });
});

test("under `report` nothing is locked, whatever the default would have said", async () => {
  await withStubApi(async (api, calls, byRepo, orgRulesets) => {
    const dir = makeControlDir({ latePolicy: "report", lockDownEnabled: false });
    const res = await runLockdown(dir, api);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(orgRulesets.length, 0, "an org ruleset over a cohort that blocks nothing");
    assert.deepEqual(rulesetWrites(calls).map((c) => c.line), []);
  });
});

test("R6-27 / R6-3: a pass never takes out of the organization lock an id it holds and the plan lacks - a Lock again's", async () => {
  // Lock again put repository 99 back while its reopen record lingered (its
  // record commit failed): the next pass planned without it and replaced the
  // list, undoing the lock with nothing but a toast to say so.
  const { orgSubmissionLockName } = await import("../lib/submission-lock.mjs");
  const seeded = {
    id: 900, name: orgSubmissionLockName("exam"), enforcement: "active", source_type: "Organization",
    conditions: { repository_id: { repository_ids: [99] }, ref_name: { include: ["refs/heads/main"], exclude: [] } },
  };
  await withStubApi(
    async (api, _calls, _repoRulesets, orgRulesets) => {
      const dir = makeControlDir({ latePolicy: "block", lockDownEnabled: false });
      const res = await runLockdown(dir, api);
      assert.equal(res.status, 0, res.stderr);
      const ids = orgRulesets.find((r) => r.id === 900)?.conditions?.repository_id?.repository_ids ?? [];
      assert.deepEqual([...ids].sort((a, b) => a - b), [42, 99], "alice added, 99 kept");
    },
    { seedOrgRulesets: [seeded] },
  );
});

test("R6-29: under Nothing is locked, one unreadable repository is a partial pass, not a failed finalize", async () => {
  // Nobody is ever locked there, so one failed read with 0 locked read as
  // every student failing: `fail:all-errors`, and the deadline went red.
  await withStubApi(
    async (api) => {
      const dir = makeControlDir({ latePolicy: "report", lockDownEnabled: false, logins: ["alice", "bob"] });
      const res = await runLockdown(dir, api);
      assert.equal(res.status, 0, res.stdout + res.stderr);
      assert.match(res.outputs, /^outcome=partial$/m);
    },
    { repoStatusFor: { "exam-bob": 502 } },
  );
});

test("a demotion GitHub does not apply to an organization owner says so, and the ruleset still holds them", async () => {
  // Seen on a real deadline (2026-10-15): one of 63 still admin after the
  // demotion, "permission after=admin" and nothing more.
  await withStubApi(
    async (api, _calls, _repoRulesets, orgRulesets) => {
      const dir = makeControlDir({ latePolicy: "block", lockDownEnabled: true, logins: ["alice", "bob"] });
      const res = await runLockdown(dir, api);
      assert.equal(res.status, 0, res.stderr);
      assert.match(res.stdout, /demote bob - permission after=admin - bob owns the organization, so GitHub keeps them admin/);
      assert.equal(orgRulesets.length, 1, "stopped by the organization ruleset all the same");
    },
    { failDemote: ["bob"], owners: ["bob"] },
  );
});
