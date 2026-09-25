// A starter sync sends each student what they are MISSING, from their own
// starting point - lib/starter-sync.mjs (`startingPointFor`, `diffTreePaths`,
// the `!path` selection) and lib/starter-sync-cohort.mjs (the reads).
//
// The case it exists for, 2026-09-25, PXL-2TIN-NetAdv-26-27: lab 3 reached 31
// of 111 students before its run was stopped, lab 4 was synced over it, and a
// sync that only ever sent the newest commit's changes could never have sent
// lab 3 to the other 43.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  diffTreePaths,
  resolveSelection,
  selectionIsAll,
  startingPointFor,
  outcomeFor,
  REACHED_OUTCOMES,
} from "../lib/starter-sync.mjs";
import { listTemplateCommits, planStudent, rootTreeSha, treeReader } from "../lib/starter-sync-cohort.mjs";

const sha = (c) => c.repeat(40);
const LAB2 = sha("2");
const LAB3 = sha("3");
const LAB4 = sha("4");

const TREES = {
  [LAB2]: new Map([["README.md", "r"], ["Lab02/Program.cs", "l2"]]),
  [LAB3]: new Map([["README.md", "r"], ["Lab02/Program.cs", "l2"], ["Lab03/Program.cs", "l3"], ["Lab03/Tests.cs", "t3"]]),
  [LAB4]: new Map([["README.md", "r"], ["Lab02/Program.cs", "l2"], ["Lab03/Program.cs", "l3"], ["Lab03/Tests.cs", "t3"], ["Lab04/Program.cs", "l4"]]),
};
// The tree shas GitHub gives each commit - what a generated repository's first
// commit carries.
const COMMITS = [
  { sha: LAB4, treeSha: "tree-4", date: "2026-09-25T12:05:21Z" },
  { sha: LAB3, treeSha: "tree-3", date: "2026-09-25T11:36:21Z" },
  { sha: LAB2, treeSha: "tree-2", date: "2026-09-17T09:34:42Z" },
];

const record = (over = {}, results = []) => ({
  schema_version: 1,
  sync_id: "sync-20260925T151518Z-b1gcxj",
  assignment_id: "labs",
  synced_at: "2026-09-25T15:15:18Z",
  synced_by: "lecturer1",
  template_repo: "Org/tpl",
  template_sha: LAB4,
  selected_files: [],
  per_student_range: true,
  all_files: true,
  summary: { total: results.length, auto_merged: 0, pr_opened: 0, skipped: 0, failed: 0 },
  results,
  ...over,
});
const row = (login, outcome = "auto-merged", from_source = "generated") => ({ github_login: login, repo_name: `Org/labs-${login}`, outcome, from_source });

// =============================================================================
// The pure decisions
// =============================================================================

test("diffTreePaths is every path whose content differs, both directions, sorted", () => {
  assert.deepEqual(diffTreePaths(TREES[LAB2], TREES[LAB4]), ["Lab03/Program.cs", "Lab03/Tests.cs", "Lab04/Program.cs"]);
  assert.deepEqual(diffTreePaths(TREES[LAB4], TREES[LAB4]), []);
  // A deletion is a difference too, and a changed blob is one.
  assert.deepEqual(
    diffTreePaths(new Map([["a", "1"], ["b", "1"]]), new Map([["a", "2"]])),
    ["a", "b"],
  );
  assert.deepEqual(diffTreePaths(new Map(), new Map([["x", "1"]])), ["x"]);
});

test("a selection is everything, minus what was unticked", () => {
  const range = ["Lab03/Program.cs", "Lab03/Tests.cs", "Lab04/Program.cs"];
  assert.deepEqual(resolveSelection(range, ["*"]), range);
  assert.deepEqual(resolveSelection(range, ["*", "!Lab03/Tests.cs"]), ["Lab03/Program.cs", "Lab04/Program.cs"]);
  // An exclusion of a path not in the range changes nothing.
  assert.deepEqual(resolveSelection(range, ["*", "!nope"]), range);
  // Old-style inclusion lists still mean what they meant.
  assert.deepEqual(resolveSelection(range, ["Lab04/Program.cs"]), ["Lab04/Program.cs"]);
  assert.deepEqual(resolveSelection(range, []), range);
  assert.deepEqual(resolveSelection(range, undefined), range);
});

