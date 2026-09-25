// PXL Classroom - starter code synchronization.
//
// 1. JSON Schema validation of the sync record.
// 2. The fixture that matters: a repository created the way `POST /generate`
//    creates one - NO shared history with its template - and what that means
//    for the merge-based implementation this replaced.
// 3. lib/starter-sync.mjs: which files land in place, which raise a PR.
// 4. Selection, outcomes and the summary roll-up.
//
// The old version of this file built its "student" repositories with
// `git clone` of the template, so they shared every object and a plain
// `git merge <templateSha>` succeeded. That is not a repository this system
// ever produces, and it is why a feature that could not work for a single
// student passed nine tests for months.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv from "ajv";
import addFormats from "ajv-formats";

import {
  changedPaths,
  resolveSelection,
  planStarterSync,
  outcomeFor,
  summarize,
  syncMarker,
  findExistingSyncPr,
  readTemplateCommit,
} from "../lib/starter-sync.mjs";

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

const git = (args, cwd) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();

const schemaPath = join(process.cwd(), "schemas", "sync-record.schema.json");
const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
const validateSyncRecord = ajv.compile(schema);
const here = dirname(fileURLToPath(import.meta.url));

// `git ls-tree -r` is the same path -> blob sha mapping the GitHub tree API
// returns, so a fixture built here exercises the real comparison.
function treeOf(dir, ref = "HEAD") {
  const out = git(["ls-tree", "-r", ref], dir);
  const map = new Map();
  for (const line of out.split("\n").filter(Boolean)) {
    const [meta, path] = line.split("\t");
    const [, type, sha] = meta.split(/\s+/);
    if (type === "blob") map.set(path, sha);
  }
  return map;
}

