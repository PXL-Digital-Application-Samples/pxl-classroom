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
