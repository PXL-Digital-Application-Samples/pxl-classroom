import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const libDir = join(here, "..", "frontend", "src", "lib");
const authJsPath = join(libDir, "auth.js");

// auth.js imports these; they have to land in the temp dir alongside it or the
// import fails before the CORS assertions this file cares about ever run.
const AUTH_LOCAL_DEPS = ["http.js"];

async function loadAuthMod(envVars) {
  const code = readFileSync(authJsPath, "utf8");
  // Replace import.meta.env with process.env for Node compatibility
  const modified = code.replace(/import\.meta\.env/g, "process.env");

  const tmp = mkdtempSync(join(tmpdir(), "pxl-cors-test-"));
  const tmpFile = join(tmp, "auth.mjs");
  writeFileSync(tmpFile, modified);
  for (const dep of AUTH_LOCAL_DEPS) {
    writeFileSync(join(tmp, dep), readFileSync(join(libDir, dep), "utf8"));
  }

  const oldEnv = { ...process.env };
  Object.assign(process.env, envVars);
  
  if (!globalThis.sessionStorage) {
    globalThis.sessionStorage = {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {}
    };
  }

  try {
    const mod = await import(pathToFileURL(tmpFile).href);
    return mod;
  } finally {
    process.env = oldEnv;
  }
}

test("a bad VITE_CORS_PROXY_URL fails at sign-in, NOT at import", async () => {
  // It used to throw at module scope, which blanked the entire SPA - a
  // misconfigured build secret produced a white page with nothing written on
  // it. The module must load; the complaint belongs where there is a sign-in
  // card to show it in.
  const mod = await loadAuthMod({ VITE_CORS_PROXY_URL: "https://badproxy.com" });
  assert.ok(mod, "importing auth.js must not throw over a bad proxy setting");

  await assert.rejects(
    () => mod.startDeviceFlow("Iv23liEXAMPLE"),
    /CORS proxy is misconfigured/,
    "signing in must report the configuration problem in words",
  );
});

test("a keyed proxy URL is accepted - the form that recovers from a gated proxy", async () => {
  // corsproxy.io withdrew its free tier on 2026-08-28 and answered 401 to
  // everything; the fix is a key, and a keyed URL ends `&url=` rather than
  // `?url=`. The old check rejected exactly the value needed to recover.
  const mod = await loadAuthMod({ VITE_CORS_PROXY_URL: "https://corsproxy.io/?key=abcd1234&url=" });
  assert.ok(mod);
});

test("auth.js proxy-URL-with-no-trailing-? is auto-fixed", async () => {
  const mod = await loadAuthMod({ VITE_CORS_PROXY_URL: "https://proxy.com/?" });
  assert.ok(mod);
});

test("device-flow state machine and mock fetch", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const originalFetch = globalThis.fetch;
  let fetchCalls = [];
  
  globalThis.fetch = async (url, opts) => {
    fetchCalls.push({ url, opts });
    const decUrl = decodeURIComponent(url);
    if (decUrl.includes("login/device/code")) {
      return new Response(JSON.stringify({ device_code: "DC1", user_code: "UC1", verification_uri: "http://verify" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (decUrl.includes("login/oauth/access_token")) {
      const body = JSON.parse(opts.body);
      if (body.device_code === "DC1") {
        return new Response(JSON.stringify({ access_token: "TOKEN1" }), { status: 200, headers: { "content-type": "application/json" } });
      }
    }
    if (decUrl.includes("api.github.com/user")) {
      return new Response(JSON.stringify({ login: "testuser" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error("Unexpected URL: " + url);
  };
  t.after(() => globalThis.fetch = originalFetch);

  const mod = await loadAuthMod({ VITE_CORS_PROXY_URL: "https://myproxy.com/?url=" });
  
  const startRes = await mod.startDeviceFlow("CLIENT1");
  assert.equal(startRes.device_code, "DC1");
  assert.equal(startRes.user_code, "UC1");
  
  const pollPromise = mod.pollDeviceFlow("CLIENT1", "DC1", 1);
  
  // Advance timer to trigger the poll fetch
  await Promise.resolve(); await Promise.resolve();
  t.mock.timers.tick(1000);
  await Promise.resolve(); await Promise.resolve();
  
  const pollRes = await pollPromise;
  assert.equal(pollRes.token, "TOKEN1");
  assert.equal(pollRes.user.login, "testuser");
  
  // Ensure the proxy was used
  assert.ok(fetchCalls[0].url.startsWith("https://myproxy.com/?url="));
  assert.ok(fetchCalls[1].url.startsWith("https://myproxy.com/?url="));
  
  // Ensure api call bypasses proxy
  assert.ok(fetchCalls[2].url.startsWith("https://api.github.com"));
});
