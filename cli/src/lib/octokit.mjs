// PXL Classroom CLI - authed Octokit factory.
//
// Builds an Octokit with the cached OAuth token and a sensible user-agent.
// Use this for read-only and Contents-API calls; for multi-file commits use
// the gittree wrapper which threads through to lib/gittree.mjs.

import { Octokit } from "@octokit/rest";
import { retry } from "@octokit/plugin-retry";

const RetryOctokit = Octokit.plugin(retry);
import { requireToken } from "./auth.mjs";
import { GITHUB_API_VERSION } from "../../../lib/github-api-version.mjs";

const USER_AGENT = "pxl-classroom-cli/0.1.0";

/** `fetch`: a stand-in transport, so a test can see what goes on the wire. */
export function makeOctokit({ token, fetch } = {}) {
  const t = token ?? requireToken().access_token;
  const octokit = new RetryOctokit({
    auth: t,
    userAgent: USER_AGENT,
    request: { retries: 3, ...(fetch ? { fetch } : {}) },
  });
  // THE SAME API VERSION AS EVERYTHING ELSE (lib/github-api-version.mjs). The
  // CLI sent none, so it got GitHub's default and warned on every issue it
  // created. Octokit has no default-headers option, so a hook sets it on
  // every request - including the retries the plugin makes.
  octokit.hook.before("request", (options) => {
    options.headers = { ...options.headers, "x-github-api-version": GITHUB_API_VERSION };
  });
  return octokit;
}
