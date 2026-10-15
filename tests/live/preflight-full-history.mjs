#!/usr/bin/env node
// PXL Classroom - LIVE: the publish preflight on a full-history template
// (review PG8, TV-10). One template on the drill org, made once: a branch
// called pxl-baseline beside main, and a workflow that runs on push.
//
//   node tests/live/preflight-full-history.mjs
//
// With feedback PRs on, publish is REFUSED: every branch is copied, so the
// template's pxl-baseline would be taken for each student's feedback baseline.
// Without them it publishes, and the run WARNS that the workflow runs once per
// branch in every student repository. Two drill assignments are left behind;
// the ids are printed for `drill.mjs cleanup`.

import { stringify } from "yaml";
import { accounts, api, die, loadEnv, reporter, sleep } from "./live-kit.mjs";
import { buildAssignmentDoc, utcToLocalInput } from "../../lib/assignment-doc.mjs";
import { validateAgainst } from "../../lib/validate.mjs";
import { CONTROL_REPO, HUB_OWNER, HUB_REPO_NAME, TIMEZONE } from "../../lib/deployment.mjs";

const ORG = process.env.DRILL_ORG || "pxl-classroom-testbed";
const TEMPLATE = "history-template-preflight";
const DRILL_DESCRIPTION = "Automated deadline drill (tests/live/drill.mjs). Safe to delete.";
const HUB = `/repos/${HUB_OWNER}/${HUB_REPO_NAME}`;
const { LECTURER } = accounts(loadEnv());
const T = LECTURER.token;
const r = reporter();

async function ensureTemplate() {
  const at = `/repos/${ORG}/${TEMPLATE}`;
  const have = await api(at, { token: T });
  if (have.ok) {
    const branches = ((await api(`${at}/branches`, { token: T })).data || []).map((b) => b.name);
    const wf = await api(`${at}/contents/.github/workflows/ci.yml`, { token: T });
    if (have.data.is_template && branches.includes("pxl-baseline") && wf.ok) return have.data;
    die(`${ORG}/${TEMPLATE} exists but is not this probe's (branches ${branches.join(", ")}) - delete it and run again`);
  }
  const must = async (res, what) => { if (!res.ok) die(`${what}: HTTP ${res.status} ${res.data?.message ?? ""}`); return res.data; };
  await must(await api(`/orgs/${ORG}/repos`, { token: T, method: "POST", body: { name: TEMPLATE, private: true, description: "Preflight probe template (tests/live/preflight-full-history.mjs). Safe to delete." } }), "create");
  const put = (path, text, message, extra = {}) => api(`${at}/contents/${path}`, { token: T, method: "PUT", body: { message, content: Buffer.from(text).toString("base64"), ...extra } });
  const first = await must(await put("README.md", "probe\n", "Start"), "README");
  await must(await put(".github/workflows/ci.yml", "name: ci\non: push\njobs:\n  ci:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ci\n", "Add a push workflow"), "workflow");
  await must(await api(`${at}/git/refs`, { token: T, method: "POST", body: { ref: "refs/heads/pxl-baseline", sha: first.commit.sha } }), "pxl-baseline");
  await must(await api(at, { token: T, method: "PATCH", body: { is_template: true } }), "template");
  return (await api(at, { token: T })).data;
}

