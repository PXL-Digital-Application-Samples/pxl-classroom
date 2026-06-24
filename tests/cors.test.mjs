import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const authJsPath = join(here, "..", "frontend", "src", "lib", "auth.js");

async function loadAuthMod(envVars) {
  const code = readFileSync(authJsPath, "utf8");
  // Replace import.meta.env with process.env for Node compatibility
  const modified = code.replace(/import\.meta\.env/g, "process.env");
  
  const tmp = mkdtempSync(join(tmpdir(), "pxl-cors-test-"));
  const tmpFile = join(tmp, "auth.mjs");
  writeFileSync(tmpFile, modified);
  
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

test("auth.js requires valid VITE_CORS_PROXY_URL", async () => {
  await assert.rejects(
    () => loadAuthMod({ VITE_CORS_PROXY_URL: "https://badproxy.com" }),
    /must end with \? or \?url=/
  );
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
