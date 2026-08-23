// GitHub's SECONDARY rate limit is the one that actually bites this system: a
// burst of content-generating requests - seeding a cohort's teams, or a nightly
// finalize walking every student - trips it, and it does not look like the
// primary limit at all.
//
// lib/gittree.mjs learned that in 8727247. lib/gh.mjs did not, and lib/gh.mjs is
// the carrier for provisioning, collection, lockdown, preservation, reporting,
// notification, usage and the team-payload read. One policy now, in
// lib/rate-limit.mjs, so the next correction cannot land in only one of them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { retryDelayMs, backoffMs, SECONDARY_MIN_WAIT_MS } from "../lib/rate-limit.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

// No jitter, fixed clock: these assert the policy, not the dice.
const FIXED = { random: () => 0, now: 1_700_000_000_000 };
const delay = (res, attempt = 0) => retryDelayMs(res, attempt, FIXED);

// --- The shape a secondary limit actually arrives in ------------------------

test("a secondary limit is retried on 403 with neither rate-limit header", () => {
  // The exact case the old lib/gh.mjs condition missed: 403, remaining is not
  // zero, no retry-after, and the only signal is the message.
  const ms = delay({
    status: 403,
    headers: { "x-ratelimit-remaining": "4837" },
    message: "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.",
  });
  assert.equal(ms, SECONDARY_MIN_WAIT_MS, "and waits GitHub's documented minimum");
});

test("a secondary limit is retried on 429 too", () => {
  const ms = delay({ status: 429, headers: {}, message: "You have exceeded a secondary rate limit." });
  assert.ok(ms >= SECONDARY_MIN_WAIT_MS);
});

test("the older abuse-detection wording is still recognised", () => {
  const ms = delay({ status: 403, headers: {}, message: "You have triggered an abuse detection mechanism." });
  assert.equal(ms, SECONDARY_MIN_WAIT_MS);
});

test("retry-after wins over every heuristic", () => {
  const ms = delay({ status: 403, headers: { "retry-after": "7" }, message: "secondary rate limit" });
  assert.equal(ms, 7000);
});

test("a secondary limit backs off further on later attempts", () => {
  const res = { status: 429, headers: {}, message: "secondary rate limit" };
  const late = delay(res, 8);
  assert.ok(late >= SECONDARY_MIN_WAIT_MS, "never below the documented floor");
  assert.ok(late >= delay(res, 0), "and not shorter than the first wait");
});

// --- What must still fail fast ----------------------------------------------

test("a permission 403 is not retried", () => {
  // It carries neither the headers nor the wording. Sleeping a minute on the
  // way to the same error helps nobody.
  assert.equal(
    delay({ status: 403, headers: {}, message: "Resource not accessible by integration" }),
    null
  );
});

test("ordinary client errors are not retried", () => {
  for (const status of [400, 401, 404, 409, 422]) {
    assert.equal(delay({ status, headers: {}, message: "Not Found" }), null, `${status} must not retry`);
  }
});

test("success is not retried", () => {
  assert.equal(delay({ status: 200, headers: {}, message: "" }), null);
});

// --- The primary limit ------------------------------------------------------

test("a primary limit waits for the reset when it is soon", () => {
  const ms = delay({
    status: 403,
    headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(FIXED.now / 1000 + 30) },
  });
  assert.equal(ms, 30_000);
});

test("a primary limit whose reset is far away backs off instead of sleeping through it", () => {
  const ms = delay({
    status: 403,
    headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(FIXED.now / 1000 + 3600) },
  });
  assert.ok(ms < SECONDARY_MIN_WAIT_MS, `expected a short backoff, got ${ms}ms`);
});

test("5xx is retried with plain backoff", () => {
  assert.equal(delay({ status: 502, headers: {}, message: "" }), backoffMs(0, 500, () => 0));
});

// --- Both carriers, one policy ----------------------------------------------

test("headers work as a fetch Headers object and as a plain object", () => {
  // lib/gh.mjs hands over a real Headers; gittree's error shape is a plain
  // object. A reader that only understood one of them would silently disable
  // the policy for the other.
  const plain = delay({ status: 403, headers: { "retry-after": "3" }, message: "secondary rate limit" });
  const fetched = delay({
    status: 403,
    headers: new Headers({ "retry-after": "3" }),
    message: "secondary rate limit",
  });
  assert.equal(plain, 3000);
  assert.equal(fetched, 3000);
});

test("neither carrier keeps its own copy of the policy", () => {
  for (const file of ["gh.mjs", "gittree.mjs"]) {
    const src = readFileSync(join(root, "lib", file), "utf8");
    assert.match(src, /from "\.\/rate-limit\.mjs"/, `lib/${file} must import the shared policy`);
    assert.ok(
      !/secondary rate limit\|abuse detection/.test(src),
      `lib/${file} must not re-implement the secondary-limit test`
    );
  }
});

test("gh.mjs reads the body before deciding whether to retry", () => {
  // The secondary limit announces itself in the message, so a retry decision
  // taken on headers alone cannot see it.
  const src = readFileSync(join(root, "lib", "gh.mjs"), "utf8");
  const body = src.indexOf("const text = await res.text()");
  const decide = src.indexOf("retryDelayMs(");
  assert.ok(body > -1 && decide > -1, "both steps must exist");
  assert.ok(body < decide, "the body must be read before the retry decision");
});
