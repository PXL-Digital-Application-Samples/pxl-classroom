#!/usr/bin/env node
// PXL Classroom - LIVE: what a student can do on their repository at each
// `student_permission`, measured with the student's OWN token. Not part of
// `npm test`.
//
//   node tests/live/permission-probe.mjs [maintain admin push]
//
// The Admin Panel's Student permission field says what each level cannot do,
// and that text is a claim about GitHub. This is where it comes from. For
// every level: the lecturer sets the student's permission on a throwaway
// repository, the student accepts the invitation if there is one, and then the
// student tries each action. A 403/404 is "cannot"; anything else (a success,
// or a validation error about the VALUE, which GitHub only reaches once the
// permission check has passed) is "can". Nothing destructive is attempted:
// deleting the repository and changing its visibility are admin-only per
// GitHub's documentation and are not tried.

import { api, die, loadEnv, reporter, accounts } from "./live-kit.mjs";
import { applyStudentPermission } from "../../lib/permission-change.mjs";

const env = loadEnv();
const org = process.env.PROBE_ORG || "pxl-classroom-testbed";
const { LECTURER, STUDENT_A, STUDENT_B } = accounts(env);
if (!LECTURER.token || !STUDENT_A.token) die("TEST_LECTURER_TOKEN and TEST_STUDENT1_TOKEN are required (.env.test)");
const REPO = "pxl-permission-probe";
const FULL = `${org}/${REPO}`;
const LEVELS = process.argv.slice(2).length ? process.argv.slice(2) : ["push", "maintain", "admin"];
const r = reporter();

const as = (who) => (path, opts = {}) => api(path, { token: who.token, ...opts });
const lect = as(LECTURER);
const stu = as(STUDENT_A);

// Each check: what it tries, and how to undo it if it worked.
const CHECKS = [
  ["push a commit", async () => {
    const ref = await stu(`/repos/${FULL}/git/ref/heads/main`);
    if (!ref.ok) return ref;
    const base = await stu(`/repos/${FULL}/git/commits/${ref.data.object.sha}`);
    const tree = await stu(`/repos/${FULL}/git/trees`, { method: "POST", body: { base_tree: base.data.tree.sha, tree: [{ path: "probe.txt", mode: "100644", type: "blob", content: String(Date.now()) }] } });
    if (!tree.ok) return tree;
    const c = await stu(`/repos/${FULL}/git/commits`, { method: "POST", body: { message: "probe", tree: tree.data.sha, parents: [ref.data.object.sha] } });
    if (!c.ok) return c;
    return stu(`/repos/${FULL}/git/refs/heads/main`, { method: "PATCH", body: { sha: c.data.sha } });
  }],
  ["create an Actions secret", () => stu(`/repos/${FULL}/actions/secrets/PROBE_SECRET`, { method: "PUT", body: { encrypted_value: "bm90LXJlYWxseS1lbmNyeXB0ZWQ=", key_id: "0" } }),
    () => lect(`/repos/${FULL}/actions/secrets/PROBE_SECRET`, { method: "DELETE" })],
  ["create an Actions variable", () => stu(`/repos/${FULL}/actions/variables`, { method: "POST", body: { name: "PROBE_VAR", value: "x" } }),
    () => lect(`/repos/${FULL}/actions/variables/PROBE_VAR`, { method: "DELETE" })],
  ["register a self-hosted runner", () => stu(`/repos/${FULL}/actions/runners/registration-token`, { method: "POST" })],
  ["create an environment", () => stu(`/repos/${FULL}/environments/probe-env`, { method: "PUT", body: {} }),
    () => lect(`/repos/${FULL}/environments/probe-env`, { method: "DELETE" })],
  ["change Actions permissions", () => stu(`/repos/${FULL}/actions/permissions/workflow`, { method: "PUT", body: { default_workflow_permissions: "read" } })],
  ["change a repository setting", () => stu(`/repos/${FULL}`, { method: "PATCH", body: { has_wiki: false } })],
  ["add another person to the repository", () => STUDENT_B.login
    ? stu(`/repos/${FULL}/collaborators/${STUDENT_B.login}`, { method: "PUT", body: { permission: "pull" } })
    : Promise.resolve({ status: 0 }),
    async () => {
      await lect(`/repos/${FULL}/collaborators/${STUDENT_B.login}`, { method: "DELETE" });
      const inv = await lect(`/repos/${FULL}/invitations`);
      for (const i of inv.data || []) if (i.invitee?.login === STUDENT_B.login) await lect(`/repos/${FULL}/invitations/${i.id}`, { method: "DELETE" });
    }],
  ["create a ruleset", () => stu(`/repos/${FULL}/rulesets`, { method: "POST", body: { name: "probe", target: "branch", enforcement: "disabled", conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } }, rules: [{ type: "deletion" }] } }),
    async (res) => { if (res?.data?.id) await lect(`/repos/${FULL}/rulesets/${res.data.id}`, { method: "DELETE" }); }],
  ["add a webhook", () => stu(`/repos/${FULL}/hooks`, { method: "POST", body: { config: { url: "https://example.invalid/hook", content_type: "json" }, events: ["push"], active: false } }),
    async (res) => { if (res?.data?.id) await lect(`/repos/${FULL}/hooks/${res.data.id}`, { method: "DELETE" }); }],
];

