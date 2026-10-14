// The live UI suite's two bridges to the real system: who is signed in, and
// where the published student data comes from. Everything else the SPA reads
// is real GitHub, as the test accounts in .env.test (tests/live/live-kit.mjs).

import { accounts, api, decode, loadEnv } from "../live-kit.mjs";
import { CONTROL_REPO, HUB_OWNER, HUB_REPO_NAME } from "../../../lib/deployment.mjs";
import { linkSecretFrom, parseInviteFields } from "../../../lib/invite-token-format.mjs";
import { AUTH_KEY } from "../../../frontend/src/lib/auth-storage.js";

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

/** The student link of an assignment, from its stored invitation. */
export async function studentLink(assignmentId) {
  const secret = linkSecretFrom(parseInviteFields(await control(`assignments/${assignmentId}.yml`)));
  if (!secret) throw new Error(`${assignmentId} has no invitation`);
  return `/${ORG}/i/${secret}`;
}
