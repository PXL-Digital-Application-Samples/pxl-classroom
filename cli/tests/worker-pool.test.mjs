import test from "node:test";
import assert from "node:assert";
import { withConcurrency } from "../src/lib/worker-pool.mjs";

test("withConcurrency - basic", async () => {
  let active = 0;
  let maxActive = 0;
  const items = [1, 2, 3, 4, 5];
  const results = await withConcurrency(items, 2, async (item) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise(r => setTimeout(r, 10));
    active--;
    return item * 2;
  });
  assert.deepStrictEqual(results, [2, 4, 6, 8, 10]);
  assert.ok(maxActive <= 2, "concurrency should not exceed limit");
});

test("withConcurrency - errors", async () => {
  const items = [1, 2, 3];
  const results = await withConcurrency(items, 2, async (item) => {
    if (item === 2) throw new Error("test error");
    return item * 2;
  });
  assert.strictEqual(results[0], 2);
  assert.strictEqual(results[1].error.message, "test error");
  assert.strictEqual(results[1].item, 2);
  assert.strictEqual(results[2], 6);
});
