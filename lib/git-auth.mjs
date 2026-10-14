// Git over HTTPS to GitHub, authenticated with an App installation token,
// without the credential ever reaching an argument, a remote URL, a log line or
// a `.git/config` (CLAUDE.md: credentials never appear in a git command line).
//
// `http.<origin>/.extraheader` set through GIT_CONFIG_* in the process
// environment: git reads it for this one process and writes it nowhere. A
// failed command's error quotes the command, which now holds a plain URL.
//
// Lived in preserve/preserve.mjs until provisioning began to push as well (a
// template copied with its full history, 2026-10-14). One spelling for both.

/**
 * The environment additions that authenticate git to `serverUrl`'s origin.
 *
 * AND NOTHING ELSE MAY ASK (2026-10-14). The header is the credential, so no
 * credential helper is consulted (`credential.helper` emptied) and nothing
 * prompts: a terminal prompt is off (GIT_TERMINAL_PROMPT) and so is Git
 * Credential Manager's window (GCM_INTERACTIVE). A test whose URL reached
 * github.com by mistake popped the credential window at the person running
 * the suite, over and over, while it hung.
 */
export function gitAuthEnv(token, serverUrl = "https://github.com") {
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: `http.${new URL(serverUrl).origin}/.extraheader`,
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
    GIT_CONFIG_KEY_1: "credential.helper",
    GIT_CONFIG_VALUE_1: "",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
  };
}

/**
 * The clone URL of `owner/repo` under `serverUrl`. Built from the whole URL
 * rather than its origin, so a test can point it at a directory of bare
 * repositories (`file:///tmp/x` gives `file:///tmp/x/owner/repo.git`).
 */
export function gitRepoUrl(serverUrl, owner, repo) {
  return `${String(serverUrl).replace(/\/+$/, "")}/${owner}/${repo}.git`;
}
