#!/usr/bin/env node
// PXL Classroom - LIVE: the CLI starter sync against a student repository whose
// own RULESET refuses the direct write - the real `pxl-classroom sync-starter`
// against pxl-classroom-testbed. Not part of `npm test`.
//
//   node tests/live/cli-sync-ruleset.mjs
//
// 2026-11-08, PXL-Systems-Expert: four duo teams had put a ruleset on main
// requiring a pull request, with no bypass, so the sync's direct commit was
// refused with 422 "Repository rule violations found" and eight students were
// listed as "could not update" in GitHub's words. One team's second ruleset
// forbade creating any branch outside feature/* and fix/*. A ruleset binds
// everyone not on its bypass list - here the testbed lecturer running the CLI,
// exactly as it bound the App.
//
//   setup   a template at T1; a student repository at T1's tree; a ruleset on
//           its main requiring a pull request (no bypass). T2 changes lab1.md
//           and adds lab2.md.
//   1 run   nothing lands on main; ONE pull request carries both files; the
//           record row is pr-opened with main_refused; one [Action Required]
//           issue names the pull request.
//   2 run   again: the pull request is adopted, nothing new.
//   3 run   a second ruleset forbids creating any branch but fix/*; T3 changes
//           lab1.md again: a failed row that says what the team can do, no new
//           pull request, main untouched.
//
// The CLI runs as the testbed lecturer from a scratch config directory
// (APPDATA / XDG_CONFIG_HOME), never the user's own CLI login. The rulesets
// this drill makes are deleted at its end and before the next run's reset: a
// force-reset of main is exactly what the first one refuses.

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
import { accounts, api, decode, die, loadEnv, reporter, root } from "./live-kit.mjs";

const env = loadEnv();
const org = process.env.PROBE_ORG || "pxl-classroom-testbed";
const { LECTURER } = accounts(env);
const token = LECTURER.token;
if (!token) die("TEST_LECTURER_TOKEN is required (.env.test)");
const ID = "cli-rule-probe";
const TPL = "pxl-cli-rule-probe-template";
const STU = `pxl-cli-rule-probe-${LECTURER.login}`;
const RULESET_PREFIX = "PXL live test (cli-sync-ruleset):";
const r = reporter();
const stamp = new Date().toISOString();

const T1 = { "README.md": `# rule lab ${stamp}\n`, "lab1.md": `lab 1 starter ${stamp}\n` };
const T2 = { ...T1, "lab1.md": `lab 1 starter, corrected ${stamp}\n`, "lab2.md": `lab 2 starter ${stamp}\n` };
const T3 = { ...T2, "lab1.md": `lab 1 starter, corrected twice ${stamp}\n` };

