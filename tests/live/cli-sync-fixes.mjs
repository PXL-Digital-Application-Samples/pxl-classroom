#!/usr/bin/env node
// PXL Classroom - LIVE: the four starter-sync defects fixed in 9bee23d, through
// the real `pxl-classroom sync-starter` against pxl-classroom-testbed. Not part
// of `npm test`.
//
//   node tests/live/cli-sync-fixes.mjs
//
// One template (T1 -> T2) and four individual student repositories, all
// generated at T1 (their first commit is T1's tree). T2 changes lab1.md and
// the executable run.sh, and adds lab2.md.
//
//   mode     run.sh is T1's content at 100644, as every sync before 2026-09-26
//            wrote it. It is untouched starter code, so T2's run.sh is written
//            straight onto main at 100755 - not offered as a pull request
//            (it was, while "unchanged since the base" compared sha@mode).
//   pr       edited lab1.md, so lab1.md is a new pull request. Three OLDER
//            sync pull requests are open: X (one commit, lab1.md) is carried
//            whole by the new one and is CLOSED with a comment; Y offers
//            notes.md, which the new one does not, and stays open; Z touches
//            lab1.md in two commits (the student pushed to it) and stays open.
//            The CLI closed none before.
//   has2     already holds T2's lab2.md, so it is sent lab1.md and run.sh only:
//            its row carries `applied_files` (it differs from the union);
//            `mode` and `pr` received the union and their rows omit it.
//   current  already at T2: skipped, `applied_files: []`.
//   pad-NN   PAD records naming repositories that do not exist, so the run
//            passes FLUSH_EVERY (20) finished students and flushes a progress
//            record between the start and the end.
//
// What each student received is measured from the repositories (main before
// and after, and the pull request's files), never from the plan, and compared
// with each row's `applied_files` (absent read as `selected_files`).
//
// The record's history is read from the control repo's commits of its file:
// the START (running, no rows), at least one PROGRESS write (running, some
// rows), and the final one (completed, every row), whose issue fields must be
// what GitHub shows on each issue.
//
// The CLI runs as the testbed lecturer from a scratch config directory. The
// probe assignment is a draft; fixtures are reset each run, and the pull
// requests, branches and padding this run makes are removed at the end.

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { commitWithRebase } from "../../lib/gittree.mjs";
import { validateAgainst } from "../../lib/validate.mjs";
import { syncMarker } from "../../lib/starter-sync.mjs";
import { CONTROL_REPO } from "../../lib/deployment.mjs";
import { sameLogin } from "../../lib/github-login.mjs";
import { accounts, api, decode, die, loadEnv, reporter, root, sleep } from "./live-kit.mjs";

const env = loadEnv();
const org = process.env.PROBE_ORG || "pxl-classroom-testbed";
const { LECTURER, STUDENT_B } = accounts(env);
const token = LECTURER.token;
if (!token) die("TEST_LECTURER_TOKEN is required (.env.test)");
const ID = "cli-fixes-probe";
const TPL = "pxl-cli-fixes-probe-template";
const PAD = 22;
const r = reporter();
const stamp = new Date().toISOString();

// login -> repository. `mode` is an account that can be assigned; `pr` one
// that may not be; the others do not exist, so GitHub assigns nobody.
const STUDENTS = {
  mode: { login: LECTURER.login, repo: "pxl-cli-fixes-probe-mode" },
  pr: { login: STUDENT_B.login || "pxl-no-such-acct-b9x2", repo: "pxl-cli-fixes-probe-pr" },
  has2: { login: "pxl-no-such-acct-c9x2", repo: "pxl-cli-fixes-probe-has2" },
  current: { login: "pxl-no-such-acct-d9x2", repo: "pxl-cli-fixes-probe-current" },
};

const X = (content) => ({ content, mode: "100755" });
const T1 = {
  "README.md": `# fixes probe ${stamp}\n`,
  "lab1.md": `lab 1 starter ${stamp}\n`,
  "run.sh": X(`#!/bin/sh\necho v1 ${stamp}\n`),
};
const T2 = {
  ...T1,
  "lab1.md": `lab 1 starter, corrected ${stamp}\n`,
  "run.sh": X(`#!/bin/sh\necho v2 ${stamp}\n`),
  "lab2.md": `lab 2 starter ${stamp}\n`,
};

