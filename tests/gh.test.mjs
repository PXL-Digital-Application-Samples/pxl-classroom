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

// Backoff carries jitter (up to half the base step) so that matrix legs firing
// at the same instant do not retry in lockstep. These assert the BOUNDS, not an
// exact tick - pinning an exact delay would either forbid the jitter or pass
// only by accident.
// gh() now reads the response body BEFORE deciding whether to retry - the
// secondary limit announces itself in the message, not the headers - and
// Response.text() resolves through the microtask queue, so draining it takes
// more than a couple of turns. setImmediate is not among the mocked timers.
const settle = () => new Promise((r) => setImmediate(r));

test("gh retries a 5xx, and not before the base delay has passed", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts++;
    if (attempts < 3) return new Response("error", { status: 500, headers: { "content-type": "text/plain" } });
    return new Response('{"ok": true}', { status: 200, headers: { "content-type": "application/json" } });
  };
  t.after(() => (globalThis.fetch = originalFetch));

  const p = gh("GET", "/test", null, { token: "secret" });
  await settle();
  assert.equal(attempts, 1);

  t.mock.timers.tick(499);
  await settle();
  assert.equal(attempts, 1, "must not retry before the base delay");

  t.mock.timers.tick(251); // 500 + max jitter (base/2)
  await settle();
  assert.equal(attempts, 2, "first retry lands within base + jitter");

  t.mock.timers.tick(1500); // second step is 1000 + jitter
  await settle();
  assert.equal(attempts, 3);

  const res = await p;
  assert.equal(res.status, 200);
});

test("gh honours Retry-After exactly, jitter and all", async (t) => {
  // An explicit instruction from GitHub is not a suggestion to randomise.
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts++;
    if (attempts === 1) return new Response("error", { status: 429, headers: { "retry-after": "5" } });
    return new Response('{"ok": true}', { status: 200, headers: { "content-type": "application/json" } });
  };
  t.after(() => (globalThis.fetch = originalFetch));

  const p = gh("GET", "/test", null, { token: "secret" });
  await settle();
  assert.equal(attempts, 1);

  t.mock.timers.tick(4999);
  await settle();
  assert.equal(attempts, 1, "not a millisecond early");

  t.mock.timers.tick(1);
  await settle();
  assert.equal(attempts, 2);

  const res = await p;
  assert.equal(res.status, 200);
});

test("gh backs off on a secondary rate limit that carries no rate-limit headers", async (t) => {
  // The case lib/gh.mjs used to fail outright: 403, remaining is not zero, no
  // retry-after, and the only signal is the message body. A nightly finalize
  // over a large cohort is exactly the burst that produces it.
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts++;
    if (attempts === 1) {
      return new Response(
        JSON.stringify({ message: "You have exceeded a secondary rate limit. Please wait a few minutes." }),
        { status: 403, headers: { "content-type": "application/json", "x-ratelimit-remaining": "4837" } }
      );
    }
    return new Response('{"ok": true}', { status: 200, headers: { "content-type": "application/json" } });
  };
  t.after(() => (globalThis.fetch = originalFetch));

  const p = gh("GET", "/test", null, { token: "secret" });
  await settle();
  assert.equal(attempts, 1);

  t.mock.timers.tick(59_000);
  await settle();
  assert.equal(attempts, 1, "GitHub's documented floor is a full minute");

  t.mock.timers.tick(2_000);
  await settle();
  assert.equal(attempts, 2);

  const res = await p;
  assert.equal(res.status, 200);
});

test("gh fails fast on a permission 403 rather than sleeping a minute", async (t) => {
  // It carries neither the headers nor the wording, and no amount of waiting
  // will grant the permission.
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts++;
    return new Response(JSON.stringify({ message: "Resource not accessible by integration" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  };
  t.after(() => (globalThis.fetch = originalFetch));

  const res = await gh("GET", "/test", null, { token: "secret" });
  assert.equal(res.status, 403);
  assert.equal(attempts, 1, "one attempt, no sleep");
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
