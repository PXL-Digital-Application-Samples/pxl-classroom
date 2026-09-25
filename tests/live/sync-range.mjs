#!/usr/bin/env node
// PXL Classroom - LIVE check that a starter sync sends each student what THEY
// are missing. Not part of `npm test`.
//
//   node tests/live/sync-range.mjs
//
// Runs the REAL Sync Starter Code workflow on the hub against
// pxl-classroom-testbed four times, and checks the repositories and the record
// after each:
//
//   1 catch-up   template lab 2 -> 3 -> 4. `early` was generated at lab 2 and
//                received lab 4 but never lab 3 (.NET Advanced, 2026-09-25);
//                `late` was generated at lab 4; `edited` was generated at lab 2,
//                has everything, and has worked in lab 3. Only `early` gets
//                anything - lab 3 - and every start is found from the student's
//                first commit (`generated`).
//   2 evidence   lab 5 is pushed. Everyone gets it, and every start is round
//                1's record (`synced`, from lab 4) - no first-commit lookup.
//   3 exclusion  lab 6 adds A.cs and B.cs; the sync leaves B.cs out. Only A.cs
//                arrives, and the record says `all_files: false`.
//   4 not lost   a plain sync. Round 3 left something out, so it is not
//                evidence: starts are lab 5 again, and B.cs arrives.
//   5 backwards  everyone holds lab 6; a sync NAMING lab 5 takes nothing away.
//   6 cut off    a run cancelled part-way: its START record is on GitHub before
//                the cancel, stays `running` with partial results after it, and
//                lib/sync-status.mjs reads it as a run that ended unfinished.
//
// Every round also checks the record names its run and closed itself.
//
// Every fixture is reset each run and the probe's earlier sync records are
// cleared, so the run is repeatable. The probe assignment is a draft. No issue
// is opened (the named-commit probe covers the issue path).

import { stringify } from "yaml";
import { commitWithRebase } from "../../lib/gittree.mjs";
import { validateAgainst } from "../../lib/validate.mjs";
import { CONTROL_REPO, HUB_OWNER, HUB_REPO_NAME } from "../../lib/deployment.mjs";
import { api, decode, die, loadEnv, reporter, sleep } from "./live-kit.mjs";

const env = loadEnv();
// Named, never TEST_ORG: this creates repositories (see inline-commit.mjs).
const org = process.env.PROBE_ORG || "pxl-classroom-testbed";
const token = env.TEST_LECTURER_TOKEN;
if (!token) die("TEST_LECTURER_TOKEN is required (.env.test)");
const HUB = `${HUB_OWNER}/${HUB_REPO_NAME}`;
const ID = "sync-range-probe";
const TPL = "pxl-range-probe-template";
const STUDENTS = { early: "pxl-range-probe-early", late: "pxl-range-probe-late", edited: "pxl-range-probe-edited" };
const r = reporter();
const stamp = new Date().toISOString();

const LAB = {
  2: { "README.md": `# Labs ${stamp}\n`, "Lab02/Program.cs": `// lab 2 ${stamp}\r\n` },
  3: { "Lab03/Program.cs": `// lab 3 ${stamp}\r\n`, "Lab03/Tests.cs": `// lab 3 tests ${stamp}\r\n` },
  4: { "Lab04/Program.cs": `// lab 4 ${stamp}\r\n` },
  5: { "Lab05/Program.cs": `// lab 5 ${stamp}\r\n` },
  6: { "Lab06/A.cs": `// lab 6 A ${stamp}\r\n`, "Lab06/B.cs": `// lab 6 B ${stamp}\r\n` },
};
const upTo = (n) => Object.assign({}, ...[2, 3, 4, 5, 6].filter((k) => k <= n).map((k) => LAB[k]));

async function must(res, what) {
  if (!res.ok) die(`${what}: HTTP ${res.status} ${res.data?.message ?? ""}`);
  return res.data;
}

async function ensureRepo(name) {
  const got = await api(`/repos/${org}/${name}`, { token });
  if (got.ok) return got.data;
  if (got.status !== 404) die(`could not read ${org}/${name}: HTTP ${got.status}`);
  const made = await must(
    await api(`/orgs/${org}/repos`, { token, method: "POST", body: { name, private: true, auto_init: true, description: "tests/live/sync-range.mjs" } }),
    `create ${org}/${name}`,
  );
  r.note(`created ${org}/${name}`);
  return made;
}