test("only an unnarrowed selection counts as 'everything'", () => {
  assert.equal(selectionIsAll(["*"]), true);
  assert.equal(selectionIsAll([]), true);
  assert.equal(selectionIsAll(undefined), true);
  assert.equal(selectionIsAll(["*", "!a"]), false);
  assert.equal(selectionIsAll(["a", "b"]), false);
});

test("a student's start is the newest per-student record that REACHED them", () => {
  const records = [
    record({ template_sha: LAB3, synced_at: "2026-09-25T11:40:00Z" }, [row("ada")]),
    record({ template_sha: LAB4, synced_at: "2026-09-25T13:00:00Z" }, [row("ada", "skipped-up-to-date", "synced")]),
  ];
  assert.deepEqual(startingPointFor({ login: "ADA", records }), { sha: LAB4, source: "synced" });
});

test("records that are NOT evidence of where a student is are ignored", () => {
  const cases = {
    "a single-commit record from before per-student ranges": record({ per_student_range: undefined }, [row("ada")]),
    "a record with files left out": record({ all_files: false }, [row("ada")]),
    "a record where the student failed": record({}, [row("ada", "failed")]),
    "a record with no repository for them": record({}, [row("ada", "skipped-no-repo")]),
    "a record whose start for them was unknown": record({}, [row("ada", "auto-merged", "unknown")]),
    "a record naming somebody else": record({}, [row("bo")]),
    "a record with a malformed sha": record({ template_sha: "not-a-sha" }, [row("ada")]),
  };
  for (const [why, r] of Object.entries(cases)) {
    const start = startingPointFor({ login: "ada", records: [r], rootTreeSha: "tree-2", templateCommits: COMMITS });
    assert.deepEqual(start, { sha: LAB2, source: "generated" }, why);
  }
  for (const o of REACHED_OUTCOMES) {
    assert.equal(startingPointFor({ login: "ada", records: [record({}, [row("ada", o)])] }).source, "synced", o);
  }
});

test("with no record, the template commit whose tree their first commit carries", () => {
  assert.deepEqual(
    startingPointFor({ login: "ada", rootTreeSha: "tree-3", templateCommits: COMMITS }),
    { sha: LAB3, source: "generated" },
  );
  // Two commits with one tree (a revert): the same files, so either is right;
  // the newest is taken.
  const reverted = [...COMMITS, { sha: sha("9"), treeSha: "tree-2", date: "2026-09-26T08:00:00Z" }];
  assert.equal(startingPointFor({ login: "ada", rootTreeSha: "tree-2", templateCommits: reverted }).sha, sha("9"));
});

test("unanswerable is the old behaviour - the head's parent - named as unknown", () => {
  assert.deepEqual(
    startingPointFor({ login: "ada", rootTreeSha: "tree-from-elsewhere", templateCommits: COMMITS, fallbackSha: LAB3 }),
    { sha: LAB3, source: "unknown" },
  );
  assert.deepEqual(startingPointFor({ login: "ada" }), { sha: null, source: "unknown" });
});

// =============================================================================
// The reads, over a fake GitHub
// =============================================================================

function fakeGitHub({ roots = {}, commitCounts = {}, treesDown = new Set(), headerStyle = "fetch", templateCommitPages = null } = {}) {
  const calls = [];
  const headers = (obj) =>
    headerStyle === "fetch" ? new Headers(obj) : Object.fromEntries(Object.entries(obj).map(([k, v]) => [k.toLowerCase(), v]));
  const get = async (path) => {
    calls.push(path);
    const u = new URL(`https://x${path}`);
    const tree = u.pathname.match(/^\/repos\/Org\/tpl\/git\/trees\/([0-9a-f]{40})$/);
    if (tree) {
      if (treesDown.has(tree[1]) || !TREES[tree[1]]) return { ok: false, status: 404, data: null };
      return { ok: true, status: 200, data: { truncated: false, tree: [...TREES[tree[1]]].map(([path, sha]) => ({ path, sha, type: "blob" })) } };
    }
    if (u.pathname === "/repos/Org/tpl/commits") {
      const page = Number(u.searchParams.get("page"));
      const pages = templateCommitPages || [COMMITS.map((c) => ({ sha: c.sha, commit: { tree: { sha: c.treeSha }, committer: { date: c.date } } }))];
      return { ok: true, status: 200, data: pages[page - 1] || [] };
    }
    const student = u.pathname.match(/^\/repos\/Org\/(labs-\w+)\/commits$/);
    if (student) {
      const repo = student[1];
      const n = commitCounts[repo] ?? 1;
      const page = Number(u.searchParams.get("page") || 1);
      const newest = { sha: `newest-${repo}`, commit: { tree: { sha: `tip-${repo}` } } };
      const oldest = { sha: `root-${repo}`, commit: { tree: { sha: roots[repo] } } };
      const link = n > 1 ? { Link: `<https://api.github.com${u.pathname}?sha=main&per_page=1&page=${n}>; rel="last"` } : {};
      return { ok: true, status: 200, headers: headers(link), data: [page === n ? oldest : newest] };
    }
    return { ok: false, status: 404, data: null };
  };
  return { get, calls };
}

