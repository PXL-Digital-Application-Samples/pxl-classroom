#!/usr/bin/env node
// PXL Classroom - LIVE check that a starter sync brings a repository created
// from ANOTHER template up to this one whole. Not part of `npm test`.
//
//   node tests/live/sync-template-swap.mjs
//
// 2026-09-25, PXL-Automation-II / 2627-pe-1-test-1: published on the wrong
// template, accepted, template changed, synced - and `.gitignore`,
// `.gitattributes` and `infra/README.md`, added by earlier commits of the new
// template, never arrived, because the student's first commit matched no
// commit of it and the start fell back to the newest commit's parent.
//
// Runs the REAL Sync Starter Code workflow on the hub against
// pxl-classroom-testbed:
//
//   0 trust      the first commit of a repository PROVISIONING generated
//                reads as generated (rootCommit); the fixtures here, built from
//                the lecturer's own commits, do not - so this probe runs the
//                UNTRUSTED path (review 2026-09-26: a force-pushed history).
//   1 swap       the new template has three commits; the old starter was a
//                README and a notes file. Nothing proves their first commit
//                was starter code, so: every new file arrives directly, the
//                README (which no version of THIS template ever had) is a
//                pull request for both, and so is removing notes.md - never
//                deleted on main. Both start `first-commit`.
//   2 evidence   one more template commit. Round 1's record is where they
//                are now (`synced`), so only the new file is sent.
//   3 again      the assignment moves to a THIRD template. Their last sync
//                came from the second, so that commit is the base
//                (`other-template`): the second template's own files are
//                removed, the third's added, theirs left alone.
//
// Fixtures are reset each run and earlier records of this probe cleared. The
// probe assignment is a draft. No issue is opened.

import { stringify } from "yaml";
import { commitWithRebase } from "../../lib/gittree.mjs";
import { rootCommit } from "../../lib/starter-sync-cohort.mjs";
import { validateAgainst } from "../../lib/validate.mjs";
import { CONTROL_REPO, HUB_OWNER, HUB_REPO_NAME } from "../../lib/deployment.mjs";
import { api, decode, die, loadEnv, reporter, sleep } from "./live-kit.mjs";

const env = loadEnv();
// Named, never TEST_ORG: this creates repositories (see inline-commit.mjs).
const org = process.env.PROBE_ORG || "pxl-classroom-testbed";
const token = env.TEST_LECTURER_TOKEN;
if (!token) die("TEST_LECTURER_TOKEN is required (.env.test)");
const HUB = `${HUB_OWNER}/${HUB_REPO_NAME}`;
const ID = "sync-swap-probe";
const TPL = "pxl-swap-probe-template";
const STUDENTS = { fresh: "pxl-swap-probe-fresh", worked: "pxl-swap-probe-worked" };
const r = reporter();
const stamp = new Date().toISOString();

// The template the assignment was published on by mistake.
const OLD = { "README.md": `# wrong template ${stamp}\n`, "notes.md": `old notes ${stamp}\n` };
// The right one, as the real one was built: in several commits.
const NEW1 = { "README.md": `# PE 1 ${stamp}\n`, ".gitignore": `*.tfstate\n# ${stamp}\n` };
const NEW2 = { ...NEW1, ".gitattributes": `* text=auto eol=lf\n# ${stamp}\n`, "infra/README.md": `infra ${stamp}\n` };
const NEW3 = { ...NEW2, ".github/workflows/classroom.yml": `name: grade # ${stamp}\non: push\njobs: {}\n`, "PROCEDURE.md": `procedure ${stamp}\n` };
const NEW4 = { ...NEW3, "infra/main.tf": `# main ${stamp}\n` };
// A THIRD template (round 3): shares README and .gitignore with the second,
// adds one file of its own, and has none of the rest.
const TPL_C = "pxl-swap-probe-template-c";
const THIRD = { "README.md": NEW1["README.md"], ".gitignore": NEW1[".gitignore"], "c-only.md": `third ${stamp}\n` };

async function must(res, what) {
  if (!res.ok) die(`${what}: HTTP ${res.status} ${res.data?.message ?? ""}`);
  return res.data;
}

async function ensureRepo(name) {
  const got = await api(`/repos/${org}/${name}`, { token });
  if (got.ok) return got.data;
  if (got.status !== 404) die(`could not read ${org}/${name}: HTTP ${got.status}`);
  const made = await must(
    await api(`/orgs/${org}/repos`, { token, method: "POST", body: { name, private: true, auto_init: true, description: "tests/live/sync-template-swap.mjs" } }),
    `create ${org}/${name}`,
  );
  r.note(`created ${org}/${name}`);
  return made;
}

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

