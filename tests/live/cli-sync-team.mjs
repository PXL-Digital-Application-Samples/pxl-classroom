#!/usr/bin/env node
// PXL Classroom - LIVE: the CLI starter sync on a TEAM repository, the real
// `pxl-classroom sync-starter` against pxl-classroom-testbed. Not part of
// `npm test`.
//
//   node tests/live/cli-sync-team.mjs
//
// Review 2026-09-26: the CLI planned every repository RECORD concurrently, and
// a team is several records naming one repository - so each member's worker
// read the open pull requests before the other's existed, and one team got a
// pull request (and a tracking issue) per member. Now one plan per repository
// (`oneRecordPerRepo`, lib/sync-issue.mjs).
//
//   setup   a template at T1; a team repository whose first commit carries
//           T1's tree (so the team starts `generated` at T1), then a student
//           edit to lab1.md; T2 changes lab1.md and adds lab2.md. Two
//           repository records - two members - name the one repository.
//   1 run   lab2.md lands on main, lab1.md is ONE pull request, ONE issue.
//   2 run   again: nothing new - the pull request is adopted, no second issue.
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
import { syncMarker } from "../../lib/starter-sync.mjs";
import { CONTROL_REPO } from "../../lib/deployment.mjs";
import { accounts, api, die, loadEnv, reporter, root } from "./live-kit.mjs";

const env = loadEnv();
const org = process.env.PROBE_ORG || "pxl-classroom-testbed";
const { LECTURER, STUDENT_A } = accounts(env);
const token = LECTURER.token;
if (!token) die("TEST_LECTURER_TOKEN is required (.env.test)");
const ID = "cli-team-probe";
const TPL = "pxl-cli-team-probe-template";
const GRP = "pxl-cli-team-probe-grp";
const r = reporter();
const stamp = new Date().toISOString();

const T1 = { "README.md": `# team lab ${stamp}\n`, "lab1.md": `lab 1 starter ${stamp}\n` };
const T2 = { ...T1, "lab1.md": `lab 1 starter, corrected ${stamp}\n`, "lab2.md": `lab 2 starter ${stamp}\n` };
const EDIT = { ...T1, "lab1.md": `lab 1 - OUR WORK ${stamp}\n` };

