import { test } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { registerGradeCommand } from "../src/commands/grade.mjs";

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
      await program.parseAsync(["node", "pxl", "grade", "--org", "TestOrg", "--assignment", "a1", "--runner", "host", "--concurrency", "2", "--dry-run"]);
    } catch (e) {
      exitCode = 1;
    } finally {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
      process.exit = originalExit;
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
