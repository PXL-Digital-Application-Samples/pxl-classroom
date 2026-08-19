import { test } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { registerGradeCommand, parseCheckRunScore } from "../src/commands/grade.mjs";

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
  const sha2 = runGitSync(["rev-parse", "preserved/a1/student2"], mockArchive);

  writeFileSync(join(homeDir, ".gitconfig"), `
[url "file://${mockArchive.replace(/\\/g, '/')}"]
    insteadOf = https://x-access-token:fake@github.com/TestOrg/pxl-classroom-archive.git
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
    process.stdout.write = (chunk) => { stdout += chunk; return true; };
    process.stderr.write = (chunk) => { stderr += chunk; return true; };

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

    let stdout = "";
    let stderr = "";
    const originalStdoutWrite = process.stdout.write;
    const originalStderrWrite = process.stderr.write;
    process.stdout.write = (chunk) => { stdout += chunk; return true; };
    process.stderr.write = (chunk) => { stderr += chunk; return true; };

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

    assert.ok(stderr.includes("student_no_ci: no CI run at preserved SHA"));
    assert.equal(exitCode, 1);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(process, 'platform', originalPlatform);
  }
});

test("parseCheckRunScore: extracts Points X/Y from summary, text, or title", () => {
  // Scenario 1: Partial score from reporter summary
  const run1 = {
    output: {
      title: "Autograding",
      summary: "### Test Results\n\n| Test | Points |\n|---|---|\n| Task 1 | 5/5 |\n\nPoints 18/20",
      text: ""
    },
    conclusion: "failure"
  };
  const res1 = parseCheckRunScore(run1, 20);
  assert.equal(res1.earned, 18);
  assert.equal(res1.total, 20);
  assert.equal(res1.matched, true);
  assert.equal(res1.passed, false);

  // Scenario 2: Perfect score
  const run2 = {
    output: {
      title: "Autograding Tests",
      summary: "Points 20/20",
      text: ""
    },
    conclusion: "success"
  };
  const res2 = parseCheckRunScore(run2, 20);
  assert.equal(res2.earned, 20);
  assert.equal(res2.total, 20);
  assert.equal(res2.matched, true);
  assert.equal(res2.passed, true);

  // Scenario 3: Decimals / colon formatting
  const run3 = {
    output: {
      title: "Points: 7.5/10",
      summary: "",
      text: ""
    },
    conclusion: "failure"
  };
  const res3 = parseCheckRunScore(run3, 10);
  assert.equal(res3.earned, 7.5);
  assert.equal(res3.total, 10);
  assert.equal(res3.matched, true);

  // Scenario 4: Output in output.text
  const runText = {
    output: {
      title: "CI",
      summary: "Completed",
      text: "Detailed output:\nPoints 14/20\nDone."
    },
    conclusion: "failure"
  };
  const resText = parseCheckRunScore(runText, 20);
  assert.equal(resText.earned, 14);
  assert.equal(resText.total, 20);
  assert.equal(resText.matched, true);

  // Scenario 5: Case insensitivity & extra whitespace
  const runCase = {
    output: {
      title: "",
      summary: "POINTS   35   /   50",
      text: ""
    },
    conclusion: "failure"
  };
  const resCase = parseCheckRunScore(runCase, 50);
  assert.equal(resCase.earned, 35);
  assert.equal(resCase.total, 50);
  assert.equal(resCase.matched, true);

  // Scenario 6: Zero score
  const runZero = {
    output: {
      title: "Points 0/25",
      summary: "",
      text: ""
    },
    conclusion: "failure"
  };
  const resZero = parseCheckRunScore(runZero, 25);
  assert.equal(resZero.earned, 0);
  assert.equal(resZero.total, 25);
  assert.equal(resZero.matched, true);
  assert.equal(resZero.passed, false);

  // Scenario 7: Fallback to binary conclusion when no Points string
  const runFallback = {
    output: {
      title: "CI build",
      summary: "All tests passed",
      text: ""
    },
    conclusion: "success"
  };
  const resFallback = parseCheckRunScore(runFallback, 50);
  assert.equal(resFallback.earned, 50);
  assert.equal(resFallback.total, 50);
  assert.equal(resFallback.matched, false);
  assert.equal(resFallback.passed, true);

  // Scenario 8: Null / undefined output
  const runNull = {
    output: null,
    conclusion: "failure"
  };
  const resNull = parseCheckRunScore(runNull, 30);
  assert.equal(resNull.earned, 0);
  assert.equal(resNull.total, 30);
  assert.equal(resNull.matched, false);
  assert.equal(resNull.passed, false);
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
      { github_login: "alice", preservation_status: "preserved", preserved_sha: aliceSha, repo_name: "TestOrg/cloud-pe-1-alice" }
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
    let stderr = "";
    const originalStdoutWrite = process.stdout.write;
    const originalStderrWrite = process.stderr.write;
    process.stdout.write = (chunk) => { stdout += chunk; return true; };
    process.stderr.write = (chunk) => { stderr += chunk; return true; };

    try {
      await program.parseAsync(["node", "pxl", "grade", "--org", "TestOrg", "--assignment", "cloud-pe-1"]);
    } finally {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
    }

    assert.ok(stdout.includes("alice: 15/20"));
    assert.ok(stdout.includes("1 graded, 0 failed"));
    assert.equal(committedBlobs.length, 2); // 1 per-student JSON + 1 summary JSON
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(process, 'platform', originalPlatform);
  }
});


