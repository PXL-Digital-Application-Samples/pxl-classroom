#!/usr/bin/env node
// PXL Classroom - `npm ci --omit=dev`, tried again when the network failed it.
//
// A dropped connection to the npm registry (ECONNRESET, 2026-10-15, the
// watchdog's 17:08 run) fails a job before any of its own code has run. For
// most jobs the next run is the retry. For the Deadline Sentinel it is not: a
// watch that cannot install stops nothing at the instant, and the cohort can
// push until the nightly locks it, hours later. So the sentinel's two jobs
// install through this, under the rules any retry loop needs:
//
// - ONLY WHAT A RETRY CAN FIX is retried: a network or registry-side failure
//   (`isRetryable`). Anything else - a lockfile out of date, an engine refused,
//   a bad commit - fails at once, as a bare `npm ci` did, so a real breakage is
//   red now and not hours later.
// - CAPPED BACKOFF WITH JITTER: 10, 20, 40, then 60 seconds, each between half
//   and all of that, so the hub's parallel sentinels do not retry in lockstep
//   against a registry that is coming back.
// - A TIME LIMIT PER TRY: a hung install is killed and counts as a network
//   failure.
// - A HARD STOP: no wait runs past the deadline - it is cut so a try lands on
//   it - and trying ends `GRACE_AFTER_DEADLINE_MS` after the deadline, and never
//   past the job's own budget. Then the step fails, the run is red (the
//   watchdog alerts), and the nightly locks as it always did.
// - SAFE TO REPEAT: `npm ci` starts from nothing each time, and no later step
//   runs until it succeeds. A watch that starts late fires at once and plans
//   from what GitHub says then - reopen records, each student's deadline - with
//   an idempotent lock that keeps the first lock time, so acting late undoes
//   nothing (lockdown/lockdown.mjs, scripts/deadline-sentinel.mjs).
//
// RUNS BEFORE `npm ci`, so it imports node builtins and nothing else - no
// package, and nothing from lib/ that could import one.
//
//   DEADLINE_AT           the instant the job acts at (optional)
//   RETRY_BUDGET_MINUTES  how long it may keep trying, from its own start

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/** The ceiling of each wait, by try (1-based); the last repeats. */
export const BACKOFF_SECONDS = Object.freeze([10, 20, 40, 60]);

/** How long after the deadline a late install is still worth having. */
export const GRACE_AFTER_DEADLINE_MS = 60 * 60_000;

/** A try that runs longer than this is killed, as a hung network would be. */
export const ATTEMPT_TIMEOUT_MS = 10 * 60_000;

/**
 * Whether npm's output says the network or the registry failed it - the only
 * failures a retry can fix. npm prints `npm error code <CODE>` (`npm ERR!` in
 * older versions) and, for these, `npm error network ...`.
 *
 * @param {string} output  what npm wrote, stdout and stderr together
 */
export function isRetryable(output) {
  const text = String(output ?? "");
  if (/npm (?:error|ERR!) network\b/.test(text)) return true;
  return /npm (?:error|ERR!) code (?:ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|ECONNABORTED|EPIPE|EHOSTUNREACH|ENETUNREACH|ERR_SOCKET_TIMEOUT|UND_ERR_SOCKET|E429|E5\d\d)\b/.test(text);
}

/**
 * How long to wait after a failed try, in ms, or null to give up.
 *
 * @param {{ attempt: number, nowMs: number, startedMs: number, budgetMs: number,
 *           deadlineMs?: number|null, random?: () => number }} p
 * @returns {number|null}
 */
export function planWait({ attempt, nowMs, startedMs, budgetMs, deadlineMs = null, random = Math.random }) {
  const ceiling = BACKOFF_SECONDS[Math.min(attempt, BACKOFF_SECONDS.length) - 1] * 1000;
  const hasDeadline = Number.isFinite(deadlineMs);
  const giveUpAt = Math.min(startedMs + budgetMs, hasDeadline ? deadlineMs + GRACE_AFTER_DEADLINE_MS : Infinity);
  if (nowMs >= giveUpAt) return null;
  // Between half and all of the ceiling.
  let wait = ceiling / 2 + Math.floor(random() * (ceiling / 2));
  // Never sleep across the instant: the try lands on it instead.
  if (hasDeadline && nowMs < deadlineMs && nowMs + wait > deadlineMs) wait = deadlineMs - nowMs;
  // Nor past the end: one last try there.
  if (nowMs + wait > giveUpAt) wait = giveUpAt - nowMs;
  return Math.max(0, wait);
}

/**
 * Try `run` until it succeeds, fails in a way a retry cannot fix, or the plan
 * gives up.
 *
 * @param {{ run: () => { status: number|null, output: string, timedOut?: boolean },
 *           sleep: (ms: number) => Promise<void>, now: () => number, log: (s: string) => void,
 *           budgetMs: number, deadlineMs?: number|null, random?: () => number }} deps
 * @returns {Promise<number>} the exit code to leave with
 */
export async function retryInstall({ run, sleep, now, log, budgetMs, deadlineMs = null, random = Math.random }) {
  const startedMs = now();
  for (let attempt = 1; ; attempt++) {
    const { status, output, timedOut = false } = run();
    if (status === 0) {
      if (attempt > 1) log(`npm ci succeeded on try ${attempt}.`);
      return 0;
    }
    const code = status || 1;
    const why = timedOut ? "it ran out of time" : (/npm (?:error|ERR!) code (\S+)/.exec(output)?.[1] ?? `exit ${code}`);
    if (!timedOut && !isRetryable(output)) {
      log(`::error::npm ci failed (${why}), which is not a network failure, so it is not tried again.`);
      return code;
    }
    const wait = planWait({ attempt, nowMs: now(), startedMs, budgetMs, deadlineMs, random });
    if (wait === null) {
      log(`::error::npm ci failed ${attempt} time(s) (${why}) over ${Math.round((now() - startedMs) / 60000)} minute(s); giving up - the nightly locks what this job would have.`);
      return code;
    }
    log(`::warning::npm ci failed (try ${attempt}, ${why}); trying again in ${Math.round(wait / 1000)}s.`);
    await sleep(wait);
  }
}

function runNpmCi() {
  const res = spawnSync("npm", ["ci", "--omit=dev"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: ATTEMPT_TIMEOUT_MS });
  // Shown as npm wrote it, then read for why it failed.
  if (res.stdout) process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);
  const timedOut = res.error?.code === "ETIMEDOUT" || res.signal === "SIGTERM";
  return { status: res.status ?? 1, output: `${res.stdout ?? ""}\n${res.stderr ?? ""}`, timedOut };
}

function main() {
  const minutes = Number(process.env.RETRY_BUDGET_MINUTES);
  const budgetMs = (Number.isFinite(minutes) && minutes > 0 ? minutes : 8) * 60_000;
  const deadline = Date.parse(process.env.DEADLINE_AT ?? "");
  return retryInstall({
    run: runNpmCi,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    log: (s) => console.log(s),
    budgetMs,
    deadlineMs: Number.isFinite(deadline) ? deadline : null,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code));
}
