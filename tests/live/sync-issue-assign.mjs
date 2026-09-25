#!/usr/bin/env node
// PXL Classroom - LIVE check that a starter sync's tracking issue is ASSIGNED
// to the students whose records name the repository. Not part of `npm test`.
//
//   node tests/live/sync-issue-assign.mjs
//
// An unassigned issue emails only people who watch the repository
// (2026-09-25: a lecturer who accepted their own assignment got nothing).
//
// One repository, three records naming it, as a group repository has:
//   - the account of TEST_LECTURER_TOKEN      (has access: assigned)
//   - ALSO_ASSIGN, default tomcoolpxl         (an org owner: assigned, and gets the email)
//   - an account that does not exist          (left off; the issue still stands)
//
// Runs the REAL Sync Starter Code workflow with the tracking issue on.

import { stringify } from "yaml";
import { commitWithRebase } from "../../lib/gittree.mjs";
import { validateAgainst } from "../../lib/validate.mjs";
import { CONTROL_REPO, HUB_OWNER, HUB_REPO_NAME } from "../../lib/deployment.mjs";
import { sameLogin } from "../../lib/github-login.mjs";
import { api, decode, die, loadEnv, reporter, sleep } from "./live-kit.mjs";

const env = loadEnv();
const org = process.env.PROBE_ORG || "pxl-classroom-testbed";
const token = env.TEST_LECTURER_TOKEN;
if (!token) die("TEST_LECTURER_TOKEN is required (.env.test)");
const HUB = `${HUB_OWNER}/${HUB_REPO_NAME}`;
const ID = "sync-assign-probe";
const TPL = "pxl-assign-probe-template";
const REPO = "pxl-assign-probe-team";
const ALSO = process.env.ALSO_ASSIGN || "tomcoolpxl";
const NOBODY = "pxl-no-such-account-7f3q";
const r = reporter();
const stamp = new Date().toISOString();

async function must(res, what) {
  if (!res.ok) die(`${what}: HTTP ${res.status} ${res.data?.message ?? ""}`);
  return res.data;
}

async function ensureRepo(name) {
  const got = await api(`/repos/${org}/${name}`, { token });
  if (got.ok) return got.data;
  if (got.status !== 404) die(`could not read ${org}/${name}: HTTP ${got.status}`);
  const made = await must(
    await api(`/orgs/${org}/repos`, { token, method: "POST", body: { name, private: true, auto_init: true, description: "tests/live/sync-issue-assign.mjs" } }),
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

async function main() {
  const me = (await must(await api("/user", { token }), "who am I")).login;
  console.log(`\nSync issue assignment probe - ${org}, hub ${HUB}, as ${me}\n`);

  await ensureRepo(TPL);
  const V1 = { "README.md": `# probe ${stamp}\n` };
  const V2 = { ...V1, "lab.md": `new lab ${stamp}\n` };
  const t1 = await commitFiles(TPL, V1, [], "Initial commit");
  const t2 = await commitFiles(TPL, V2, [t1], "add lab");
  await resetMain(TPL, t2);
  const repo = await ensureRepo(REPO);
  await resetMain(REPO, await commitFiles(REPO, V1, [], "Initial commit"));
  // Open issues from an earlier run would make "the newest issue" ambiguous.
  const open = await must(await api(`/repos/${org}/${REPO}/issues?state=open&per_page=100`, { token }), "list issues");
  for (const i of open) await api(`/repos/${org}/${REPO}/issues/${i.number}`, { token, method: "PATCH", body: { state: "closed" } });
  r.ok(`template ${t1.slice(0, 7)} -> ${t2.slice(0, 7)}; ${REPO} at the first${open.length ? `, ${open.length} old issue(s) closed` : ""}`);

  const assignment = {
    schema_version: 1, id: ID, title: "Sync issue assignment probe (live test)", organization: org,
    template: { owner: org, repository: TPL }, repository_name_pattern: "pxl-assign-probe-{team_slug}",
    assignment_type: "group", opens_at: "2026-09-01T08:00:00.000Z", deadline_at: "2027-06-30T21:00:00.000Z", state: "draft",
  };
  const recs = [me, ALSO, NOBODY].map((login) => ({
    schema_version: 1, assignment_id: ID, github_login: login, team_slug: "team", repo_id: repo.id,
    repo_name: `${org}/${REPO}`, repo_url: `https://github.com/${org}/${REPO}`,
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
  r.ok(`control repo: draft ${ID}, 3 records naming ${REPO} (${me}, ${ALSO}, ${NOBODY})`);

  const res = await api(`/repos/${HUB}/actions/workflows/sync-starter-code.yml/dispatches`, {
    token, method: "POST",
    body: { ref: "main", inputs: { org, assignment_id: ID, create_issue: true }, return_run_details: true },
  });
  const id = res.data?.workflow_run_id;
  if (!id) die(`dispatch gave no run id: HTTP ${res.status}`);
  let run;
  for (let waited = 0; waited < 15 * 60_000; waited += 10_000) {
    await sleep(10_000);
    run = (await api(`/repos/${HUB}/actions/runs/${id}`, { token })).data;
    if (run?.status === "completed") break;
  }
  if (run?.conclusion !== "success") die(`run ${run?.html_url} ended ${run?.status}/${run?.conclusion}`);
  r.ok(`run ${run.html_url} succeeded`);

  const rec = (await records()).at(-1)?.doc;
  const v = validateAgainst("sync-record", rec);
  if (!v.valid) r.bad(`record fails its schema: ${JSON.stringify(v.errors)}`);
  const row = rec.results.find((x) => x.issue_url);
  if (!row) die(`no row opened an issue: ${JSON.stringify(rec.results)}`);
  r.ok(`${row.github_login}: ${row.outcome}, issue ${row.issue_url}`);

  const issue = await must(await api(`/repos/${org}/${REPO}/issues/${row.issue_number}`, { token }), "read issue");
  const onGitHub = issue.assignees.map((a) => a.login);
  const want = [me, ALSO];
  if (want.every((w) => onGitHub.some((a) => sameLogin(a, w))) && !onGitHub.some((a) => sameLogin(a, NOBODY))) {
    r.ok(`GitHub shows the issue assigned to ${onGitHub.join(", ")}; ${NOBODY} left off`);
  } else {
    r.bad(`GitHub shows assignees [${onGitHub}], wanted ${want} and not ${NOBODY}`);
  }
  if (JSON.stringify([...row.issue_assignees].sort()) === JSON.stringify([...onGitHub].sort())) {
    r.ok(`the record keeps what GitHub answered: [${row.issue_assignees}]`);
  } else {
    r.bad(`record says [${row.issue_assignees}], GitHub says [${onGitHub}]`);
  }
  if (issue.user?.login?.endsWith("[bot]")) r.ok(`opened by ${issue.user.login}, so the assignment is somebody else's act and is notified`);
  else r.bad(`opened by ${issue.user?.login}`);

  console.log(`\n${r.failures() ? `${r.failures()} FAILED` : "all good"} - ${ALSO} should now have a "You were assigned" email for ${issue.html_url}\n`);
  process.exit(r.failures() ? 1 : 0);
}

main().catch((e) => die(e.stack || String(e)));
