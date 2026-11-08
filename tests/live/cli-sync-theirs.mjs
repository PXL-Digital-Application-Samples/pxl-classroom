#!/usr/bin/env node
// PXL Classroom - LIVE: the CLI starter sync over repositories whose history is
// their own, or already carries the template's files - the real
// `pxl-classroom sync-starter` against pxl-classroom-testbed. Not part of
// `npm test`.
//
//   node tests/live/cli-sync-theirs.mjs
//
// 2026-11-08, PXL-Systems-Expert: a team's own .env.example, filled in, was
// offered as a pull request wiping it, because their repository was planned
// from its own first commit and the file read as a template change the
// template had never made. Three repositories here, each one record:
//
//   own     a first commit of the lecturer's own (no template commit matches
//           it, and GitHub did not generate it) holding T1's files with
//           config.env FILLED IN. T2 changes lab1.md and adds lab2.md; the
//           template never changed config.env.
//           1 run: lab1.md and lab2.md land on main, config.env is left as
//           theirs, NO pull request.
//   merged  generated at T1 (its root IS T1's tree), then given T2's files by
//           hand, as a lecturer's pull request merged by the team would.
//           1 run: up to date, nothing sent, no pull request.
//   mid     generated at T1, holding lab1.md at T2's version by hand; T3
//           changes lab1.md again.
//           2 run (target T3): lab1.md written on main - a template version in
//           between is starter code, never offered back as a pull request.
//
// The CLI runs as the testbed lecturer from a scratch config directory
// (APPDATA / XDG_CONFIG_HOME), never the user's own CLI login. Fixtures are
// reset each run; the probe assignment is a draft.

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { commitWithRebase } from "../../lib/gittree.mjs";
import { validateAgainst } from "../../lib/validate.mjs";
import { CONTROL_REPO } from "../../lib/deployment.mjs";
import { sameLogin } from "../../lib/github-login.mjs";
import { accounts, api, decode, die, loadEnv, reporter, root } from "./live-kit.mjs";

const env = loadEnv();
const org = process.env.PROBE_ORG || "pxl-classroom-testbed";
const { LECTURER, STUDENT_A, STUDENT_B } = accounts(env);
const token = LECTURER.token;
if (!token) die("TEST_LECTURER_TOKEN is required (.env.test)");
const ID = "cli-theirs-probe";
const TPL = "pxl-cli-theirs-probe-template";
const REPOS = {
  own: { name: "pxl-cli-theirs-probe-own", login: LECTURER.login },
  merged: { name: "pxl-cli-theirs-probe-merged", login: STUDENT_A.login },
  mid: { name: "pxl-cli-theirs-probe-mid", login: STUDENT_B.login },
};
const r = reporter();
const stamp = new Date().toISOString();

const T1 = { "README.md": `# theirs lab ${stamp}\n`, "lab1.md": `lab 1 starter ${stamp}\n`, "config.env": "NAME=\n" };
const T2 = { ...T1, "lab1.md": `lab 1 starter, corrected ${stamp}\n`, "lab2.md": `lab 2 starter ${stamp}\n` };
const T3 = { ...T2, "lab1.md": `lab 1 starter, corrected twice ${stamp}\n` };
const FILLED = `NAME=alice-${stamp}\n`;

async function must(res, what) {
  if (!res.ok) die(`${what}: HTTP ${res.status} ${res.data?.message ?? ""}`);
  return res.data;
}
async function ensureRepo(name) {
  const got = await api(`/repos/${org}/${name}`, { token });
  if (got.ok) return got.data;
  if (got.status !== 404) die(`could not read ${org}/${name}: HTTP ${got.status}`);
  const made = await must(await api(`/orgs/${org}/repos`, { token, method: "POST", body: { name, private: true, auto_init: true, description: "tests/live/cli-sync-theirs.mjs" } }), `create ${name}`);
  r.note(`created ${org}/${name}`);
  return made;
}
async function commitFiles(repo, files, parents, message) {
  const tree = await must(await api(`/repos/${org}/${repo}/git/trees`, {
    token, method: "POST", body: { tree: Object.entries(files).map(([path, content]) => ({ path, mode: "100644", type: "blob", content })) },
  }), `tree in ${repo}`);
  return (await must(await api(`/repos/${org}/${repo}/git/commits`, { token, method: "POST", body: { message, tree: tree.sha, parents } }), `commit in ${repo}`)).sha;
}
const resetMain = async (repo, sha) =>
  must(await api(`/repos/${org}/${repo}/git/refs/heads/main`, { token, method: "PATCH", body: { sha, force: true } }), `reset ${repo}`);