async function syncAndWait(label) {
  const res = await api(`/repos/${HUB}/actions/workflows/sync-starter-code.yml/dispatches`, {
    token, method: "POST",
    body: { ref: "main", inputs: { org, assignment_id: ID, create_issue: false }, return_run_details: true },
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
  if (newest?.run_id !== id) die(`${label}: newest record is not run ${id}'s`);
  const v = validateAgainst("sync-record", newest);
  if (!v.valid) r.bad(`${label}: record fails its schema: ${JSON.stringify(v.errors)}`);
  return newest;
}

function expectRow(label, record, login, want) {
  const x = record.results.find((y) => y.github_login === login);
  const got = { outcome: x?.outcome, merged: x?.files_merged ?? 0, conflicted: x?.files_conflicted ?? 0, from: x?.from_sha ?? null, source: x?.from_source };
  const bad = Object.keys(want).filter((k) => want[k] !== got[k]);
  if (bad.length) r.bad(`${label}: ${login} expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
  else r.ok(`${label}: ${login} ${JSON.stringify(want)}`);
  return x;
}

/** The student's main holds exactly `want`'s paths, each byte-identical to the template's at `tplRef`, except `theirs`. */
async function expectExactly(label, who, want, tplRef, theirs = [], leftAlone = []) {
  const [mine, tpl] = [await treeOf(STUDENTS[who]), await treeOf(TPL, tplRef)];
  const extra = [...mine.keys()].filter((p) => !(p in want) && !leftAlone.includes(p));
  const gone = leftAlone.filter((p) => !mine.has(p));
  if (gone.length) r.bad(`${label}: ${who} lost [${gone}], which no template version proves was starter code`);
  const missing = Object.keys(want).filter((p) => !mine.has(p));
  const differ = Object.keys(want).filter((p) => mine.has(p) && !theirs.includes(p) && mine.get(p) !== tpl.get(p));
  const kept = theirs.filter((p) => mine.get(p) === tpl.get(p));
  if (extra.length || missing.length || differ.length || kept.length) {
    r.bad(`${label}: ${who} extra [${extra}] missing [${missing}] differs [${differ}] overwritten [${kept}]`);
  } else {
    r.ok(`${label}: ${who} holds the template's ${Object.keys(want).length - theirs.length} file(s)${theirs.length ? ` and their own ${theirs.join(", ")}` : ""}, nothing else`);
  }
}

async function main() {
  console.log(`\nTemplate swap sync probe - ${org}, hub ${HUB}\n`);

  await ensureRepo(TPL);
  const n1 = await commitFiles(TPL, NEW1, [], "Initial commit");
  const n2 = await commitFiles(TPL, NEW2, [n1], "add gitattributes and infra");
  const n3 = await commitFiles(TPL, NEW3, [n2], "add workflow and procedure");
  await resetMain(TPL, n3);
  r.ok(`new template: ${n1.slice(0, 7)} -> ${n2.slice(0, 7)} -> ${n3.slice(0, 7)}`);

  // Both students were created from the OLD template: their first commit is
  // its tree, which is no tree of the new one.
  const repos = {};
  for (const [who, name] of Object.entries(STUDENTS)) repos[who] = await ensureRepo(name);
  await resetMain(STUDENTS.fresh, await commitFiles(STUDENTS.fresh, OLD, [], "Initial commit"));
  const MINE = { "README.md": `# my notes ${stamp}\n` };
  {
    const root = await commitFiles(STUDENTS.worked, OLD, [], "Initial commit");
    await resetMain(STUDENTS.worked, await commitFiles(STUDENTS.worked, { ...OLD, ...MINE }, [root], "my notes"));
  }
  r.ok("students: fresh (old starter, untouched), worked (old starter, README edited)");

  const assignment = {
    schema_version: 1, id: ID, title: "Sync template swap probe (live test)", organization: org,
    template: { owner: org, repository: TPL }, repository_name_pattern: "pxl-swap-probe-{github_login}",
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
  await commitWithRebase({
    token, owner: org, repo: CONTROL_REPO, branch: "main", message: `Live test fixture: ${ID}`,
    changes: [
      { path: `assignments/${ID}.yml`, content: stringify(assignment) },
      ...recs.map((x) => ({ path: `repositories/${ID}/${x.github_login}.json`, content: JSON.stringify(x, null, 2) + "\n" })),
      ...stale.map((s) => ({ path: s.path, content: null })),
    ],
  });
  r.ok(`control repo: draft ${ID}${stale.length ? `, ${stale.length} earlier record(s) cleared` : ""}`);

  // --- 0: trust -----------------------------------------------------------------
  // With headers: rootCommit finds the first commit through the `link` header.
  const get = async (p) => {
    const res = await fetch(`https://api.github.com${p}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "pxl-classroom-live" } });
    return { status: res.status, data: await res.json().catch(() => null), headers: Object.fromEntries(res.headers) };
  };
  const provisioned = `${org}/live-smoke-group-smoke-team`; // created by provisioning (smoke.mjs)
  const real = await rootCommit(get, provisioned, "main");
  if (real?.generated === true) r.ok(`0 trust: ${provisioned}'s first commit reads as generated`);
  else r.bad(`0 trust: ${provisioned}'s first commit does not read as generated: ${JSON.stringify(real)}`);
  for (const name of Object.values(STUDENTS)) {
    const own = await rootCommit(get, `${org}/${name}`, "main");
    if (own && own.generated === false) r.ok(`0 trust: ${name} (the lecturer's own commits) is not trusted`);
    else r.bad(`0 trust: ${name} ${JSON.stringify(own)}`);
  }

  // --- 1: swap ------------------------------------------------------------------
  const r1 = await syncAndWait("1 swap");
  // Both: the 5 files they lack written on main; the old README and the
  // removal of notes.md offered as ONE pull request - notes.md stays on main.
  const f = expectRow("1 swap", r1, "fresh", { outcome: "merged-and-pr", merged: 5, conflicted: 2, from: null, source: "first-commit" });
  await expectExactly("1 swap", "fresh", NEW3, n3, ["README.md"], ["notes.md"]);
  const w = expectRow("1 swap", r1, "worked", { outcome: "merged-and-pr", merged: 5, conflicted: 2, from: null, source: "first-commit" });
  await expectExactly("1 swap", "worked", NEW3, n3, ["README.md"], ["notes.md"]);
  for (const [who, row] of [["fresh", f], ["worked", w]]) {
    if (!row?.pr_number) { r.bad(`1 swap: ${who} has no pull request`); continue; }
    const files = await must(await api(`/repos/${org}/${STUDENTS[who]}/pulls/${row.pr_number}/files`, { token }), "pr files");
    const got = files.map((x) => `${x.filename}:${x.status}`).sort().join(",");
    if (got === "README.md:modified,notes.md:removed") r.ok(`1 swap: ${who}'s pull request #${row.pr_number} carries the README and removing notes.md - nothing else`);
    else r.bad(`1 swap: ${who}'s pull request carries ${got}`);
    await api(`/repos/${org}/${STUDENTS[who]}/pulls/${row.pr_number}`, { token, method: "PATCH", body: { state: "closed" } });
  }

  // --- 2: evidence --------------------------------------------------------------
  // Round 1 reached them (nothing kept), so it is where they are now.
  const n4 = await commitFiles(TPL, NEW4, [n3], "add main.tf");
  await resetMain(TPL, n4);
  const r2 = await syncAndWait("2 evidence");
  expectRow("2 evidence", r2, "fresh", { outcome: "auto-merged", merged: 1, conflicted: 0, from: n3, source: "synced" });
  expectRow("2 evidence", r2, "worked", { outcome: "auto-merged", merged: 1, conflicted: 0, from: n3, source: "synced" });
  await expectExactly("2 evidence", "fresh", NEW4, n4, ["README.md"], ["notes.md"]);
  await expectExactly("2 evidence", "worked", NEW4, n4, ["README.md"], ["notes.md"]);

  // --- 3: switched AGAIN --------------------------------------------------------
  // The assignment moves to a third template. Their last sync came from the
  // second one, at n4 - exactly what they hold - so that is the base
  // (`other-template`): its own files are removed on main, the third's new
  // file added, and what is theirs (README, notes.md) left alone.
  await ensureRepo(TPL_C);
  const c1 = await commitFiles(TPL_C, THIRD, [], "Initial commit");
  await resetMain(TPL_C, c1);
  await commitWithRebase({
    token, owner: org, repo: CONTROL_REPO, branch: "main", message: `Live test fixture: ${ID} switches template again`,
    changes: [{ path: `assignments/${ID}.yml`, content: stringify({ ...assignment, template: { owner: org, repository: TPL_C } }) }],
  });
  const r3 = await syncAndWait("3 switched again");
  const gone = Object.keys(NEW4).filter((p) => !(p in THIRD));
  for (const who of ["fresh", "worked"]) {
    expectRow("3 switched again", r3, who, { outcome: "auto-merged", merged: gone.length + 1, conflicted: 0, from: n4, source: "other-template" });
    const [mine, third] = [await treeOf(STUDENTS[who]), await treeOf(TPL_C, c1)];
    const left = gone.filter((p) => mine.has(p));
    const missingC = mine.get("c-only.md") !== third.get("c-only.md");
    const theirs = ["README.md", "notes.md"].filter((p) => !mine.has(p));
    if (left.length || missingC || theirs.length) r.bad(`3 switched again: ${who} still has [${left}], c-only ${missingC ? "missing" : "ok"}, lost [${theirs}]`);
    else r.ok(`3 switched again: ${who} lost the second template's ${gone.length} file(s), gained the third's, kept their own`);
  }

  console.log(`\n${r.failures() ? `${r.failures()} FAILED` : "all good"}\n`);
  process.exit(r.failures() ? 1 : 0);
}

main().catch((e) => die(e.stack || String(e)));
