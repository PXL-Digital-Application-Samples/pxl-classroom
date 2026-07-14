// PXL Classroom CLI — device flow auth against the Provisioner App.
//
// Uses @octokit/auth-oauth-device. On first login the user is shown a code
// and a verification URL; we poll GitHub until they authorize. The resulting
// access token is cached locally (see config.mjs).

import { createOAuthDeviceAuth } from "@octokit/auth-oauth-device";
import { request as octokitRequest } from "@octokit/request";
import { saveToken, saveConfig, loadToken } from "./config.mjs";

export async function login({ clientId, onPrompt }) {
  const auth = createOAuthDeviceAuth({
    clientType: "github-app",
    clientId,
    onVerification: (verification) => {
      if (onPrompt) onPrompt(verification);
    },
  });

  const { token, scopes } = await auth({ type: "oauth" });

  // Resolve the authenticated user so subsequent `auth status` calls are useful
  // and so we can fail fast if the token is wrong.
  const userRes = await octokitRequest("GET /user", {
    headers: { authorization: `token ${token}` },
  });

  const record = {
    access_token: token,
    scopes: scopes ?? [],
    user_login: userRes.data.login,
    user_id: userRes.data.id,
    client_id: clientId,
    obtained_at: new Date().toISOString(),
  };
  saveToken(record);
  saveConfig({ client_id: clientId, last_login: record.obtained_at });
  return record;
}

export async function status() {
  const tok = loadToken();
  if (!tok) return { authenticated: false };
  try {
    const userRes = await octokitRequest("GET /user", {
      headers: { authorization: `token ${tok.access_token}` },
    });
    return {
      authenticated: true,
      login: userRes.data.login,
      scopes: tok.scopes,
      obtained_at: tok.obtained_at,
      client_id: tok.client_id,
    };
  } catch (err) {
    return { authenticated: false, error: err.message, stale: true };
  }
}

// Device-flow user tokens live ~8 hours. Check the cached token's age up
// front so an expired session fails with a clear next step instead of a raw
// "Bad credentials" from GitHub halfway through a command.
const TOKEN_TTL_MS = 8 * 60 * 60 * 1000;

export function requireToken() {
  const tok = loadToken();
  if (!tok) {
    throw new Error("not authenticated. Run `pxl-classroom auth login` first.");
  }
  const obtained = Date.parse(tok.obtained_at);
  if (Number.isFinite(obtained) && Date.now() - obtained > TOKEN_TTL_MS) {
    throw new Error(
      "session expired — device-flow tokens live ~8h. Run `pxl-classroom auth login` again.",
    );
  }
  return tok;
}