async function fileAt(repo, path) {
  const res = await api(`/repos/${org}/${repo}/contents/${path}`, { token });
  return res.ok ? Buffer.from(res.data.content, "base64").toString("utf8") : null;
}
async function closeAll(repo, kind) {
  const open = (await api(`/repos/${org}/${repo}/${kind}?state=open&per_page=100`, { token })).data || [];
  for (const x of open.filter((i) => kind === "pulls" || !i.pull_request)) {
    await api(`/repos/${org}/${repo}/${kind === "pulls" ? "pulls" : "issues"}/${x.number}`, { token, method: "PATCH", body: { state: "closed" } });
  }
}
async function openPulls(repo) {
  return (await api(`/repos/${org}/${repo}/pulls?state=open&per_page=100`, { token })).data || [];
}
async function newestRecord() {
  const list = await api(`/repos/${org}/${CONTROL_REPO}/contents/syncs/${ID}`, { token });
  if (!list.ok || !Array.isArray(list.data)) return null;
  const docs = [];
  for (const f of list.data) {
    const one = await api(`/repos/${org}/${CONTROL_REPO}/contents/${f.path}`, { token });
    if (one.ok) docs.push(JSON.parse(decode(one.data.content)));
  }
  return docs.sort((a, b) => String(a.synced_at).localeCompare(String(b.synced_at))).at(-1) ?? null;
}
const rowOf = (rec, login) => rec?.results?.find((x) => sameLogin(x.github_login, login)) ?? null;