test("rootTreeSha follows the LAST link to the first commit, with either header shape", async () => {
  for (const headerStyle of ["fetch", "object"]) {
    const { get, calls } = fakeGitHub({ roots: { "labs-ada": "tree-2" }, commitCounts: { "labs-ada": 57 }, headerStyle });
    assert.equal(await rootTreeSha(get, "Org/labs-ada", "main"), "tree-2", headerStyle);
    assert.equal(calls.length, 2);
    assert.match(calls[1], /page=57$/);
  }
});

test("rootTreeSha of a repository with ONE commit is that commit, in one request", async () => {
  // With a single commit the newest IS the oldest: GitHub answers one row and
  // no `last` link.
  const calls = [];
  const one = async (p) => {
    calls.push(p);
    return { ok: true, status: 200, headers: new Headers({}), data: [{ commit: { tree: { sha: "tree-4" } } }] };
  };
  assert.equal(await rootTreeSha(one, "Org/labs-bo", "main"), "tree-4");
  assert.equal(calls.length, 1);
});

test("rootTreeSha that cannot read answers null, never a guess", async () => {
  assert.equal(await rootTreeSha(async () => ({ ok: false, status: 403 }), "Org/x", "main"), null);
  // The last page failing is a failure too - not the newest commit.
  const half = async (p) =>
    p.includes("page=")
      ? { ok: false, status: 502 }
      : { ok: true, status: 200, headers: new Headers({ Link: '<https://api.github.com/x?page=9>; rel="last"' }), data: [{ commit: { tree: { sha: "tip" } } }] };
  assert.equal(await rootTreeSha(half, "Org/x", "main"), null);
});

test("listTemplateCommits walks every page and says when it stopped", async () => {
  const pageOf = (n, from) => Array.from({ length: n }, (_, i) => ({ sha: `${from + i}`.padStart(40, "0"), commit: { tree: { sha: `t${from + i}` }, committer: { date: "2026-01-01T00:00:00Z" } } }));
  const two = fakeGitHub({ templateCommitPages: [pageOf(100, 0), pageOf(3, 100)] });
  const res = await listTemplateCommits(two.get, "Org/tpl");
  assert.equal(res.complete, true);
  assert.equal(res.commits.length, 103);
  assert.equal(res.commits[102].treeSha, "t102");
  const many = fakeGitHub({ templateCommitPages: Array.from({ length: 11 }, (_, i) => pageOf(100, i * 100)) });
  assert.equal((await listTemplateCommits(many.get, "Org/tpl")).complete, false);
  const down = await listTemplateCommits(async () => ({ ok: false, status: 500 }), "Org/tpl");
  assert.equal(down.ok, false);
});

test("treeReader reads each commit once, refuses a truncated listing, retries a failure", async () => {
  let n = 0;
  let fail = true;
  const get = async (path) => {
    n++;
    if (path.includes("trunc")) return { ok: true, status: 200, data: { truncated: true, tree: [] } };
    if (fail) { fail = false; return { ok: false, status: 502 }; }
    return { ok: true, status: 200, data: { tree: [{ path: "a", sha: "1", type: "blob" }, { path: "d", sha: "2", type: "tree" }] } };
  };
  const read = treeReader(get);
  await assert.rejects(read("Org/r", "main"), /HTTP 502/);
  const t = await read("Org/r", "main");
  assert.deepEqual([...t], [["a", "1"]], "blobs only");
  await read("Org/r", "main");
  assert.equal(n, 2, "the failure was not cached; the success was");
  await assert.rejects(read("Org/trunc", "main"), /truncated/);
});

