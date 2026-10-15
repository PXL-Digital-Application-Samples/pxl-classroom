// scripts/npm-ci-retry.mjs - the sentinel's install, tried again on a registry
// blip (ECONNRESET, 2026-10-15) under the rules any retry needs: only what a
// retry can fix, capped backoff with jitter, a limit per try, a hard stop that
// never sleeps across the deadline, and nothing run until it succeeds.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

import { BACKOFF_SECONDS, GRACE_AFTER_DEADLINE_MS, isRetryable, planWait, retryInstall } from "../scripts/npm-ci-retry.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIN = 60_000;
const T0 = Date.parse("2026-10-15T15:00:00Z");
const top = () => 0.999999;
const bottom = () => 0;

// What npm printed on the hub at 17:08 UTC, 2026-10-15.
const ECONNRESET = "npm error code ECONNRESET\nnpm error syscall read\nnpm error errno -104\nnpm error network read ECONNRESET\n";

test("only what a retry can fix: the network and the registry, never the project's own failure", () => {
  assert.equal(isRetryable(ECONNRESET), true);
  for (const code of ["ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "ECONNREFUSED", "E503", "E502", "E429"]) {
    assert.equal(isRetryable(`npm error code ${code}\n`), true, code);
  }
  assert.equal(isRetryable("npm ERR! code ECONNRESET\n"), true, "older npm's spelling");
  for (const out of [
    "npm error code EUSAGE\nnpm error `npm ci` can only install packages when your package.json and package-lock.json are in sync.",
    "npm error code EBADENGINE\n",
    "npm error code E404\nnpm error 404 Not Found",
    "npm error code ERESOLVE\n",
    "",
  ]) assert.equal(isRetryable(out), false, out.split("\n")[0] || "(nothing)");
});

test("the waits are capped at a minute, and jittered between half and all of it", () => {
  const at = (attempt, random) => planWait({ attempt, nowMs: T0, startedMs: T0, budgetMs: 270 * MIN, random });
  assert.deepEqual([1, 2, 3, 4, 50].map((a) => at(a, top)), [9_999, 19_999, 39_999, 59_999, 59_999]);
  assert.deepEqual([1, 2, 3, 4, 50].map((a) => at(a, bottom)), [5_000, 10_000, 20_000, 30_000, 30_000]);
  assert.equal(Math.max(...BACKOFF_SECONDS), 60);
});

test("a wait never runs past the deadline: the next try lands on it", () => {
  const deadlineMs = T0 + 25_000;
  assert.equal(planWait({ attempt: 4, nowMs: T0, startedMs: T0, budgetMs: 270 * MIN, deadlineMs, random: top }), 25_000);
  // Past it, the ordinary wait: a watch that starts late still stops writes.
  assert.equal(planWait({ attempt: 4, nowMs: deadlineMs + 1, startedMs: T0, budgetMs: 270 * MIN, deadlineMs, random: top }), 59_999);
});

test("it stops: an hour after the deadline, or at the end of the budget, with one last try there", () => {
  const deadlineMs = T0 + 10 * MIN;
  const end = deadlineMs + GRACE_AFTER_DEADLINE_MS;
  assert.equal(GRACE_AFTER_DEADLINE_MS, 60 * MIN);
  assert.equal(planWait({ attempt: 9, nowMs: end, startedMs: T0, budgetMs: 270 * MIN, deadlineMs }), null, "the grace, not the 270-minute budget");
  assert.equal(planWait({ attempt: 9, nowMs: end - 5_000, startedMs: T0, budgetMs: 270 * MIN, deadlineMs, random: top }), 5_000);
  // No deadline (the arm job): the budget alone.
  assert.equal(planWait({ attempt: 9, nowMs: T0 + 8 * MIN, startedMs: T0, budgetMs: 8 * MIN }), null);
});

function fakes(results) {
  const state = { clock: T0, slept: [], logs: [] };
  return {
    state,
    deps: {
      run: () => results.shift(),
      sleep: async (ms) => { state.slept.push(ms); state.clock += ms; },
      now: () => state.clock,
      log: (s) => state.logs.push(s),
      random: top,
    },
  };
}

test("retryInstall: a network failure is tried again until it works", async () => {
  const { state, deps } = fakes([{ status: 152, output: ECONNRESET }, { status: 152, output: ECONNRESET }, { status: 0, output: "" }]);
  assert.equal(await retryInstall({ ...deps, budgetMs: 8 * MIN }), 0);
  assert.deepEqual(state.slept, [9_999, 19_999]);
  assert.match(state.logs[0], /::warning::npm ci failed \(try 1, ECONNRESET\); trying again in 10s/);
  assert.match(state.logs.at(-1), /succeeded on try 3/);
});

test("retryInstall: anything else fails at once, with npm's own code, as a bare npm ci did", async () => {
  const { state, deps } = fakes([{ status: 1, output: "npm error code EUSAGE\n" }]);
  assert.equal(await retryInstall({ ...deps, budgetMs: 270 * MIN }), 1);
  assert.deepEqual(state.slept, [], "no wait: a real breakage is red now");
  assert.match(state.logs[0], /::error::npm ci failed \(EUSAGE\), which is not a network failure/);
});

test("retryInstall: a try that hung is a network failure; the end is an error naming the nightly", async () => {
  const hung = { status: 1, output: "", timedOut: true };
  const { state, deps } = fakes(Array.from({ length: 50 }, () => hung));
  assert.equal(await retryInstall({ ...deps, budgetMs: 2 * MIN }), 1);
  assert.ok(state.slept.length > 1);
  assert.ok(state.slept.reduce((a, b) => a + b, 0) <= 2 * MIN, "never past the budget");
  assert.match(state.logs.at(-1), /::error::npm ci failed \d+ time\(s\) \(it ran out of time\).*the nightly locks/);
});

test("both sentinel jobs install through it, the watch with its instant, inside each job's timeout", () => {
  const wf = parse(readFileSync(join(root, ".github", "workflows", "deadline-sentinel.yml"), "utf8"));
  const installOf = (job) => wf.jobs[job].steps.find((s) => /npm-ci-retry\.mjs/.test(String(s.run ?? "")));
  for (const job of ["arm", "watch"]) {
    assert.equal(wf.jobs[job].steps.some((s) => /\bnpm ci\b/.test(String(s.run ?? ""))), false, `${job} still runs a bare npm ci`);
    const install = installOf(job);
    assert.ok(install, `${job} installs through scripts/npm-ci-retry.mjs`);
    assert.ok(Number(install.env.RETRY_BUDGET_MINUTES) < wf.jobs[job]["timeout-minutes"], `${job}: the retry fits inside the job's timeout`);
  }
  assert.equal(installOf("watch").env.DEADLINE_AT, "${{ matrix.sentinel.deadline_at }}");
  assert.equal(installOf("arm").env.DEADLINE_AT, undefined, "the arm job has no instant yet");
});

test("it imports node builtins only: it runs before anything is installed", () => {
  const src = readFileSync(join(root, "scripts", "npm-ci-retry.mjs"), "utf8");
  const specifiers = [...src.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
  assert.ok(specifiers.length > 0);
  assert.deepEqual(specifiers.filter((s) => !s.startsWith("node:")), []);
});
