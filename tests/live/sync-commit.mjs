#!/usr/bin/env node
// PXL Classroom - LIVE check of syncing a NAMED template commit. Not part of
// `npm test`.
//
//   node tests/live/sync-commit.mjs
//
// Rebuilds, on pxl-classroom-testbed, the situation .NET Advanced was left in
// on 2026-09-25 - lab 3 reached some students, lab 4 went over it - and runs
// the REAL Sync Starter Code workflow on the hub with `template_commit` set to
// lab 3. Then checks, from the repositories themselves:
//
//   missed   - never got lab 3, has lab 4, edited lab 2: gets exactly lab 3's
//              files, directly, and keeps everything else as it was
//   got      - has lab 3 untouched: no commit
//   working  - has lab 3 and has edited it: no commit, no pull request; the
//              edited file counted as kept
//
// and that the sync record names the lab 3 commit in full and only the missed
// student got an issue.
//
// Every fixture is RESET each run (main force-moved to a fresh commit), so the
// run is repeatable and leaves the same four repositories behind. The probe
// assignment in the testbed control repo is a draft. Nothing is deleted.

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
const ID = "sync-commit-probe";
const TPL = "pxl-sync-probe-template";
const STUDENTS = { missed: "pxl-sync-probe-missed", got: "pxl-sync-probe-got", working: "pxl-sync-probe-working" };
const r = reporter();
const stamp = new Date().toISOString();

const LAB2 = { "Lab02/Program.cs": `// lab 2 ${stamp}\n` };
const LAB3 = {
  "Lab03/Program.cs": `// lab 3 program ${stamp}\r\n`,
  "Lab03/Tests/TutorialTests.cs": `// lab 3 tests ${stamp}\r\n`,
  "Lab03/Lab03.csproj": `<Project Sdk="Microsoft.NET.Sdk"><!-- ${stamp} --></Project>\r\n`,
};
const LAB4 = { "Lab04/Program.cs": `// lab 4 ${stamp}\n` };

async function must(res, what) {
  if (!res.ok) die(`${what}: HTTP ${res.status} ${res.data?.message ?? ""}`);
  return res.data;
}

async function ensureRepo(name) {
  const got = await api(`/repos/${org}/${name}`, { token });
  if (got.ok) return got.data;
  if (got.status !== 404) die(`could not read ${org}/${name}: HTTP ${got.status}`);
  const made = await must(
    await api(`/orgs/${org}/repos`, { token, method: "POST", body: { name, private: true, auto_init: true, description: "tests/live/sync-commit.mjs" } }),
    `create ${org}/${name}`,
  );
  r.note(`created ${org}/${name}`);
  return made;
}

/** A commit of exactly these files, on top of `parents`. */
async function commitFiles(repo, files, parents, message) {
  const tree = await must(
    await api(`/repos/${org}/${repo}/git/trees`, {
      token, method: "POST",
      body: { tree: Object.entries(files).map(([path, content]) => ({ path, mode: "100644", type: "blob", content })) },
    }),
    `tree in ${repo}`,
  );
  const commit = await must(
    await api(`/repos/${org}/${repo}/git/commits`, { token, method: "POST", body: { message, tree: tree.sha, parents } }),
    `commit in ${repo}`,
  );
  return commit.sha;
}

async function resetMain(repo, sha) {
  await must(
    await api(`/repos/${org}/${repo}/git/refs/heads/main`, { token, method: "PATCH", body: { sha, force: true } }),
    `reset ${repo}`,
  );
}

async function mainSha(repo) {
  return (await must(await api(`/repos/${org}/${repo}/git/ref/heads/main`, { token }), `main of ${repo}`)).object.sha;
}

async function treeOf(repo, ref) {
  const t = await must(await api(`/repos/${org}/${repo}/git/trees/${ref}?recursive=1`, { token }), `tree of ${repo}`);
  return new Map(t.tree.filter((e) => e.type === "blob").map((e) => [e.path, e.sha]));
}