// =============================================================================
// One student's plan, end to end
// =============================================================================

async function plan(login, { studentTree, records = [], roots = {}, commitCounts = {}, selected = ["*"], treesDown, fallbackSha = LAB3, templateCommits = COMMITS }) {
  const { get, calls } = fakeGitHub({ roots, commitCounts, treesDown });
  const res = await planStudent({
    login,
    studentTree,
    readTree: treeReader(get),
    root: () => rootTreeSha(get, `Org/labs-${login}`, "main"),
    templateFullName: "Org/tpl",
    headSha: LAB4,
    headTree: TREES[LAB4],
    templateCommits,
    records,
    fallbackSha,
    selected,
  });
  return { ...res, calls };
}

test("THE CASE: generated at lab 2, lab 3 never arrived, lab 4 did - lab 3 is sent now", async () => {
  // What 43 students of .NET Advanced held on 2026-09-25 at 14:30.
  const studentTree = new Map([...TREES[LAB2], ["Lab02/Program.cs", "their-work"], ["Lab04/Program.cs", "l4"]]);
  const res = await plan("ada", { studentTree, roots: { "labs-ada": "tree-2" }, commitCounts: { "labs-ada": 12 } });
  assert.equal(res.source, "generated");
  assert.equal(res.from, LAB2);
  assert.deepEqual(res.plan.clean.map((c) => c.path), ["Lab03/Program.cs", "Lab03/Tests.cs"]);
  assert.deepEqual(res.plan.upToDate, ["Lab04/Program.cs"]);
  assert.deepEqual(res.plan.conflicts, [], "their lab 2 work is outside the range and untouched");
  assert.equal(outcomeFor(res.plan), "auto-merged");
});

test("under the OLD rule the same student would have been sent nothing", async () => {
  // Start unknown: the head's parent (lab 3) - exactly what every sync did.
  const studentTree = new Map([...TREES[LAB2], ["Lab04/Program.cs", "l4"]]);
  const res = await plan("ada", { studentTree, roots: { "labs-ada": "tree-from-elsewhere" } });
  assert.equal(res.source, "unknown");
  assert.equal(outcomeFor(res.plan), "skipped-up-to-date", "which is the bug this replaced");
});

test("a student a per-student sync already reached is not asked for their first commit", async () => {
  const records = [record({ template_sha: LAB4 }, [row("bo", "auto-merged", "generated")])];
  const res = await plan("bo", { studentTree: TREES[LAB4], records });
  assert.equal(res.source, "synced");
  assert.deepEqual(res.paths, []);
  assert.equal(res.calls.some((c) => c.includes("labs-bo/commits")), false, "no root lookup");
});

test("generated at lab 4: nothing to send, and their own work in lab 3 is not offered back", async () => {
  const studentTree = new Map([...TREES[LAB4], ["Lab03/Program.cs", "their-lab3"]]);
  const res = await plan("cy", { studentTree, roots: { "labs-cy": "tree-4" }, commitCounts: { "labs-cy": 5 } });
  assert.equal(res.from, LAB4);
  assert.equal(outcomeFor(res.plan), "skipped-up-to-date");
  assert.deepEqual(res.plan.conflicts, []);
});

test("generated at lab 2 and ALREADY caught up by hand: everything up to date, an edit kept", async () => {
  const studentTree = new Map([...TREES[LAB4], ["Lab03/Program.cs", "their-lab3"]]);
  const res = await plan("dee", { studentTree, roots: { "labs-dee": "tree-2" }, commitCounts: { "labs-dee": 30 } });
  assert.equal(outcomeFor(res.plan), "skipped-up-to-date");
  assert.deepEqual(res.plan.kept, ["Lab03/Program.cs"]);
});

