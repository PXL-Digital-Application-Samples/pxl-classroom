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

// deployment.js is STUBBED rather than copied, and that is not a shortcut.
//
// The real one inlines deployment.yml through Vite's `?raw` and parses it with
// the `yaml` package - neither resolves under plain Node in a temp directory.
// More to the point, what this file tests is the FAILOVER between two proxies,
// not the config reader: stubbing it lets a test set the primary as directly as
// it already sets the secondary, which is what the assertions below need now
// that the PXL-owned Worker is the primary and comes from deployment.yml
// instead of a VITE_ secret.
//
// tests/cors-proxy-config.test.mjs is what holds the real reader honest - it
// asserts the ORDER against auth.js's own source.
const DEPLOYMENT_STUB = 'export const DEVICE_FLOW_PROXY = process.env.TEST_DEVICE_FLOW_PROXY || ""\n';

async function loadAuthMod(envVars) {
  const code = readFileSync(authJsPath, "utf8");
  // Replace import.meta.env with process.env for Node compatibility
  const modified = code.replace(/import\.meta\.env/g, "process.env");

  const tmp = mkdtempSync(join(tmpdir(), "pxl-cors-test-"));
  const tmpFile = join(tmp, "auth.mjs");
  writeFileSync(tmpFile, modified);
  writeFileSync(join(tmp, "deployment.js"), DEPLOYMENT_STUB);
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

// ---------------------------------------------------------------------------
// Failover. The PXL-owned Cloudflare Worker is primary; a third-party proxy is
// the secondary, and there is no THIRD to add - measured 2026-08-28, allorigins,
// thingproxy and codetabs each turned out to issue a GET and hand back GitHub's
// HTML sign-in page, so the pair is the whole set.
// ---------------------------------------------------------------------------

// THE ROLES SWAPPED on 2026-08-31 and these constants follow the code.
//
// The PXL-owned Worker is now the PRIMARY and comes from deployment.yml; the
// third-party proxy is the SECONDARY and keeps its VITE_ secret. It used to be
// the other way round, which meant the third party was on the path of every
// sign-in - seeing the device_code and the access token - while the Worker,
// being a fallback, was only reached if corsproxy.io failed. Measured live, it
// never was.
//
// The failover MECHANICS under test are unchanged: first entry, then second.
// Only which URL sits in which slot moved.
const PRIMARY = "https://pxl-cors.example.workers.dev/?url=";
const SECONDARY = "https://corsproxy.io/?key=k&url=";
const BOTH = { TEST_DEVICE_FLOW_PROXY: PRIMARY, VITE_CORS_PROXY_URL: SECONDARY };

const DEVICE_CODE_OK = JSON.stringify({
  device_code: "DC1",
  user_code: "UC1",
  verification_uri: "https://github.com/login/device",
  interval: 5,
});

/** Install a fetch mock and return the list it records into. */
function mockFetch(t, handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return handler(url, opts);
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

test("the 2026-08-28 outage: primary answers 401, sign-in still works", async (t) => {
  // corsproxy.io's withdrawal reply verbatim. It is well-formed JSON with an
  // `error` field, which is exactly why "did we get JSON back" cannot be the
  // test for whether a proxy worked.
  const calls = mockFetch(t, (url) => {
    if (url.startsWith(PRIMARY)) {
      return new Response(JSON.stringify({ error: "A valid API key is required" }), { status: 401 });
    }
    return new Response(DEVICE_CODE_OK, { status: 200 });
  });

  const mod = await loadAuthMod(BOTH);
  const res = await mod.startDeviceFlow("CLIENT1");

  assert.equal(res.device_code, "DC1", "the fallback must carry the sign-in through");
  assert.equal(calls.length, 2, "primary tried once, then the fallback");
  assert.ok(calls[0].url.startsWith(PRIMARY), "the primary must be tried FIRST");
  assert.ok(calls[1].url.startsWith(SECONDARY));
});

test("HTTP 200 carrying HTML is a broken proxy, not an answer", async (t) => {
  // The failure mode of every GET-only proxy: the request succeeds, the method
  // was silently wrong, and the body is GitHub's sign-in page. No error path
  // fires anywhere unless the reply is checked for shape.
  const calls = mockFetch(t, (url) => {
    if (url.startsWith(PRIMARY)) {
      return new Response("<!DOCTYPE html><html><body>Sign in</body></html>", { status: 200 });
    }
    return new Response(DEVICE_CODE_OK, { status: 200 });
  });

  const mod = await loadAuthMod(BOTH);
  assert.equal((await mod.startDeviceFlow("CLIENT1")).device_code, "DC1");
  assert.equal(calls.length, 2, "a 200 with an unparseable body must fail over");
});

test("a healthy primary means the fallback is never called", async (t) => {
  const calls = mockFetch(t, () => new Response(DEVICE_CODE_OK, { status: 200 }));

  const mod = await loadAuthMod(BOTH);
  await mod.startDeviceFlow("CLIENT1");

  assert.equal(calls.length, 1, "one proxy answered, so nothing else should be tried");
  assert.ok(calls[0].url.startsWith(PRIMARY));
});

test("when every proxy fails, the message says how many and quotes the last reply", async (t) => {
  // "Sign-in is broken" is not a diagnosis. A bad client_id reaches here as
  // GitHub's own 404, and whoever is reading has to be able to tell the two
  // apart without a debugger.
  mockFetch(t, () => new Response(JSON.stringify({ error: "Not Found" }), { status: 404 }));

  const mod = await loadAuthMod(BOTH);
  await assert.rejects(
    () => mod.startDeviceFlow("BAD_CLIENT"),
    (err) => {
      assert.match(err.message, /2 tried/, "it must say how many proxies were attempted");
      assert.match(err.message, /404/, "and quote what the last one actually said");
      assert.match(err.message, /Not Found/);
      return true;
    },
  );
});

test("a misconfigured primary is skipped when the fallback is usable", async (t) => {
  // A typo in one setting must not take working sign-in down with it.
  const calls = mockFetch(t, () => new Response(DEVICE_CODE_OK, { status: 200 }));

  const mod = await loadAuthMod({
    TEST_DEVICE_FLOW_PROXY: "https://typo.example.com",
    VITE_CORS_PROXY_URL: SECONDARY,
  });
  assert.equal((await mod.startDeviceFlow("CLIENT1")).device_code, "DC1");
  assert.equal(calls.length, 1, "the unusable entry is not even attempted");
  assert.ok(calls[0].url.startsWith(SECONDARY));
});

// setTimeout is mocked so the poll's wait is under our control; setImmediate is
// NOT, so awaiting one yields to the event loop and drains the whole pending
// microtask chain - fetch, res.text(), JSON.parse and the follow-up /user call.
// A fixed number of `await Promise.resolve()` hops does not, and stalls the test
// instead of failing it.
const flush = () => new Promise((r) => setImmediate(r));

async function pollTick(t) {
  await flush();
  t.mock.timers.tick(1000);
  await flush();
}

test("authorization_pending is GitHub answering - it must NOT fail over", async (t) => {
  // The most common reply in the whole flow. Treating it as a proxy fault would
  // hammer the fallback on every poll tick of every normal sign-in.
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });

  let pending = true;
  const calls = mockFetch(t, (url) => {
    if (url.includes("api.github.com")) {
      return new Response(JSON.stringify({ login: "testuser", id: 7 }), { status: 200 });
    }
    if (url.includes("device%2Fcode")) return new Response(DEVICE_CODE_OK, { status: 200 });
    if (pending) {
      pending = false;
      return new Response(JSON.stringify({ error: "authorization_pending" }), { status: 200 });
    }
    return new Response(JSON.stringify({ access_token: "TOKEN1" }), { status: 200 });
  });

  const mod = await loadAuthMod(BOTH);
  await mod.startDeviceFlow("CLIENT1");

  const poll = mod.pollDeviceFlow("CLIENT1", "DC1", 1);
  await pollTick(t); // authorization_pending
  await pollTick(t); // access_token
  assert.equal((await poll).token, "TOKEN1");

  const proxied = calls.filter((c) => !c.url.includes("api.github.com"));
  assert.ok(proxied.length >= 3, "device code plus two polls should all be proxied");
  assert.ok(
    proxied.every((c) => c.url.startsWith(PRIMARY)),
    "every proxied call should have stayed on the healthy primary",
  );
});

