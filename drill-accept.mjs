#!/usr/bin/env node
// TEMPORARY - drill helper. Delete when the drill is over.
//   GH_OWNER_TOKEN=… node drill-accept.mjs <ORG> <ASSIGNMENT> <STUDENT_A|STUDENT_B|STUDENT_C> [teamSlug]
import { readFileSync } from "node:fs";
import { signAcceptanceTitle } from "./lib/acceptance-signature.mjs";
import { linkSecretFrom } from "./lib/invite-token-format.mjs";
import { normalizeLogin } from "./lib/github-login.mjs";
import { parse as parseYaml } from "yaml";

const [ORG, ASSIGNMENT, WHO, TEAM] = process.argv.slice(2);
const env = {};
for (const line of readFileSync(new URL("./.env.test", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
const ACCOUNTS = {
  STUDENT_A: { token: env.TEST_STUDENT1_TOKEN },
  STUDENT_B: { token: env.TEST_LECTURER2_TOKEN },
  STUDENT_C: { token: env.TEST_LECTURER_TOKEN },
};
const student = ACCOUNTS[WHO];
const OWNER_TOKEN = process.env.GH_OWNER_TOKEN;
if (!ORG || !ASSIGNMENT || !student || !OWNER_TOKEN) {
  console.error("usage: GH_OWNER_TOKEN=… drill-accept.mjs <org> <assignment> <STUDENT_A|B|C> [teamSlug]");
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

const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(4))).toString("hex");
const signed = await signAcceptanceTitle({ privateKey: secret, kid: "a1", subject: ASSIGNMENT, githubId: me.data.id, nonce });
// The team hint is appended AFTER signing - a concurrency key, never an
// authoritative value; the hub re-derives the team from the body, and
// read-team-payload refuses a body naming a different one.
const title = TEAM ? `${signed} team:${TEAM}` : signed;

const issue = await api(`/repos/${ORG}/broker-${ASSIGNMENT}/issues`, {
  token: student.token,
  method: "POST",
  body: {
    title,
    body: TEAM ? JSON.stringify({ team_slug: TEAM, team_name: TEAM, team_action: "join" }) : "",
  },
});
if (!issue.ok) { console.error(`broker issue: HTTP ${issue.status} ${issue.data?.message ?? ""}`); process.exit(1); }

const repoName = TEAM ? `${ASSIGNMENT}-${TEAM}` : `${ASSIGNMENT}-${normalizeLogin(me.data.login)}`;
let repo = null;
for (let i = 1; i <= 20; i++) {
  await new Promise((r) => setTimeout(r, 6000));
  const got = await api(`/repos/${ORG}/${repoName}`, { token: OWNER_TOKEN });
  if (got.ok) { repo = got.data; break; }
}
if (!repo) {
  const back = await api(`/repos/${ORG}/broker-${ASSIGNMENT}/issues/${issue.data.number}`, { token: OWNER_TOKEN });
  console.error(`no repository after 120s for ${me.data.login}. labels: ${(back.data?.labels ?? []).map((l) => l.name).join(", ") || "(none)"}`);
  process.exit(1);
}
console.log(`${me.data.login}: ${repoName} (id ${repo.id})`);

const invites = await api(`/repos/${ORG}/${repoName}/invitations`, { token: OWNER_TOKEN });
const mine = (invites.data || []).find((v) => normalizeLogin(v.invitee?.login ?? "") === normalizeLogin(me.data.login));
if (!mine) { console.log("  (already a collaborator)"); process.exit(0); }
const accepted = await api(`/user/repository_invitations/${mine.id}`, { token: student.token, method: "PATCH" });
console.log(accepted.status === 204 ? "  invitation accepted" : `  invitation NOT accepted: HTTP ${accepted.status}`);