test("unticking a catch-up file leaves it out, and only it", async () => {
  const studentTree = new Map([...TREES[LAB2], ["Lab04/Program.cs", "l4"]]);
  const res = await plan("ada", {
    studentTree, roots: { "labs-ada": "tree-2" }, commitCounts: { "labs-ada": 2 }, selected: ["*", "!Lab03/Tests.cs"],
  });
  assert.deepEqual(res.plan.clean.map((c) => c.path), ["Lab03/Program.cs"]);
});

test("a starting commit the template no longer holds falls back to the old behaviour, named", async () => {
  // A force-pushed template: the record points at a commit whose tree is gone.
  const records = [record({ template_sha: sha("7") }, [row("eve")])];
  const res = await plan("eve", { studentTree: TREES[LAB3], records });
  assert.equal(res.source, "unknown");
  assert.equal(res.from, LAB3);
  assert.deepEqual(res.plan.clean.map((c) => c.path), ["Lab04/Program.cs"]);
});

test("A SYNC NEVER MOVES A STUDENT BACKWARDS: syncing to an older commit sends a later starter nothing", async () => {
  // A lecturer names lab 3 (`template_commit`) while a student was generated
  // at lab 4. Their range would run lab 4 -> lab 3: Lab04/Program.cs is in the
  // start and not the target, untouched, so it would be a CLEAN DELETE. On
  // 2026-09-25 that is 37 students of .NET Advanced losing lab 4.
  const { get } = fakeGitHub({ roots: { "labs-hal": "tree-4" }, commitCounts: { "labs-hal": 4 } });
  const res = await planStudent({
    login: "hal", studentTree: TREES[LAB4], readTree: treeReader(get), root: () => rootTreeSha(get, "Org/labs-hal", "main"),
    templateFullName: "Org/tpl", headSha: LAB3, headTree: TREES[LAB3], templateCommits: COMMITS,
    records: [], fallbackSha: LAB2, selected: ["*"],
  });
  assert.equal(res.from, LAB4);
  assert.deepEqual(res.paths, [], "nothing is in range");
  assert.deepEqual(res.plan.clean, [], "and above all, nothing is deleted");
  assert.equal(outcomeFor(res.plan), "skipped-up-to-date");

  // The same from a RECORD: synced to lab 4, then a sync named lab 3.
  const records = [record({ template_sha: LAB4 }, [row("ivy")])];
  const viaRecord = await planStudent({
    login: "ivy", studentTree: TREES[LAB4], readTree: treeReader(get), root: async () => null,
    templateFullName: "Org/tpl", headSha: LAB3, headTree: TREES[LAB3], templateCommits: COMMITS,
    records, fallbackSha: LAB2, selected: ["*"],
  });
  assert.deepEqual(viaRecord.plan.clean, []);
});

test("an order that cannot be established falls back to the old behaviour, never a guess", async () => {
  // The start is not in the template's listed history (a record older than
  // the 1,000 commits listed, or the listing failed): which way the range runs
  // is unknown, so it is not run at all.
  const { get } = fakeGitHub({});
  const records = [record({ template_sha: LAB4 }, [row("jo")])];
  const res = await planStudent({
    login: "jo", studentTree: TREES[LAB3], readTree: treeReader(get), root: async () => null,
    templateFullName: "Org/tpl", headSha: LAB3, headTree: TREES[LAB3], templateCommits: [],
    records, fallbackSha: LAB2, selected: ["*"],
  });
  assert.equal(res.source, "unknown");
  assert.equal(res.from, LAB2);
  assert.deepEqual(res.plan.clean, [], "lab 3 is already there - and lab 4 was never a candidate for deletion");
});

// -----------------------------------------------------------------------------
// The template was CHANGED after the student accepted
//
// 2026-09-25, PXL-Automation-II / 2627-pe-1-test-1: published on the wrong
// template (a README only), accepted, then switched to 2627-aut2-pe1. The
// student's first commit matches nothing in the new template's history, the
// start fell back to "the newest commit's parent", and only the 7 files that
// commit changed were considered - `.gitignore`, `.gitattributes` and
// `infra/README.md`, from earlier commits of the new template, never arrived.
// -----------------------------------------------------------------------------