function runCli(configDir, args) {
  const res = spawnSync("node", [join(root, "cli", "bin", "pxl-classroom.mjs"), ...args], {
    encoding: "utf8",
    env: { ...process.env, APPDATA: configDir, XDG_CONFIG_HOME: configDir },
    timeout: 10 * 60_000,
  });
  return { status: res.status, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

async function main() {
  console.log(`\nCLI starter sync over a rewritten history, a hand-merged copy and a version in between - ${org}\n`);

  // --- setup -------------------------------------------------------------------
  await ensureRepo(TPL);
  const repos = {};
  for (const [key, { name }] of Object.entries(REPOS)) {
    repos[key] = await ensureRepo(name);
    await closeAll(name, "pulls");
    await closeAll(name, "issues");
  }
  const t1 = await commitFiles(TPL, T1, [], "Initial commit");
  await resetMain(TPL, t1);
  const t2 = await commitFiles(TPL, T2, [t1], "correct lab 1, add lab 2");
  await resetMain(TPL, t2);
  // own: their own first commit, config.env already filled in - matches no template tree.
  await resetMain(REPOS.own.name, await commitFiles(REPOS.own.name, { ...T1, "config.env": FILLED }, [], "our repo"));
  // merged: generated at T1 (exactly T1's tree), then T2's files merged by hand.
  const mergedRoot = await commitFiles(REPOS.merged.name, T1, [], "Initial commit");
  await resetMain(REPOS.merged.name, await commitFiles(REPOS.merged.name, T2, [mergedRoot], "Merge the lecturer's pull request"));
  // mid: generated at T1, lab1.md brought to T2's version by hand - T3 comes later.
  const midRoot = await commitFiles(REPOS.mid.name, T1, [], "Initial commit");
  await resetMain(REPOS.mid.name, await commitFiles(REPOS.mid.name, { ...T1, "lab1.md": T2["lab1.md"] }, [midRoot], "Merge the lecturer's pull request"));
  r.ok(`template ${t1.slice(0, 7)} -> ${t2.slice(0, 7)}; own (filled config.env), merged (T2 by hand), mid (lab1.md at T2 by hand)`);

  const assignment = {
    schema_version: 1, id: ID, title: "CLI theirs probe (live test)", organization: org,
    template: { owner: org, repository: TPL }, repository_name_pattern: "pxl-cli-theirs-probe-{github_login}",
    opens_at: "2026-09-01T08:00:00.000Z", deadline_at: "2027-06-30T21:00:00.000Z", state: "draft",
    assignment_type: "individual",
  };
  const recOf = (key) => ({
    schema_version: 1, assignment_id: ID, github_login: REPOS[key].login, repo_id: repos[key].id,
    repo_name: `${org}/${REPOS[key].name}`, repo_url: `https://github.com/${org}/${REPOS[key].name}`,
  });
  const recs = { own: recOf("own"), merged: recOf("merged"), mid: recOf("mid") };
  for (const [kind, doc] of [["assignment", assignment], ...Object.values(recs).map((x) => ["repository-record", x])]) {
    const v = validateAgainst(kind, structuredClone(doc));
    if (!v.valid) die(`fixture ${kind} fails its schema: ${JSON.stringify(v.errors)}`);
  }
  const recordPath = (rec) => `repositories/${ID}/${rec.github_login}.json`;
  const stale = (await api(`/repos/${org}/${CONTROL_REPO}/contents/repositories/${ID}`, { token })).data;
  const staleSyncs = (await api(`/repos/${org}/${CONTROL_REPO}/contents/syncs/${ID}`, { token })).data;
  // `mid` is registered only before run 2: with a record from run 1 it would
  // start from that record, and the in-between case needs a GENERATED start.
  await commitWithRebase({
    token, owner: org, repo: CONTROL_REPO, branch: "main", message: `Live test fixture: ${ID}`,
    changes: [
      { path: `assignments/${ID}.yml`, content: stringify(assignment) },
      ...(Array.isArray(stale) ? stale.map((f) => ({ path: f.path, content: null })) : []),
      // Earlier runs' sync records would place these students at an old commit of a template whose history this run resets.
      ...(Array.isArray(staleSyncs) ? staleSyncs.map((f) => ({ path: f.path, content: null })) : []),
      { path: recordPath(recs.own), content: JSON.stringify(recs.own, null, 2) + "\n" },
      { path: recordPath(recs.merged), content: JSON.stringify(recs.merged, null, 2) + "\n" },
    ],
  });
  r.ok(`control repo: draft ${ID}, records for own and merged, no earlier sync records`);

  const configDir = mkdtempSync(join(tmpdir(), "pxl-cli-theirs-probe-"));
  try {
    const cfg = join(configDir, "pxl-classroom");
    mkdirSync(cfg, { recursive: true });
    writeFileSync(join(cfg, "token"), JSON.stringify({ access_token: token, obtained_at: new Date().toISOString() }));
    writeFileSync(join(cfg, "config.json"), JSON.stringify({ last_org: org }));

    // --- 1: target T2 -----------------------------------------------------------
    const one = runCli(configDir, ["sync-starter", "--org", org, "--assignment", ID]);
    if (one.status !== 0) die(`1 the CLI exited ${one.status}:\n${one.out}`);
    if (new RegExp(`${REPOS.own.login}: 1 file\\(s\\) the template never changed are theirs, not offered: config\\.env`).test(one.out)) r.ok("1 own: the CLI said config.env is theirs");
    else r.bad(`1 own: the CLI did not say config.env is theirs:\n${one.out}`);
    if ((await fileAt(REPOS.own.name, "config.env")) === FILLED) r.ok("1 own: config.env is still theirs on main");
    else r.bad("1 own: config.env was changed on main");
    if ((await fileAt(REPOS.own.name, "lab1.md")) === T2["lab1.md"] && (await fileAt(REPOS.own.name, "lab2.md")) === T2["lab2.md"]) r.ok("1 own: lab1.md corrected and lab2.md added on main");
    else r.bad("1 own: lab1.md / lab2.md did not land on main");
    if ((await openPulls(REPOS.own.name)).length === 0) r.ok("1 own: no pull request");
    else r.bad("1 own: a pull request was opened");
    if ((await fileAt(REPOS.merged.name, "lab2.md")) === T2["lab2.md"] && (await openPulls(REPOS.merged.name)).length === 0) r.ok("1 merged: nothing to do, no pull request");
    else r.bad("1 merged: changed, or a pull request was opened");
    const rec1 = await newestRecord();
    const own1 = rowOf(rec1, REPOS.own.login);
    const merged1 = rowOf(rec1, REPOS.merged.login);
    if (own1?.outcome === "auto-merged" && own1.from_source === "first-commit" && !own1.pr_number) r.ok("1 record: own is auto-merged from their first commit, no pull request");
    else r.bad(`1 record: own row ${JSON.stringify(own1 && { o: own1.outcome, s: own1.from_source, pr: own1.pr_number })}`);
    if (merged1?.outcome === "skipped-up-to-date" && merged1.from_source === "generated") r.ok("1 record: merged is up to date, generated at T1");
    else r.bad(`1 record: merged row ${JSON.stringify(merged1 && { o: merged1.outcome, s: merged1.from_source })}`);

    // --- 2: target T3 -----------------------------------------------------------
    const t3 = await commitFiles(TPL, T3, [t2], "correct lab 1 again");
    await resetMain(TPL, t3);
    await commitWithRebase({
      token, owner: org, repo: CONTROL_REPO, branch: "main", message: `Live test fixture: ${ID} (mid)`,
      changes: [{ path: recordPath(recs.mid), content: JSON.stringify(recs.mid, null, 2) + "\n" }],
    });
    const two = runCli(configDir, ["sync-starter", "--org", org, "--assignment", ID]);
    if (two.status !== 0) die(`2 the CLI exited ${two.status}:\n${two.out}`);
    if ((await fileAt(REPOS.mid.name, "lab1.md")) === T3["lab1.md"] && (await openPulls(REPOS.mid.name)).length === 0) r.ok("2 mid: lab1.md held at T2 by hand is written to T3 on main, no pull request");
    else r.bad(`2 mid: lab1.md ${JSON.stringify(await fileAt(REPOS.mid.name, "lab1.md"))}, pull requests ${(await openPulls(REPOS.mid.name)).length}`);
    if ((await fileAt(REPOS.mid.name, "lab2.md")) === T3["lab2.md"]) r.ok("2 mid: lab2.md added on main");
    else r.bad("2 mid: lab2.md missing");
    if ((await fileAt(REPOS.own.name, "config.env")) === FILLED && (await fileAt(REPOS.own.name, "lab1.md")) === T3["lab1.md"] && (await openPulls(REPOS.own.name)).length === 0) r.ok("2 own: lab1.md followed to T3, config.env still theirs, no pull request");
    else r.bad("2 own: config.env changed, lab1.md not at T3, or a pull request");
    const rec2 = await newestRecord();
    const mid2 = rowOf(rec2, REPOS.mid.login);
    if (mid2?.outcome === "auto-merged" && mid2.from_source === "generated" && !mid2.pr_number) r.ok("2 record: mid is auto-merged from T1, no pull request");
    else r.bad(`2 record: mid row ${JSON.stringify(mid2 && { o: mid2.outcome, s: mid2.from_source, pr: mid2.pr_number })}`);
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }

  console.log(`\n${r.failures() ? `${r.failures()} FAILED` : "all good"}\n`);
  process.exit(r.failures() ? 1 : 0);
}

main().catch((e) => die(e.stack || String(e)));