async function must(res, what) {
  if (!res.ok) die(`${what}: HTTP ${res.status} ${res.data?.message ?? ""}`);
  return res.data;
}
async function ensureRepo(name) {
  const got = await api(`/repos/${org}/${name}`, { token });
  if (got.ok) return got.data;
  if (got.status !== 404) die(`could not read ${org}/${name}: HTTP ${got.status}`);
  const made = await must(await api(`/orgs/${org}/repos`, { token, method: "POST", body: { name, private: true, auto_init: true, description: "tests/live/cli-sync-fixes.mjs" } }), `create ${name}`);
  r.note(`created ${org}/${name}`);
  return made;
}
/** A commit of exactly these files; a value is a string (100644) or {content, mode}. */
async function commitFiles(repo, files, parents, message) {
  const tree = await must(await api(`/repos/${org}/${repo}/git/trees`, {
    token, method: "POST",
    body: {
      tree: Object.entries(files).map(([path, v]) => ({
        path, type: "blob", mode: typeof v === "string" ? "100644" : v.mode, content: typeof v === "string" ? v : v.content,
      })),
    },
  }), `tree in ${repo}`);
  return (await must(await api(`/repos/${org}/${repo}/git/commits`, { token, method: "POST", body: { message, tree: tree.sha, parents } }), `commit in ${repo}`)).sha;
}
const resetRef = async (repo, branch, sha) =>
  must(await api(`/repos/${org}/${repo}/git/refs/heads/${branch}`, { token, method: "PATCH", body: { sha, force: true } }), `reset ${repo}@${branch}`);
/** path -> {sha, mode} */
async function treeOf(repo, ref = "main") {
  const t = await must(await api(`/repos/${org}/${repo}/git/trees/${ref}?recursive=1`, { token }), `tree of ${repo}`);
  return new Map(t.tree.filter((e) => e.type === "blob").map((e) => [e.path, { sha: e.sha, mode: e.mode }]));
}
async function openPulls(repo) {
  return (await api(`/repos/${org}/${repo}/pulls?state=open&per_page=100`, { token })).data || [];
}
/** Close every open pull request and issue, and delete every branch but main. */
async function tidy(repo) {
  for (const p of await openPulls(repo)) await api(`/repos/${org}/${repo}/pulls/${p.number}`, { token, method: "PATCH", body: { state: "closed" } });
  const issues = (await api(`/repos/${org}/${repo}/issues?state=open&per_page=100`, { token })).data || [];
  for (const i of issues.filter((x) => !x.pull_request)) await api(`/repos/${org}/${repo}/issues/${i.number}`, { token, method: "PATCH", body: { state: "closed" } });
  const branches = (await api(`/repos/${org}/${repo}/branches?per_page=100`, { token })).data || [];
  for (const b of branches.filter((x) => x.name !== "main")) await api(`/repos/${org}/${repo}/git/refs/heads/${b.name}`, { token, method: "DELETE" });
}
async function controlCommit(message, changes) {
  await commitWithRebase({ token, owner: org, repo: CONTROL_REPO, branch: "main", message, changes });
}
async function syncFiles() {
  const list = await api(`/repos/${org}/${CONTROL_REPO}/contents/syncs/${ID}`, { token });
  return list.ok && Array.isArray(list.data) ? list.data : [];
}
/** An older sync pull request on `branch`: one commit per entry of `commits`, each a file map over main. */
async function olderSyncPr(repo, branch, mainSha, baseFiles, commits, title) {
  await must(await api(`/repos/${org}/${repo}/git/refs`, { token, method: "POST", body: { ref: `refs/heads/${branch}`, sha: mainSha } }), `branch ${branch}`);
  let head = mainSha;
  for (const [i, files] of commits.entries()) head = await commitFiles(repo, { ...baseFiles, ...files }, [head], `${title} (${i + 1})`);
  await resetRef(repo, branch, head);
  const pr = await must(await api(`/repos/${org}/${repo}/pulls`, {
    token, method: "POST",
    // The marker of an OLDER template commit: a sync PR, not this sync's.
    body: { title, head: branch, base: "main", body: `An older starter sync (live probe).\n\n${syncMarker("0".repeat(39) + "1")}` },
  }), `pull request ${branch}`);
  return pr.number;
}

