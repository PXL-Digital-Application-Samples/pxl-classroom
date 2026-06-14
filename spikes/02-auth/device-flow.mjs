#!/usr/bin/env node
// PXL Classroom — Spike 2: Student authentication via GitHub device flow.
//
// Device flow needs no redirect URL and no client secret in the browser, so it
// is the most static-frontend-friendly candidate. This harness tests it from
// the CLI in two steps (so the user code can be shown before authorizing):
//
//   node device-flow.mjs request   # prints the user code + URL, saves device_code
//   ...user authorizes in browser...
//   node device-flow.mjs poll      # exchanges the code, identifies the user
//
// Requires: CLIENT_ID of a GitHub App (or OAuth App) with Device Flow ENABLED.
// No npm deps (Node 18+ fetch).

import { writeFile, readFile } from "node:fs/promises";

const CLIENT_ID = process.env.CLIENT_ID;
const SCOPE = process.env.SCOPE ?? ""; // GitHub Apps ignore scope; OAuth Apps may set e.g. "public_repo"
const STATE = "/tmp/spike2-device.json";
const mode = process.argv[2];

if (!CLIENT_ID) { console.error("Set CLIENT_ID (GitHub App/OAuth App client id)."); process.exit(2); }

async function post(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "pxl-spike-02" },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function request() {
  const data = await post("https://github.com/login/device/code", { client_id: CLIENT_ID, scope: SCOPE });
  if (data.error) { console.error(data); process.exit(1); }
  await writeFile(STATE, JSON.stringify(data));
  console.log("\n  Open:        " + data.verification_uri);
  console.log("  Enter code:  " + data.user_code);
  console.log(`\n  (code valid ${data.expires_in}s; then run: node spikes/02-auth/device-flow.mjs poll)\n`);
}

async function poll() {
  const saved = JSON.parse(await readFile(STATE, "utf8"));
  const deadline = Date.now() + (saved.expires_in ?? 900) * 1000;
  let interval = (saved.interval ?? 5) * 1000;
  while (Date.now() < deadline) {
    const tok = await post("https://github.com/login/oauth/access_token", {
      client_id: CLIENT_ID,
      device_code: saved.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    if (tok.access_token) {
      const who = await fetch("https://api.github.com/user", {
        headers: { Authorization: `Bearer ${tok.access_token}`, "User-Agent": "pxl-spike-02" },
      }).then((r) => r.json());
      console.log("authenticated_as=" + who.login + " (id=" + who.id + ")");
      console.log("token_type=" + (tok.refresh_token ? "user-to-server (expiring)" : "user token"));
      console.log("token_expires_in=" + (tok.expires_in ?? "(none — non-expiring)"));
      console.log("has_refresh_token=" + Boolean(tok.refresh_token));
      console.log("scope=" + (tok.scope ?? "(GitHub App: governed by app permissions, not scopes)"));
      return;
    }
    if (tok.error === "authorization_pending") { /* keep waiting */ }
    else if (tok.error === "slow_down") { interval += 5000; }
    else { console.error(tok); process.exit(1); }
    await new Promise((r) => setTimeout(r, interval));
  }
  console.error("timed out waiting for authorization");
  process.exit(1);
}

if (mode === "request") await request();
else if (mode === "poll") await poll();
else { console.error("usage: device-flow.mjs request|poll"); process.exit(2); }
