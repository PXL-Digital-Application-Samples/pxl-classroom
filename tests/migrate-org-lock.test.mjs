// The migration from per-repository rulesets to one organization ruleset.
//
// The order is the safety property: create and VERIFY the organization ruleset
// before disabling any repository one. Deleting first leaves a window with no
// lock on a cohort whose deadline has passed - the same rule publish-assignment
// follows with the broker secret, where the new workflow is pushed BEFORE the
// old credential is removed.
//
// Driven as a subprocess against a real control-repo directory, because the
// script's job is reading those files and the ordering is what is under test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { parse as parseYaml } from "yaml";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateAgainst } from "../lib/validate.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(root, "scripts", "migrate-org-lock.mjs");

function controlDir(record, assignment = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pxl-migrate-"));
  mkdirSync(join(dir, "lockdowns", "lab-1"), { recursive: true });
  mkdirSync(join(dir, "assignments"), { recursive: true });
  writeFileSync(join(dir, "lockdowns", "lab-1", "lockdown-record.json"), JSON.stringify(record, null, 2));
  writeFileSync(join(dir, "assignments", "lab-1.yml"), [
    "schema_version: 1",
    "id: lab-1",
    "title: Lab 1",
    "organization: TestOrg",
    "template:",
    "  owner: TestOrg",
    "  repository: tpl",
    "repository_name_pattern: lab-1-{github_login}",
    "opens_at: 2026-08-01T08:00:00.000Z",
    "deadline_at: 2026-09-01T22:00:00.000Z",
    "state: closed",
    ...Object.entries(assignment).map(([k, v]) => `${k}: ${v}`),
    "",
  ].join("\n"));
  return dir;
}

const run = (dir, env = {}) =>
  spawnSync("node", [SCRIPT], {
    encoding: "utf8",
    env: {
      ...process.env,
      ORG: "TestOrg",
      DATA_DIR: dir,
      GITHUB_TOKEN: "x",
      // A base that resolves to nothing, so a run that gets as far as an API
      // call fails loudly instead of touching anything real.
      GITHUB_API_URL: "http://127.0.0.1:9",
      ...env,
    },
  });

const record = (rows) => ({
  schema_version: 1,
  assignment_id: "lab-1",
  executed_at: "2026-09-01T22:05:00.000Z",
  lock_method: "ruleset",
  results: rows,
});

