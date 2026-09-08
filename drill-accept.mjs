#!/usr/bin/env node
// TEMPORARY - drill helper. Delete when the drill is over.
//
//   GH_OWNER_TOKEN=… node drill-accept.mjs <ORG> <ASSIGNMENT_ID> <STUDENT_A|STUDENT_B>
//
// The path tests/live/smoke.mjs takes, parameterised by account so a
// two-student INDIVIDUAL cohort can be built. Signing and login normalisation
// come from lib/, never re-implemented here.
import { readFileSync } from "node:fs";
import { signAcceptanceTitle } from "./lib/acceptance-signature.mjs";
import { linkSecretFrom } from "./lib/invite-token-format.mjs";
import { normalizeLogin } from "./lib/github-login.mjs";
import { parse as parseYaml } from "yaml";

const [ORG, ASSIGNMENT, WHO] = process.argv.slice(2);
const env = {};
for (const line of readFileSync(new URL("./.env.test", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
const ACCOUNTS = {
  STUDENT_A: { token: env.TEST_STUDENT1_TOKEN },
  STUDENT_B: { token: env.TEST_LECTURER2_TOKEN },
};
const student = ACCOUNTS[WHO];
const OWNER_TOKEN = process.env.GH_OWNER_TOKEN;
if (!ORG || !ASSIGNMENT || !student || !OWNER_TOKEN) {
  console.error("usage: GH_OWNER_TOKEN=… drill-accept.mjs <org> <assignment> <STUDENT_A|STUDENT_B>");
  process.exit(1);
}

async function api(path, { token, method = "GET", body } = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "pxl-drill",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = { raw: text }; } }
  return { ok: res.ok, status: res.status, data };
}

const me = await api("/user", { token: student.token });
if (!me.ok) { console.error(`cannot authenticate ${WHO}: HTTP ${me.status}`); process.exit(1); }

const yml = await api(`/repos/${ORG}/pxl-classroom-control/contents/assignments/${ASSIGNMENT}.yml`, { token: OWNER_TOKEN });
const doc = parseYaml(Buffer.from(yml.data.content, "base64").toString("utf8"));
const secret = linkSecretFrom(doc);
if (!secret) { console.error("no invitation secret"); process.exit(1); }

const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(4))).toString("hex");
const title = await signAcceptanceTitle({ privateKey: secret, kid: "a1", subject: ASSIGNMENT, githubId: me.data.id, nonce });

const issue = await api(`/repos/${ORG}/broker-${ASSIGNMENT}/issues`, {
  token: student.token, method: "POST", body: { title, body: "" },
});
if (!issue.ok) { console.error(`broker issue: HTTP ${issue.status} ${issue.data?.message ?? ""}`); process.exit(1); }

const repoName = `${ASSIGNMENT}-${normalizeLogin(me.data.login)}`;
let repo = null;
for (let i = 1; i <= 20; i++) {
  await new Promise((r) => setTimeout(r, 6000));
  const got = await api(`/repos/${ORG}/${repoName}`, { token: OWNER_TOKEN });
  if (got.ok) { repo = got.data; break; }
}
if (!repo) { console.error(`no repository after 120s for ${me.data.login}`); process.exit(1); }
console.log(`${me.data.login}: ${repoName} (id ${repo.id})`);

// The REPO side, not `/user/repository_invitations` - that endpoint answers
// `200 []` over a genuinely pending invitation.
const invites = await api(`/repos/${ORG}/${repoName}/invitations`, { token: OWNER_TOKEN });
const mine = (invites.data || []).find((v) => normalizeLogin(v.invitee?.login ?? "") === normalizeLogin(me.data.login));
if (!mine) { console.log("  (already a collaborator)"); process.exit(0); }
const accepted = await api(`/user/repository_invitations/${mine.id}`, { token: student.token, method: "PATCH" });
console.log(accepted.status === 204 ? "  invitation accepted" : `  invitation NOT accepted: HTTP ${accepted.status}`);
