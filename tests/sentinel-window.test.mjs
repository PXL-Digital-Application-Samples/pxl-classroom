// When is a deadline close enough to arm a sentinel for?
//
// The sentinel arms from a 4-hourly cron, and a cron cannot see something that
// did not exist when it last fired. Two moments create a deadline it has
// already missed, and both now arm it themselves:
//
//   * publishing an assignment whose deadline is hours away - "the exam is at
//     10:00 and I set it up at 10:15", where the next firing is 14:00;
//   * editing a live assignment to bring its deadline forward, from next week
//     to this afternoon, which is not a publish and so armed nothing at all.
//
// Missing the window is survivable but wrong for an exam: marks are unaffected
// (late is decided by the commit's own timestamp) while the repositories stay
// writable until the nightly, up to fourteen hours later.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { SENTINEL_ARM_WINDOW_MS, deadlineIsImminent, sentinelStoppedAt } from "../lib/sentinel-window.mjs";

const NOW = Date.parse("2026-09-07T10:00:00.000Z");

test("A STOP THAT FAILED is not a stop; one not yet confirmed is one only where not unlocking matters (third review, 2026-09-26)", () => {
  const t = (stop) => ({ outcome: "fired", deadline_at: "2026-09-30T00:00:00.000Z", ...(stop ? { stop } : {}) });
  const at = "2026-09-30T00:00:00.000Z";
  // Lockdown's credit: confirmed stops, and timelines from before the field.
  assert.equal(sentinelStoppedAt([t("done")], { confirmedOnly: true }), at);
  assert.equal(sentinelStoppedAt([t()], { confirmedOnly: true }), at, "absent: written before the field, when fired meant stopped");
  assert.equal(sentinelStoppedAt([t("pending")], { confirmedOnly: true }), null);
  assert.equal(sentinelStoppedAt([t("failed")], { confirmedOnly: true }), null);
  // The permission plan: anything that may have held is held.
  assert.equal(sentinelStoppedAt([t("pending")]), at);
  assert.equal(sentinelStoppedAt([t("failed")]), null);
});

test("the workflow confirms the stop after it runs, on this run's timelines only", () => {
  const wf = readFileSync(fileURLToPath(new URL("../.github/workflows/deadline-sentinel.yml", import.meta.url)), "utf8");
  const stop = wf.indexOf("- name: Stop writes");
  const mark = wf.indexOf("- name: Record whether the stop held");
  const commit = wf.indexOf("- name: Commit the push timeline");
  assert.ok(stop > 0 && stop < mark && mark < commit, "stop, then record it, then commit");
  assert.match(wf.slice(mark, commit), /RESULT: \$\{\{ steps\.stop\.outcome == 'success' && 'done' \|\| 'failed' \}\}/);
  const src = readFileSync(fileURLToPath(new URL("../scripts/mark-sentinel-stop.mjs", import.meta.url)), "utf8");
  assert.match(src, /doc\?\.observer_run !== runUrl/, "never relabels another run's timeline");
});

test("mark-sentinel-stop, run: marks this run's pending timelines and nothing else", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "pxl-mark-"));
  mkdirSync(join(dir, "lockdowns", "exam"), { recursive: true });
  const mine = "https://github.com/Hub/pxl/actions/runs/77";
  const put = (name, doc) => writeFileSync(join(dir, "lockdowns", "exam", name), JSON.stringify(doc));
  put("sentinel-a.json", { outcome: "fired", stop: "pending", observer_run: mine });
  put("sentinel-b.json", { outcome: "fired", stop: "pending", observer_run: "https://github.com/Hub/pxl/actions/runs/1" });
  const res = spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/mark-sentinel-stop.mjs", import.meta.url))], {
    encoding: "utf8",
    env: { ...process.env, DATA_DIR: dir, RESULT: "failed", GITHUB_SERVER_URL: "https://github.com", GITHUB_REPOSITORY: "Hub/pxl", GITHUB_RUN_ID: "77" },
  });
  assert.equal(res.status, 0, res.stderr);
  const read = (n) => JSON.parse(readFileSync(join(dir, "lockdowns", "exam", n), "utf8"));
  assert.equal(read("sentinel-a.json").stop, "failed");
  assert.equal(read("sentinel-b.json").stop, "pending", "another run's timeline is left as it was");
});
const at = (ms) => new Date(NOW + ms).toISOString();
const HOUR = 3600_000;