/** A commit of exactly these files. The same files make the same tree sha in any repository - which is what a generated repository's first commit is. */
async function commitFiles(repo, files, parents, message) {
  const tree = await must(
    await api(`/repos/${org}/${repo}/git/trees`, {
      token, method: "POST",
      body: { tree: Object.entries(files).map(([path, content]) => ({ path, mode: "100644", type: "blob", content })) },
    }),
    `tree in ${repo}`,
  );
  return (await must(await api(`/repos/${org}/${repo}/git/commits`, { token, method: "POST", body: { message, tree: tree.sha, parents } }), `commit in ${repo}`)).sha;
}

const resetMain = async (repo, sha) =>
  must(await api(`/repos/${org}/${repo}/git/refs/heads/main`, { token, method: "PATCH", body: { sha, force: true } }), `reset ${repo}`);

async function treeOf(repo, ref = "main") {
  const t = await must(await api(`/repos/${org}/${repo}/git/trees/${ref}?recursive=1`, { token }), `tree of ${repo}`);
  return new Map(t.tree.filter((e) => e.type === "blob").map((e) => [e.path, e.sha]));
}

async function controlCommit(message, changes) {
  await commitWithRebase({ token, owner: org, repo: CONTROL_REPO, branch: "main", message, changes });
}

async function records() {
  const list = await api(`/repos/${org}/${CONTROL_REPO}/contents/syncs/${ID}`, { token });
  if (!list.ok) return [];
  const out = [];
  for (const f of list.data) {
    const one = await api(`/repos/${org}/${CONTROL_REPO}/contents/${f.path}`, { token });
    out.push({ path: f.path, doc: JSON.parse(decode(one.data.content)) });
  }
  return out.sort((a, b) => a.doc.synced_at.localeCompare(b.doc.synced_at));
}

async function syncAndWait(label, inputs = {}) {
  const res = await api(`/repos/${HUB}/actions/workflows/sync-starter-code.yml/dispatches`, {
    token, method: "POST",
    body: { ref: "main", inputs: { org, assignment_id: ID, create_issue: false, ...inputs }, return_run_details: true },
  });
  if (!res.ok || !res.data?.workflow_run_id) die(`${label}: dispatch refused or no run id: HTTP ${res.status} ${JSON.stringify(res.data)}`);
  const id = res.data.workflow_run_id;
  let run;
  for (let waited = 0; waited < 15 * 60_000; waited += 10_000) {
    await sleep(10_000);
    run = (await api(`/repos/${HUB}/actions/runs/${id}`, { token })).data;
    if (run?.status === "completed") break;
  }
  if (run?.conclusion !== "success") die(`${label}: run ${run?.html_url} ended ${run?.status}/${run?.conclusion}`);
  r.ok(`${label}: run ${run.html_url} succeeded`);
  const newest = (await records()).at(-1)?.doc;
  if (!newest) die(`${label}: no sync record`);
  const v = validateAgainst("sync-record", newest);
  if (!v.valid) r.bad(`${label}: record fails its schema: ${JSON.stringify(v.errors)}`);
  // The record the run wrote about itself, and closed.
  if (newest.run_id === id && newest.status === "completed" && newest.remaining === 0 && newest.finished_at) {
    r.ok(`${label}: record names run ${id}, completed, 0 remaining`);
  } else {
    r.bad(`${label}: record run_id ${newest.run_id} status ${newest.status} remaining ${newest.remaining}`);
  }
  return newest;
}

function expectRow(label, record, login, { outcome, merged, kept, from, source }) {
  const x = record.results.find((y) => y.github_login === login);
  const bad = [];
  if (x?.outcome !== outcome) bad.push(`outcome ${x?.outcome}`);
  if (merged !== undefined && (x?.files_merged ?? 0) !== merged) bad.push(`merged ${x?.files_merged}`);
  if (kept !== undefined && (x?.files_kept ?? 0) !== kept) bad.push(`kept ${x?.files_kept}`);
  if (from !== undefined && x?.from_sha !== from) bad.push(`from ${x?.from_sha?.slice(0, 7)}`);
  if (source !== undefined && x?.from_source !== source) bad.push(`source ${x?.from_source}`);
  const says = `${outcome}${merged ? `, ${merged} merged` : ""}${kept ? `, ${kept} kept` : ""}${source ? `, from ${source} ${from?.slice(0, 7)}` : ""}`;
  if (bad.length) r.bad(`${label}: ${login} expected ${says}, got ${bad.join(", ")}`);
  else r.ok(`${label}: ${login} ${says}`);
}

