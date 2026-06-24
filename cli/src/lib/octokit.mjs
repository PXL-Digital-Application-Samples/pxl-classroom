// PXL Classroom CLI — authed Octokit factory.
//
// Builds an Octokit with the cached OAuth token and a sensible user-agent.
// Use this for read-only and Contents-API calls; for multi-file commits use
// the gittree wrapper which threads through to lib/gittree.mjs.

import { Octokit } from "@octokit/rest";
import { retry } from "@octokit/plugin-retry";

const RetryOctokit = Octokit.plugin(retry);
import { requireToken } from "./auth.mjs";

const USER_AGENT = "pxl-classroom-cli/0.1.0";

export function makeOctokit({ token } = {}) {
  const t = token ?? requireToken().access_token;
  return new RetryOctokit({
    auth: t,
    userAgent: USER_AGENT,
    request: { retries: 3 },
  });
}