async function main() {
  console.log(`\nNamed-commit sync probe - ${org}, hub ${HUB}\n`);

  // --- the template: lab 2 -> lab 3 -> lab 4 ---------------------------------
  await ensureRepo(TPL);
  const a = await commitFiles(TPL, LAB2, [], "lab 2");
  const b = await commitFiles(TPL, { ...LAB2, ...LAB3 }, [a], "add lab 3 startcode");
  const c = await commitFiles(TPL, { ...LAB2, ...LAB3, ...LAB4 }, [b], "add lab 4 startcode");
  await resetMain(TPL, c);
  r.ok(`template: lab 2 ${a.slice(0, 7)} -> lab 3 ${b.slice(0, 7)} -> lab 4 ${c.slice(0, 7)}`);

  // --- the three students ------------------------------------------------------
  const EDITED_LAB2 = { "Lab02/Program.cs": `// lab 2, the student's own work ${stamp}\n` };
  const EDITED_LAB3 = { "Lab03/Program.cs": `// lab 3, the student's own work ${stamp}\r\n` };
  const fixtures = {
    missed: { ...EDITED_LAB2, ...LAB4 },
    got: { ...LAB2, ...LAB3, ...LAB4 },
    working: { ...LAB2, ...LAB3, ...EDITED_LAB3, ...LAB4 },
  };
  const repos = {};
  const before = {};
  for (const [who, name] of Object.entries(STUDENTS)) {
    repos[who] = await ensureRepo(name);
    await resetMain(name, await commitFiles(name, fixtures[who], [], "starter"));
    before[who] = await mainSha(name);
  }
  r.ok("students: missed (no lab 3), got (lab 3 untouched), working (lab 3 edited)");

  // --- the probe assignment, a draft, in the testbed control repo -------------
  const assignment = {
    schema_version: 1,
    id: ID,
    title: "Sync commit probe (live test)",
    organization: org,
    template: { owner: org, repository: TPL },
    repository_name_pattern: "pxl-sync-probe-{github_login}",
    opens_at: "2026-09-01T08:00:00.000Z",
    deadline_at: "2027-06-30T21:00:00.000Z",
    state: "draft",
  };
  const records = Object.entries(STUDENTS).map(([who, name]) => ({
    schema_version: 1,
    assignment_id: ID,
    github_login: `probe-${who}`,
    repo_id: repos[who].id,
    repo_name: `${org}/${name}`,
    repo_url: `https://github.com/${org}/${name}`,
  }));
  for (const [kind, doc] of [["assignment", assignment], ...records.map((x) => ["repository-record", x])]) {
    const v = validateAgainst(kind, doc);
    if (!v.valid) die(`fixture ${kind} fails its schema: ${JSON.stringify(v.errors)}`);
  }
  await commitWithRebase({
    token, owner: org, repo: CONTROL_REPO, branch: "main", message: `Live test fixture: ${ID}`,
    changes: [
      { path: `assignments/${ID}.yml`, content: stringify(assignment) },
      ...records.map((x) => ({ path: `repositories/${ID}/${x.github_login}.json`, content: JSON.stringify(x, null, 2) + "\n" })),
    ],
  });
  r.ok(`control repo: draft ${ID} with ${records.length} repository records`);

  // --- the real workflow, naming lab 3 ----------------------------------------
  const since = new Date(Date.now() - 5_000).toISOString();
  const dispatched = await api(`/repos/${HUB}/actions/workflows/sync-starter-code.yml/dispatches`, {
    token, method: "POST",
    body: {
      ref: "main",
      inputs: { org, assignment_id: ID, template_commit: b.slice(0, 7), create_issue: true },
      return_run_details: true,
    },
  });
  if (!dispatched.ok) die(`dispatch refused: HTTP ${dispatched.status} ${dispatched.data?.message ?? ""}`);
  let runId = dispatched.data?.workflow_run_id ?? null;
  r.ok(`dispatched with template_commit ${b.slice(0, 7)}${runId ? ` - run ${runId} from the dispatch itself` : ""}`);
  if (!runId) {
    for (let i = 0; i < 12 && !runId; i++) {
      await sleep(5_000);
      const runs = await api(`/repos/${HUB}/actions/workflows/sync-starter-code.yml/runs?created=>=${since.slice(0, 19)}Z&per_page=20`, { token });
      runId = runs.data?.workflow_runs?.[0]?.id ?? null;
    }
    if (!runId) die("the dispatched run never appeared");
    r.note(`the dispatch returned no run id (HTTP ${dispatched.status}); found run ${runId} by listing`);
  }

  let run;
  for (let waited = 0; waited < 12 * 60_000; waited += 10_000) {
    run = (await api(`/repos/${HUB}/actions/runs/${runId}`, { token })).data;
    if (run?.status === "completed") break;
    await sleep(10_000);
  }
  if (run?.conclusion === "success") r.ok(`run ${run.html_url} succeeded`);
  else die(`run ${run?.html_url} ended ${run?.status}/${run?.conclusion}`);

  // --- what the repositories now hold -----------------------------------------
  const missedTree = await treeOf(STUDENTS.missed, "main");
  const tplLab3 = await treeOf(TPL, b);
  const lab3Paths = Object.keys(LAB3);
  if (lab3Paths.every((p) => missedTree.get(p) === tplLab3.get(p))) r.ok("missed: has every lab 3 file, byte-identical to the template");
  else r.bad(`missed: lab 3 incomplete - ${lab3Paths.map((p) => `${p}=${missedTree.get(p)?.slice(0, 7)}`).join(", ")}`);
  const beforeMissed = await treeOf(STUDENTS.missed, before.missed);
  const untouched = [...beforeMissed].every(([p, s]) => missedTree.get(p) === s);
  if (untouched) r.ok("missed: their edited lab 2 and their lab 4 are as they were");
  else r.bad("missed: a file they already had was changed");
  if (missedTree.size === beforeMissed.size + lab3Paths.length) r.ok("missed: nothing else was added");
  else r.bad(`missed: ${missedTree.size} files, expected ${beforeMissed.size + lab3Paths.length}`);

  for (const who of ["got", "working"]) {
    const now = await mainSha(STUDENTS[who]);
    if (now === before[who]) r.ok(`${who}: no commit`);
    else r.bad(`${who}: main moved ${before[who].slice(0, 7)} -> ${now.slice(0, 7)}`);
    const pulls = await api(`/repos/${org}/${STUDENTS[who]}/pulls?state=open`, { token });
    const fresh = (pulls.data || []).filter((p) => p.created_at >= since);
    if (!fresh.length) r.ok(`${who}: no pull request`);
    else r.bad(`${who}: a pull request was opened: ${fresh[0].html_url}`);
  }

  // --- issues, only where something arrived -----------------------------------
  for (const [who, name] of Object.entries(STUDENTS)) {
    const issues = await api(`/repos/${org}/${name}/issues?state=all&since=${since}`, { token });
    const n = (issues.data || []).filter((i) => !i.pull_request && i.created_at >= since).length;
    const want = who === "missed" ? 1 : 0;
    if (n === want) r.ok(`${who}: ${n} issue(s)`);
    else r.bad(`${who}: ${n} issue(s), expected ${want}`);
  }

  // --- the record --------------------------------------------------------------
  const list = await api(`/repos/${org}/${CONTROL_REPO}/contents/syncs/${ID}`, { token });
  const newest = (list.data || []).map((f) => f.name).sort().at(-1);
  const file = newest ? await api(`/repos/${org}/${CONTROL_REPO}/contents/syncs/${ID}/${newest}`, { token }) : null;
  const record = file?.ok ? JSON.parse(decode(file.data.content)) : null;
  if (!record) die("no sync record was written");
  if (record.template_sha === b) r.ok(`record names lab 3 in full (${b.slice(0, 12)}…)`);
  else r.bad(`record template_sha ${record.template_sha}, expected ${b}`);
  const row = Object.fromEntries(record.results.map((x) => [x.github_login, x]));
  const expect = [
    ["probe-missed", "auto-merged", (x) => x.files_merged === 3],
    ["probe-got", "skipped-up-to-date", (x) => !x.files_kept],
    ["probe-working", "skipped-up-to-date", (x) => x.files_kept === 1],
  ];
  for (const [login, outcome, extra] of expect) {
    const x = row[login];
    if (x?.outcome === outcome && extra(x)) r.ok(`record: ${login} ${outcome}${x.files_kept ? `, ${x.files_kept} kept` : ""}${x.files_merged ? `, ${x.files_merged} merged` : ""}`);
    else r.bad(`record: ${login} is ${JSON.stringify(x)}`);
  }
  const v = validateAgainst("sync-record", record);
  if (v.valid) r.ok("record validates against its schema");
  else r.bad(`record fails its schema: ${JSON.stringify(v.errors)}`);

  console.log(`\n${r.failures() ? `${r.failures()} FAILED` : "all good"}\n`);
  process.exit(r.failures() ? 1 : 0);
}

main().catch((e) => die(e.stack || String(e)));
