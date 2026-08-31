#!/usr/bin/env node
// PXL Classroom - create the broker dispatch App.
//
// WHAT THIS EXISTS FOR. A broker repository is PUBLIC, there is one per
// assignment, and it needs a credential because its whole job is one POST to
// the hub's /dispatches endpoint. Until 2026-08-31 it was handed
// PXL_APP_PRIVATE_KEY - the provisioning App's own key, which mints tokens
// carrying administration/organization_administration/members/secrets/workflows/
// contents write on every org the App is installed on. Counted live, that key
// was sitting on 11 public repositories across 8 organizations.
//
// The broker App is the replacement: installed on the HUB REPOSITORY ALONE,
// holding `contents: write` ALONE - exactly what POST /repos/{o}/{r}/dispatches
// requires and nothing more. See ARCHITECTURE §4.3.0 and RUNBOOK §1.10.
//
// WHY THERE IS A BROWSER STEP AT ALL, since the obvious question is why this is
// not pure CLI. Two GitHub limits, both checked rather than assumed:
//
//   - Creating an App has no REST endpoint. The only programmatic route is the
//     App Manifest flow: POST a manifest to a GitHub page, the human confirms,
//     GitHub redirects back with a code valid for ONE HOUR, and that code is
//     exchanged for the App. This script does everything except the confirm.
//   - Installing an App has no REST endpoint either. "An organization owner or
//     application manager must make this change within the UI." Adding further
//     repositories to an EXISTING installation is an API; the first install is
//     not. So the last step prints a URL and stops.
//
// The manifest is what makes this worth scripting: it sets the permission set
// exactly, so nobody ticks `contents: write` by hand and nobody accidentally
// ticks anything else.
//
// THE PRIVATE KEY NEVER TOUCHES DISK and is never printed. It goes from the
// conversion response straight into `gh secret set` over a pipe.
//
// Usage:
//   node scripts/create-broker-app.mjs            # create, then store secrets
//   node scripts/create-broker-app.mjs --dry-run  # print the manifest, do nothing
//   node scripts/create-broker-app.mjs --verify   # check an existing App instead

import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

import { HUB_OWNER, HUB_REPO_NAME } from "#deployment";

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = args[i + 1];
  return next && !next.startsWith("--") ? next : true;
};

const ORG = flag("org", HUB_OWNER);
const REPO = flag("repo", HUB_REPO_NAME);
const NAME = flag("name", "PXL Classroom Broker");
const PORT = Number(flag("port", 8721));
const ENVIRONMENT = "provisioning";
const DRY_RUN = args.includes("--dry-run");
const VERIFY_ONLY = args.includes("--verify");

const die = (msg) => {
  console.error(`\n[FAIL] ${msg}\n`);
  process.exit(1);
};

// THE ONE PERMISSION. Stated here and nowhere else, so the manifest, the
// verification below and RUNBOOK §1.10 cannot disagree about what this App is
// allowed to do. `contents: write` is what a repository_dispatch needs; in
// particular NOT `actions: write`, or a leaked broker key could dispatch hub
// workflows - which is most of what made the old arrangement dangerous.
const REQUIRED_PERMISSIONS = Object.freeze({ contents: "write" });

function manifest(redirectUrl) {
  return {
    name: NAME,
    url: `https://github.com/${ORG}/${REPO}`,
    description:
      "Dispatches acceptance events from public per-assignment broker repositories to the PXL Classroom hub. " +
      "Holds Contents: write on the hub repository and nothing else.",
    redirect_url: redirectUrl,
    // Installable only on the account that owns it. A broker App has no reason
    // to be installable anywhere else, and every org it is NOT on is an org a
    // leaked key cannot reach.
    public: false,
    default_permissions: { ...REQUIRED_PERMISSIONS },
    // It never receives webhooks - it only ever makes one API call.
    default_events: [],
  };
}

/** `gh`, present and authenticated, BEFORE an App exists that we cannot store. */
function requireGh() {
  const which = spawnSync("gh", ["--version"], { encoding: "utf8", shell: process.platform === "win32" });
  if (which.status !== 0) die("`gh` is not on PATH. Install the GitHub CLI, then re-run.");
  const auth = spawnSync("gh", ["auth", "status"], { encoding: "utf8", shell: process.platform === "win32" });
  if (auth.status !== 0) die("`gh` is not authenticated. Run `gh auth login`, then re-run.");
}

/** Write one secret without the value ever reaching disk, argv or a log. */
function setSecret(name, value) {
  return new Promise((resolve) => {
    const child = spawn(
      "gh",
      ["secret", "set", name, "--env", ENVIRONMENT, "--repo", `${ORG}/${REPO}`],
      { stdio: ["pipe", "inherit", "inherit"], shell: process.platform === "win32" },
    );
    child.on("close", (code) => resolve(code === 0));
    // --body would put the value in argv, which `ps` shows to every local user.
    child.stdin.end(value);
  });
}

async function convert(code) {
  const res = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
    method: "POST",
    headers: { accept: "application/vnd.github+json", "user-agent": "pxl-classroom-broker-app-setup" },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    die(
      `Exchanging the manifest code failed (HTTP ${res.status}). ${body.slice(0, 200)}\n` +
        "       The code is valid for one hour and ONCE. If it was already used, delete the\n" +
        "       half-created App in the org's Developer settings and run this again.",
    );
  }
  return res.json();
}