test("DRY RUN IS SACRED - it reports and touches nothing", () => {
  // Not "makes no lasting change": no writes at all, on GitHub or on disk. The
  // API base points at a closed port, so a dry run that reached GitHub would
  // fail rather than pass - and the script writes the control repo now, so the
  // two files it can write are compared byte for byte.
  const dir = controlDir(record([
    { github_login: "ada", repo_name: "TestOrg/lab-1-ada", repo_id: 11, lock_method: "ruleset", verified: true },
    { github_login: "bo", repo_name: "TestOrg/lab-1-bo", repo_id: 22, lock_method: "ruleset", verified: true },
  ]));
  const before = [
    readFileSync(join(dir, "lockdowns", "lab-1", "lockdown-record.json"), "utf8"),
    readFileSync(join(dir, "assignments", "lab-1.yml"), "utf8"),
  ];
  try {
    const res = run(dir, { DRY_RUN: "1" });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /DRY RUN/);
    assert.match(res.stdout, /would cover 2 repositories/);
    assert.match(res.stdout, /set org_scoped_lock and rewrite 2 row\(s\)/);
    assert.match(res.stdout, /disable 2 repository ruleset\(s\)/);
    assert.deepEqual([
      readFileSync(join(dir, "lockdowns", "lab-1", "lockdown-record.json"), "utf8"),
      readFileSync(join(dir, "assignments", "lab-1.yml"), "utf8"),
    ], before, "a dry run writes no files either");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("it reads the submission ref off the assignment, not a default", () => {
  const dir = controlDir(
    record([{ github_login: "ada", repo_name: "TestOrg/lab-1-ada", repo_id: 11, lock_method: "ruleset", verified: true }]),
    { submission_ref: "refs/heads/hand-in" },
  );
  try {
    assert.match(run(dir, { DRY_RUN: "1" }).stdout, /on refs\/heads\/hand-in/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a demoted cohort is left alone - the inverse is different", () => {
  // Moving a demotion to a ruleset would silently change what the student lost:
  // demotion takes Actions, secrets and runners, a ruleset takes none of them.
  const dir = controlDir(record([
    { github_login: "ada", repo_name: "TestOrg/lab-1-ada", repo_id: 11, lock_method: "demotion", verified: true },
  ]));
  try {
    const res = run(dir, { DRY_RUN: "1" });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /no repository-ruleset rows to migrate/);
    assert.match(res.stdout, /methods: demotion/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an already-migrated cohort is not migrated twice", () => {
  const dir = controlDir(record([
    { github_login: "ada", repo_name: "TestOrg/lab-1-ada", repo_id: 11, lock_method: "org-ruleset", verified: true },
  ]));
  try {
    assert.match(run(dir, { DRY_RUN: "1" }).stdout, /no repository-ruleset rows/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a team's five rows over one repository are ONE id", () => {
  // The lockdown record writes a row per LOGIN, and a group repository is one
  // object with one lock on it. Counting rows would target the same repository
  // five times and report a cohort five times its size.
  const rows = ["ada", "bo", "cy", "di", "eve"].map((l) => ({
    github_login: l, repo_name: "TestOrg/lab-1-alpha", repo_id: 77, team_slug: "alpha",
    lock_method: "ruleset", verified: true,
  }));
  const dir = controlDir(record(rows));
  try {
    const out = run(dir, { DRY_RUN: "1" }).stdout;
    assert.match(out, /would cover 1 repository\b/);
    assert.match(out, /disable 1 repository ruleset/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a row with no repo_id is not migrated - an org ruleset targets ids", () => {
  const dir = controlDir(record([
    { github_login: "ada", repo_name: "TestOrg/lab-1-ada", lock_method: "ruleset", verified: true },
  ]));
  try {
    assert.match(run(dir, { DRY_RUN: "1" }).stdout, /no repository-ruleset rows to migrate/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an organization with no lockdown records says so and stops", () => {
  const dir = mkdtempSync(join(tmpdir(), "pxl-migrate-empty-"));
  try {
    const res = run(dir, { DRY_RUN: "1" });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /nothing to migrate/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the workflow runs the script, and dry-run is its default", () => {
  // A script nothing calls looks exactly like a working migration, and a
  // destructive default is how somebody migrates twelve organizations by
  // pressing a button to see what it does.
  const wf = readFileSync(join(root, ".github/workflows/migrate-org-lock.yml"), "utf8");
  assert.match(wf, /node scripts\/migrate-org-lock\.mjs/);
  const dryRun = wf.slice(wf.indexOf("dry_run:"));
  assert.match(dryRun.slice(0, 200), /default: true/);
  // It changes what stops a graded cohort being written to, so it must not run
  // beside a finalize doing the same thing.
  assert.match(wf, /group: lockdown-\$\{\{ matrix\.org \}\}/);
  assert.match(wf, /max-parallel: 1/);
});

// ---------------------------------------------------------------------------
// A FULL RUN, over a fake API that behaves as the live one was measured to.
//
// The write-back is the half that cannot be seen from a dry run, and it is what
// stops the migration from leaving Reopen reporting success over a student the
// organization ruleset still holds. Driven end to end rather than asserted off
// the source, because "the file says org-ruleset afterwards" is the claim.
// ---------------------------------------------------------------------------

function fakeApi({ repoRulesets = { "lab-1-ada": [{ id: 7, name: "pxl-classroom-deadline", enforcement: "active" }] } } = {}) {
  const state = { org: null, repoRulesets, calls: [] };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
      const url = req.url;
      state.calls.push(`${req.method} ${url}`);
      const send = (code, data) => {
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      };

      if (req.method === "GET" && url === "/orgs/TestOrg/rulesets") {
        return send(200, state.org ? [{ id: state.org.id, name: state.org.name }] : []);
      }
      if (req.method === "POST" && url === "/orgs/TestOrg/rulesets") {
        state.org = { id: 900, ...body };
        return send(201, state.org);
      }
      if (req.method === "GET" && url === "/orgs/TestOrg/rulesets/900") {
        return send(200, state.org);
      }
      const repoList = url.match(/^\/repos\/TestOrg\/([^/]+)\/rulesets$/);
      if (req.method === "GET" && repoList) {
        return send(200, state.repoRulesets[repoList[1]] ?? []);
      }
      const repoPut = url.match(/^\/repos\/TestOrg\/([^/]+)\/rulesets\/(\d+)$/);
      if (req.method === "PUT" && repoPut) {
        const hit = (state.repoRulesets[repoPut[1]] ?? []).find((r) => r.id === Number(repoPut[2]));
        if (!hit) return send(404, {});
        hit.enforcement = body.enforcement;
        return send(200, hit);
      }
      // 400, NOT a 5xx. lib/gh.mjs retries anything >= 500 six times with the
      // secondary-rate-limit backoff, so a catch-all 599 turns "the test hit a
      // path the fake does not implement" into a suite that hangs for minutes
      // and never says why.
      return send(400, { message: `unexpected ${req.method} ${url}` });
    });
  });
  return { server, state };
}

// NOT spawnSync. spawnSync blocks this process's event loop for as long as the
// child runs, so the server above can never answer it: the child waits on an
// HTTP response that cannot be produced until the child exits. Deadlock, and it
// presents as the whole test FILE timing out with no output rather than as one
// failing test - the timers stop firing too. The dry-run tests above stay on
// spawnSync because they never reach the API at all.
const runAsync = (dir, env = {}) =>
  new Promise((resolve) => {
    const child = spawn("node", [SCRIPT], {
      env: {
        ...process.env,
        ORG: "TestOrg",
        DATA_DIR: dir,
        GITHUB_TOKEN: "x",
        ...env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });

async function withFakeApi(dir, opts, fn) {
  const { server, state } = typeof opts === "function" ? opts() : fakeApi(opts);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    const res = await runAsync(dir, {
      DRY_RUN: "0",
      PXL_APP_ID: "4242",
      GITHUB_API_URL: `http://127.0.0.1:${port}`,
    });
    return fn ? fn(res, state) : { res, state };
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

const runLive = (dir, opts) => withFakeApi(dir, opts);

test("A REAL RUN REWRITES THE ROWS, or Reopen goes green over a locked student", async () => {
  // The row's lock_method is what lib/repo-unlock.mjs reads to pick the
  // inverse. Left saying `ruleset`, reopening flips a repository ruleset that
  // is no longer the lock and reports success while the organization one still
  // holds the repository.
  const dir = controlDir(record([
    { github_login: "ada", repo_name: "TestOrg/lab-1-ada", repo_id: 11, lock_method: "ruleset", verified: true },
  ]));
  try {
    const { res } = await runLive(dir);
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.doesNotMatch(res.stdout, /\[FAIL\]/, res.stdout);

    const after = JSON.parse(readFileSync(join(dir, "lockdowns", "lab-1", "lockdown-record.json"), "utf8"));
    assert.equal(after.results[0].lock_method, "org-ruleset");
    assert.equal(after.lock_method, "org-ruleset");
    assert.equal(after.org_ruleset_id, 900);
    // MERGE, NEVER REPLACE. Everything the record already carried survives.
    assert.equal(after.assignment_id, "lab-1");
    assert.equal(after.executed_at, "2026-09-01T22:05:00.000Z");
    assert.equal(after.results[0].verified, true);
    assert.equal(after.results[0].repo_name, "TestOrg/lab-1-ada");

    // And it is still a valid lockdown record. This script is a second writer
    // of a document lockdown.mjs owns, which is exactly the situation a schema
    // exists for - the migration must not be the one writer nothing checks.
    const v = validateAgainst("lockdown-record", after);
    assert.equal(v.valid, true, JSON.stringify(v.errors));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a real run sets org_scoped_lock, or the next finalize undoes the migration", async () => {
  // A finalize run is not once - the nightly re-queues an assignment while
  // preservation is incomplete and when any student's deferred extension
  // expires. Without this field lockdown.mjs takes the repository-scoped path
  // again and locks the cohort per repository on somebody else's extension.
  const dir = controlDir(record([
    { github_login: "ada", repo_name: "TestOrg/lab-1-ada", repo_id: 11, lock_method: "ruleset", verified: true },
  ]));
  try {
    const { res } = await runLive(dir);
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const yml = parseYaml(readFileSync(join(dir, "assignments", "lab-1.yml"), "utf8"));
    assert.equal(yml.org_scoped_lock, true);
    // and the rest of the document is still there
    assert.equal(yml.id, "lab-1");
    assert.equal(yml.repository_name_pattern, "lab-1-{github_login}");
    assert.deepEqual(yml.template, { owner: "TestOrg", repository: "tpl" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("THE WRITE-BACK LANDS BEFORE ANY REPOSITORY RULESET IS DISABLED", async () => {
  // Ordering, observed rather than asserted off the source. If the disable
  // happened first, a run that died in between would leave rows saying
  // `ruleset` over an organization-held repository - the unrecoverable
  // direction. The other way round, lib/repo-unlock.mjs releases both.
  const dir = controlDir(record([
    { github_login: "ada", repo_name: "TestOrg/lab-1-ada", repo_id: 11, lock_method: "ruleset", verified: true },
  ]));
  try {
    // The release step KILLS the run - the socket is destroyed, fetch rejects,
    // and nothing in lib/gh.mjs catches it, so the script dies there. Anything
    // still on disk afterwards was written before it. A write-back placed after
    // the release loop would leave the record untouched and fail this.
    const { res: out, state } = await runLive(dir, () => {
      const made = fakeApi();
      const orig = made.server.listeners("request")[0];
      made.server.removeAllListeners("request");
      made.server.on("request", (req, res) => {
        if (req.url.startsWith("/repos/TestOrg/")) {
          made.state.calls.push(`KILLED ${req.method} ${req.url}`);
          return res.socket.destroy();
        }
        return orig(req, res);
      });
      return made;
    });
    assert.notEqual(out.status, 0, "the run must actually have died at the release");
    assert.ok(state.calls.some((c) => c.startsWith("KILLED")), "and it died at the release, not earlier");
    const after = JSON.parse(readFileSync(join(dir, "lockdowns", "lab-1", "lockdown-record.json"), "utf8"));
    assert.equal(after.results[0].lock_method, "org-ruleset",
      "the record was written before the release was attempted");
    assert.equal(
      parseYaml(readFileSync(join(dir, "assignments", "lab-1.yml"), "utf8")).org_scoped_lock, true,
      "and so was the assignment");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a repository that no longer exists keeps its row - nothing covers it", async () => {
  // ensureOrgSubmissionLock drops an id GitHub refuses. Writing `org-ruleset`
  // over that row would claim a lock that is not there, on the one repository
  // where nobody can ever check.
  const dir = controlDir(record([
    { github_login: "ada", repo_name: "TestOrg/lab-1-ada", repo_id: 11, lock_method: "ruleset", verified: true },
    { github_login: "bo", repo_name: "TestOrg/lab-1-bo", repo_id: 22, lock_method: "ruleset", verified: true },
  ]));
  try {
    // 422 on the create carrying the dead id, then a live-id walk that finds
    // only ada's - the measured shape of a student having deleted their repo.
    const { res: out } = await runLive(dir, () => {
      const made = fakeApi();
      const orig = made.server.listeners("request")[0];
      made.server.removeAllListeners("request");
      let refused = false;
      made.server.on("request", (req, res) => {
        if (req.method === "POST" && req.url === "/orgs/TestOrg/rulesets" && !refused) {
          refused = true;
          res.writeHead(422, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ message: "Invalid parameter repository_ids" }));
        }
        if (req.method === "GET" && req.url === "/repositories/11") {
          res.writeHead(200, { "Content-Type": "application/json" });
          // The owner matters: liveRepositoryIds judges on it, because a
          // repository transferred out of the org exists and still cannot be
          // covered by the org's ruleset.
          return res.end(JSON.stringify({ id: 11, name: "lab-1-ada", owner: { login: "TestOrg" } }));
        }
        if (req.method === "GET" && req.url === "/repositories/22") {
          res.writeHead(404, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({}));
        }
        return orig(req, res);
      });
      return made;
    });
    assert.equal(out.status, 0, out.stderr || out.stdout);
    const after = JSON.parse(readFileSync(join(dir, "lockdowns", "lab-1", "lockdown-record.json"), "utf8"));
    const byLogin = Object.fromEntries(after.results.map((r) => [r.github_login, r.lock_method]));
    assert.equal(byLogin.ada, "org-ruleset");
    assert.equal(byLogin.bo, "ruleset", "bo's repository is gone, so nothing covers it");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the workflow commits what the script wrote, and does it on always()", () => {
  // The script writes the control repo but does not commit it. A run that dies
  // during the releases has already recorded which lock is the real one, and
  // that is exactly the run whose write must not be thrown away.
  const wf = readFileSync(join(root, ".github/workflows/migrate-org-lock.yml"), "utf8");
  const commit = wf.slice(wf.indexOf("Commit + push to control repo"));
  assert.ok(commit, "the migration must commit what it wrote");
  assert.match(commit, /if: always\(\)/);
  // git add <dir>/ exits 128 when the directory is absent and stages NOTHING,
  // including the pathspecs that did match.
  assert.match(commit, /mkdir -p control\/assignments control\/lockdowns/);
  assert.match(commit, /git -C control add assignments\/ lockdowns\//);
  assert.ok(commit.indexOf("mkdir -p") < commit.indexOf("git -C control add"));
});

test("the script creates BEFORE it disables, and verifies in between", () => {
  // The ordering cannot be observed from outside without a live API, so it is
  // asserted where it is written - and anchored on the calls themselves, so a
  // reordering fails rather than a comment being edited.
  const src = readFileSync(SCRIPT, "utf8");
  const create = src.indexOf("ensureOrgSubmissionLock(");
  const verify = src.indexOf("findOrgSubmissionLock(");
  const release = src.indexOf("releaseSubmissionLock(gh");
  assert.ok(create > -1 && verify > -1 && release > -1, "the three steps must all be present");
  assert.ok(create < verify, "it must create before it verifies");
  assert.ok(verify < release, "it must verify before it disables anything");
  // And the repository rulesets are disabled, never deleted: one re-created
  // later without the App in bypass_actors locks this system out too.
  assert.ok(!/DELETE.*\/rulesets\//.test(src), "repository rulesets are disabled, not deleted");
});
