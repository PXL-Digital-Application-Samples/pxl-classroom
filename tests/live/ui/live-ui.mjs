// The live UI suite's two bridges to the real system: who is signed in, and
// where the published student data comes from. Everything else the SPA reads
// is real GitHub, as the test accounts in .env.test (tests/live/live-kit.mjs).

import { stringify } from "yaml";
import { accounts, api, decode, loadEnv, sleep } from "../live-kit.mjs";
import { CONTROL_REPO, HUB_OWNER, HUB_REPO_NAME, TIMEZONE } from "../../../lib/deployment.mjs";
import { linkSecretFrom, parseInviteFields } from "../../../lib/invite-token-format.mjs";
import { buildAssignmentDoc, utcToLocalInput } from "../../../lib/assignment-doc.mjs";
import { validateAgainst } from "../../../lib/validate.mjs";
import { AUTH_KEY } from "../../../frontend/src/lib/auth-storage.js";

// tests/live/drill.mjs's own marker and id prefix, so `drill.mjs cleanup <id>`
// deletes what this suite made the way the Admin Panel would.
export const DRILL_DESCRIPTION = "Automated deadline drill (tests/live/drill.mjs). Safe to delete.";

export const ACCOUNTS = accounts(loadEnv());
export const ORG = process.env.DRILL_ORG || "pxl-classroom-testbed";
// The site the hub deploys, where every student page's data is published.
export const SITE = `https://${HUB_OWNER.toLowerCase()}.github.io/${HUB_REPO_NAME}/`;

/**
 * Signed in as `account`, the way the SPA keeps a sign-in (auth-storage.js):
 * its token and who it is, as GitHub answers for that token - never a login
 * typed here, so a spec cannot think it is somebody the token is not.
 */
export async function signInAs(page, account) {
  const me = await api("/user", { token: account.token });
  if (!me.ok) throw new Error(`${account.login}: token rejected by GitHub, HTTP ${me.status}`);
  const stored = JSON.stringify({
    access_token: account.token,
    user: { login: me.data.login, id: me.data.id, name: me.data.name, email: me.data.email },
    // GitHub's own 8-hour expiry, which is what the SPA keeps it until.
    expires_at: new Date(Date.now() + 8 * 3600_000).toISOString(),
  });
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), { key: AUTH_KEY, value: stored });
  return me.data;
}

/**
 * The published files under /data/, fetched from the deployed site exactly as
 * it serves them: a dev server on localhost has none, and the student pages
 * read their card, their teams and the participating organizations there.
 */
export async function publishedData(page) {
  await page.route(
    (url) => url.hostname === "localhost" && /^\/data\/.+\.json$/.test(url.pathname),
    async (route) => {
      const url = new URL(route.request().url());
      const real = await route.fetch({ url: `${SITE}${url.pathname.slice(1)}${url.search}` });
      return route.fulfill({ response: real });
    },
  );
}

/** The control repository's copy of a file, as the lecturer reads it. */
export async function control(path) {
  const res = await api(`/repos/${ORG}/${CONTROL_REPO}/contents/${path}`, { token: ACCOUNTS.LECTURER.token });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return decode(res.data.content);
}

/**
 * A fresh assignment, saved through the Admin Panel's own builder and
 * published by the real workflow - the drill's `start`, without the students.
 * `extra` is more of the editor's form (a group's `assignment_type`,
 * `group_config`, `repository_name_pattern`).
 *
 * @returns {Promise<{ id: string, deadlineAt: string }>}
 */
export async function publishAssignment({ prefix, title, minutes = 120, pattern = "{github_login}", extra = {} }) {
  const token = ACCOUNTS.LECTURER.token;
  const now = Date.now();
  const stamp = new Date(now).toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 13).toLowerCase();
  const id = `drill-${prefix}-${stamp}`;
  const opensAt = new Date(now - 60_000).toISOString();
  const deadlineAt = new Date(Math.ceil((now + minutes * 60_000) / 60_000) * 60_000).toISOString();
  const tpl = await api(`/repos/${ORG}/starter-template`, { token });
  if (!tpl.ok) throw new Error(`template: HTTP ${tpl.status}`);
  const doc = buildAssignmentDoc({
    id, title, description: DRILL_DESCRIPTION, organization: ORG,
    template: `${ORG}/starter-template`, repository_name_pattern: `${id}-${pattern}`,
    opens_at_local: utcToLocalInput(opensAt), _opens_at_original: opensAt,
    deadline_at_local: utcToLocalInput(deadlineAt), _deadline_at_original: deadlineAt,
    timezone: TIMEZONE, submission_ref: `refs/heads/${tpl.data.default_branch}`,
    student_permission: "admin", acceptance_mode: "self-service", roster_mode: "enforced",
    late_policy: "block", lock_down_enabled: true, assignment_type: "individual", state: "published",
    ...extra,
  }, { templateRepositoryId: tpl.data.id });
  const { valid, errors } = validateAgainst("assignment", structuredClone(doc));
  if (!valid) throw new Error(`the schema refuses it: ${JSON.stringify(errors)}`);
  const put = await api(`/repos/${ORG}/${CONTROL_REPO}/contents/assignments/${id}.yml`, {
    token, method: "PUT", body: { message: `Create assignment ${id}`, content: Buffer.from(stringify(doc)).toString("base64") },
  });
  if (!put.ok) throw new Error(`assignments/${id}.yml: HTTP ${put.status}`);
  const since = new Date(Date.now() - 5_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const hub = `/repos/${HUB_OWNER}/${HUB_REPO_NAME}/actions/workflows/publish-assignment.yml`;
  const dispatched = await api(`${hub}/dispatches`, {
    token, method: "POST", body: { ref: "main", inputs: { org: ORG, assignment_id: id, regenerate_invite: "false" } },
  });
  if (!dispatched.ok) throw new Error(`publish dispatch: HTTP ${dispatched.status}`);
  for (let waited = 0; waited < 10 * 60_000; waited += 10_000) {
    await sleep(10_000);
    const runs = (await api(`${hub}/runs?created=${encodeURIComponent(`>=${since}`)}&per_page=20`, { token })).data?.workflow_runs || [];
    const run = runs.find((x) => x.actor?.login?.toLowerCase() === ACCOUNTS.LECTURER.login.toLowerCase());
    if (run?.status === "completed") {
      if (run.conclusion !== "success") throw new Error(`publish ${run.conclusion}: ${run.html_url}`);
      return { id, deadlineAt };
    }
  }
  throw new Error("publish did not finish in 10 minutes");
}

/** The student link of an assignment, from its stored invitation. */
export async function studentLink(assignmentId) {
  const secret = linkSecretFrom(parseInviteFields(await control(`assignments/${assignmentId}.yml`)));
  if (!secret) throw new Error(`${assignmentId} has no invitation`);
  return `/${ORG}/i/${secret}`;
}