// `//` lines, `/* … */` blocks and `<!-- … -->` markup comments.
function stripComments(src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

function initRepo(dir) {
  mkdirSync(dir, { recursive: true });
  git(["init", "--initial-branch=main", "."], dir);
  git(["config", "user.email", "t@example.com"], dir);
  git(["config", "user.name", "Test"], dir);
  return dir;
}

function commitAll(dir, message) {
  git(["add", "-A"], dir);
  git(["commit", "-m", message], dir);
  return git(["rev-parse", "HEAD"], dir);
}

// -----------------------------------------------------------------------------
// 1. Schema Validation
// -----------------------------------------------------------------------------

test("schemas/sync-record.schema.json validates a correct sync document", () => {
  const validDoc = {
    schema_version: 1,
    sync_id: "sync-20261015T120000Z-a1b2c3",
    assignment_id: "linux-processes",
    synced_at: "2026-10-15T12:00:00Z",
    synced_by: "lecturer-alice",
    template_repo: "PXLAutomation/template-linux-processes",
    template_sha: "a".repeat(40),
    template_base_sha: "b".repeat(40),
    selected_files: ["tests/test_processes.py"],
    pr_title: "Starter Code Update: Fix test assertions",
    pr_body: "Updated test assertions from template.",
    created_issues: true,
    summary: { total: 50, auto_merged: 46, pr_opened: 3, skipped: 1, failed: 0 },
    results: [
      {
        github_login: "student-bob",
        repo_name: "PXLAutomation/linux-processes-student-bob",
        outcome: "auto-merged",
        files_merged: 1,
        files_conflicted: 0,
        commit_sha: "c".repeat(40),
        issue_number: 2,
        issue_url: "https://github.com/PXLAutomation/linux-processes-student-bob/issues/2",
      },
      {
        github_login: "student-carol",
        repo_name: "PXLAutomation/linux-processes-student-carol",
        outcome: "merged-and-pr",
        files_merged: 2,
        files_conflicted: 1,
        commit_sha: "d".repeat(40),
        pr_number: 1,
        pr_url: "https://github.com/PXLAutomation/linux-processes-student-carol/pull/1",
      },
      {
        github_login: "student-dave",
        repo_name: "PXLAutomation/linux-processes-student-dave",
        outcome: "skipped-up-to-date",
      },
    ],
  };

  assert.equal(validateSyncRecord(validDoc), true, JSON.stringify(validateSyncRecord.errors));
});

test("schemas/sync-record.schema.json rejects invalid sync IDs or missing fields", () => {
  assert.equal(
    validateSyncRecord({
      schema_version: 1,
      sync_id: "not-a-sync-id",
      assignment_id: "x",
      synced_at: "2026-10-15T12:00:00Z",
      synced_by: "a",
      template_repo: "o/r",
      template_sha: "a".repeat(40),
      selected_files: [],
      summary: { total: 0, auto_merged: 0, pr_opened: 0, skipped: 0, failed: 0 },
      results: [],
    }),
    false,
  );

  // An outcome the executors do not produce must not validate.
  assert.equal(
    validateSyncRecord({
      schema_version: 1,
      sync_id: "sync-20261015T120000Z-a1b2c3",
      assignment_id: "x",
      synced_at: "2026-10-15T12:00:00Z",
      synced_by: "a",
      template_repo: "o/r",
      template_sha: "a".repeat(40),
      selected_files: [],
      summary: { total: 1, auto_merged: 0, pr_opened: 0, skipped: 0, failed: 0 },
      results: [{ github_login: "x", repo_name: "o/r", outcome: "rebased" }],
    }),
    false,
  );
});

// -----------------------------------------------------------------------------
// 2. The fixture: a generated repository, not a clone
// -----------------------------------------------------------------------------

test("identical bytes have identical blob shas in unrelated repositories", () => {
  const root = mkdtempSync(join(tmpdir(), "pxl-sync-generate-"));
  try {
    const template = initRepo(join(root, "template"));
    writeFileSync(join(template, "bmi_calculator.py"), "def bmi():\n    pass\n");
    writeFileSync(join(template, "README.md"), "# Starter\n");
    const templateSha = commitAll(template, "Add Python assignments");

    // What `POST /repos/{tpl}/generate` produces: the template's files in a
    // brand-new repository with ONE commit and no ancestry.
    const student = initRepo(join(root, "student"));
    writeFileSync(join(student, "bmi_calculator.py"), "def bmi():\n    pass\n");
    writeFileSync(join(student, "README.md"), "# Starter\n");
    commitAll(student, "Initial commit");

    // No shared ancestry: `git merge-base` finds nothing, which is the local
    // equivalent of what live GitHub says about a generated repository -
    // `404 No common ancestor`, which is what broke the old up-to-date check
    // and made the modal preview every student as a conflict.
    //
    // NOT a claim that the old merge 404'd. Measured on 2026-08-25, GitHub
    // keeps a generated repository in its template's object network, so
    // `POST /merges { head: templateSha }` succeeded - carrying the whole tree
    // and grafting the template's history. Git cannot model that here, and a
    // fixture that pretends to would be the same mistake this file already
    // made once by using `git clone`.
    assert.throws(() => git(["merge-base", templateSha, "main"], student));

    // What the planner actually rests on: blob shas are content addresses, so
    // they match exactly across repositories with no relationship at all.
    const tplTree = treeOf(template);
    const stuTree = treeOf(student);
    assert.equal(stuTree.get("bmi_calculator.py"), tplTree.get("bmi_calculator.py"));
    assert.equal(stuTree.get("README.md"), tplTree.get("README.md"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// -----------------------------------------------------------------------------
// 3. planStarterSync over a real correction
// -----------------------------------------------------------------------------

test("a correction lands in place for students who never touched the file, and as a PR for those who did", () => {
  const root = mkdtempSync(join(tmpdir(), "pxl-sync-plan-"));
  try {
    const template = initRepo(join(root, "template"));
    writeFileSync(join(template, "bmi_calculator.py"), "def bmi():\n    pass\n");
    writeFileSync(join(template, "README.md"), "# Starter\n");
    commitAll(template, "Add Python assignments");
    const baseTree = treeOf(template);

    // The lecturer corrects a mistake in the assignment - the case the whole
    // feature exists for.
    writeFileSync(join(template, "bmi_calculator.py"), "def bmi(w, h):\n    return w / h ** 2\n");
    commitAll(template, "Fix bmi signature");
    const headTree = treeOf(template);
    const paths = ["bmi_calculator.py"];

    // Student A generated their repo and has not opened the file.
    const untouched = initRepo(join(root, "untouched"));
    writeFileSync(join(untouched, "bmi_calculator.py"), "def bmi():\n    pass\n");
    writeFileSync(join(untouched, "README.md"), "# Starter\n");
    commitAll(untouched, "Initial commit");

    const planA = planStarterSync({ headTree, baseTree, studentTree: treeOf(untouched), paths });
    assert.deepEqual(planA.clean, [{ path: "bmi_calculator.py", action: "write" }]);
    assert.deepEqual(planA.conflicts, []);
    assert.equal(outcomeFor(planA), "auto-merged");

    // Student B has started solving it.
    const working = initRepo(join(root, "working"));
    writeFileSync(join(working, "bmi_calculator.py"), "def bmi():\n    return 'my attempt'\n");
    writeFileSync(join(working, "README.md"), "# Starter\n");
    commitAll(working, "Initial commit");

    const planB = planStarterSync({ headTree, baseTree, studentTree: treeOf(working), paths });
    assert.deepEqual(planB.clean, []);
    assert.deepEqual(planB.conflicts, [{ path: "bmi_calculator.py", action: "write" }]);
    assert.equal(outcomeFor(planB), "pr-opened");

    // Student C already has the corrected file - a re-run must do nothing.
    const current = initRepo(join(root, "current"));
    writeFileSync(join(current, "bmi_calculator.py"), "def bmi(w, h):\n    return w / h ** 2\n");
    writeFileSync(join(current, "README.md"), "# Starter\n");
    commitAll(current, "Initial commit");

    const planC = planStarterSync({ headTree, baseTree, studentTree: treeOf(current), paths });
    assert.deepEqual(planC.clean, []);
    assert.deepEqual(planC.conflicts, []);
    assert.deepEqual(planC.upToDate, ["bmi_calculator.py"]);
    assert.equal(outcomeFor(planC), "skipped-up-to-date");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the split is per file, so one student can get both a direct commit and a PR", () => {
  const headTree = new Map([["a.py", "head-a"], ["b.py", "head-b"]]);
  const baseTree = new Map([["a.py", "base-a"], ["b.py", "base-b"]]);
  // Touched b.py only.
  const studentTree = new Map([["a.py", "base-a"], ["b.py", "student-b"]]);

  const plan = planStarterSync({ headTree, baseTree, studentTree, paths: ["a.py", "b.py"] });
  assert.deepEqual(plan.clean, [{ path: "a.py", action: "write" }]);
  assert.deepEqual(plan.conflicts, [{ path: "b.py", action: "write" }]);
  assert.equal(outcomeFor(plan), "merged-and-pr");
});

test("added, deleted and renamed paths are planned correctly", () => {
  const headTree = new Map([["new.py", "sha-new"], ["renamed.py", "sha-moved"]]);
  const baseTree = new Map([["gone.py", "sha-gone"], ["old.py", "sha-moved"]]);

  // A student who has exactly what the template said before the commit.
  const pristine = new Map([["gone.py", "sha-gone"], ["old.py", "sha-moved"]]);
  const plan = planStarterSync({
    headTree,
    baseTree,
    studentTree: pristine,
    paths: ["new.py", "gone.py", "renamed.py", "old.py"],
  });

  assert.deepEqual(plan.clean, [
    { path: "new.py", action: "write" },     // added: absent in base AND in the student
    { path: "gone.py", action: "delete" },   // removed from the template
    { path: "renamed.py", action: "write" }, // the rename's new path
    { path: "old.py", action: "delete" },    // ...and its old one, or both survive
  ]);
  assert.deepEqual(plan.conflicts, []);

  // A student who already has a file at the path the template is adding must
  // not have it overwritten - and is not offered a pull request resetting it
  // either. The ordinary way to be here is to have RECEIVED it (an earlier
  // sync that got that far, or a repository generated after the commit) and
  // worked in it since; a pull request would offer to undo that work. It is
  // theirs, and counted as kept (2026-09-25, lab 3 re-sent to 43 students of
  // .NET Advanced while 68 already had it).
  const collides = new Map([["new.py", "student-wrote-this"]]);
  const plan2 = planStarterSync({ headTree, baseTree, studentTree: collides, paths: ["new.py"] });
  assert.deepEqual(plan2.clean, [], "never overwritten");
  assert.deepEqual(plan2.conflicts, [], "and not offered back as the starter version");
  assert.deepEqual(plan2.kept, ["new.py"]);
  assert.equal(outcomeFor(plan2), "skipped-up-to-date");
  // Modified or deleted by the commit is still the student's edit against
  // what they were given, and still a pull request.
  const edited = new Map([["gone.py", "student-changed-this"]]);
  const plan4 = planStarterSync({ headTree, baseTree, studentTree: edited, paths: ["gone.py"] });
  assert.deepEqual(plan4.conflicts, [{ path: "gone.py", action: "delete" }]);
  assert.deepEqual(plan4.kept, []);

  // A file the commit deletes that this student never had is nothing to do,
  // not a deletion to apply.
  const never = new Map();
  const plan3 = planStarterSync({ headTree, baseTree, studentTree: never, paths: ["gone.py"] });
  assert.deepEqual(plan3.upToDate, ["gone.py"]);
  assert.deepEqual(plan3.clean, []);
});

// -----------------------------------------------------------------------------
// 4. Selection, outcomes, summary
// -----------------------------------------------------------------------------

test("changedPaths includes a rename's previous filename", () => {
  const files = [
    { filename: "src/new_name.py", previous_filename: "src/old_name.py", status: "renamed" },
    { filename: "README.md", status: "modified" },
    { filename: "README.md", status: "modified" },
  ];
  assert.deepEqual(changedPaths(files), ["src/new_name.py", "src/old_name.py", "README.md"]);
});

test("the file selection is honoured - it used to be decorative", () => {
  // The old script recorded `selected_files` in the sync record and in the PR
  // body, then merged the entire template HEAD regardless. The modal said
  // "Files to Synchronize (1/1)" while the operation carried every file.
  const changed = ["a.py", "b.py", "c.py"];

  assert.deepEqual(resolveSelection(changed, ["b.py"]), ["b.py"]);
  assert.deepEqual(resolveSelection(changed, ["*"]), changed);
  assert.deepEqual(resolveSelection(changed, []), changed);
  assert.deepEqual(resolveSelection(changed, undefined), changed);

  // A path that is not part of this commit has no content to copy and no base
  // to compare against, so it is dropped rather than acted on.
  assert.deepEqual(resolveSelection(changed, ["b.py", "not-in-commit.py"]), ["b.py"]);
});

test("summarize counts a merged-and-pr student under both headings", () => {
  const summary = summarize([
    { outcome: "auto-merged" },
    { outcome: "merged-and-pr" },
    { outcome: "pr-opened" },
    { outcome: "skipped-up-to-date" },
    { outcome: "skipped-no-repo" },
    { outcome: "failed" },
  ]);

  assert.deepEqual(summary, { total: 6, auto_merged: 2, pr_opened: 2, skipped: 2, failed: 1 });

  // Deliberately not asserted to sum to `total`: the counters describe what
  // happened, and one student can be in two of them.
  assert.ok(summary.auto_merged + summary.pr_opened + summary.skipped + summary.failed > summary.total);
});

test("re-running the same sync adopts its pull request instead of opening another", () => {
  // Observed live on the second run of a rehearsal: the same one-file
  // correction opened PR #1 and then PR #3 in the same student repository.
  // Re-running is the first thing a lecturer does when a sync looks like it did
  // nothing, so this has to be idempotent or it litters every repo that has an
  // edit in it.
  const sha = "a".repeat(40);
  const other = "b".repeat(40);

  const pulls = [
    { number: 7, html_url: "https://example/7", body: "unrelated student PR" },
    { number: 9, html_url: "https://example/9", body: `Starter update\n\n${syncMarker(sha)}` },
  ];

  assert.equal(findExistingSyncPr(pulls, sha).number, 9);

  // A DIFFERENT correction is a different pull request, not an adoption.
  assert.equal(findExistingSyncPr(pulls, other), null);

  // No open PRs, a null body, an absent list: all "nothing to adopt", never a throw.
  assert.equal(findExistingSyncPr([], sha), null);
  assert.equal(findExistingSyncPr([{ number: 1 }], sha), null);
  assert.equal(findExistingSyncPr(undefined, sha), null);
});

test("both executors walk the whole PR list before deciding to open one", () => {
  // One page is not the list, and here a missed marker is a duplicate pull
  // request rather than a visible error - so it fails silently, which is
  // exactly the shape CLAUDE.md's pagination rule exists for.
  const script = readFileSync(join(process.cwd(), "scripts/sync-starter.mjs"), "utf8");
  const cli = readFileSync(join(process.cwd(), "cli/src/commands/sync-starter.mjs"), "utf8");

  assert.match(script, /ghAll\(`\/repos\/\$\{[^}]*\}\/pulls\?state=open/);
  assert.match(cli, /octokit\.paginate\(octokit\.rest\.pulls\.list/);
  for (const [name, src] of [["scripts", script], ["cli", cli]]) {
    assert.match(src, /findExistingSyncPr/, `${name} must check for an existing sync PR`);
    assert.match(src, /syncMarker\(/, `${name} must stamp the marker it later looks for`);
  }
});

test("nothing outside lib/starter-sync.mjs decides clean-vs-conflict for itself", () => {
  // Same guard as tests/effective-deadline.test.mjs: the pre-flight in the
  // modal, the workflow script and the CLI must reach the same verdict, or the
  // modal promises one thing and the workflow does another.
  const consumers = [
    "scripts/sync-starter.mjs",
    "cli/src/commands/sync-starter.mjs",
    "frontend/src/components/StarterSyncModal.vue",
  ];
  for (const file of consumers) {
    const src = readFileSync(join(process.cwd(), file), "utf8");
    // Through the PER-STUDENT planner, and never around it: a direct
    // planStarterSync call with one commit's parent as the base is the
    // single-commit sync that left lab 3 of .NET Advanced with 43 students who
    // could never be sent it again.
    assert.match(src, /planStudent/, `${file} must plan through lib/starter-sync-cohort.mjs planStudent`);
    assert.doesNotMatch(stripComments(src), /planStarterSync\s*\(/, `${file} must not plan a single commit for itself`);
    assert.doesNotMatch(
      // Comments stripped first: every one of these files explains the removed
      // `POST /merges` by quoting it, and a scanner that reads the explanation
      // as the code is the failure mode tests/student-wait-copy.test.mjs
      // already had to fix once.
      stripComments(src),
      /compare\/\$\{[^}]*\}\.\.\.main|repos\.merge\(|["'`]\/merges/,
      `${file} must not merge or compare a template SHA against a student repo: the compare 404s and the merge carries the whole tree`,
    );
  }
});

// --- the script itself, end to end -------------------------------------------
//
// Everything above tests lib/starter-sync.mjs, which decides clean-vs-conflict.
// Nothing drove scripts/sync-starter.mjs, and the bug below lived in the part
// no test reached: the per-student work is carefully wrapped so one student's
// failure is recorded and the loop continues, but the record PARSE sat outside
// that try. One unreadable repositories/<id>/<login>.json threw out of main(),
// so the run stopped partway and the sync record was never written - after
// students earlier in the list had already had a commit pushed to their main
// and a pull request opened against it. The one document that says who got the
// correction is exactly what was lost.
//
// `commitWithRebase` does not take an apiBase and defaults to api.github.com,
// so this drives the path that writes nothing: a student whose tree already
// carries the head blob is `skipped-up-to-date`.

function runSyncStarter({ records, env: extraEnv = {}, requested = [], controlWrites = [], controlDenied = false, behind = false, issues = [], assign = null, issueStatus = 201 }) {
  const dir = mkdtempSync(join(tmpdir(), "pxl-sync-"));
  mkdirSync(join(dir, "assignments"), { recursive: true });
  writeFileSync(
    join(dir, "assignments", "exam.yml"),
    "state: published\ntemplate:\n  owner: TestOrg\n  repository: tpl\n",
  );
  mkdirSync(join(dir, "repositories", "exam"), { recursive: true });
  for (const [name, body] of Object.entries(records)) {
    writeFileSync(join(dir, "repositories", "exam", name), body);
  }

  const HEAD_SHA = "a".repeat(40);
  const BASE_SHA = "b".repeat(40);
  const tree = (sha) => ({ truncated: false, tree: [{ path: "README.md", type: "blob", sha }] });
  const server = createServer((req, res) => {
    const [path] = req.url.split("?");
    const send = (code, body) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    requested.push(req.url);
    // The control repo, written through the Git Data API: the sync record at
    // its start, as it goes and at its end. Each record written is decoded
    // into `controlWrites`, in order.
    const ctl = "/repos/TestOrg/pxl-classroom-control/git";
    // A permission refusal, which is not retried - the shape a token without
    // write on the control repository gets.
    if (controlDenied && path.startsWith(ctl)) return send(403, { message: "Resource not accessible by integration" });
    if (path === `${ctl}/ref/heads%2Fmain`) return send(200, { object: { sha: "c".repeat(40) } });
    if (path.startsWith(`${ctl}/commits/`)) return send(200, { sha: "c".repeat(40), tree: { sha: "t".repeat(40) } });
    if (path === `${ctl}/blobs` && req.method === "POST") {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        controlWrites.push(JSON.parse(Buffer.from(JSON.parse(body).content, "base64").toString("utf8")));
        send(201, { sha: "b".repeat(40) });
      });
      return;
    }
    if (path === `${ctl}/trees` && req.method === "POST") return send(201, { sha: "t".repeat(40) });
    if (path === `${ctl}/commits` && req.method === "POST") return send(201, { sha: "d".repeat(40) });
    if (path === `${ctl}/refs/heads%2Fmain` && req.method === "PATCH") return send(200, { object: { sha: "d".repeat(40) } });
    if (path === "/repos/TestOrg/tpl/commits") return send(200, [{ sha: HEAD_SHA }]);
    // GitHub resolves an abbreviated sha to the commit, as this does: any
    // prefix of HEAD_SHA of at least 7 characters.
    const named = path.match(/^\/repos\/TestOrg\/tpl\/commits\/([0-9a-f]{7,40})$/);
    if (named && HEAD_SHA.startsWith(named[1])) {
      return send(200, {
        sha: HEAD_SHA,
        commit: { message: "Fix a typo in the brief" },
        parents: [{ sha: BASE_SHA }],
        files: [{ filename: "README.md", status: "modified" }],
      });
    }
    if (path === `/repos/TestOrg/tpl/git/trees/${HEAD_SHA}`) return send(200, tree("blob-new"));
    if (path === `/repos/TestOrg/tpl/git/trees/${BASE_SHA}`) return send(200, tree("blob-old"));
    if (path.startsWith("/repos/TestOrg/tpl/git/blobs/")) {
      return send(200, { content: Buffer.from("hello").toString("base64"), encoding: "base64" });
    }
    // Every student already carries the head blob, so nothing is written -
    // unless `behind`, where they carry the base blob untouched and the
    // correction is committed to their main and announced in an issue.
    if (/^\/repos\/TestOrg\/[^/]+\/git\/trees\/main$/.test(path)) return send(200, tree(behind ? "blob-old" : "blob-new"));
    const stu = path.match(/^\/repos\/TestOrg\/(exam-[^/]+)\/(.*)$/);
    if (stu && behind) {
      const [, repo, rest] = stu;
      const readBody = (then) => {
        let body = "";
        req.on("data", (d) => (body += d));
        req.on("end", () => then(body ? JSON.parse(body) : {}));
      };
      if (rest === "git/ref/heads%2Fmain") return send(200, { object: { sha: "c".repeat(40) } });
      if (rest.startsWith("git/commits/")) return send(200, { sha: "c".repeat(40), tree: { sha: "t".repeat(40) } });
      // The inline scratch tree reads back as nothing, so the verification
      // falls back to blobs - the path that is certain to be correct.
      if (rest === "git/trees" && req.method === "POST") return send(201, { sha: "s".repeat(40) });
      if (rest.startsWith("git/trees/")) return send(200, { truncated: false, tree: [] });
      if (rest === "git/blobs" && req.method === "POST") return send(201, { sha: "e".repeat(40) });
      if (rest === "git/commits" && req.method === "POST") return send(201, { sha: "f".repeat(40) });
      if (rest === "git/refs/heads%2Fmain" && req.method === "PATCH") return send(200, { object: { sha: "f".repeat(40) } });
      if (rest === "issues" && req.method === "POST") {
        return readBody((b) => {
          if (issueStatus >= 300) return send(issueStatus, { message: "Issues are disabled for this repo" });
          issues.push({ repo, ...b, assigned: null });
          send(201, { number: issues.length, html_url: `https://github.com/TestOrg/${repo}/issues/${issues.length}` });
        });
      }
      const asg = rest.match(/^issues\/(\d+)\/assignees$/);
      if (asg && req.method === "POST") {
        return readBody((b) => {
          const issue = issues[Number(asg[1]) - 1];
          const answer = assign ? assign(b.assignees) : { status: 201, assignees: b.assignees };
          if (issue) issue.assigned = b.assignees;
          send(answer.status, answer.status < 300
            ? { number: Number(asg[1]), assignees: answer.assignees.map((login) => ({ login })) }
            : { message: "Validation Failed" });
        });
      }
    }
    return send(404, { message: `not stubbed: ${path}` });
  });

  // `spawn`, never `spawnSync`: the stub server runs on THIS event loop, and a
  // synchronous child blocks it - so the script's first request would never be
  // answered and the test would hang rather than fail.
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const child = spawn("node", [join(here, "..", "scripts", "sync-starter.mjs")], {
        env: {
          ...process.env,
          GITHUB_TOKEN: "stub",
          GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`,
          ORG: "TestOrg",
          ASSIGNMENT_ID: "exam",
          DATA_DIR: dir,
          CREATE_ISSUE: "false",
          ...extraEnv,
        },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", reject);
      child.on("close", (status) => {
        server.close(() => {
          let record = null;
          try {
            const syncDir = join(dir, "syncs", "exam");
            record = JSON.parse(readFileSync(join(syncDir, readdirSync(syncDir)[0]), "utf8"));
          } catch { /* left null - the test says what that means */ }
          resolve({ status, stdout, stderr, record });
        });
      });
    });
  });
}

test("an unreadable repository record does not abandon the run, or the record of it", async () => {
  const res = await runSyncStarter({
    records: {
      "alice.json": JSON.stringify({ github_login: "alice", repo_name: "TestOrg/exam-alice" }),
      "bob.json": "{ this is not json",
      "carol.json": JSON.stringify({ github_login: "carol", repo_name: "TestOrg/exam-carol" }),
    },
  });

  assert.equal(res.status, 0, `the run must finish:\n${res.stdout}\n${res.stderr}`);
  assert.ok(res.record, "the sync record must be written - it is what says who got the correction");

  const byLogin = Object.fromEntries(res.record.results.map((r) => [r.github_login, r]));
  assert.equal(byLogin.alice?.outcome, "skipped-up-to-date");
  assert.equal(byLogin.carol?.outcome, "skipped-up-to-date", "a student AFTER the bad record is still processed");
  // Named from the filename, which still identifies the student when the
  // contents do not.
  assert.equal(byLogin.bob?.outcome, "failed");
  assert.match(byLogin.bob.error, /unreadable/);
  assert.equal(res.record.summary.failed, 1);
  assert.equal(res.record.summary.skipped, 2);
});

test("the sync record still validates with a failed row in it", () => {
  // The row the fix adds has to be a document the backend can read back, or the
  // validate-before-write below it turns one bad record into no record at all -
  // which is the failure it was guarding against.
  const doc = {
    schema_version: 1,
    sync_id: "sync-20260901T120000Z-abc123",
    assignment_id: "exam",
    synced_at: "2026-09-01T12:00:00Z",
    synced_by: "lecturer",
    template_repo: "TestOrg/tpl",
    template_sha: "a".repeat(40),
    selected_files: ["README.md"],
    pr_title: "t",
    pr_body: "b",
    created_issues: false,
    summary: { total: 1, auto_merged: 0, pr_opened: 0, skipped: 0, failed: 1 },
    results: [
      { github_login: "bob", repo_name: "unknown", outcome: "failed", error: "repository record unreadable: x" },
    ],
  };
  assert.equal(validateSyncRecord(doc), true, JSON.stringify(validateSyncRecord.errors));
});

// -----------------------------------------------------------------------------
// Syncing a NAMED commit, not the newest
//
// 2026-09-25, PXL-2TIN-NetAdv-26-27: the lab 3 sync (81 added files) reached 31
// of 111 students before the job timed out, and lab 4 was synced over it. A
// sync only ever took the newest commit, so nothing could send lab 3 to the
// other 43 again.
// -----------------------------------------------------------------------------

// The request for the newest commit alone - exactly `per_page=1`, which
// `per_page=100` (the commit LIST starting points are read from) is not.
const NEWEST_ONLY = /^\/repos\/TestOrg\/tpl\/commits\?per_page=1(&|$)/;

test("readTemplateCommit takes a hex sha and nothing that could move", () => {
  assert.equal(readTemplateCommit(""), null);
  assert.equal(readTemplateCommit("   "), null);
  assert.equal(readTemplateCommit(undefined), null);
  assert.equal(readTemplateCommit("1e7f714"), "1e7f714");
  assert.equal(readTemplateCommit(" 1E7F714 "), "1e7f714");
  assert.equal(readTemplateCommit("a".repeat(40)), "a".repeat(40));
  // A branch or tag would resolve too, and move under the lecturer.
  for (const bad of ["main", "v1.0", "1e7f71", "a".repeat(41), "1e7f714; rm -rf /", "HEAD~1", "1e7f71g"]) {
    assert.match(readTemplateCommit(bad).error, /not a commit sha/, bad);
  }
});

test("THE LAB 3 RE-SYNC: the 43 get every file, the 68 are skipped, an edit is kept", () => {
  // lab 2 (base) -> lab 3 adds three files (head). Lab 4 came after and is
  // irrelevant here: it touched none of lab 3's paths.
  const baseTree = new Map([["Lab02/Program.cs", "l2"]]);
  const headTree = new Map([
    ["Lab02/Program.cs", "l2"],
    ["Lab03/Program.cs", "l3a"],
    ["Lab03/Tests.cs", "l3b"],
    ["Lab03/Lab03.csproj", "l3c"],
  ]);
  const paths = ["Lab03/Program.cs", "Lab03/Tests.cs", "Lab03/Lab03.csproj"];
  const lab4 = [["Lab04/Program.cs", "l4"]];

  // Missed lab 3, got lab 4, has edited lab 2.
  const missed = new Map([["Lab02/Program.cs", "their-lab2"], ...lab4]);
  const p1 = planStarterSync({ headTree, baseTree, studentTree: missed, paths });
  assert.deepEqual(p1.clean.map((c) => c.path), paths);
  assert.equal(outcomeFor(p1), "auto-merged");

  // Got lab 3 this morning, untouched.
  const got = new Map([...headTree, ...lab4]);
  const p2 = planStarterSync({ headTree, baseTree, studentTree: got, paths });
  assert.equal(outcomeFor(p2), "skipped-up-to-date");
  assert.deepEqual(p2.kept, []);

  // Got lab 3 and has already worked in Program.cs.
  const working = new Map([...headTree, ["Lab03/Program.cs", "their-lab3"], ...lab4]);
  const p3 = planStarterSync({ headTree, baseTree, studentTree: working, paths });
  assert.equal(outcomeFor(p3), "skipped-up-to-date", "no pull request offering to reset their work");
  assert.deepEqual(p3.kept, ["Lab03/Program.cs"]);
  assert.deepEqual(p3.conflicts, []);
});

test("the script syncs the NAMED commit and never asks for the newest", async () => {
  const requested = [];
  const res = await runSyncStarter({
    records: { "alice.json": JSON.stringify({ github_login: "alice", repo_name: "TestOrg/exam-alice" }) },
    env: { TEMPLATE_COMMIT: "aaaaaaa" },
    requested,
  });
  assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
  assert.match(res.stdout, /Syncing the named commit aaaaaaa, not the newest/);
  // The template's commit LIST is read (it is where starting points come from,
  // 100 a page); the newest commit alone (`per_page=1`) is never asked for.
  assert.equal(requested.some((u) => NEWEST_ONLY.test(u)), false, requested.join("\n"));
  assert.ok(requested.includes("/repos/TestOrg/tpl/commits/aaaaaaa"));
  // Recorded under the FULL sha, which is what the pull request marker keys on.
  assert.equal(res.record.template_sha, "a".repeat(40));
});

test("blank still means the newest commit", async () => {
  const requested = [];
  const res = await runSyncStarter({
    records: { "alice.json": JSON.stringify({ github_login: "alice", repo_name: "TestOrg/exam-alice" }) },
    env: { TEMPLATE_COMMIT: "" },
    requested,
  });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(requested.some((u) => NEWEST_ONLY.test(u)), requested.join("\n"));
});

test("a sha that is not in the template stops the run before any student is touched", async () => {
  const requested = [];
  const res = await runSyncStarter({
    records: { "alice.json": JSON.stringify({ github_login: "alice", repo_name: "TestOrg/exam-alice" }) },
    env: { TEMPLATE_COMMIT: "bbbbbbb" },
    requested,
  });
  assert.notEqual(res.status, 0);
  assert.match(res.stdout + res.stderr, /has no commit bbbbbbb/);
  assert.equal(requested.some((u) => u.includes("exam-alice")), false, "no student repository was read");
  assert.equal(res.record, null);
});

test("something that is not a sha is refused without asking GitHub anything", async () => {
  const requested = [];
  const res = await runSyncStarter({
    records: { "alice.json": JSON.stringify({ github_login: "alice", repo_name: "TestOrg/exam-alice" }) },
    env: { TEMPLATE_COMMIT: "main" },
    requested,
  });
  assert.notEqual(res.status, 0);
  assert.match(res.stdout + res.stderr, /not a commit sha/);
  assert.equal(requested.some((u) => u.includes("/commits")), false, requested.join("\n"));
});

test("the workflow passes the field through env, and the record permits files_kept", () => {
  const wf = readFileSync(join(here, "..", ".github", "workflows", "sync-starter-code.yml"), "utf8");
  assert.match(wf, /template_commit:\n\s+description:/);
  assert.match(wf, /TEMPLATE_COMMIT: \$\{\{ inputs\.template_commit \}\}/);
  assert.equal(/node scripts\/sync-starter\.mjs[^\n]*inputs\./.test(wf), false, "never composed into the script");
  const schema = JSON.parse(readFileSync(join(here, "..", "schemas", "sync-record.schema.json"), "utf8"));
  assert.ok("files_kept" in schema.properties.results.items.properties);
});

// -----------------------------------------------------------------------------
// The record: written when the run starts, as it goes, and when it ends
//
// It used to be written once, at the end, by a later workflow step - so the
// runs the timeout stopped on 2026-09-25 left no record of the students they
// had already changed, and nothing could say a sync was running or had stopped.
// -----------------------------------------------------------------------------

const student = (login) => [`${login}.json`, JSON.stringify({ github_login: login, repo_name: `TestOrg/exam-${login}` })];

test("the start is recorded BEFORE any student is touched, and the end after", async () => {
  const controlWrites = [];
  const requested = [];
  const res = await runSyncStarter({
    records: Object.fromEntries([student("alice"), student("bob")]),
    env: { GITHUB_RUN_ID: "4242", GITHUB_REPOSITORY: "Hub/pxl-classroom", GITHUB_SERVER_URL: "https://github.com" },
    controlWrites,
    requested,
  });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.equal(controlWrites.length, 2, "start and end, no progress write for two students");
  const [start, end] = controlWrites;

  assert.equal(start.status, "running");
  assert.equal(start.total_students, 2);
  assert.deepEqual(start.results, []);
  assert.equal(start.run_id, 4242);
  assert.equal(start.run_url, "https://github.com/Hub/pxl-classroom/actions/runs/4242");
  assert.equal("finished_at" in start, false);
  assert.equal("remaining" in start, false);

  assert.equal(end.status, "completed");
  assert.equal(end.remaining, 0);
  assert.ok(end.finished_at);
  assert.equal(end.sync_id, start.sync_id, "one record, rewritten");
  assert.equal(end.results.length, 2);
  for (const doc of controlWrites) assert.equal(validateSyncRecord(doc), true, JSON.stringify(validateSyncRecord.errors));

  // Ordering against the students: the start record's commit precedes the
  // first read of a student repository.
  const firstStudent = requested.findIndex((u) => u.includes("/exam-"));
  const firstRecord = requested.findIndex((u) => u.includes("pxl-classroom-control/git/blobs"));
  assert.ok(firstRecord >= 0 && firstRecord < firstStudent, requested.join("\n"));
  // The checkout copy is the final one.
  assert.equal(res.record.status, "completed");
});

test("a sync that cannot record its start sends NOTHING", async () => {
  const requested = [];
  const res = await runSyncStarter({
    records: Object.fromEntries([student("alice")]),
    requested,
    controlDenied: true,
  });
  assert.notEqual(res.status, 0);
  assert.equal(requested.some((u) => u.includes("/exam-")), false, "no student repository was read");
});

test("at its time budget the sync STOPS ITSELF and records who is left", async () => {
  const controlWrites = [];
  const res = await runSyncStarter({
    records: Object.fromEntries([student("alice"), student("bob"), student("carol")]),
    // Spent before the first student: the start record alone takes longer.
    env: { SYNC_BUDGET_MS: "1" },
    controlWrites,
  });
  assert.equal(res.status, 0, "stopping at the budget is an outcome, not a failure");
  assert.match(res.stdout, /time budget reached with 3 student\(s\) not yet reached - run the sync again/);
  const end = controlWrites.at(-1);
  assert.equal(end.status, "stopped");
  assert.equal(end.remaining, 3);
  assert.equal(end.total_students, 3);
  assert.deepEqual(end.results, []);
});

test("progress is recorded as it goes, so a run that dies still says who it reached", async () => {
  const controlWrites = [];
  const logins = Array.from({ length: 22 }, (_, i) => `s${String(i).padStart(2, "0")}`);
  const res = await runSyncStarter({ records: Object.fromEntries(logins.map(student)), controlWrites });
  assert.equal(res.status, 0, res.stderr);
  const progress = controlWrites.filter((d) => d.status === "running" && d.results.length > 0);
  assert.equal(progress.length, 1, "one progress write after 20 students");
  assert.equal(progress[0].results.length, 20);
  assert.equal(controlWrites.at(-1).results.length, 22);
});

test("the workflow no longer commits the record in a later step", () => {
  const wf = readFileSync(join(here, "..", ".github", "workflows", "sync-starter-code.yml"), "utf8");
  assert.doesNotMatch(wf, /name: Commit sync records/);
  assert.match(wf, /concurrency:\n\s+group: sync-starter-\$\{\{ inputs\.org \}\}-\$\{\{ inputs\.assignment_id \}\}\n\s+cancel-in-progress: false/);
});

test("a notification issue that could not be created is recorded, not just logged", async () => {
  // The issue IS how a student learns a pull request is waiting. `if (ok)` with
  // no else left the row looking like a clean sync, and the record is what a
  // lecturer reads to see who still needs a second look. Run, not grepped: a
  // source match cannot tell the branch is reachable.
  const issues = [];
  const res = await runSyncStarter({
    records: Object.fromEntries([student("alice")]),
    env: { CREATE_ISSUE: "true" }, behind: true, issues, issueStatus: 410,
  });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  const row = res.record.results[0];
  assert.equal(row.outcome, "auto-merged");
  assert.match(row.issue_error, /^HTTP 410/);
  assert.equal("issue_assignees" in row, false, "no issue, nothing to assign");
  assert.equal(validateSyncRecord(res.record), true, JSON.stringify(validateSyncRecord.errors));
});

// --- the tracking issue is ASSIGNED, so it is emailed ------------------------
//
// 2026-09-25: an unassigned issue emails only people who watch the repository,
// and a lecturer who had accepted their own assignment got nothing.

test("the issue is assigned to the student whose repository it is, and the record says so", async () => {
  const issues = [];
  const res = await runSyncStarter({
    records: Object.fromEntries([student("alice"), student("bob")]),
    env: { CREATE_ISSUE: "true" }, behind: true, issues,
  });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.deepEqual(issues.map((i) => [i.repo, i.assigned]), [["exam-alice", ["alice"]], ["exam-bob", ["bob"]]]);
  // Created WITHOUT assignees, then assigned: a bad assignee can never cost the issue.
  assert.ok(issues.every((i) => !("assignees" in i)), "the create call carries no assignees");
  for (const row of res.record.results) assert.deepEqual(row.issue_assignees, [row.github_login]);
  assert.equal(validateSyncRecord(res.record), true, JSON.stringify(validateSyncRecord.errors));
});

test("a group repository's issue is assigned to every member, once", async () => {
  const team = (login) => [`${login}.json`, JSON.stringify({ github_login: login, team_slug: "t1", repo_name: "TestOrg/exam-t1" })];
  const issues = [];
  const res = await runSyncStarter({
    records: Object.fromEntries([team("ann"), team("ben"), team("cas")]),
    env: { CREATE_ISSUE: "true" }, behind: true, issues,
  });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  // The stub does not remember the first commit, so each member's record syncs
  // the shared repository again; every issue it opens names the whole team,
  // with the record's own member first.
  assert.ok(issues.length >= 1);
  assert.deepEqual([...issues[0].assigned].sort(), ["ann", "ben", "cas"]);
  assert.equal(issues[0].assigned[0], "ann");
});

test("an account GitHub will not assign is left off, the issue stands, and the log says who", async () => {
  const issues = [];
  const res = await runSyncStarter({
    records: Object.fromEntries([student("alice")]),
    env: { CREATE_ISSUE: "true" }, behind: true, issues,
    // GitHub answers 201 and simply does not add an account without access.
    assign: () => ({ status: 201, assignees: [] }),
  });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  const row = res.record.results[0];
  assert.ok(row.issue_url, "the issue exists");
  assert.equal(row.issue_error, undefined);
  assert.deepEqual(row.issue_assignees, []);
  assert.match(res.stdout, /could not assign alice/);
});

test("the assign call failing outright is not a failed sync either", async () => {
  const res = await runSyncStarter({
    records: Object.fromEntries([student("alice")]),
    env: { CREATE_ISSUE: "true" }, behind: true,
    assign: () => ({ status: 422 }),
  });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  const row = res.record.results[0];
  assert.equal(row.outcome, "auto-merged");
  assert.ok(row.issue_url);
  assert.deepEqual(row.issue_assignees, []);
  assert.match(res.stdout, /could not be assigned \(HTTP 422\)/);
});

test("with issues off, nobody is assigned anything", async () => {
  const issues = [];
  const requested = [];
  const res = await runSyncStarter({ records: Object.fromEntries([student("alice")]), behind: true, issues, requested });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.equal(issues.length, 0);
  assert.equal(requested.some((u) => u.includes("/assignees")), false);
  assert.equal("issue_assignees" in res.record.results[0], false);
});