async function expectFiles(label, who, want) {
  const tree = await treeOf(STUDENTS[who]);
  const missing = Object.keys(want).filter((p) => !tree.has(p));
  if (missing.length) r.bad(`${label}: ${who} is missing ${missing.join(", ")}`);
  else r.ok(`${label}: ${who} has ${Object.keys(want).length} expected file(s)`);
  return tree;
}

async function main() {
  console.log(`\nPer-student range sync probe - ${org}, hub ${HUB}\n`);

  // --- template: lab 2 -> 3 -> 4 -------------------------------------------------
  await ensureRepo(TPL);
  const c2 = await commitFiles(TPL, upTo(2), [], "lab 2");
  const c3 = await commitFiles(TPL, upTo(3), [c2], "add lab 3 startcode");
  const c4 = await commitFiles(TPL, upTo(4), [c3], "add lab 4 startcode");
  await resetMain(TPL, c4);
  r.ok(`template: lab 2 ${c2.slice(0, 7)} -> lab 3 ${c3.slice(0, 7)} -> lab 4 ${c4.slice(0, 7)}`);

  // --- students, each with a FIRST commit that is a template tree ---------------
  const MY_LAB2 = { "Lab02/Program.cs": `// lab 2, the student's own work ${stamp}\r\n` };
  const MY_LAB3 = { "Lab03/Program.cs": `// lab 3, the student's own work ${stamp}\r\n` };
  const repos = {};
  for (const [who, name] of Object.entries(STUDENTS)) repos[who] = await ensureRepo(name);
  {
    const root = await commitFiles(STUDENTS.early, upTo(2), [], "Initial commit");
    await resetMain(STUDENTS.early, await commitFiles(STUDENTS.early, { ...upTo(2), ...MY_LAB2, ...LAB[4] }, [root], "work + lab 4 arrived"));
  }
  await resetMain(STUDENTS.late, await commitFiles(STUDENTS.late, upTo(4), [], "Initial commit"));
  {
    const root = await commitFiles(STUDENTS.edited, upTo(2), [], "Initial commit");
    await resetMain(STUDENTS.edited, await commitFiles(STUDENTS.edited, { ...upTo(4), ...MY_LAB3 }, [root], "caught up + working in lab 3"));
  }
  r.ok("students: early (lab 2, missed lab 3), late (lab 4), edited (lab 2, has all, edited lab 3)");

  // --- control repo: draft assignment, records, and no earlier sync records -----
  const assignment = {
    schema_version: 1, id: ID, title: "Sync range probe (live test)", organization: org,
    template: { owner: org, repository: TPL }, repository_name_pattern: "pxl-range-probe-{github_login}",
    opens_at: "2026-09-01T08:00:00.000Z", deadline_at: "2027-06-30T21:00:00.000Z", state: "draft",
  };
  const recs = Object.entries(STUDENTS).map(([who, name]) => ({
    schema_version: 1, assignment_id: ID, github_login: who, repo_id: repos[who].id,
    repo_name: `${org}/${name}`, repo_url: `https://github.com/${org}/${name}`,
  }));
  for (const [kind, doc] of [["assignment", assignment], ...recs.map((x) => ["repository-record", x])]) {
    const v = validateAgainst(kind, doc);
    if (!v.valid) die(`fixture ${kind} fails its schema: ${JSON.stringify(v.errors)}`);
  }
  const stale = await records();
  await controlCommit(`Live test fixture: ${ID}`, [
    { path: `assignments/${ID}.yml`, content: stringify(assignment) },
    ...recs.map((x) => ({ path: `repositories/${ID}/${x.github_login}.json`, content: JSON.stringify(x, null, 2) + "\n" })),
    // Records from an earlier run point at template commits this run replaced.
    ...stale.map((s) => ({ path: s.path, content: null })),
  ]);
  r.ok(`control repo: draft ${ID}, ${recs.length} repository records${stale.length ? `, ${stale.length} earlier probe record(s) cleared` : ""}`);

  // --- 1: catch-up -----------------------------------------------------------------
  const before = { late: await treeOf(STUDENTS.late), edited: await treeOf(STUDENTS.edited) };
  const r1 = await syncAndWait("1 catch-up");
  if (r1.per_student_range === true && r1.all_files === true) r.ok("1 catch-up: record is per-student, all files");
  else r.bad(`1 catch-up: per_student_range ${r1.per_student_range}, all_files ${r1.all_files}`);
  expectRow("1 catch-up", r1, "early", { outcome: "auto-merged", merged: 2, from: c2, source: "generated" });
  expectRow("1 catch-up", r1, "late", { outcome: "skipped-up-to-date", from: c4, source: "generated" });
  expectRow("1 catch-up", r1, "edited", { outcome: "skipped-up-to-date", kept: 1, from: c2, source: "generated" });
  const early1 = await expectFiles("1 catch-up", "early", LAB[3]);
  const tpl4 = await treeOf(TPL, c4);
  if (early1.get("Lab03/Program.cs") === tpl4.get("Lab03/Program.cs")) r.ok("1 catch-up: early's lab 3 is the template's, byte for byte");
  else r.bad("1 catch-up: early's lab 3 differs from the template's");
  if (early1.get("Lab02/Program.cs") !== tpl4.get("Lab02/Program.cs")) r.ok("1 catch-up: early's own lab 2 work is untouched");
  else r.bad("1 catch-up: early's lab 2 work was overwritten");
  for (const who of ["late", "edited"]) {
    const now = await treeOf(STUDENTS[who]);
    if ([...before[who]].every(([p, s]) => now.get(p) === s) && now.size === before[who].size) r.ok(`1 catch-up: ${who} unchanged`);
    else r.bad(`1 catch-up: ${who} changed`);
  }

  // --- 2: evidence -------------------------------------------------------------------
  const c5 = await commitFiles(TPL, upTo(5), [c4], "add lab 5 startcode");
  await resetMain(TPL, c5);
  const r2 = await syncAndWait("2 evidence");
  for (const who of ["early", "late", "edited"]) {
    expectRow("2 evidence", r2, who, { outcome: "auto-merged", merged: 1, from: c4, source: "synced" });
  }
  for (const who of ["early", "late", "edited"]) await expectFiles("2 evidence", who, LAB[5]);

  // --- 3: exclusion -------------------------------------------------------------------
  const c6 = await commitFiles(TPL, upTo(6), [c5], "add lab 6 startcode");
  await resetMain(TPL, c6);
  const r3 = await syncAndWait("3 exclusion", { selected_files: JSON.stringify(["*", "!Lab06/B.cs"]) });
  if (r3.all_files === false) r.ok("3 exclusion: record says all_files false");
  else r.bad(`3 exclusion: all_files ${r3.all_files}`);
  for (const who of ["early", "late", "edited"]) {
    expectRow("3 exclusion", r3, who, { outcome: "auto-merged", merged: 1, from: c5, source: "synced" });
    const t = await treeOf(STUDENTS[who]);
    if (t.has("Lab06/A.cs") && !t.has("Lab06/B.cs")) r.ok(`3 exclusion: ${who} has A.cs and not B.cs`);
    else r.bad(`3 exclusion: ${who} A.cs ${t.has("Lab06/A.cs")}, B.cs ${t.has("Lab06/B.cs")}`);
  }

  // --- 4: not lost --------------------------------------------------------------------
  const r4 = await syncAndWait("4 not lost");
  for (const who of ["early", "late", "edited"]) {
    expectRow("4 not lost", r4, who, { outcome: "auto-merged", merged: 1, from: c5, source: "synced" });
    await expectFiles("4 not lost", who, LAB[6]);
  }

  // --- 5: never backwards ---------------------------------------------------------
  // Everyone holds lab 6. Syncing to lab 5 by name must take nothing away -
  // a range run backwards would delete every lab 6 file as "untouched".
  const beforeBack = {};
  for (const who of Object.keys(STUDENTS)) beforeBack[who] = await treeOf(STUDENTS[who]);
  const r5 = await syncAndWait("5 never backwards", { template_commit: c5.slice(0, 7) });
  for (const who of Object.keys(STUDENTS)) {
    expectRow("5 never backwards", r5, who, { outcome: "skipped-up-to-date" });
    const now = await treeOf(STUDENTS[who]);
    const same = now.size === beforeBack[who].size && [...beforeBack[who]].every(([p, s]) => now.get(p) === s);
    if (same) r.ok(`5 never backwards: ${who} lost nothing (${now.size} files)`);
    else r.bad(`5 never backwards: ${who} changed - ${beforeBack[who].size} -> ${now.size} files`);
  }

  // --- 6: cut off --------------------------------------------------------------------
  // The NetAdv case: a run that dies part-way. PAD more records (all pointing
  // at `late`, so each is a quick skip, ~0.8s) make the run long enough to
  // cancel after its START record has landed - which is what must survive it.
  // 40 was not: the run finished and closed its record before the cancel.
  const PAD = 150;
  const TOTAL = PAD + 3;
  const extra = Array.from({ length: PAD }, (_, i) => ({
    schema_version: 1, assignment_id: ID, github_login: `pad-${String(i).padStart(2, "0")}`, repo_id: repos.late.id,
    repo_name: `${org}/${STUDENTS.late}`, repo_url: `https://github.com/${org}/${STUDENTS.late}`,
  }));
  await controlCommit(`Live test fixture: ${ID} padding`, extra.map((x) => ({ path: `repositories/${ID}/${x.github_login}.json`, content: JSON.stringify(x, null, 2) + "\n" })));
  const known = new Set((await records()).map((x) => x.doc.sync_id));
  const cutRes = await api(`/repos/${HUB}/actions/workflows/sync-starter-code.yml/dispatches`, {
    token, method: "POST",
    body: { ref: "main", inputs: { org, assignment_id: ID, create_issue: false }, return_run_details: true },
  });
  const cutId = cutRes.data?.workflow_run_id;
  if (!cutId) die(`6 cut off: dispatch gave no run id (HTTP ${cutRes.status})`);
  let started = null;
  for (let waited = 0; waited < 5 * 60_000 && !started; waited += 3_000) {
    await sleep(3_000);
    started = (await records()).find((x) => !known.has(x.doc.sync_id))?.doc || null;
  }
  if (started?.status === "running" && started.run_id === cutId && started.total_students === TOTAL) {
    r.ok(`6 cut off: the start was recorded while the run was going (${TOTAL} students, run ${cutId})`);
  } else {
    r.bad(`6 cut off: no running start record for run ${cutId}: ${JSON.stringify(started && { status: started.status, run_id: started.run_id, total: started.total_students })}`);
  }
  await api(`/repos/${HUB}/actions/runs/${cutId}/cancel`, { token, method: "POST" });
  let cutRun;
  for (let waited = 0; waited < 5 * 60_000; waited += 5_000) {
    await sleep(5_000);
    cutRun = (await api(`/repos/${HUB}/actions/runs/${cutId}`, { token })).data;
    if (cutRun?.status === "completed") break;
  }
  const left = (await records()).find((x) => x.doc.sync_id === started?.sync_id)?.doc;
  if (cutRun?.conclusion === "cancelled" && left?.status === "running" && left.results.length < TOTAL) {
    r.ok(`6 cut off: cancelled; the record stayed "running" with ${left.results.length} of ${TOTAL} reached`);
  } else {
    r.bad(`6 cut off: run ${cutRun?.conclusion}, record ${left?.status} with ${left?.results?.length} results`);
  }
  const { describeSyncStatus } = await import("../../lib/sync-status.mjs");
  const said = describeSyncStatus({ record: left, run: cutRun });
  if (said?.state === "died" && said.action === "sync-again") r.ok(`6 cut off: the page would say "${said.title}" - ${said.detail}`);
  else r.bad(`6 cut off: the page would say ${JSON.stringify(said)}`);
  await controlCommit(`Live test fixture: ${ID} padding removed`, extra.map((x) => ({ path: `repositories/${ID}/${x.github_login}.json`, content: null })));

  console.log(`\n${r.failures() ? `${r.failures()} FAILED` : "all good"}\n`);
  process.exit(r.failures() ? 1 : 0);
}

main().catch((e) => die(e.stack || String(e)));