test("polling sticks to the proxy that worked, instead of re-paying for a dead one", async (t) => {
  // Without this the dead primary is retried on every single poll tick, which
  // doubles the request count and adds its timeout to each one.
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });

  const calls = mockFetch(t, (url) => {
    if (url.includes("api.github.com")) {
      return new Response(JSON.stringify({ login: "testuser", id: 7 }), { status: 200 });
    }
    if (url.startsWith(PRIMARY)) return new Response("nope", { status: 401 });
    if (url.includes("device%2Fcode")) return new Response(DEVICE_CODE_OK, { status: 200 });
    return new Response(JSON.stringify({ access_token: "TOKEN1" }), { status: 200 });
  });

  const mod = await loadAuthMod(BOTH);
  await mod.startDeviceFlow("CLIENT1"); // primary 401s, fallback answers

  const before = calls.length;
  const poll = mod.pollDeviceFlow("CLIENT1", "DC1", 1);
  await pollTick(t);
  await poll;

  const pollCalls = calls.slice(before).filter((c) => !c.url.includes("api.github.com"));
  assert.ok(pollCalls.length > 0, "the poll must have issued a proxied request");
  assert.ok(
    pollCalls[0].url.startsWith(SECONDARY),
    "the first poll should go straight to the proxy that answered, not back to the dead one",
  );
});