/** What the App actually declares, read back from GitHub rather than assumed. */
async function verify(slug) {
  const res = await fetch(`https://api.github.com/apps/${slug}`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "pxl-classroom-broker-app-setup" },
  });
  if (!res.ok) {
    console.log(`   Could not read /apps/${slug} (HTTP ${res.status}) - check it by hand.`);
    return;
  }
  const declared = (await res.json()).permissions || {};
  const problems = [];
  for (const [perm, level] of Object.entries(REQUIRED_PERMISSIONS)) {
    if (declared[perm] !== level) problems.push(`missing or wrong: ${perm}=${declared[perm] ?? "absent"} (want ${level})`);
  }
  // Excess matters more than absence here - this App's whole point is being small.
  for (const perm of Object.keys(declared)) {
    if (!(perm in REQUIRED_PERMISSIONS)) problems.push(`EXCESS: ${perm}=${declared[perm]}`);
  }
  if (problems.length) {
    console.log(`\n   [warn] ${slug} does not declare exactly Contents: write:`);
    for (const p of problems) console.log(`          - ${p}`);
    console.log("          Fix it in the App's Permissions & events before installing.");
  } else {
    console.log(`   Verified: ${slug} declares Contents: write and nothing else.`);
  }
}

// --- main --------------------------------------------------------------------

if (VERIFY_ONLY) {
  const slug = flag("slug");
  if (typeof slug !== "string") die("--verify needs --slug <app-slug>");
  await verify(slug);
  process.exit(0);
}

if (DRY_RUN) {
  console.log(JSON.stringify(manifest(`http://127.0.0.1:${PORT}/callback`), null, 2));
  process.exit(0);
}

requireGh();

const state = randomBytes(16).toString("hex");
const redirectUrl = `http://127.0.0.1:${PORT}/callback`;
const formTarget = `https://github.com/organizations/${ORG}/settings/apps/new?state=${state}`;
const payload = JSON.stringify(manifest(redirectUrl));

const escape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

let resolveCode;
const gotCode = new Promise((r) => (resolveCode = r));

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (url.pathname === "/") {
    // Auto-submits, so the only thing the human does is press GitHub's own
    // "Create GitHub App" button on the page this lands them on.
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><meta charset="utf-8"><title>Create the broker App</title>
<body style="font:16px system-ui;margin:3rem;max-width:40rem">
<h1>Creating ${escape(NAME)}</h1>
<p>Sending you to GitHub. Press <b>Create GitHub App</b> there - the permissions are already filled in
(<code>Contents: write</code>, nothing else) and you should not need to change anything.</p>
<form id="f" method="post" action="${escape(formTarget)}">
<input type="hidden" name="manifest" value="${escape(payload)}">
<noscript><button type="submit">Continue to GitHub</button></noscript>
</form>
<script>document.getElementById('f').submit()</script>
</body>`);
    return;
  }

  if (url.pathname === "/callback") {
    const code = url.searchParams.get("code");
    // The state check: without it, any page you visit while this server is up
    // could drive the callback with a code of its choosing.
    if (url.searchParams.get("state") !== state || !code) {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("Bad state or missing code. Close this and run the script again.");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><meta charset="utf-8"><body style="font:16px system-ui;margin:3rem">
<h1>Done</h1><p>The App is created. Go back to your terminal - it is storing the secrets now.</p></body>`);
    resolveCode(code);
    return;
  }

  res.writeHead(404).end();
});

// 127.0.0.1, not 0.0.0.0: this briefly carries an App-creation callback and has
// no business being reachable from the network.
server.listen(PORT, "127.0.0.1", () => {
  const entry = `http://127.0.0.1:${PORT}/`;
  console.log(`\n  Broker App setup - ${ORG}/${REPO}\n`);
  console.log(`  Opening ${entry}`);
  console.log(`  If no browser appears, open that URL yourself.\n`);
  const opener =
    process.platform === "win32" ? ["cmd", ["/c", "start", "", entry]]
    : process.platform === "darwin" ? ["open", [entry]]
    : ["xdg-open", [entry]];
  spawn(opener[0], opener[1], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
});

// The manifest code expires in an hour, but a script sitting open for an hour is
// a script somebody has walked away from.
const timeout = setTimeout(() => die("Timed out after 10 minutes waiting for GitHub to redirect back."), 600_000);

const code = await gotCode;
clearTimeout(timeout);
server.close();

console.log("  Exchanging the manifest code ...");
const app = await convert(code);

console.log(`  Created: ${app.html_url}`);
console.log(`  Storing secrets on the '${ENVIRONMENT}' environment of ${ORG}/${REPO} ...`);

const okId = await setSecret("PXL_BROKER_CLIENT_ID", String(app.client_id));
const okKey = await setSecret("PXL_BROKER_PRIVATE_KEY", String(app.pem));

if (!okId || !okKey) {
  die(
    "The App was created but a secret could not be stored.\n" +
      "       The private key is NOT saved anywhere - deliberately - so recover by generating\n" +
      `       a fresh one at ${app.html_url} and setting these two by hand on the\n` +
      `       '${ENVIRONMENT}' environment: PXL_BROKER_CLIENT_ID, PXL_BROKER_PRIVATE_KEY.`,
  );
}

console.log("  Secrets stored.\n");
await verify(app.slug);

console.log(`
  ONE STEP LEFT, and it has no API - GitHub requires the first install to
  happen in the UI:

    ${app.html_url}/installations/new

  Choose "Only select repositories" and select ${REPO} - ONLY that one.
  Installing it anywhere else hands a credential to an org that has no use
  for it.

  Then check it took:

    gh api /repos/${ORG}/${REPO}/installation --jq '.app_slug + " -> " + (.permissions|tostring)'

  After that, republish each assignment (RUNBOOK §1.10) - that is what pushes
  the new broker workflow AND removes the provisioning App's key from the
  public broker repositories.
`);