function runCli(configDir, args) {
  const res = spawnSync("node", [join(root, "cli", "bin", "pxl-classroom.mjs"), ...args], {
    encoding: "utf8",
    env: { ...process.env, APPDATA: configDir, XDG_CONFIG_HOME: configDir },
    timeout: 10 * 60_000,
  });
  return { status: res.status, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

const sortJoin = (xs) => [...xs].sort().join(",");

async function main() {
  console.log(`\nCLI starter sync fixes (9bee23d) - ${org}\n`);

  // --- template --------------------------------------------------------------------
  await ensureRepo(TPL);
  const t1 = await commitFiles(TPL, T1, [], "Initial commit");
  const t2 = await commitFiles(TPL, T2, [t1], "correct lab 1 and run.sh, add lab 2");
  await resetRef(TPL, "main", t2);
  const tplTree = await treeOf(TPL, t2);
  if (tplTree.get("run.sh")?.mode === "100755") r.ok(`template ${t1.slice(0, 7)} -> ${t2.slice(0, 7)}; run.sh is 100755 in both`);
  else die(`the template's run.sh is ${tplTree.get("run.sh")?.mode}, not 100755`);

  // --- students ----------------------------------------------------------------------
  const repos = {};
  const heads = {};
  for (const [who, s] of Object.entries(STUDENTS)) {
    repos[who] = await ensureRepo(s.repo);
    await tidy(s.repo);
  }
  {
    const first = await commitFiles(STUDENTS.mode.repo, T1, [], "Initial commit");
    // The pre-fix sync: same bytes, mode lost.
    heads.mode = await commitFiles(STUDENTS.mode.repo, { ...T1, "run.sh": T1["run.sh"].content }, [first], "an old sync wrote run.sh as 100644");
    await resetRef(STUDENTS.mode.repo, "main", heads.mode);
  }
  const PR_EDIT = { ...T1, "lab1.md": `lab 1 - OUR WORK ${stamp}\n` };
  {
    const first = await commitFiles(STUDENTS.pr.repo, T1, [], "Initial commit");
    heads.pr = await commitFiles(STUDENTS.pr.repo, PR_EDIT, [first], "our work on lab 1");
    await resetRef(STUDENTS.pr.repo, "main", heads.pr);
  }
  {
    const first = await commitFiles(STUDENTS.has2.repo, T1, [], "Initial commit");
    heads.has2 = await commitFiles(STUDENTS.has2.repo, { ...T1, "lab2.md": T2["lab2.md"] }, [first], "lab 2 copied from a classmate");
    await resetRef(STUDENTS.has2.repo, "main", heads.has2);
  }
  heads.current = await commitFiles(STUDENTS.current.repo, T2, [], "Initial commit");
  await resetRef(STUDENTS.current.repo, "main", heads.current);
  const modeBefore = (await treeOf(STUDENTS.mode.repo)).get("run.sh");
  const t1Tree = await treeOf(TPL, t1);
  if (modeBefore?.mode === "100644" && modeBefore.sha === t1Tree.get("run.sh").sha) r.ok("mode: run.sh holds T1's bytes at 100644");
  else die(`mode: fixture run.sh is ${JSON.stringify(modeBefore)}`);

  const oldX = await olderSyncPr(STUDENTS.pr.repo, "pxl-probe-old-x", heads.pr, PR_EDIT, [{ "lab1.md": `lab 1, an older sync ${stamp}\n` }], "Older sync X");
  const oldY = await olderSyncPr(STUDENTS.pr.repo, "pxl-probe-old-y", heads.pr, PR_EDIT, [{ "notes.md": `notes, an older sync ${stamp}\n` }], "Older sync Y");
  const oldZ = await olderSyncPr(STUDENTS.pr.repo, "pxl-probe-old-z", heads.pr, PR_EDIT,
    [{ "lab1.md": `lab 1, an older sync ${stamp}\n` }, { "lab1.md": `lab 1, the student pushed to it ${stamp}\n` }], "Older sync Z");
  r.ok(`pr: older sync PRs X #${oldX} (lab1.md), Y #${oldY} (notes.md), Z #${oldZ} (lab1.md, two commits)`);

  const before = {};
  for (const [who, s] of Object.entries(STUDENTS)) before[who] = await treeOf(s.repo);

  // --- control repo -------------------------------------------------------------------
  const assignment = {
    schema_version: 1, id: ID, title: "CLI sync fixes probe (live test)", organization: org,
    template: { owner: org, repository: TPL }, repository_name_pattern: "pxl-cli-fixes-probe-{github_login}",
    opens_at: "2026-09-01T08:00:00.000Z", deadline_at: "2027-06-30T21:00:00.000Z", state: "draft",
  };
  const recs = Object.entries(STUDENTS).map(([who, s]) => ({
    schema_version: 1, assignment_id: ID, github_login: s.login, repo_id: repos[who].id,
    repo_name: `${org}/${s.repo}`, repo_url: `https://github.com/${org}/${s.repo}`,
  }));
  const pads = Array.from({ length: PAD }, (_, i) => {
    const n = `pxl-cli-fixes-probe-pad-${String(i).padStart(2, "0")}`;
    return { schema_version: 1, assignment_id: ID, github_login: `pad-${String(i).padStart(2, "0")}`, repo_id: repos.current.id, repo_name: `${org}/${n}`, repo_url: `https://github.com/${org}/${n}` };
  });
  for (const [kind, doc] of [["assignment", assignment], ...[...recs, ...pads].map((x) => ["repository-record", x])]) {
    const v = validateAgainst(kind, structuredClone(doc));
    if (!v.valid) die(`fixture ${kind} fails its schema: ${JSON.stringify(v.errors)}`);
  }
  const staleRecs = (await api(`/repos/${org}/${CONTROL_REPO}/contents/repositories/${ID}`, { token })).data;
  const staleSyncs = await syncFiles();
  const keep = new Set([...recs, ...pads].map((x) => `${x.github_login}.json`));
  await controlCommit(`Live test fixture: ${ID}`, [
    { path: `assignments/${ID}.yml`, content: stringify(assignment) },
    ...(Array.isArray(staleRecs) ? staleRecs.filter((f) => !keep.has(f.name)).map((f) => ({ path: f.path, content: null })) : []),
    ...[...recs, ...pads].map((x) => ({ path: `repositories/${ID}/${x.github_login}.json`, content: JSON.stringify(x, null, 2) + "\n" })),
    ...staleSyncs.map((f) => ({ path: f.path, content: null })),
  ]);
  const TOTAL = recs.length + PAD;
  r.ok(`control repo: draft ${ID}, ${recs.length} students + ${PAD} padding records${staleSyncs.length ? `, ${staleSyncs.length} earlier sync record(s) cleared` : ""}`);

  // --- the CLI -----------------------------------------------------------------------
  const configDir = mkdtempSync(join(tmpdir(), "pxl-cli-probe-"));
  let out;
  try {
    const cfg = join(configDir, "pxl-classroom");
    mkdirSync(cfg, { recursive: true });
    writeFileSync(join(cfg, "token"), JSON.stringify({ access_token: token, obtained_at: new Date().toISOString() }));
    writeFileSync(join(cfg, "config.json"), JSON.stringify({ last_org: org }));
    const run = runCli(configDir, ["sync-starter", "--org", org, "--assignment", ID, "--issue"]);
    out = run.out;
    if (run.status !== 0) r.bad(`the CLI exited ${run.status}`);
    else r.ok("the CLI exited 0");
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
  console.log(out.split("\n").map((l) => `        | ${l}`).join("\n"));

  // --- #1 the record's history ---------------------------------------------------------
  const files = await syncFiles();
  if (files.length !== 1) die(`expected one sync record, found ${files.length}`);
  const recPath = files[0].path;
  const commits = ((await api(`/repos/${org}/${CONTROL_REPO}/commits?path=${encodeURIComponent(recPath)}&per_page=100`, { token })).data || []).reverse();
  const versions = [];
  for (const c of commits) {
    const got = await api(`/repos/${org}/${CONTROL_REPO}/contents/${recPath}?ref=${c.sha}`, { token });
    if (got.ok) versions.push({ message: c.commit.message.split("\n")[0], doc: JSON.parse(decode(got.data.content)) });
  }
  r.note(`record ${recPath}: ${versions.map((v) => `${v.doc.status}/${v.doc.results.length}`).join(" -> ")}`);
  const [startV, ...rest] = versions;
  const finalV = versions.at(-1);
  if (startV?.doc.status === "running" && startV.doc.results.length === 0) r.ok(`#1 the START record was committed before any row ("${startV.message}")`);
  else r.bad(`#1 the first version is ${startV?.doc.status} with ${startV?.doc.results.length} rows`);
  const progress = rest.slice(0, -1).filter((v) => v.doc.status === "running" && v.doc.results.length > 0 && v.doc.results.length < TOTAL);
  if (progress.length) r.ok(`#1 a PROGRESS record was flushed mid-run: ${progress.map((v) => `${v.doc.results.length} rows`).join(", ")} of ${TOTAL}`);
  else r.bad(`#1 no progress record between start and end (${versions.length} versions)`);
  const rec = finalV.doc;
  const v = validateAgainst("sync-record", structuredClone(rec));
  if (!v.valid) r.bad(`#1 the final record fails its schema: ${JSON.stringify(v.errors)}`);
  if (rec.status === "completed" && rec.results.length === TOTAL && rec.via === "cli") r.ok(`#1 the final record is completed with all ${TOTAL} rows, via cli`);
  else r.bad(`#1 the final record: ${rec.status}, ${rec.results.length} rows, via ${rec.via}`);
  const rowOf = (who) => rec.results.find((x) => sameLogin(x.github_login, STUDENTS[who].login));

  for (const who of ["mode", "pr", "has2"]) {
    const row = rowOf(who);
    if (!row?.issue_number || !row?.issue_url || !Array.isArray(row?.issue_assignees)) {
      r.bad(`#1 ${who}: row lacks issue fields: ${JSON.stringify(row && { n: row.issue_number, u: row.issue_url, a: row.issue_assignees })}`);
      continue;
    }
    const issue = await api(`/repos/${org}/${STUDENTS[who].repo}/issues/${row.issue_number}`, { token });
    const onGitHub = (issue.data?.assignees || []).map((a) => a.login);
    if (issue.data?.html_url !== row.issue_url) r.bad(`#1 ${who}: issue_url ${row.issue_url} is not issue #${row.issue_number}`);
    if (sortJoin(row.issue_assignees) === sortJoin(onGitHub)) r.ok(`#1 ${who}: issue #${row.issue_number}, record assignees [${row.issue_assignees}] = GitHub's [${onGitHub}]`);
    else r.bad(`#1 ${who}: record assignees [${row.issue_assignees}], GitHub shows [${onGitHub}]`);
  }
  if (rowOf("mode")?.issue_assignees?.some((a) => sameLogin(a, STUDENTS.mode.login))) r.ok("#1 mode: the assignable account IS assigned");
  else r.bad("#1 mode: the assignable account was not assigned");
  if (rowOf("has2")?.issue_assignees?.length === 0) r.ok(`#1 has2: ${STUDENTS.has2.login} does not exist, and the record says nobody was assigned (not the list asked for)`);
  else r.bad(`#1 has2: issue_assignees ${JSON.stringify(rowOf("has2")?.issue_assignees)}`);

  // --- #7 mode drift ----------------------------------------------------------------------
  {
    const row = rowOf("mode");
    const now = (await treeOf(STUDENTS.mode.repo)).get("run.sh");
    if (row?.outcome === "auto-merged" && !row.files_conflicted && !row.pr_number) r.ok("#7 mode: auto-merged, no pull request");
    else r.bad(`#7 mode: outcome ${row?.outcome}, conflicted ${row?.files_conflicted}, pr ${row?.pr_number}`);
    if (now?.sha === tplTree.get("run.sh").sha && now.mode === "100755") r.ok(`#7 mode: run.sh on main is T2's bytes at ${now.mode}`);
    else r.bad(`#7 mode: run.sh on main is ${JSON.stringify(now)}, template ${JSON.stringify(tplTree.get("run.sh"))}`);
    if ((await openPulls(STUDENTS.mode.repo)).length === 0) r.ok("#7 mode: no open pull request in the repository");
    else r.bad("#7 mode: a pull request is open");
  }

  // --- #13 superseded ----------------------------------------------------------------------
  {
    const row = rowOf("pr");
    const open = await openPulls(STUDENTS.pr.repo);
    const newPr = open.find((p) => p.number === row?.pr_number);
    if (row?.outcome === "merged-and-pr" && newPr && (newPr.body || "").includes(syncMarker(t2))) r.ok(`#13 pr: the CLI opened #${newPr.number} for this sync`);
    else r.bad(`#13 pr: outcome ${row?.outcome}, pr ${row?.pr_number}, open [${open.map((p) => p.number)}]`);
    const newFiles = newPr ? ((await api(`/repos/${org}/${STUDENTS.pr.repo}/pulls/${newPr.number}/files`, { token })).data || []).map((f) => f.filename) : [];
    r.note(`#${newPr?.number} carries [${newFiles}]`);
    const x = (await api(`/repos/${org}/${STUDENTS.pr.repo}/pulls/${oldX}`, { token })).data;
    const xComments = (await api(`/repos/${org}/${STUDENTS.pr.repo}/issues/${oldX}/comments`, { token })).data || [];
    if (x?.state === "closed" && !x.merged && xComments.some((c) => c.body.includes(`Superseded by #${newPr?.number}`))) r.ok(`#13 X #${oldX} (all its files carried again) is CLOSED, with "Superseded by #${newPr?.number}"`);
    else r.bad(`#13 X #${oldX}: ${x?.state}, comments [${xComments.map((c) => c.body)}]`);
    for (const [name, n, why] of [["Y", oldY, "offers notes.md, not carried"], ["Z", oldZ, "two commits: the student pushed to it"]]) {
      const p = (await api(`/repos/${org}/${STUDENTS.pr.repo}/pulls/${n}`, { token })).data;
      if (p?.state === "open") r.ok(`#13 ${name} #${n} stays open (${why})`);
      else r.bad(`#13 ${name} #${n} is ${p?.state} (${why})`);
    }
    if (new RegExp(`closed the superseded #${oldX}\\b`).test(out)) r.ok("#13 the CLI says it closed it");
    else r.bad("#13 the CLI output does not mention closing X");
  }

  // --- #14 per-student applied_files --------------------------------------------------------
  // What each student RECEIVED, from the repositories: every path whose blob
  // or mode changed on main, plus the files of the pull request this sync
  // opened. Compared with the row, absent read as selected_files.
  const selected = rec.selected_files;
  r.note(`selected_files [${selected}]`);
  for (const [who, s] of Object.entries(STUDENTS)) {
    const after = await treeOf(s.repo);
    const got = new Set();
    for (const p of new Set([...before[who].keys(), ...after.keys()])) {
      const a = before[who].get(p);
      const b = after.get(p);
      if (a?.sha !== b?.sha || a?.mode !== b?.mode) got.add(p);
    }
    const row = rec.results.find((x) => sameLogin(x.github_login, s.login));
    if (row?.pr_number) for (const f of (await api(`/repos/${org}/${s.repo}/pulls/${row.pr_number}/files`, { token })).data || []) got.add(f.filename);
    const says = Array.isArray(row?.applied_files) ? row.applied_files : selected;
    const how = Array.isArray(row?.applied_files) ? `applied_files [${row.applied_files}]` : "applied_files omitted (= selected_files)";
    if (sortJoin(got) === sortJoin(says)) r.ok(`#14 ${who}: received [${[...got].sort()}]; row: ${how}`);
    else r.bad(`#14 ${who}: received [${[...got].sort()}], row says ${how}`);
    if (Array.isArray(row?.applied_files) && sortJoin(row.applied_files) === sortJoin(selected)) r.bad(`#14 ${who}: applied_files repeats selected_files (should be omitted)`);
  }
  if (Array.isArray(rowOf("has2")?.applied_files)) r.ok("#14 has2's row carries applied_files, because it differs from the union");
  else r.bad("#14 has2's row has no applied_files");
  const padRows = rec.results.filter((x) => /^pad-/.test(x.github_login));
  if (padRows.length === PAD && padRows.every((x) => x.outcome === "failed" && !("applied_files" in x))) r.ok(`#14 the ${PAD} failed padding rows carry no applied_files`);
  else r.bad(`#14 padding rows: ${padRows.length}, ${JSON.stringify(padRows.find((x) => x.outcome !== "failed" || "applied_files" in x))}`);

  // --- cleanup --------------------------------------------------------------------------------
  for (const s of Object.values(STUDENTS)) await tidy(s.repo);
  await controlCommit(`Live test fixture: ${ID} padding removed`, pads.map((x) => ({ path: `repositories/${ID}/${x.github_login}.json`, content: null })));
  await sleep(1000);
  r.note("cleanup: pull requests and issues closed, branches other than main deleted, padding records removed");

  console.log(`\n${r.failures() ? `${r.failures()} FAILED` : "all good"}\n`);
  process.exit(r.failures() ? 1 : 0);
}

main().catch((e) => die(e.stack || String(e)));