/** Save it as the Admin Panel would, publish it as the editor does, and the run's log. */
async function publish(tpl, { feedbackPr, tag }) {
  const now = Date.now();
  const id = `drill-${tag}-${new Date(now).toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 13).toLowerCase()}`;
  const opensAt = new Date(now - 60_000).toISOString();
  const deadlineAt = new Date(Math.ceil((now + 120 * 60_000) / 60_000) * 60_000).toISOString();
  const doc = buildAssignmentDoc({
    id, title: `Preflight probe (${tag})`, description: DRILL_DESCRIPTION, organization: ORG,
    template: `${ORG}/${TEMPLATE}`, repository_name_pattern: `${id}-{github_login}`,
    opens_at_local: utcToLocalInput(opensAt), _opens_at_original: opensAt,
    deadline_at_local: utcToLocalInput(deadlineAt), _deadline_at_original: deadlineAt,
    timezone: TIMEZONE, submission_ref: `refs/heads/${tpl.default_branch}`, student_permission: "admin",
    acceptance_mode: "self-service", roster_mode: "enforced", late_policy: "block", lock_down_enabled: true,
    assignment_type: "individual", state: "published", template_full_history: true,
    ...(feedbackPr ? { feedback_pr: true, feedback_pr_baseline_branch: "pxl-baseline" } : {}),
  }, { templateRepositoryId: tpl.id });
  const { valid, errors } = validateAgainst("assignment", structuredClone(doc));
  if (!valid) die(`schema: ${JSON.stringify(errors)}`);
  const put = await api(`/repos/${ORG}/${CONTROL_REPO}/contents/assignments/${id}.yml`, {
    token: T, method: "PUT", body: { message: `Create assignment ${id}`, content: Buffer.from(stringify(doc)).toString("base64") },
  });
  if (!put.ok) die(`${id}: HTTP ${put.status}`);
  const since = new Date(Date.now() - 5_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const go = await api(`${HUB}/actions/workflows/publish-assignment.yml/dispatches`, {
    token: T, method: "POST", body: { ref: "main", inputs: { org: ORG, assignment_id: id, regenerate_invite: "false", prior_state: "draft" } },
  });
  if (!go.ok) die(`dispatch: HTTP ${go.status}`);
  for (let waited = 0; waited < 10 * 60_000; waited += 10_000) {
    await sleep(10_000);
    const runs = (await api(`${HUB}/actions/workflows/publish-assignment.yml/runs?created=${encodeURIComponent(`>=${since}`)}&per_page=20`, { token: T })).data?.workflow_runs || [];
    const run = runs.find((x) => x.actor?.login?.toLowerCase() === LECTURER.login.toLowerCase() && x.status === "completed");
    if (!run) continue;
    const jobs = (await api(`${HUB}/actions/runs/${run.id}/jobs`, { token: T })).data?.jobs || [];
    let log = "";
    for (const job of jobs) log += (await api(`${HUB}/actions/jobs/${job.id}/logs`, { token: T })).data?.raw ?? "";
    return { id, run, log };
  }
  die(`${id}: the publish did not finish in 10 minutes`);
}

const tpl = await ensureTemplate();
r.ok(`${ORG}/${TEMPLATE}: branches main and pxl-baseline, a push workflow`);

const refused = await publish(tpl, { feedbackPr: true, tag: "pf-refused" });
console.log(`  ${refused.id}: ${refused.run.html_url}`);
if (refused.run.conclusion === "failure") r.ok("with feedback PRs, the publish is refused");
else r.bad(`with feedback PRs, the publish ended ${refused.run.conclusion}`);
if (refused.log.includes("The template has a branch called pxl-baseline")) r.ok("and it says why: the template's own pxl-baseline");
else r.bad("the refusal does not name the template's pxl-baseline branch");

const warned = await publish(tpl, { feedbackPr: false, tag: "pf-warned" });
console.log(`  ${warned.id}: ${warned.run.html_url}`);
if (warned.run.conclusion === "success") r.ok("without feedback PRs, it publishes");
else r.bad(`without feedback PRs, the publish ended ${warned.run.conclusion}`);
if (warned.log.includes("The template has workflows")) r.ok("and warns that the template's workflow runs once per branch");
else r.bad("no warning about the template's workflows");

console.log(`\nDelete them: node tests/live/drill.mjs cleanup ${refused.id} ${warned.id}`);
console.log(`\n${r.failures() === 0 ? "All checks passed." : `${r.failures()} check(s) failed.`}\n`);
process.exit(r.failures() === 0 ? 0 : 1);
