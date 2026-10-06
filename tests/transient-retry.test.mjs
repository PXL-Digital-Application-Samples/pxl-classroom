// lib/transient-retry.mjs: GitHub saying "not now" is asked again; any other
// answer is not.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isTransient, withTransientRetry } from "../lib/transient-retry.mjs";

const failing = (status) => Object.assign(new Error(`HTTP ${status}`), { status });
const noSleep = () => Promise.resolve();

test("a gateway timeout is asked again, and the answer that follows is used", async () => {
  // 2026-10-06: one 504 failed the Pages deploy for every organization.
  let calls = 0;
  const waited = [];
  const out = await withTransientRetry(
    async () => {
      calls++;
      if (calls < 3) throw failing(504);
      return "ok";
    },
    { sleep: async (ms) => { waited.push(ms); } },
  );
  assert.equal(out, "ok");
  assert.equal(calls, 3);
  assert.deepEqual(waited, [2000, 5000]);
});

test("only 'not now' is asked again: an answer is not", async () => {
  for (const status of [404, 401, 403, 422, 500]) {
    let calls = 0;
    await assert.rejects(withTransientRetry(async () => { calls++; throw failing(status); }, { sleep: noSleep }), { status });
    assert.equal(calls, 1, `HTTP ${status} is not retried`);
  }
});

test("a dropped connection is asked again; a bug is not", async () => {
  assert.equal(isTransient(new TypeError("fetch failed")), true);
  assert.equal(isTransient(Object.assign(new TypeError("x is not a function"), { status: 400 })), false);
  assert.equal(isTransient(new SyntaxError("Unexpected token")), false);
  for (const status of [502, 503, 504]) assert.equal(isTransient(failing(status)), true);
});

test("it gives up after the last wait and throws what GitHub said", async () => {
  let calls = 0;
  await assert.rejects(withTransientRetry(async () => { calls++; throw failing(503); }, { sleep: noSleep }), { status: 503 });
  assert.equal(calls, 3);
});

test("the Pages data fetch asks through it", () => {
  const src = readFileSync(new URL("../scripts/fetch-pages-data.mjs", import.meta.url), "utf8");
  assert.match(src, /withTransientRetry\(/);
});
