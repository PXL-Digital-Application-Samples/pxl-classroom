import { test } from "node:test";
import assert from "node:assert/strict";
import { gh, ghAll } from "../lib/gh.mjs";

test("gh basic", async (t) => {
  let fetchedUrl;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    fetchedUrl = url;
    return new Response('{"ok": true}', { status: 200, headers: { "content-type": "application/json" } });
  };
  t.after(() => globalThis.fetch = originalFetch);

  const res = await gh("GET", "/test", null, { token: "secret" });
  assert.equal(fetchedUrl.toString(), "https://api.github.com/test");
  assert.equal(res.status, 200);
  assert.deepEqual(res.data, { ok: true });
});

test("gh retry backoff table", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts++;
    if (attempts < 3) return new Response('error', { status: 500, headers: { "content-type": "text/plain" } });
    return new Response('{"ok": true}', { status: 200, headers: { "content-type": "application/json" } });
  };
  t.after(() => globalThis.fetch = originalFetch);

  const p = gh("GET", "/test", null, { token: "secret" });
  
  // It should wait 500ms after the first 500 error
  await Promise.resolve(); await Promise.resolve();
  assert.equal(attempts, 1);
  
  t.mock.timers.tick(500);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(attempts, 2);
  
  t.mock.timers.tick(1000);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(attempts, 3);
  
  const res = await p;
  assert.equal(res.status, 200);
});

test("gh Retry-After", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts++;
    if (attempts === 1) return new Response('error', { status: 429, headers: { "retry-after": "5" } });
    return new Response('{"ok": true}', { status: 200, headers: { "content-type": "application/json" } });
  };
  t.after(() => globalThis.fetch = originalFetch);

  const p = gh("GET", "/test", null, { token: "secret" });
  
  await Promise.resolve(); await Promise.resolve();
  assert.equal(attempts, 1);

  t.mock.timers.tick(500);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(attempts, 1); // Not retried yet
  
  t.mock.timers.tick(4500);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(attempts, 2); // Retried after 5s

  const res = await p;
  assert.equal(res.status, 200);
});

test("ghAll next link", async (t) => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls++;
    if (calls === 1) {
      return new Response('[1, 2]', { status: 200, headers: { "content-type": "application/json", "link": '<https://api.github.com/test?page=2>; rel="next"' } });
    }
    return new Response('[3]', { status: 200, headers: { "content-type": "application/json" } });
  };
  t.after(() => globalThis.fetch = originalFetch);

  const res = await ghAll("/test", { token: "secret" });
  assert.deepEqual(res, [1, 2, 3]);
  assert.equal(calls, 2);
});