const OLD_FIRST = new Map([["README.md", "old-readme"]]);
const NEW_PARENT = sha("8");
const NEW_HEAD = sha("9");
const NEW_TREE = new Map([
  ["README.md", "new-readme"],
  [".gitignore", "gi"],
  [".gitattributes", "ga"],
  ["infra/README.md", "infra"],
  [".github/workflows/classroom.yml", "wf"],
  ["PROCEDURE.md", "proc"],
]);
// The newest commit changed only some of them - what the old fallback saw -
// including `classroom.yml`, as 69abed3 did on 2026-09-26.
const NEW_PARENT_TREE = new Map([
  ["README.md", "older-readme"], [".gitignore", "gi"], [".gitattributes", "ga"], ["infra/README.md", "infra"],
  [".github/workflows/classroom.yml", "wf-old"],
]);

/** A planner over a swapped template: the student's first commit is `first`. */
async function swapped(studentTree, { first = OLD_FIRST, firstReadable = true, repo = "Org/labs-swap", records = [] } = {}) {
  const trees = {
    [`Org/tpl@${NEW_HEAD}`]: NEW_TREE,
    [`Org/tpl@${NEW_PARENT}`]: NEW_PARENT_TREE,
    [`${repo}@first-tree`]: firstReadable ? first : null,
  };
  const readTree = async (r, ref) => {
    const t = trees[`${r}@${ref}`];
    if (!t) throw new Error(`no tree ${r}@${ref}`);
    return t;
  };
  return planStudent({
    login: "swap", studentRepo: repo, studentTree, readTree, root: async () => "first-tree",
    templateFullName: "Org/tpl", headSha: NEW_HEAD, headTree: NEW_TREE,
    // The new template's history holds no commit with the student's first tree.
    templateCommits: [{ sha: NEW_HEAD, treeSha: "t9", date: "2026-09-25T20:00:00Z" }, { sha: NEW_PARENT, treeSha: "t8", date: "2026-09-25T19:00:00Z" }],
    records, fallbackSha: NEW_PARENT, selected: ["*"],
  });
}

test("SWAPPED TEMPLATE: every file of the new template arrives, not just the newest commit's", async () => {
  const res = await swapped(OLD_FIRST);
  assert.equal(res.source, "first-commit");
  assert.equal(res.from, null);
  const sent = res.plan.clean.map((c) => `${c.action} ${c.path}`).sort();
  assert.deepEqual(sent, [
    "write .gitattributes",
    "write .github/workflows/classroom.yml",
    "write .gitignore",
    "write PROCEDURE.md",
    // Untouched since their first commit, so the old starter's README is replaced.
    "write README.md",
    "write infra/README.md",
  ]);
  assert.deepEqual(res.plan.conflicts, []);
});

test("SWAPPED TEMPLATE: a file they changed since is a pull request, not overwritten", async () => {
  const res = await swapped(new Map([["README.md", "their-notes"]]));
  assert.deepEqual(res.plan.conflicts, [{ path: "README.md", action: "write" }]);
  assert.ok(res.plan.clean.some((c) => c.path === ".gitignore"));
});

test("SWAPPED TEMPLATE: an old-starter file removed if untouched, offered if edited", async () => {
  const first = new Map([["README.md", "old-readme"], ["old-lab.md", "old"]]);
  const untouched = await swapped(new Map(first), { first });
  assert.ok(untouched.plan.clean.some((c) => c.path === "old-lab.md" && c.action === "delete"));
  const edited = await swapped(new Map([...first, ["old-lab.md", "their-work"]]), { first });
  assert.ok(edited.plan.conflicts.some((c) => c.path === "old-lab.md" && c.action === "delete"));
});

test("SWAPPED TEMPLATE: a file at a template path with their own content is a pull request, never kept, never overwritten", async () => {
  // It used to be "kept" - theirs, left alone for ever. After a switch every
  // new-template file is "added" relative to their first commit, so that rule
  // could not tell their work from a file an earlier sync delivered.
  const res = await swapped(new Map([...OLD_FIRST, ["infra/README.md", "their-own"]]));
  assert.deepEqual(res.plan.kept, []);
  assert.ok(res.plan.conflicts.some((c) => c.path === "infra/README.md" && c.action === "write"));
  assert.equal(res.plan.clean.some((c) => c.path === "infra/README.md"), false);
});

