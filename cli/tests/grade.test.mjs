import { test } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { registerGradeCommand } from "../src/commands/grade.mjs";
// The parser moved to lib/check-run-score.mjs and is covered by
// tests/check-run-score.test.mjs. What belongs HERE is the wiring: that the
// command fetches annotations and hands them over.

// THE RUNNER'S OWN REPORTS TRAVEL ON STDOUT, as binary frames: node:test runs
// each file in a child and reads its results from there. A capture that
// swallowed every write swallowed three of this file's four results with it,
// so a failure showed no name and no diff (review 2026-10-14, P2-11). Text is
// the command's output; anything else goes through.
function capturing(onText, original) {
  return function (chunk, ...rest) {
    if (typeof chunk === "string") { onText(chunk); return true; }
    return original.call(this, chunk, ...rest);
  };
}

function runGitSync(args, cwd) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (res.status !== 0) throw new Error(res.stderr);
  return res.stdout.trim();
}

test("grade command: SHA-mismatch guard, validation, and dry-run", async () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'linux' });
  
  const tmp = mkdtempSync(join(tmpdir(), "pxl-grade-test-"));
  const homeDir = join(tmp, "home");
  mkdirSync(homeDir);
  
  const mockArchive = join(tmp, "mock-archive");
  mkdirSync(mockArchive);
  runGitSync(["init"], mockArchive);
  runGitSync(["config", "user.email", "test@example.com"], mockArchive);
  runGitSync(["config", "user.name", "Test"], mockArchive);
  
  writeFileSync(join(mockArchive, "test.js"), "console.log('pass')");
  runGitSync(["add", "test.js"], mockArchive);
  runGitSync(["commit", "-m", "init"], mockArchive);
  
  runGitSync(["branch", "preserved/a1/student1"], mockArchive);
  const sha1 = runGitSync(["rev-parse", "preserved/a1/student1"], mockArchive);
  
  runGitSync(["branch", "preserved/a1/student2"], mockArchive);
  const _sha2 = runGitSync(["rev-parse", "preserved/a1/student2"], mockArchive);

  // The PLAIN URL is what the CLI asks git for now: the token travels in the
  // fetch's environment only (lib/git-auth.mjs), never in the remote, so it is
  // in no workdir's .git/config for the sandboxed student code to read.
  writeFileSync(join(homeDir, ".gitconfig"), `
[url "file://${mockArchive.replace(/\\/g, '/')}"]
    insteadOf = https://github.com/TestOrg/pxl-classroom-archive.git
`);

  mkdirSync(join(homeDir, "pxl-classroom"), { recursive: true });
  writeFileSync(join(homeDir, "pxl-classroom", "token"), JSON.stringify({ access_token: "fake" }));

  const assignmentYaml = `
id: a1
autograde:
  enabled: true
  tests:
    - id: test1
      points: 10
      timeout_s: 5
      command: "node test.js"
`;

  const reportJson = {
    students: [
      { github_login: "student1", preservation_status: "preserved", preserved_sha: sha1 },
      { github_login: "student2", preservation_status: "preserved", preserved_sha: "badsha" }
    ]
  };

  const originalFetch = globalThis.fetch;
  let commitCount = 0;
  
  globalThis.fetch = async (url, options) => {
    const u = url.toString();
    if (u === "https://api.github.com/user") {
      return new Response(JSON.stringify({ login: "teacher1" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (u === "https://api.github.com/repos/TestOrg/pxl-classroom-control/contents/assignments%2Fa1.yml") {
      return new Response(JSON.stringify({ content: Buffer.from(assignmentYaml).toString("base64") }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (u === "https://api.github.com/repos/TestOrg/pxl-classroom-control/contents/reports%2Fa1.json") {
      return new Response(JSON.stringify({ content: Buffer.from(JSON.stringify(reportJson)).toString("base64") }), { status: 200, headers: { "content-type": "application/json" } });
    }
    
    if (u === "https://api.github.com/repos/TestOrg/pxl-classroom-control/git/ref/heads/main") {
      return new Response(JSON.stringify({ object: { sha: "headsha" } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (u === "https://api.github.com/repos/TestOrg/pxl-classroom-control/git/commits/headsha") {
      return new Response(JSON.stringify({ tree: { sha: "treesha" } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (u === "https://api.github.com/repos/TestOrg/pxl-classroom-control/git/blobs") {
      commitCount++;
      return new Response(JSON.stringify({ sha: "blobsha" }), { status: 201, headers: { "content-type": "application/json" } });
    }
    if (u === "https://api.github.com/repos/TestOrg/pxl-classroom-control/git/trees") {
      return new Response(JSON.stringify({ sha: "newtreesha" }), { status: 201, headers: { "content-type": "application/json" } });
    }
    if (u === "https://api.github.com/repos/TestOrg/pxl-classroom-control/git/commits") {
      return new Response(JSON.stringify({ sha: "newcommitsha" }), { status: 201, headers: { "content-type": "application/json" } });
    }
    if (u === "https://api.github.com/repos/TestOrg/pxl-classroom-control/git/refs/heads/main") {
      return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
    }
    console.error("UNHANDLED FETCH", u);
    return new Response("Not Found", { status: 404 });
  };

  try {
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    process.env.APPDATA = homeDir;
    process.env.XDG_CONFIG_HOME = homeDir;

    const program = new Command();
    program.exitOverride();
    registerGradeCommand(program);

    let stdout = "";
    let stderr = "";
    const originalStdoutWrite = process.stdout.write;
    const originalStderrWrite = process.stderr.write;
    process.stdout.write = capturing((chunk) => { stdout += chunk; }, originalStdoutWrite);
    process.stderr.write = capturing((chunk) => { stderr += chunk; }, originalStderrWrite);

    const originalExit = process.exit;
    let exitCode = 0;
    try {
      process.exit = (code) => { throw new Error(`process.exit(${code})`); };
      await program.parseAsync(["node", "pxl", "grade", "--org", "TestOrg", "--assignment", "a1", "--runner", "host", "--concurrency", "2", "--dry-run", "--force-host"]);
    } catch (e) {
      exitCode = 1;
    } finally {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
      process.exit = originalExit;
    }


    if (!stdout.includes("student1: 0/10")) {
      console.log("TEST STDOUT:", stdout);
      console.log("TEST STDERR:", stderr);
    }
    assert.ok(stdout.includes("student1: 0/10"));
    assert.equal(commitCount, 0);
    assert.equal(exitCode, 1); // 1 failed
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(process, 'platform', originalPlatform);
  }
});

test("grade command: github_actions with 0 check-runs", async () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'linux' });
  
  const tmp = mkdtempSync(join(tmpdir(), "pxl-grade-ghactions-test-"));
  const homeDir = join(tmp, "home");
  mkdirSync(homeDir);
  
  mkdirSync(join(homeDir, "pxl-classroom"), { recursive: true });
  writeFileSync(join(homeDir, "pxl-classroom", "token"), JSON.stringify({ access_token: "fake" }));

  const assignmentYaml = `
id: a1
autograde:
  enabled: true
  execution_environment: github_actions
  tests:
    - id: test1
      points: 10
      timeout_s: 5
      command: "node test.js"
`;

  const reportJson = {
    students: [
      { github_login: "student_no_ci", preservation_status: "preserved", preserved_sha: "noci_sha", repo_name: "TestOrg/a1-student_no_ci" }
    ]
  };

  const originalFetch = globalThis.fetch;
  
  globalThis.fetch = async (url, options) => {
    const u = url.toString();
    if (u === "https://api.github.com/user") {
      return new Response(JSON.stringify({ login: "teacher1" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (u === "https://api.github.com/repos/TestOrg/pxl-classroom-control/contents/assignments%2Fa1.yml") {
      return new Response(JSON.stringify({ content: Buffer.from(assignmentYaml).toString("base64") }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (u === "https://api.github.com/repos/TestOrg/pxl-classroom-control/contents/reports%2Fa1.json") {
      return new Response(JSON.stringify({ content: Buffer.from(JSON.stringify(reportJson)).toString("base64") }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (u === "https://api.github.com/repos/TestOrg/a1-student_no_ci/commits/noci_sha/check-runs") {
      return new Response(JSON.stringify({ check_runs: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    console.error("UNHANDLED FETCH in new test", u);
    return new Response("Not Found", { status: 404 });
  };

  try {
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    process.env.APPDATA = homeDir;
    process.env.XDG_CONFIG_HOME = homeDir;

    const program = new Command();
    program.exitOverride();
    registerGradeCommand(program);

    let _stdout = "";
    let stderr = "";
    const originalStdoutWrite = process.stdout.write;
    const originalStderrWrite = process.stderr.write;
    process.stdout.write = capturing((chunk) => { _stdout += chunk; }, originalStdoutWrite);
    process.stderr.write = capturing((chunk) => { stderr += chunk; }, originalStderrWrite);

    const originalExit = process.exit;
    let exitCode = 0;
    try {
      process.exit = (code) => { throw new Error(`process.exit(${code})`); };
      await program.parseAsync(["node", "pxl", "grade", "--org", "TestOrg", "--assignment", "a1", "--dry-run"]);
    } catch (e) {
      exitCode = 1;
    } finally {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
      process.exit = originalExit;
    }

    // The commit is named now, because the commit read is no longer always the
    // preserved one: an assignment carrying a hand-in marker reads the score at
    // the hand-in commit instead. "at preserved SHA" would be a lie there.
    assert.ok(
      stderr.includes(`student_no_ci: no CI run at commit ${"noci_sha".slice(0, 7)}`),
      `saw: ${stderr}`,
    );
    assert.equal(exitCode, 1);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(process, 'platform', originalPlatform);
  }
});

test("grade command: github_actions successfully syncs Check Run with Points and commits to control repo", async () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'linux' });
  
  const tmp = mkdtempSync(join(tmpdir(), "pxl-grade-ghactions-sync-"));
  const homeDir = join(tmp, "home");
  mkdirSync(homeDir);
  
  mkdirSync(join(homeDir, "pxl-classroom"), { recursive: true });
  writeFileSync(join(homeDir, "pxl-classroom", "token"), JSON.stringify({ access_token: "fake" }));

  const assignmentYaml = `
id: cloud-pe-1
autograde:
  enabled: true
  execution_environment: github_actions
  tests:
    - id: lint
      points: 10
    - id: test
      points: 10
`;

  const aliceSha = "a".repeat(40);
  const reportJson = {
    students: [
      { github_login: "alice", preservation_status: "preserved", preserved_sha: aliceSha, repo_name: "TestOrg/cloud-pe-1-alice" },
      // R1-13 (review 2026-10-14): nothing preserved, so not in this grader's
      // queue - and left out of the summary that replaces the whole file.
      { github_login: "bo", preservation_status: "pending", repo_name: "TestOrg/cloud-pe-1-bo", submission_status: "on-time" },
      { github_login: "cy", preservation_status: "not-required", repo_name: "TestOrg/cloud-pe-1-cy", submission_status: "no-submission" },
    ]
  };

  let committedBlobs = [];
  const originalFetch = globalThis.fetch;
  
  globalThis.fetch = async (url, options) => {
    const u = url.toString();
    if (u === "https://api.github.com/user") {
      return new Response(JSON.stringify({ login: "teacher1" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (u === "https://api.github.com/repos/TestOrg/pxl-classroom-control/contents/assignments%2Fcloud-pe-1.yml") {
      return new Response(JSON.stringify({ content: Buffer.from(assignmentYaml).toString("base64") }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (u === "https://api.github.com/repos/TestOrg/pxl-classroom-control/contents/reports%2Fcloud-pe-1.json") {
      return new Response(JSON.stringify({ content: Buffer.from(JSON.stringify(reportJson)).toString("base64") }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (u === `https://api.github.com/repos/TestOrg/cloud-pe-1-alice/commits/${aliceSha}/check-runs`) {
      return new Response(JSON.stringify({
        check_runs: [
          {
            name: "CodeQL Analysis",
            conclusion: "success",
            output: { title: "No issues", summary: "" }
          },
          {
            name: "Autograding Tests",
            conclusion: "failure",
            output: {
              title: "Autograding",
              summary: "### Summary\n\nPoints 15/20\n\nTest 1 passed, Test 2 failed."
            }
          }
        ]
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (u.includes("/git/ref/heads")) {
      return new Response(JSON.stringify({ object: { sha: "headsha" } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (u === "https://api.github.com/repos/TestOrg/pxl-classroom-control/git/commits/headsha") {
      return new Response(JSON.stringify({ tree: { sha: "treesha" } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (u === "https://api.github.com/repos/TestOrg/pxl-classroom-control/git/blobs") {
      const body = JSON.parse(options.body);
      committedBlobs.push(body);
      return new Response(JSON.stringify({ sha: "blobsha" }), { status: 201, headers: { "content-type": "application/json" } });
    }
    if (u === "https://api.github.com/repos/TestOrg/pxl-classroom-control/git/trees") {
      return new Response(JSON.stringify({ sha: "newtreesha" }), { status: 201, headers: { "content-type": "application/json" } });
    }
    if (u === "https://api.github.com/repos/TestOrg/pxl-classroom-control/git/commits") {
      return new Response(JSON.stringify({ sha: "newcommitsha" }), { status: 201, headers: { "content-type": "application/json" } });
    }
    if (u.includes("/git/refs/heads")) {
      return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
    }
    console.error("UNHANDLED FETCH in sync test", u);
    return new Response("Not Found", { status: 404 });
  };

  try {
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    process.env.APPDATA = homeDir;
    process.env.XDG_CONFIG_HOME = homeDir;

    const program = new Command();
    program.exitOverride();
    registerGradeCommand(program);

    let stdout = "";
    let _stderr = "";
    const originalStdoutWrite = process.stdout.write;
    const originalStderrWrite = process.stderr.write;
    process.stdout.write = capturing((chunk) => { stdout += chunk; }, originalStdoutWrite);
    process.stderr.write = capturing((chunk) => { _stderr += chunk; }, originalStderrWrite);

    try {
      await program.parseAsync(["node", "pxl", "grade", "--org", "TestOrg", "--assignment", "cloud-pe-1"]);
    } finally {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
    }

    assert.ok(stdout.includes("alice: 15/20"));
    assert.ok(stdout.includes("1 graded, 0 failed"));
    assert.equal(committedBlobs.length, 2); // 1 per-student JSON + 1 summary JSON
    // R1-8 and R1-13: the summary written names every report student, each
    // failed row with the kind the page reads (lib/grade-cohort.mjs FAILED_KINDS).
    const decode = (b) => (b.encoding === "base64" ? Buffer.from(b.content, "base64").toString("utf8") : b.content);
    const summary = committedBlobs.map((b) => JSON.parse(decode(b))).find((d) => Array.isArray(d.students) && Array.isArray(d.failed));
    assert.ok(summary, "the summary was committed");
    assert.deepEqual(summary.students.map((s) => s.login), ["alice"]);
    const kinds = Object.fromEntries(summary.failed.map((f) => [f.login, f.kind]));
    assert.deepEqual(kinds, { bo: "no-result", cy: "not-handed-in" });
    assert.match(summary.failed.find((f) => f.login === "bo").reason, /nothing was preserved/);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(process, 'platform', originalPlatform);
  }
});

test("P2-3: a row carried over from the summary read makes the write depend on that version: changed meanwhile, nothing is written", async () => {
  // Review 2026-10-14: bo is outside the queue (nothing preserved), so their
  // row is carried from the summary on record - and the write replaced the
  // file whole with no check that it was still that version.
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "linux" });
  const tmp = mkdtempSync(join(tmpdir(), "pxl-grade-carry-"));
  const homeDir = join(tmp, "home");
  mkdirSync(join(homeDir, "pxl-classroom"), { recursive: true });
  writeFileSync(join(homeDir, "pxl-classroom", "token"), JSON.stringify({ access_token: "fake" }));
  const aliceSha = "a".repeat(40);
  const assignmentYaml = "id: carry\nautograde:\n  enabled: true\n  execution_environment: github_actions\n  tests:\n    - id: t\n      points: 20\n";
  const reportJson = {
    students: [
      { github_login: "alice", preservation_status: "preserved", preserved_sha: aliceSha, repo_name: "TestOrg/carry-alice", submission_status: "on-time" },
      { github_login: "bo", preservation_status: "pending", repo_name: "TestOrg/carry-bo", submission_status: "on-time" },
    ],
  };
  const stored = {
    schema_version: 1, assignment_id: "carry", generated_at: "2026-10-14T10:00:00Z", graded_by: "x", runner: "github_actions",
    students: [{ login: "bo", earned_points: 15, total_points: 20, graded_at: "2026-10-14T10:00:00Z" }], failed: [],
  };
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const writes = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const u = url.toString();
    if (u === "https://api.github.com/user") return json({ login: "teacher1" });
    if (u.endsWith("contents/assignments%2Fcarry.yml")) return json({ content: Buffer.from(assignmentYaml).toString("base64") });
    if (u.endsWith("contents/reports%2Fcarry.json")) return json({ content: Buffer.from(JSON.stringify(reportJson)).toString("base64") });
    // The read the CLI decides from (its path escaped), and the check at the
    // commit it would land on (its path as written): another writer since.
    if (u.includes("contents/grading%2Fcarry%2Fsummary.json")) return json({ sha: "s1", content: Buffer.from(JSON.stringify(stored)).toString("base64") });
    if (u.includes("contents/grading/carry/summary.json")) return json({ sha: "s2", content: Buffer.from("{}").toString("base64") });
    if (u.includes(`/commits/${aliceSha}/check-runs`)) {
      return json({ check_runs: [{ name: "Autograding Tests", conclusion: "success", status: "completed", output: { title: "Autograding", summary: "Points 18/20" } }] });
    }
    if (u.includes("/git/ref/heads")) return json({ object: { sha: "headsha" } });
    if (u.endsWith("/git/commits/headsha")) return json({ tree: { sha: "treesha" } });
    if (u.endsWith("/git/blobs")) {
      const b = JSON.parse(options.body);
      writes.push(b.encoding === "base64" ? Buffer.from(b.content, "base64").toString("utf8") : b.content);
      return json({ sha: "blobsha" }, 201);
    }
    if (u.endsWith("/git/trees")) { writes.push("tree"); return json({ sha: "newtreesha" }, 201); }
    if (u.endsWith("/git/commits")) { writes.push("commit"); return json({ sha: "newcommitsha" }, 201); }
    if (u.includes("/git/refs/heads")) { writes.push("ref"); return json({}); }
    return new Response("Not Found", { status: 404 });
  };
  let stdout = "";
  let stderr = "";
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  try {
    Object.assign(process.env, { HOME: homeDir, USERPROFILE: homeDir, APPDATA: homeDir, XDG_CONFIG_HOME: homeDir });
    const program = new Command();
    program.exitOverride();
    registerGradeCommand(program);
    process.stdout.write = capturing((c) => { stdout += c; }, originalStdoutWrite);
    process.stderr.write = capturing((c) => { stderr += c; }, originalStderrWrite);
    let refused = null;
    await program.parseAsync(["node", "pxl", "grade", "--org", "TestOrg", "--assignment", "carry"]).catch((e) => { refused = e; });
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    assert.match(String(refused?.message), /changed by someone else/, `refused: ${stdout}${stderr}`);
    // alice's own record is its own commit, before the summary; the summary
    // with bo's carried row is never written.
    const summaries = writes.filter((w) => w.includes('"failed"') && w.includes('"students"'));
    assert.deepEqual(summaries, [], "no summary was written over the newer one");
    assert.equal(writes.filter((w) => w === "ref").length, 1, "only alice's record moved the branch");
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    globalThis.fetch = originalFetch;
    Object.defineProperty(process, "platform", originalPlatform);
  }
});

test("P2-1: a student with nothing handed in gets no score, on the Actions path and the local runner, though their starter passes", async () => {
  // Review 2026-10-14: the shared grader refuses "no submission" before it
  // reads anything (lib/grade-cohort.mjs `gradeStudent`); the CLI read the
  // preserved commit regardless, and an untouched student's preserved commit
  // is the starter - with a passing grading run, or passing tests.
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "linux" });
  const tmp = mkdtempSync(join(tmpdir(), "pxl-grade-nosub-"));
  const homeDir = join(tmp, "home");
  mkdirSync(join(homeDir, "pxl-classroom"), { recursive: true });
  writeFileSync(join(homeDir, "pxl-classroom", "token"), JSON.stringify({ access_token: "fake" }));
  const sha = "c".repeat(40);
  for (const local of [false, true]) {
  const assignmentYaml = local
    ? `
id: nosub
autograde:
  enabled: true
  tests:
    - id: t
      points: 10
      timeout_s: 5
      command: "node -v"
`
    : `
id: nosub
autograde:
  enabled: true
  execution_environment: github_actions
  tests:
    - id: t
      points: 10
`;
  const reportJson = {
    students: [
      { github_login: "cy", preservation_status: "preserved", preserved_sha: sha, repo_name: "TestOrg/nosub-cy", submission_status: "no-submission" },
    ],
  };
  const committedBlobs = [];
  const asked = [];
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const u = url.toString();
    asked.push(u);
    if (u === "https://api.github.com/user") return json({ login: "teacher1" });
    if (u.endsWith("contents/assignments%2Fnosub.yml")) return json({ content: Buffer.from(assignmentYaml).toString("base64") });
    if (u.endsWith("contents/reports%2Fnosub.json")) return json({ content: Buffer.from(JSON.stringify(reportJson)).toString("base64") });
    // The starter's grading run passes: what the old path recorded.
    if (u.includes("/check-runs")) {
      return json({ check_runs: [{ name: "Autograding Tests", conclusion: "success", status: "completed", output: { title: "Autograding", summary: "Points 10/10" } }] });
    }
    if (u.includes("/git/ref/heads")) return json({ object: { sha: "headsha" } });
    if (u.endsWith("/git/commits/headsha")) return json({ tree: { sha: "treesha" } });
    if (u.endsWith("/git/blobs")) { committedBlobs.push(JSON.parse(options.body)); return json({ sha: "blobsha" }, 201); }
    if (u.endsWith("/git/trees")) return json({ sha: "newtreesha" }, 201);
    if (u.endsWith("/git/commits")) return json({ sha: "newcommitsha" }, 201);
    if (u.includes("/git/refs/heads")) return json({});
    return new Response("Not Found", { status: 404 });
  };
  try {
    Object.assign(process.env, { HOME: homeDir, USERPROFILE: homeDir, APPDATA: homeDir, XDG_CONFIG_HOME: homeDir });
    const program = new Command();
    program.exitOverride();
    registerGradeCommand(program);
    let stdout = "";
    let stderr = "";
    const originalStdoutWrite = process.stdout.write;
    const originalStderrWrite = process.stderr.write;
    process.stdout.write = capturing((c) => { stdout += c; }, originalStdoutWrite);
    process.stderr.write = capturing((c) => { stderr += c; }, originalStderrWrite);
    // A student without a score exits 1, as any failed row does; caught here,
    // or it ends the test process.
    const originalExit = process.exit;
    let exitCode = null;
    process.exit = (code) => { exitCode = code; throw new Error(`exit ${code}`); };
    try {
      const argv = ["node", "pxl", "grade", "--org", "TestOrg", "--assignment", "nosub", ...(local ? ["--runner", "host", "--force-host"] : [])];
      await program.parseAsync(argv).catch((e) => {
        if (!/^exit /.test(e.message)) throw e;
      });
    } finally {
      process.exit = originalExit;
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
    }
    const path = local ? "local runner" : "Actions";
    assert.equal(exitCode, 1, `${path}: no score for them is a row without a score`);
    assert.ok(!asked.some((u) => u.includes("/check-runs")), `${path}: no score is read for them: ${stdout}${stderr}`);
    // The local runner would have checked out the archive, which this test
    // does not serve, and said so (a no-result row, not not-handed-in).
    assert.doesNotMatch(stderr, /archive fetch failed/, `${path}: nothing is checked out`);
    assert.doesNotMatch(stdout, /cy: 10\/10/);
    const decode = (b) => (b.encoding === "base64" ? Buffer.from(b.content, "base64").toString("utf8") : b.content);
    const summary = committedBlobs.map((b) => JSON.parse(decode(b))).find((d) => Array.isArray(d.students) && Array.isArray(d.failed));
    assert.ok(summary, `${path}: the summary was committed: ${stdout}${stderr}`);
    assert.deepEqual(summary.students, []);
    assert.deepEqual(summary.failed.map((f) => [f.login, f.kind]), [["cy", "not-handed-in"]], path);
  } finally {
    globalThis.fetch = originalFetch;
  }
  }
  Object.defineProperty(process, "platform", originalPlatform);
});

// The shape measured live on 2026-09-04 in PXL-2TIN-CloudEssentials-2627: a
// template whose grading job is gated on
// `if: github.event.head_commit.message == 'einde examen'`, so the check run at
// every OTHER commit exists and says `skipped`. Alice handed in and then pushed
// a readme fix, which is the ordinary way a student ends up here.
test("grade command: a skipped run at the preserved commit is read at the hand-in commit instead", async () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "linux" });

  const tmp = mkdtempSync(join(tmpdir(), "pxl-grade-marker-"));
  const homeDir = join(tmp, "home");
  mkdirSync(homeDir);
  mkdirSync(join(homeDir, "pxl-classroom"), { recursive: true });
  writeFileSync(join(homeDir, "pxl-classroom", "token"), JSON.stringify({ access_token: "fake" }));

  // No `autograde.tests`: the checks live in the template's own workflow, which
  // is the entire point of this setup. The total comes from the annotation.
  const assignmentYaml = `
id: proef-pe1
submission_ref: refs/heads/main
submission_marker:
  type: commit_message
  value: einde examen
autograde:
  enabled: true
  execution_environment: github_actions
  tests:
    - id: from-template
      points: 0
`;

  const headSha = "f".repeat(40);   // "fix the readme" - preserved, and skipped
  const handInSha = "4".repeat(40); // "einde examen"   - where the score is
  const reportJson = {
    students: [
      {
        github_login: "alice",
        preservation_status: "preserved",
        preserved_sha: headSha,
        repo_name: "TestOrg/proef-pe1-alice",
        effective_deadline_at: "2027-02-28T08:37:00.000Z",
      },
    ],
  };

  const skippedRun = {
    check_runs: [
      { name: "run-autograding-tests", conclusion: "skipped", output: { title: null, summary: null, annotations_count: 0 } },
    ],
  };
  const gradedRun = {
    check_runs: [
      { id: 991, name: "run-autograding-tests", conclusion: "success", output: { title: null, summary: null, annotations_count: 2 } },
    ],
  };

  const committedBlobs = [];
  let commitsQuery = null;
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url, options) => {
    const u = url.toString();
    if (u === "https://api.github.com/user") {
      return new Response(JSON.stringify({ login: "teacher1" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (u === "https://api.github.com/repos/TestOrg/pxl-classroom-control/contents/assignments%2Fproef-pe1.yml") {
      return new Response(JSON.stringify({ content: Buffer.from(assignmentYaml).toString("base64") }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (u === "https://api.github.com/repos/TestOrg/pxl-classroom-control/contents/reports%2Fproef-pe1.json") {
      return new Response(JSON.stringify({ content: Buffer.from(JSON.stringify(reportJson)).toString("base64") }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (u === `https://api.github.com/repos/TestOrg/proef-pe1-alice/commits/${headSha}/check-runs`) {
      return new Response(JSON.stringify(skippedRun), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (u === `https://api.github.com/repos/TestOrg/proef-pe1-alice/commits/${handInSha}/check-runs`) {
      return new Response(JSON.stringify(gradedRun), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (u.startsWith("https://api.github.com/repos/TestOrg/proef-pe1-alice/commits?")) {
      commitsQuery = u;
      return new Response(JSON.stringify([
        { sha: headSha, commit: { message: "fix the readme", committer: { date: "2026-09-02T08:10:00Z" } } },
        { sha: handInSha, commit: { message: "einde examen", committer: { date: "2026-09-02T07:50:04Z" } } },
      ]), { status: 200, headers: { "content-type": "application/json" } });
    }
    // When GitHub saw each push, which is what the deadline is compared to
    // (lib/submission-marker.mjs `handInTime`): the push runs and the push log.
    if (u.startsWith("https://api.github.com/repos/TestOrg/proef-pe1-alice/actions/runs?")) {
      return new Response(JSON.stringify({ workflow_runs: [
        { id: 2, head_sha: headSha, head_branch: "main", event: "push", created_at: "2026-09-02T08:10:09Z", head_commit: { message: "fix the readme" } },
        { id: 1, head_sha: handInSha, head_branch: "main", event: "push", created_at: "2026-09-02T07:50:09Z", head_commit: { message: "einde examen" } },
      ] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (u.startsWith("https://api.github.com/repos/TestOrg/proef-pe1-alice/activity?")) {
      return new Response(JSON.stringify([
        { activity_type: "push", ref: "refs/heads/main", after: headSha, timestamp: "2026-09-02T08:10:05Z" },
        { activity_type: "push", ref: "refs/heads/main", after: handInSha, timestamp: "2026-09-02T07:50:05Z" },
      ]), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (u === "https://api.github.com/repos/TestOrg/proef-pe1-alice/check-runs/991/annotations?per_page=100&page=1") {
      return new Response(JSON.stringify([
        { annotation_level: "warning", title: "", message: "Node.js 20 is deprecated." },
        { annotation_level: "notice", title: "Autograding report", message: '{"totalPoints":10,"maxPoints":10}' },
      ]), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (u.includes("/git/ref/heads")) {
      return new Response(JSON.stringify({ object: { sha: "headsha" } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (u === "https://api.github.com/repos/TestOrg/pxl-classroom-control/git/commits/headsha") {
      return new Response(JSON.stringify({ tree: { sha: "treesha" } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (u === "https://api.github.com/repos/TestOrg/pxl-classroom-control/git/blobs") {
      committedBlobs.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ sha: "blobsha" }), { status: 201, headers: { "content-type": "application/json" } });
    }
    if (u === "https://api.github.com/repos/TestOrg/pxl-classroom-control/git/trees") {
      return new Response(JSON.stringify({ sha: "newtreesha" }), { status: 201, headers: { "content-type": "application/json" } });
    }
    if (u === "https://api.github.com/repos/TestOrg/pxl-classroom-control/git/commits") {
      return new Response(JSON.stringify({ sha: "newcommitsha" }), { status: 201, headers: { "content-type": "application/json" } });
    }
    if (u.includes("/git/refs/heads")) {
      return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
    }
    console.error("UNHANDLED FETCH in marker test", u);
    return new Response("Not Found", { status: 404 });
  };

  try {
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    process.env.APPDATA = homeDir;
    process.env.XDG_CONFIG_HOME = homeDir;

    const program = new Command();
    program.exitOverride();
    registerGradeCommand(program);

    let stdout = "";
    let _stderr = "";
    const originalStdoutWrite = process.stdout.write;
    const originalStderrWrite = process.stderr.write;
    process.stdout.write = capturing((chunk) => { stdout += chunk; }, originalStdoutWrite);
    process.stderr.write = capturing((chunk) => { _stderr += chunk; }, originalStderrWrite);
    try {
      await program.parseAsync(["node", "pxl", "grade", "--org", "TestOrg", "--assignment", "proef-pe1"]);
    } finally {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
    }

    // Without the walk this is `alice: 0/0` and a green "1 graded" - a mark
    // nobody measured, which is the whole defect.
    assert.ok(stdout.includes("alice: 10/10"), `saw: ${stdout}${_stderr}`);
    assert.ok(stdout.includes("1 graded, 0 failed"));

    // The submission branch is read whole; the deadline is applied to when
    // GitHub saw each hand-in pushed, in lib/submission-marker.mjs, rather
    // than handed to GitHub, so a hand-in pushed after it can be reported as
    // late instead of being invisible.
    assert.ok(commitsQuery, "the hand-in commit has to be looked for");
    assert.match(commitsQuery, /sha=main/);
    assert.ok(!commitsQuery.includes("until="), "the deadline is not GitHub's filter to apply");

    // The grade is recorded against the commit it was read at, not the head.
    const result = JSON.parse(Buffer.from(committedBlobs[0].content, committedBlobs[0].encoding || "utf-8").toString());
    assert.equal(result.archive_sha, handInSha);
    assert.equal(result.earned_points, 10);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(process, "platform", originalPlatform);
  }
});


