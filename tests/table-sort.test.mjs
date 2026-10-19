// The one way a table column sorts (frontend/src/lib/table-sort.js), the state
// behind every sortable heading (composables/useTableSort.js), and a team's
// last commit (frontend/src/lib/last-commit.js). Six tables wrote their own
// copies of the first two; the Teams table could not sort at all.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
// The pure rules over plain holders: `npm test` installs the hub's packages and
// not the SPA's, so composables/useTableSort.js (which imports Vue) cannot be
// imported here - it passed locally and failed CI. It is checked below to be
// nothing but these rules over two refs.
import { compareSortValues, createTableSort, sortRows, timeValue } from "../frontend/src/lib/table-sort.js";
import { latestSha, commitTime, commitMsg, teamCommitRow } from "../frontend/src/lib/last-commit.js";
import { repoFiles } from "./repo-files.mjs";

test("blanks sort last in both directions", () => {
  const rows = [{ v: "b" }, { v: null }, { v: "a" }, { v: "" }, { v: undefined }, { v: "  " }];
  const asc = sortRows(rows, (r) => r.v, true).map((r) => r.v);
  const desc = sortRows(rows, (r) => r.v, false).map((r) => r.v);
  assert.deepEqual(asc.slice(0, 2), ["a", "b"]);
  assert.deepEqual(desc.slice(0, 2), ["b", "a"]);
  for (const list of [asc, desc]) {
    assert.ok(list.slice(2).every((v) => v == null || String(v).trim() === ""), "every blank after every value");
  }
  assert.equal(compareSortValues(NaN, 1), 1, "NaN is no value");
});

test("numbers compare as numbers, text naturally and case-blind", () => {
  assert.deepEqual(sortRows([{ n: 10 }, { n: 9 }, { n: 100 }], (r) => r.n).map((r) => r.n), [9, 10, 100]);
  assert.deepEqual(sortRows(["12A", "3A", "3a", "1B"].map((g) => ({ g })), (r) => r.g).map((r) => r.g), ["1B", "3A", "3a", "12A"]);
  assert.equal(compareSortValues(0, 5, true) < 0, true, "zero is a value, not a blank");
});

test("sortRows returns a copy and never reorders what it was given", () => {
  const rows = [{ v: 2 }, { v: 1 }];
  const sorted = sortRows(rows, (r) => r.v);
  assert.notEqual(sorted, rows);
  assert.deepEqual(rows.map((r) => r.v), [2, 1]);
});

test("timeValue: a time that does not parse is no value", () => {
  assert.equal(timeValue("2026-10-20T10:00:00Z"), Date.parse("2026-10-20T10:00:00Z"));
  assert.equal(timeValue("not a date"), null);
  assert.equal(timeValue(null), null);
});

const useTableSort = (key = null, options) => createTableSort({ value: key }, { value: true }, options);

test("useTableSort is these rules over two refs, and nothing else", () => {
  const src = readFileSync(new URL("../frontend/src/composables/useTableSort.js", import.meta.url), "utf8");
  assert.match(src, /return createTableSort\(ref\(initialKey\), ref\(true\), options\)/);
  assert.doesNotMatch(src, /function sortBy|sortAsc\.value/, "no second copy of the rules");
});

test("the sort state: another column ascends, the same one flips, descFirst starts down", () => {
  const s = useTableSort("team");
  assert.equal(s.ariaSort("team"), "ascending");
  assert.equal(s.sortDir("members"), null);
  assert.equal(s.ariaSort("members"), "none");
  s.sortBy("team");
  assert.equal(s.sortDir("team"), "desc");
  s.sortBy("members");
  assert.equal(s.sortDir("members"), "asc");

  const none = useTableSort(null);
  assert.equal(none.sortKey.value, null, "unsorted until a heading is pressed");

  const usage = useTableSort("used", { descFirst: ["used"] });
  assert.equal(usage.sortDir("used"), "desc");
  usage.sortBy("repo");
  assert.equal(usage.sortDir("repo"), "asc");
  usage.sortBy("used");
  assert.equal(usage.sortDir("used"), "desc");
});

test("a team's last commit is the commit of the member row on its repository", () => {
  const team = { team_slug: "alpha", members: ["Ann", "bob"], repo_name: "org/grp-alpha", repo_url: "https://github.com/org/grp-alpha", latest_observed_sha: "old", commit_count: 4 };
  const students = [
    // Not accepted: no repository, so cannot speak for the team.
    { github_login: "ann", repo_name: null },
    { github_login: "bob", repo_name: "org/grp-alpha", latest_observed_sha: "abc1234ff", commit_date: "2026-10-19T08:00:00Z", commit_message: "Lab 2" },
    // Not a member.
    { github_login: "cleo", repo_name: "org/grp-alpha", latest_observed_sha: "zzz", commit_date: "2026-10-20T08:00:00Z" },
  ];
  const row = teamCommitRow(team, students);
  assert.equal(row.repo_url, team.repo_url);
  assert.equal(latestSha(row), "abc1234ff", "SHA, time and message from one row");
  assert.equal(commitTime(row), "2026-10-19T08:00:00Z");
  assert.equal(commitMsg(row), "Lab 2");
  assert.equal(row.commit_count, 4, "the team's own count");
});

test("a team no member row is on keeps its SHA and claims no time", () => {
  const team = { team_slug: "beta", members: ["dan"], repo_name: "org/grp-beta", repo_url: "u", latest_observed_sha: "def5678" };
  const row = teamCommitRow(team, [{ github_login: "dan", repo_name: "org/other", commit_date: "2026-10-19T08:00:00Z" }]);
  assert.equal(latestSha(row), "def5678");
  assert.equal(commitTime(row), null, "never another repository's time");
});

test("no table hand-writes its own sortable heading any more", () => {
  // A `<th>` with an aria-sort is a sortable heading written by hand: the
  // shape six tables had, each with its own copy of the sort state.
  const vue = repoFiles({ under: "frontend/src", exts: [".vue"] }).filter((f) => !f.endsWith("SortableTh.vue"));
  assert.ok(vue.length > 20, `only ${vue.length} components found - the sweep has broken, not the code`);
  const offenders = vue.filter((f) => /<th\b[^>]*aria-sort/.test(readFileSync(f, "utf8")));
  assert.deepEqual(offenders, [], "use <SortableTh> and useTableSort()");
  const users = vue.filter((f) => readFileSync(f, "utf8").includes("<SortableTh"));
  assert.ok(users.length >= 5, `SortableTh is used by ${users.length} files - the anchor has moved`);
});