// --- 2026-09-26, run 36202430900: the first-commit sync that "kept" -----------
//
// The student had received `.gitignore` and an OLDER `classroom.yml` from the
// pre-fix sync. The first-commit sync called both "already theirs, left
// alone", recorded the student as holding 69abed3 - which changed
// classroom.yml - and every later sync would have started after it.

test("THE REPORT, first half: the first sync after a switch sends the full tree - a file an earlier sync delivered is updated, not kept", async () => {
  const student = new Map([
    ...OLD_FIRST,
    [".gitignore", "gi"],                             // delivered earlier, current
    [".github/workflows/classroom.yml", "wf-old"],     // delivered earlier, an OLDER template version
    ["infra/README.md", "their-own"],                  // their own content
  ]);
  const res = await swapped(student);
  assert.equal(res.source, "first-commit");
  assert.deepEqual(res.plan.kept, [], "nothing is left alone as theirs after a switch");
  assert.ok(res.plan.upToDate.includes(".gitignore"));
  // Byte-identical to a version the template once had: untouched starter code, replaced.
  assert.ok(res.plan.clean.some((c) => c.path === ".github/workflows/classroom.yml" && c.action === "write"));
  assert.ok(res.plan.conflicts.some((c) => c.path === "infra/README.md"));
  // And everything else of the new template arrives.
  for (const f of [".gitattributes", "PROCEDURE.md", "README.md"]) {
    assert.ok(res.plan.clean.some((c) => c.path === f && c.action === "write"), f);
  }
});

test("THE REPORT: the poisoned record - a first-commit sync that KEPT files - is not a starting point", async () => {
  const poisoned = record({ template_sha: NEW_HEAD }, [{ ...row("swap", "skipped-up-to-date", "first-commit"), files_kept: 2 }]);
  assert.equal(startingPointFor({ login: "swap", records: [poisoned] }).source, "unknown");
  // So the next sync compares the whole tree again, and the stale workflow is sent.
  const res = await swapped(new Map([...OLD_FIRST, [".github/workflows/classroom.yml", "wf-old"]]), { records: [poisoned] });
  assert.equal(res.source, "first-commit");
  assert.ok(res.plan.clean.some((c) => c.path === ".github/workflows/classroom.yml"));
});

test("THE REPORT, second half: after a clean first-commit sync, a later change to a synced file reaches the student", async () => {
  // The switch sync ran at NEW_PARENT and left nothing behind; the template
  // then changed classroom.yml in NEW_HEAD.
  const clean = record({ template_sha: NEW_PARENT }, [{ ...row("swap", "auto-merged", "first-commit"), files_kept: 0 }]);
  assert.deepEqual(startingPointFor({ login: "swap", records: [clean] }), { sha: NEW_PARENT, source: "synced" });
  const student = new Map(NEW_PARENT_TREE); // exactly what that sync delivered
  const res = await swapped(student, { records: [clean] });
  assert.equal(res.source, "synced");
  assert.equal(res.from, NEW_PARENT);
  assert.ok(res.plan.clean.some((c) => c.path === ".github/workflows/classroom.yml" && c.action === "write"));
  assert.deepEqual(res.plan.kept, []);
});

test("a first-commit record with no files_kept at all (older writers omit zeros) still counts", () => {
  const r = record({ template_sha: NEW_HEAD }, [row("swap", "auto-merged", "first-commit")]);
  assert.equal(startingPointFor({ login: "swap", records: [r] }).source, "synced");
});

test("the template's history is read ONCE per sync, however many students were switched", async () => {
  const reads = [];
  const readTree = async (r, ref) => {
    reads.push(`${r}@${ref}`);
    if (r === "Org/tpl" && ref === NEW_HEAD) return NEW_TREE;
    if (r === "Org/tpl" && ref === NEW_PARENT) return NEW_PARENT_TREE;
    if (ref === "first-tree") return OLD_FIRST;
    throw new Error("no tree");
  };
  const templateCommits = [{ sha: NEW_HEAD, treeSha: "t9", date: "2026-09-25T20:00:00Z" }, { sha: NEW_PARENT, treeSha: "t8", date: "2026-09-25T19:00:00Z" }];
  for (const login of ["a", "b", "c"]) {
    await planStudent({
      login, studentRepo: `Org/labs-${login}`, studentTree: new Map(OLD_FIRST), readTree, root: async () => "first-tree",
      templateFullName: "Org/tpl", headSha: NEW_HEAD, headTree: NEW_TREE, templateCommits, records: [], fallbackSha: NEW_PARENT, selected: ["*"],
    });
  }
  const historyReads = reads.filter((x) => x.startsWith("Org/tpl@"));
  assert.equal(historyReads.filter((x) => x === `Org/tpl@${NEW_PARENT}`).length, 1, historyReads.join(" "));
});