async function must(res, what) {
  if (!res.ok) die(`${what}: HTTP ${res.status} ${res.data?.message ?? ""}`);
  return res.data;
}
async function ensureRepo(name) {
  const got = await api(`/repos/${org}/${name}`, { token });
  if (got.ok) return got.data;
  if (got.status !== 404) die(`could not read ${org}/${name}: HTTP ${got.status}`);
  const made = await must(await api(`/orgs/${org}/repos`, { token, method: "POST", body: { name, private: true, auto_init: true, description: "tests/live/cli-sync-team.mjs" } }), `create ${name}`);
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
async function closeAll(kind) {
  const open = (await api(`/repos/${org}/${GRP}/${kind}?state=open&per_page=100`, { token })).data || [];
  for (const x of open.filter((i) => kind === "pulls" || !i.pull_request)) {
    await api(`/repos/${org}/${GRP}/${kind === "pulls" ? "pulls" : "issues"}/${x.number}`, { token, method: "PATCH", body: { state: "closed" } });
  }
}
async function openSyncPulls(templateSha) {
  const pulls = (await api(`/repos/${org}/${GRP}/pulls?state=open&per_page=100`, { token })).data || [];
  return pulls.filter((p) => (p.body || "").includes(syncMarker(templateSha)));
}
// The issue list lags a fresh issue by seconds (measured: created 1s after the
// pull request, absent from the list read just after the CLI exited), so a
// count is read until it settles on one or 30 seconds pass.
async function openIssues() {
  let issues = [];
  for (let waited = 0; waited <= 30_000; waited += 5_000) {
    const page = (await api(`/repos/${org}/${GRP}/issues?state=open&per_page=100`, { token })).data || [];
    issues = page.filter((i) => !i.pull_request);
    if (issues.length) return issues;
    await new Promise((res) => setTimeout(res, 5_000));
  }
  return issues;
}

function runCli(configDir, args) {
  const res = spawnSync("node", [join(root, "cli", "bin", "pxl-classroom.mjs"), ...args], {
    encoding: "utf8",
    // The scratch config dir is the CLI's whole world: its token, its org.
    env: { ...process.env, APPDATA: configDir, XDG_CONFIG_HOME: configDir },
    timeout: 10 * 60_000,
  });
  return { status: res.status, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

async function main() {
  console.log(`\nCLI starter sync on a team repository - ${org}\n`);

  // --- setup -------------------------------------------------------------------
  await ensureRepo(TPL);
  const t1 = await commitFiles(TPL, T1, [], "Initial commit");
  await resetMain(TPL, t1);
  const grp = await ensureRepo(GRP);
  await closeAll("pulls");
  await closeAll("issues");
  const first = await commitFiles(GRP, T1, [], "Initial commit");
  await resetMain(GRP, await commitFiles(GRP, EDIT, [first], "our work on lab 1"));
  const t2 = await commitFiles(TPL, T2, [t1], "correct lab 1, add lab 2");
  await resetMain(TPL, t2);
  r.ok(`template ${t1.slice(0, 7)} -> ${t2.slice(0, 7)}; team repository at T1's tree plus an edit to lab1.md`);

  const assignment = {
    schema_version: 1, id: ID, title: "CLI team sync probe (live test)", organization: org,
    template: { owner: org, repository: TPL }, repository_name_pattern: "pxl-cli-team-probe-{team_slug}",
    opens_at: "2026-09-01T08:00:00.000Z", deadline_at: "2027-06-30T21:00:00.000Z", state: "draft",
    assignment_type: "group", group_config: { max_team_size: 3 },
  };
  const members = [LECTURER.login, STUDENT_A.login];
  const recs = members.map((login) => ({
    schema_version: 1, assignment_id: ID, github_login: login, team_slug: "grp", repo_id: grp.id,
    repo_name: `${org}/${GRP}`, repo_url: `https://github.com/${org}/${GRP}`,
  }));
  for (const [kind, doc] of [["assignment", assignment], ...recs.map((x) => ["repository-record", x])]) {
    const v = validateAgainst(kind, structuredClone(doc));
    if (!v.valid) die(`fixture ${kind} fails its schema: ${JSON.stringify(v.errors)}`);
  }
  const stale = (await api(`/repos/${org}/${CONTROL_REPO}/contents/repositories/${ID}`, { token })).data;
  await commitWithRebase({
    token, owner: org, repo: CONTROL_REPO, branch: "main", message: `Live test fixture: ${ID}`,
    changes: [
      { path: `assignments/${ID}.yml`, content: stringify(assignment) },
      ...(Array.isArray(stale) ? stale.filter((f) => !members.some((m) => f.name === `${m}.json`)).map((f) => ({ path: f.path, content: null })) : []),
      ...recs.map((x) => ({ path: `repositories/${ID}/${x.github_login}.json`, content: JSON.stringify(x, null, 2) + "\n" })),
    ],
  });
  r.ok(`control repo: draft ${ID}, two members (${members.join(", ")}) naming ${GRP}`);

  const configDir = mkdtempSync(join(tmpdir(), "pxl-cli-probe-"));
  try {
    const cfg = join(configDir, "pxl-classroom");
    mkdirSync(cfg, { recursive: true });
    writeFileSync(join(cfg, "token"), JSON.stringify({ access_token: token, obtained_at: new Date().toISOString() }));
    writeFileSync(join(cfg, "config.json"), JSON.stringify({ last_org: org }));

    // --- 1 -------------------------------------------------------------------
    const one = runCli(configDir, ["sync-starter", "--org", org, "--assignment", ID, "--issue"]);
    if (one.status !== 0) die(`1 the CLI exited ${one.status}:\n${one.out}`);
    if (/Processing 1 student repositories .*1 team member\(s\) share one of them/.test(one.out)) r.ok("1 the CLI planned one repository for two records");
    else r.bad(`1 the CLI did not say it planned per repository:\n${one.out}`);
    const pulls = await openSyncPulls(t2);
    if (pulls.length === 1) r.ok(`1 ONE pull request (#${pulls[0].number})`);
    else r.bad(`1 ${pulls.length} sync pull requests: ${pulls.map((p) => `#${p.number}`).join(", ")}`);
    const files = pulls[0] ? (await api(`/repos/${org}/${GRP}/pulls/${pulls[0].number}/files`, { token })).data || [] : [];
    if (files.length === 1 && files[0].filename === "lab1.md") r.ok("1 the pull request carries lab1.md only - the file they edited");
    else r.bad(`1 the pull request carries [${files.map((f) => f.filename)}]`);
    if ((await fileAt(GRP, "lab2.md")) === T2["lab2.md"]) r.ok("1 lab2.md is on main");
    else r.bad("1 lab2.md did not land on main");
    if ((await fileAt(GRP, "lab1.md")) === EDIT["lab1.md"]) r.ok("1 their lab1.md is untouched on main");
    else r.bad("1 their lab1.md was overwritten on main");
    const issues = await openIssues();
    if (issues.length === 1) r.ok(`1 ONE tracking issue (#${issues[0].number}), assigned to [${issues[0].assignees.map((a) => a.login)}]`);
    else r.bad(`1 ${issues.length} tracking issues`);

    // --- 2 -------------------------------------------------------------------
    const two = runCli(configDir, ["sync-starter", "--org", org, "--assignment", ID, "--issue"]);
    if (two.status !== 0) die(`2 the CLI exited ${two.status}:\n${two.out}`);
    const pulls2 = await openSyncPulls(t2);
    const issues2 = await openIssues();
    if (pulls2.length === 1 && pulls2[0].number === pulls[0]?.number) r.ok("2 run again: the same one pull request, adopted");
    else r.bad(`2 run again: ${pulls2.length} pull requests`);
    if (issues2.length === 1) r.ok("2 run again: still one issue");
    else r.bad(`2 run again: ${issues2.length} issues`);
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }

  console.log(`\n${r.failures() ? `${r.failures()} FAILED` : "all good"}\n`);
  process.exit(r.failures() ? 1 : 0);
}

main().catch((e) => die(e.stack || String(e)));
