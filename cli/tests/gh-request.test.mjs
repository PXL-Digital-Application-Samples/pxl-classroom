// The one Octokit -> `request(path)` adapter keeps what GitHub answered on an
// error: a rate limit is a 403 too, told apart only by its message or its
// headers (lib/grade-dispatch.mjs `isRateLimited`), and dropping both made the
// CLI read every rate limit as a missing permission (review 2026-10-14, P2-5).

import { test } from "node:test";
import assert from "node:assert/strict";
import { toRequest } from "../src/lib/gh-request.mjs";
import { isRateLimited } from "../../lib/grade-dispatch.mjs";

const throwing = (status, data, headers) => ({
  request: async () => {
    const err = new Error("HttpError");
    err.status = status;
    err.response = { status, data, headers };
    throw err;
  },
});

test("an error answers with its status, GitHub's message and its headers, never a throw", async () => {
  const get = toRequest(throwing(403, { message: "API rate limit exceeded for installation" }, { "x-ratelimit-remaining": "0" }));
  const res = await get("/repos/o/r/commits/x/check-runs");
  assert.equal(res.status, 403);
  assert.equal(res.data.message, "API rate limit exceeded for installation");
  assert.equal(res.headers["x-ratelimit-remaining"], "0");
  assert.equal(isRateLimited(res), true, "so the shared rule can tell it from a permission");
  const denied = await toRequest(throwing(403, { message: "Resource not accessible by integration" }, {}))("/x");
  assert.equal(isRateLimited(denied), false);
});

test("an error with no response still answers, with nothing invented", async () => {
  const res = await toRequest({ request: async () => { throw Object.assign(new Error("socket hang up"), {}); } })("/x");
  assert.deepEqual(res, { status: 0, data: null, headers: {} });
});

test("a success answers status, data and headers", async () => {
  const res = await toRequest({ request: async () => ({ status: 200, data: [1], headers: { link: "<x>; rel=\"last\"" } }) })("/x");
  assert.deepEqual(res, { status: 200, data: [1], headers: { link: "<x>; rel=\"last\"" } });
});