const can = (res) => res && res.status !== 0 && res.status !== 403 && res.status !== 404;

async function grant(level) {
  const put = await lect(`/repos/${FULL}/collaborators/${STUDENT_A.login}`, { method: "PUT", body: { permission: level } });
  if (put.status === 201) {
    const inv = await stu("/user/repository_invitations");
    const mine = (inv.data || []).find((i) => i.repository?.full_name?.toLowerCase() === FULL.toLowerCase());
    if (!mine) die(`invitation for ${level} not found`);
    const ok = await stu(`/user/repository_invitations/${mine.id}`, { method: "PATCH" });
    if (ok.status !== 204) die(`accepting the invitation: HTTP ${ok.status}`);
  } else if (put.status !== 204) {
    die(`granting ${level}: HTTP ${put.status} ${put.data?.message ?? ""}`);
  }
  const perm = await lect(`/repos/${FULL}/collaborators/${STUDENT_A.login}/permission`);
  return perm.data?.role_name || perm.data?.permission;
}

async function main() {
  const got = await lect(`/repos/${FULL}`);
  if (got.status === 404) {
    const made = await lect(`/orgs/${org}/repos`, { method: "POST", body: { name: REPO, private: true, auto_init: true, description: "tests/live/permission-probe.mjs" } });
    if (!made.ok) die(`create ${FULL}: HTTP ${made.status}`);
    r.note(`created ${FULL}`);
  }
  const table = {};
  for (const level of LEVELS) {
    const role = await grant(level);
    r.ok(`${STUDENT_A.login} is ${role} on ${FULL}`);
    table[level] = {};
    for (const [what, run, undo] of CHECKS) {
      const res = await run();
      table[level][what] = `${can(res) ? "yes" : "no "} (${res?.status})`;
      if (can(res) && undo) await undo(res);
    }
  }
  const w = Math.max(...CHECKS.map(([w]) => w.length));
  console.log(`\n${"".padEnd(w)}  ${LEVELS.map((l) => l.padEnd(12)).join("")}`);
  for (const [what] of CHECKS) console.log(`${what.padEnd(w)}  ${LEVELS.map((l) => table[l][what].padEnd(12)).join("")}`);
  console.log("");

  // --- applying a change: lib/permission-change.mjs against real GitHub ------
  const request = (method, path, body) => api(path, { token: LECTURER.token, method, body });
  await lect(`/repos/${FULL}/collaborators/${STUDENT_A.login}`, { method: "DELETE" });
  const invites = async () => ((await lect(`/repos/${FULL}/invitations`)).data || []).filter((i) => i.invitee?.login === STUDENT_A.login);
  for (const i of await invites()) await lect(`/repos/${FULL}/invitations/${i.id}`, { method: "DELETE" });
  // A student who has not accepted their invitation yet, invited at admin.
  await lect(`/repos/${FULL}/collaborators/${STUDENT_A.login}`, { method: "PUT", body: { permission: "admin" } });
  const pending = await applyStudentPermission(request, { repo: FULL, login: STUDENT_A.login, permission: "maintain" });
  const [inv] = await invites();
  if (pending.ok && pending.via === "invitation" && inv?.permissions === "maintain") r.ok("pending invitation: admin -> maintain, through the invitation");
  else r.bad(`pending invitation: ${JSON.stringify(pending)}, invitation says ${inv?.permissions}`);
  const pushInv = await applyStudentPermission(request, { repo: FULL, login: STUDENT_A.login, permission: "push" });
  const [inv2] = await invites();
  if (pushInv.ok && inv2?.permissions === "write") r.ok("pending invitation: push is written as write");
  else r.bad(`pending invitation push: ${JSON.stringify(pushInv)}, invitation says ${inv2?.permissions}`);
  // Accepted: it arrives at what the invitation now says.
  await stu(`/user/repository_invitations/${inv2.id}`, { method: "PATCH" });
  const role = async () => (await lect(`/repos/${FULL}/collaborators/${STUDENT_A.login}/permission`)).data?.role_name;
  if ((await role()) === "write") r.ok("accepted: the student is at write, what the updated invitation said");
  else r.bad(`accepted at ${await role()}, wanted write`);
  // A collaborator: one call.
  const collab = await applyStudentPermission(request, { repo: FULL, login: STUDENT_A.login, permission: "admin" });
  if (collab.ok && collab.via === "collaborator" && (await role()) === "admin") r.ok("collaborator: write -> admin in one call");
  else r.bad(`collaborator: ${JSON.stringify(collab)}, now ${await role()}`);
  const down = await applyStudentPermission(request, { repo: FULL, login: STUDENT_A.login, permission: "maintain" });
  if (down.ok && (await role()) === "maintain") r.ok("collaborator: admin -> maintain, and back down works");
  else r.bad(`collaborator down: ${JSON.stringify(down)}, now ${await role()}`);

  // Leave the student off the probe repository.
  await lect(`/repos/${FULL}/collaborators/${STUDENT_A.login}`, { method: "DELETE" });
  console.log("");
  process.exit(r.failures() ? 1 : 0);
}

main().catch((e) => die(e.stack || String(e)));
