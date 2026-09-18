// A failed multi-file commit, as a lecturer reads it.
//
// commitWithRebase gives up after five quick attempts when the control
// repository keeps moving under it, and that error has no status of its own.
// The Teams tab printed `HTTP ${res.status}`, so a lecturer who saved while the
// dashboard update from their previous save was still writing read "HTTP 0".

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { commitWithRebase, commitFailureMessage } from "../lib/gittree.mjs";

test("running out of retries says what happened, not HTTP 0", async () => {
  // The real helper against a repository whose branch moves on every attempt.
  let head = 0;
  const fetch = async (url, init) => {
    const json = (status, data) => ({
      ok: status < 300, status, headers: new Map(), text: async () => JSON.stringify(data),
    });
    if (init.method === "GET" && url.includes("/git/ref/")) return json(200, { object: { sha: `c${head}` } });
    if (init.method === "GET" && url.includes("/git/commits/")) return json(200, { tree: { sha: `t${head}` } });
    if (url.endsWith("/git/blobs")) return json(201, { sha: "b" });
    if (url.endsWith("/git/trees")) return json(201, { sha: "t" });
    if (url.endsWith("/git/commits")) return json(201, { sha: "n" });
    head++;
    return json(422, { message: "Update is not a fast forward" });
  };
  let err;
  try {
    await commitWithRebase({ fetch, token: "x", owner: "o", repo: "r", message: "m", changes: [{ path: "a", content: "1" }], baseBackoffMs: 1 });
  } catch (e) {
    err = e;
  }
  assert.ok(err, "the helper gives up");
  assert.equal(err.status, undefined, "and carries no status of its own, which is how HTTP 0 happened");
  const said = commitFailureMessage(err);
  assert.doesNotMatch(said, /HTTP 0/);
  assert.match(said, /nothing was saved/);
  assert.match(said, /try again/);
});

test("a real HTTP failure still names its status", () => {
  assert.equal(commitFailureMessage({ status: 403, message: "Resource not accessible by integration" }), "HTTP 403 (Resource not accessible by integration)");
  assert.equal(commitFailureMessage({ status: 500, message: "HTTP 500" }), "HTTP 500");
  assert.equal(commitFailureMessage({ message: "Failed to fetch" }), "Failed to fetch");
  assert.equal(commitFailureMessage(undefined), "the commit failed");
});

test("the team save reports the helper's message, never the bare status", () => {
  const src = readFileSync(new URL("../frontend/src/components/TeamsTable.vue", import.meta.url), "utf8");
  assert.doesNotMatch(src, /Could not update team: HTTP \$\{res\.status\}/);
});
