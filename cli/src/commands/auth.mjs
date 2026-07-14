// PXL Classroom CLI — `auth` subcommand group.
//
// login   — device flow against the Provisioner App
// status  — show current token + login
// logout  — wipe the cached token

import { Command } from "commander";
import { spawn } from "node:child_process";
import { platform } from "node:os";
import { login, status } from "../lib/auth.mjs";
import { clearToken, resolveClientId, tokenPath, configPath } from "../lib/config.mjs";

// Best-effort: pop the verification page in the default browser, like
// `gh auth login` does. The printed URL remains the fallback (headless
// shells, SSH sessions).
function openInBrowser(url) {
  const [cmd, args] =
    platform() === "win32" ? ["cmd", ["/c", "start", "", url]]
    : platform() === "darwin" ? ["open", [url]]
    : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch { /* headless — the printed URL is enough */ }
}

export function registerAuthCommand(program) {
  const auth = new Command("auth").description("Authentication against the PXL Classroom GitHub App.");

  auth
    .command("login")
    .description("Authenticate via GitHub device flow and cache the token.")
    .option("--client-id <id>", "GitHub App client ID (overrides env / config)")
    .action(async (opts) => {
      const clientId = resolveClientId({ flag: opts.clientId });
      const record = await login({
        clientId,
        onPrompt: (v) => {
          process.stdout.write(
            `\nOpen ${v.verification_uri}\nEnter code: ${v.user_code}\nExpires in: ${v.expires_in}s\n\n` +
            `Security notice: the page must ask you to authorize "PXL Classroom Provisioner".\n` +
            `If any other App name appears, do NOT enter the code.\n\n`,
          );
          openInBrowser(v.verification_uri);
        },
      });
      process.stdout.write(`Signed in as ${record.user_login}.\nToken cached at: ${tokenPath()}\n`);
    });

  auth
    .command("status")
    .description("Show the current cached login + token age.")
    .action(async () => {
      const s = await status();
      if (!s.authenticated) {
        const detail = s.stale ? ` (cached token stale: ${s.error})` : "";
        process.stdout.write(`Not authenticated${detail}.\nRun: pxl-classroom auth login\n`);
        process.exitCode = 1;
        return;
      }
      const ageMs = Date.now() - Date.parse(s.obtained_at);
      const ageHours = (ageMs / 1000 / 3600).toFixed(1);
      process.stdout.write(
        `Logged in as: ${s.login}\n` +
          `Client ID:    ${s.client_id}\n` +
          `Token age:    ${ageHours}h (obtained ${s.obtained_at})\n` +
          `Token file:   ${tokenPath()}\n` +
          `Config file:  ${configPath()}\n`,
      );
    });

  auth
    .command("logout")
    .description("Wipe the cached token (config is preserved).")
    .action(() => {
      clearToken();
      process.stdout.write(`Token cleared.\n`);
    });

  program.addCommand(auth);
}
