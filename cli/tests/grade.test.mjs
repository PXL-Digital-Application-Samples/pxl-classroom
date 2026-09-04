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

    let _stdout = "";
    let stderr = "";
    const originalStdoutWrite = process.stdout.write;
    const originalStderrWrite = process.stderr.write;
    process.stdout.write = (chunk) => { _stdout += chunk; return true; };
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
    let _stderr = "";
    const originalStdoutWrite = process.stdout.write;
    const originalStderrWrite = process.stderr.write;
    process.stdout.write = (chunk) => { stdout += chunk; return true; };
    process.stderr.write = (chunk) => { _stderr += chunk; return true; };

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
    process.stdout.write = (chunk) => { stdout += chunk; return true; };
    process.stderr.write = (chunk) => { _stderr += chunk; return true; };
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

    // The branch and the student's own deadline are both sent, so a hand-in
    // pushed after it cannot become the graded commit.
    assert.ok(commitsQuery, "the hand-in commit has to be looked for");
    assert.match(commitsQuery, /sha=main/);
    assert.match(commitsQuery, /until=2027-02-28T08%3A37%3A00\.000Z/);

    // The grade is recorded against the commit it was read at, not the head.
    const result = JSON.parse(Buffer.from(committedBlobs[0].content, committedBlobs[0].encoding || "utf-8").toString());
    assert.equal(result.archive_sha, handInSha);
    assert.equal(result.earned_points, 10);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(process, "platform", originalPlatform);
  }
});