async function must(res, what) {
  if (!res.ok) die(`${what}: HTTP ${res.status} ${res.data?.message ?? ""}`);
  return res.data;
}
async function ensureRepo(name) {
  const got = await api(`/repos/${org}/${name}`, { token });
  if (got.ok) return got.data;
  if (got.status !== 404) die(`could not read ${org}/${name}: HTTP ${got.status}`);
  const made = await must(await api(`/orgs/${org}/repos`, { token, method: "POST", body: { name, private: true, auto_init: true, description: "tests/live/cli-sync-ruleset.mjs" } }), `create ${name}`);
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
  const open = (await api(`/repos/${org}/${STU}/${kind}?state=open&per_page=100`, { token })).data || [];
  for (const x of open.filter((i) => kind === "pulls" || !i.pull_request)) {
    await api(`/repos/${org}/${STU}/${kind === "pulls" ? "pulls" : "issues"}/${x.number}`, { token, method: "PATCH", body: { state: "closed" } });
  }
}
async function openSyncPulls(templateSha) {
  const pulls = (await api(`/repos/${org}/${STU}/pulls?state=open&per_page=100`, { token })).data || [];
  return pulls.filter((p) => (p.body || "").includes(syncMarker(templateSha)));
}
// The issue list lags a fresh issue by seconds, so a count is read until it
// settles on one or 30 seconds pass (tests/live/cli-sync-team.mjs).
async function openIssues() {
  let issues = [];
  for (let waited = 0; waited <= 30_000; waited += 5_000) {
    const page = (await api(`/repos/${org}/${STU}/issues?state=open&per_page=100`, { token })).data || [];
    issues = page.filter((i) => !i.pull_request);
    if (issues.length) return issues;
    await new Promise((res) => setTimeout(res, 5_000));
  }
  return issues;
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
const myRow = (rec) => rec?.results?.find((x) => sameLogin(x.github_login, LECTURER.login)) ?? null;

// --- the rulesets this drill makes, and nothing else's ---------------------
async function dropOurRulesets() {
  const list = await api(`/repos/${org}/${STU}/rulesets`, { token });
  if (!list.ok) die(`could not list the rulesets of ${STU}: HTTP ${list.status} ${list.data?.message ?? ""}`);
  for (const rs of list.data.filter((x) => String(x.name).startsWith(RULESET_PREFIX))) {
    await must(await api(`/repos/${org}/${STU}/rulesets/${rs.id}`, { token, method: "DELETE" }), `delete ruleset ${rs.id}`);
    r.note(`deleted ruleset ${rs.id} "${rs.name}"`);
  }
}
// What the four teams had: main takes pull requests only, nobody bypasses.
async function requirePullRequests() {
  return must(await api(`/repos/${org}/${STU}/rulesets`, { token, method: "POST", body: {
    name: `${RULESET_PREFIX} main takes pull requests only`, target: "branch", enforcement: "active", bypass_actors: [],
    conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    rules: [{ type: "pull_request", parameters: {
      required_approving_review_count: 0, dismiss_stale_reviews_on_push: false, require_code_owner_review: false,
      require_last_push_approval: false, required_review_thread_resolution: false,
    } }],
  } }), "create the pull-request ruleset");
}
// What one of them had besides: no branch may be created outside fix/*.
async function forbidBranches() {
  return must(await api(`/repos/${org}/${STU}/rulesets`, { token, method: "POST", body: {
    name: `${RULESET_PREFIX} only fix/* branches`, target: "branch", enforcement: "active", bypass_actors: [],
    conditions: { ref_name: { include: ["~ALL"], exclude: ["refs/heads/main", "refs/heads/fix/*"] } },
    rules: [{ type: "creation" }],
  } }), "create the branch-creation ruleset");
}

function runCli(configDir, args) {
  const res = spawnSync("node", [join(root, "cli", "bin", "pxl-classroom.mjs"), ...args], {
    encoding: "utf8",
    env: { ...process.env, APPDATA: configDir, XDG_CONFIG_HOME: configDir },
    timeout: 10 * 60_000,
  });
  return { status: res.status, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

async function main() {
  console.log(`\nCLI starter sync against a student ruleset - ${org}\n`);

  // --- setup -------------------------------------------------------------------
  await ensureRepo(TPL);
  const stu = await ensureRepo(STU);
  await dropOurRulesets();
  const t1 = await commitFiles(TPL, T1, [], "Initial commit");
  await resetMain(TPL, t1);
  await closeAll("pulls");
  await closeAll("issues");
  await resetMain(STU, await commitFiles(STU, T1, [], "Initial commit"));
  const t2 = await commitFiles(TPL, T2, [t1], "correct lab 1, add lab 2");
  await resetMain(TPL, t2);
  r.ok(`template ${t1.slice(0, 7)} -> ${t2.slice(0, 7)}; student repository at T1's tree, untouched`);

  const assignment = {
    schema_version: 1, id: ID, title: "CLI ruleset sync probe (live test)", organization: org,
    template: { owner: org, repository: TPL }, repository_name_pattern: "pxl-cli-rule-probe-{github_login}",
    opens_at: "2026-09-01T08:00:00.000Z", deadline_at: "2027-06-30T21:00:00.000Z", state: "draft",
    assignment_type: "individual",
  };
  const rec = {
    schema_version: 1, assignment_id: ID, github_login: LECTURER.login, repo_id: stu.id,
    repo_name: `${org}/${STU}`, repo_url: `https://github.com/${org}/${STU}`,
  };
  for (const [kind, doc] of [["assignment", assignment], ["repository-record", rec]]) {
    const v = validateAgainst(kind, structuredClone(doc));
    if (!v.valid) die(`fixture ${kind} fails its schema: ${JSON.stringify(v.errors)}`);
  }
  const stale = (await api(`/repos/${org}/${CONTROL_REPO}/contents/repositories/${ID}`, { token })).data;
  await commitWithRebase({
    token, owner: org, repo: CONTROL_REPO, branch: "main", message: `Live test fixture: ${ID}`,
    changes: [
      { path: `assignments/${ID}.yml`, content: stringify(assignment) },
      ...(Array.isArray(stale) ? stale.filter((f) => f.name !== `${LECTURER.login}.json`).map((f) => ({ path: f.path, content: null })) : []),
      { path: `repositories/${ID}/${LECTURER.login}.json`, content: JSON.stringify(rec, null, 2) + "\n" },
    ],
  });
  r.ok(`control repo: draft ${ID}, one record (${LECTURER.login}) naming ${STU}`);

  const rs1 = await requirePullRequests();
  r.ok(`ruleset ${rs1.id} on ${STU}: main takes pull requests only, no bypass`);

  const configDir = mkdtempSync(join(tmpdir(), "pxl-cli-rule-probe-"));
  try {
    const cfg = join(configDir, "pxl-classroom");
    mkdirSync(cfg, { recursive: true });
    writeFileSync(join(cfg, "token"), JSON.stringify({ access_token: token, obtained_at: new Date().toISOString() }));
    writeFileSync(join(cfg, "config.json"), JSON.stringify({ last_org: org }));

    // --- 1 -------------------------------------------------------------------
    const one = runCli(configDir, ["sync-starter", "--org", org, "--assignment", ID, "--issue"]);
    if (one.status !== 0) die(`1 the CLI exited ${one.status}:\n${one.out}`);
    if (/pr-opened\b.*2 in a PR \(their branch only takes pull requests\)/.test(one.out)) r.ok("1 the CLI said the update went by pull request because main only takes them");
    else r.bad(`1 the CLI did not say so:\n${one.out}`);
    if ((await fileAt(STU, "lab2.md")) === null && (await fileAt(STU, "lab1.md")) === T1["lab1.md"]) r.ok("1 nothing landed on main - the rule held");
    else r.bad("1 something landed on main past the rule");
    const pulls = await openSyncPulls(t2);
    if (pulls.length === 1) r.ok(`1 ONE pull request (#${pulls[0].number})`);
    else r.bad(`1 ${pulls.length} sync pull requests: ${pulls.map((p) => `#${p.number}`).join(", ")}`);
    const files = pulls[0] ? ((await api(`/repos/${org}/${STU}/pulls/${pulls[0].number}/files`, { token })).data || []).map((f) => f.filename).sort() : [];
    if (files.join(",") === "lab1.md,lab2.md") r.ok("1 the pull request carries BOTH files - the untouched one too");
    else r.bad(`1 the pull request carries [${files}]`);
    const rec1 = myRow(await newestRecord());
    if (rec1?.outcome === "pr-opened" && /Repository rule violations found/.test(rec1.main_refused || "") && rec1.pr_number === pulls[0]?.number && !rec1.commit_sha) {
      r.ok(`1 record: pr-opened, main_refused "${rec1.main_refused}", pull request #${rec1.pr_number}, no commit`);
    } else {
      r.bad(`1 record row: ${JSON.stringify(rec1 && { o: rec1.outcome, m: rec1.main_refused, pr: rec1.pr_number, c: rec1.commit_sha })}`);
    }
    const issues = await openIssues();
    if (issues.length === 1 && /^\[Action Required\]/.test(issues[0].title) && issues[0].title.endsWith(`#${pulls[0]?.number}`)) r.ok(`1 ONE issue, "${issues[0].title}"`);
    else r.bad(`1 ${issues.length} issues: ${issues.map((i) => i.title).join(" | ")}`);

    // --- 2 -------------------------------------------------------------------
    const two = runCli(configDir, ["sync-starter", "--org", org, "--assignment", ID, "--issue"]);
    if (two.status !== 0) die(`2 the CLI exited ${two.status}:\n${two.out}`);
    // The record says the pull request reached them (`pr-opened` is a reached
    // outcome), so a second run of the same sync plans nothing for them -
    // the pull request stays the delivery, and no second one is opened.
    const pulls2 = await openSyncPulls(t2);
    if (pulls2.length === 1 && pulls2[0].number === pulls[0]?.number && /skipped-up-to-date|\(already open\)/.test(two.out)) r.ok("2 run again: the same one pull request, nothing new");
    else r.bad(`2 run again: ${pulls2.length} pull requests\n${two.out}`);
    if ((await openIssues()).length === 1) r.ok("2 run again: still one issue");
    else r.bad("2 run again: a second issue");

    // --- 3 -------------------------------------------------------------------
    const rs2 = await forbidBranches();
    r.ok(`ruleset ${rs2.id} on ${STU}: no branch may be created outside fix/*`);
    const t3 = await commitFiles(TPL, T3, [t2], "correct lab 1 again");
    await resetMain(TPL, t3);
    const three = runCli(configDir, ["sync-starter", "--org", org, "--assignment", ID, "--issue"]);
    if (three.status !== 0) die(`3 the CLI exited ${three.status}:\n${three.out}`);
    if (/failed: their repository's rules do not allow PXL Classroom to create a branch \(starter-update-[0-9a-z]+\)\. They can allow that name or add PXL Classroom as a bypass, then Sync again\./.test(three.out)) {
      r.ok("3 a failed row that says what the team can do");
    } else r.bad(`3 the failure was not said in words:\n${three.out}`);
    if ((await openSyncPulls(t3)).length === 0) r.ok("3 no pull request without its branch");
    else r.bad("3 a pull request was opened although its branch was refused");
    if ((await fileAt(STU, "lab1.md")) === T1["lab1.md"]) r.ok("3 main untouched");
    else r.bad("3 main changed");
    const rec3 = myRow(await newestRecord());
    if (rec3?.outcome === "failed" && /do not allow PXL Classroom to create a branch/.test(rec3.error || "")) r.ok("3 record: failed, with that sentence");
    else r.bad(`3 record row: ${JSON.stringify(rec3 && { o: rec3.outcome, e: rec3.error })}`);
  } finally {
    rmSync(configDir, { recursive: true, force: true });
    await dropOurRulesets();
  }

  console.log(`\n${r.failures() ? `${r.failures()} FAILED` : "all good"}\n`);
  process.exit(r.failures() ? 1 : 0);
}

main().catch((e) => die(e.stack || String(e)));