test("the window is 4.5 hours, and both bounds are forced", () => {
  // Wider than the 4h cron interval or some deadline gets no firing that can
  // reach it; narrower than the 6h job limit or the sentinel is killed while
  // it waits.
  assert.equal(SENTINEL_ARM_WINDOW_MS, 4.5 * HOUR);
  assert.ok(SENTINEL_ARM_WINDOW_MS > 4 * HOUR, "must exceed the cron interval");
  assert.ok(SENTINEL_ARM_WINDOW_MS < 6 * HOUR, "must stay under the job limit");
});

test("a deadline inside the window is imminent", () => {
  for (const h of [0.1, 1, 2, 4, 4.4]) {
    assert.equal(deadlineIsImminent(at(h * HOUR), { now: NOW }), true, `${h}h out`);
  }
});

test("a deadline beyond the window is not - the cron will get it", () => {
  // THE POINT of arming being conditional. Publishing an exam a week early
  // must not spawn a sentinel that sleeps for a week; the job limit is 6h.
  for (const h of [4.6, 6, 24, 24 * 7]) {
    assert.equal(deadlineIsImminent(at(h * HOUR), { now: NOW }), false, `${h}h out`);
  }
});

test("THE EXAM CASE: published at 10:15 for a 12:00 deadline", () => {
  // The scenario this exists for. Cron fires at 00/04/08/12/16/20 UTC, so a
  // publish at 10:15 has already missed 08:00 and the deadline at 12:00 comes
  // before the next firing. Without arming at publish, nothing watches it.
  const published = Date.parse("2026-09-07T10:15:00.000Z");
  assert.equal(deadlineIsImminent("2026-09-07T12:00:00.000Z", { now: published }), true);
});

test("a deadline already past is NOT imminent", () => {
  // The sentinel stops writes at an instant. An instant that has gone is the
  // nightly's job, and arming for it would spawn a job that wakes, finds the
  // moment gone and exits - noise that looks like coverage.
  assert.equal(deadlineIsImminent(at(-1), { now: NOW }), false);
  assert.equal(deadlineIsImminent(at(-3 * HOUR), { now: NOW }), false);
});

test("UNREADABLE IS NOT IMMINENT", () => {
  // A deadline nobody can parse is not evidence of a close one. Reading it as
  // imminent would arm on every malformed assignment; reading it as a number
  // would be worse.
  for (const bad of [undefined, null, "", "soon", "2026-13-45", 0, 12345, {}, []]) {
    assert.equal(deadlineIsImminent(bad, { now: NOW }), false, JSON.stringify(bad));
  }
});

test("find-armable derives the window rather than re-spelling it", () => {
  // The number is now in two files' behaviour and one file's source. A second
  // literal would be the defect this repository has paid for repeatedly: two
  // spellings that agree until one is edited.
  const src = readFileSync(fileURLToPath(new URL("../scripts/find-armable.mjs", import.meta.url)), "utf8");
  assert.match(src, /SENTINEL_ARM_WINDOW_MS/, "must import the shared window");
  assert.doesNotMatch(
    src.replace(/\/\/[^\n]*/g, ""),
    /4\.5\s*\*\s*3600/,
    "and must not carry its own copy of the number",
  );
});

test("both arming callers exist, or the cron gap is still open", () => {
  // A window nobody arms from is just a constant. These are the two moments
  // the cron cannot see; if either call is removed, the case it covers goes
  // back to locking on the nightly with nothing to say so.
  const publish = readFileSync(
    fileURLToPath(new URL("../.github/workflows/publish-assignment.yml", import.meta.url)),
    "utf8",
  );
  assert.match(
    publish,
    /workflows\/deadline-sentinel\.yml\/dispatches/,
    "publishing must arm the sentinel, not merely enable it",
  );

  const admin = readFileSync(
    fileURLToPath(new URL("../frontend/src/views/AdminView.vue", import.meta.url)),
    "utf8",
  );
  assert.match(admin, /deadlineIsImminent/, "saving an edited deadline must arm it too");
  assert.match(admin, /deadline-sentinel\.yml/);
});