test("a template commit whose tree cannot be read makes a pull request, never an overwrite", async () => {
  // Without NEW_PARENT's tree, "wf-old" is not known to be starter code.
  const readTree = async (r, ref) => {
    if (r === "Org/tpl" && ref === NEW_HEAD) return NEW_TREE;
    if (ref === "first-tree") return OLD_FIRST;
    throw new Error("unreadable");
  };
  const res = await planStudent({
    login: "x", studentRepo: "Org/labs-x", studentTree: new Map([...OLD_FIRST, [".github/workflows/classroom.yml", "wf-old"]]),
    readTree, root: async () => "first-tree", templateFullName: "Org/tpl", headSha: NEW_HEAD, headTree: NEW_TREE,
    templateCommits: [{ sha: NEW_HEAD, treeSha: "t9", date: "2026-09-25T20:00:00Z" }, { sha: NEW_PARENT, treeSha: "t8", date: "2026-09-25T19:00:00Z" }],
    records: [], fallbackSha: null, selected: ["*"],
  });
  assert.equal(res.source, "first-commit");
  assert.ok(res.plan.conflicts.some((c) => c.path === ".github/workflows/classroom.yml"));
});

test("SWAPPED TEMPLATE: a first commit that cannot be read falls back to the old behaviour, named", async () => {
  const res = await swapped(OLD_FIRST, { firstReadable: false });
  assert.equal(res.source, "unknown");
  assert.equal(res.from, NEW_PARENT);
});

test("SWAPPED TEMPLATE: THE OLD FALLBACK would have missed exactly the three files", async () => {
  // The regression guard, written against the reproduction: what the parent
  // fallback considers is the newest commit's changes only.
  const res = await swapped(OLD_FIRST, { firstReadable: false });
  const considered = new Set(res.paths);
  for (const missed of [".gitignore", ".gitattributes", "infra/README.md"]) {
    assert.equal(considered.has(missed), false, `${missed} was out of range under the old fallback`);
  }
  const fixed = await swapped(OLD_FIRST);
  for (const f of [".gitignore", ".gitattributes", "infra/README.md"]) assert.ok(fixed.paths.includes(f), f);
});

test("a sync from their first commit reached everything, so it is evidence next time", () => {
  const r = record({ template_sha: NEW_HEAD }, [row("swap", "merged-and-pr", "first-commit")]);
  assert.deepEqual(startingPointFor({ login: "swap", records: [r] }), { sha: NEW_HEAD, source: "synced" });
});

test("a template file DELETED since their start is removed if untouched, offered if edited", async () => {
  const LAB5 = sha("5");
  TREES[LAB5] = new Map([...TREES[LAB4]].filter(([p]) => p !== "Lab02/Program.cs"));
  try {
    const { get } = fakeGitHub({ roots: { "labs-fay": "tree-2", "labs-gus": "tree-2" }, commitCounts: { "labs-fay": 3, "labs-gus": 3 } });
    const run = (login, studentTree) =>
      planStudent({
        login, studentTree, readTree: treeReader(get), root: () => rootTreeSha(get, `Org/labs-${login}`, "main"),
        templateFullName: "Org/tpl", headSha: LAB5, headTree: TREES[LAB5], templateCommits: COMMITS,
        records: [], fallbackSha: LAB4, selected: ["*"],
      });
    const untouched = await run("fay", TREES[LAB2]);
    assert.ok(untouched.plan.clean.some((c) => c.path === "Lab02/Program.cs" && c.action === "delete"));
    const edited = await run("gus", new Map([...TREES[LAB2], ["Lab02/Program.cs", "their-work"]]));
    assert.ok(edited.plan.conflicts.some((c) => c.path === "Lab02/Program.cs" && c.action === "delete"));
  } finally {
    delete TREES[LAB5];
  }
});
