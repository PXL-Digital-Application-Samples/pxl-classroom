// PXL Classroom - deadline-sentinel.test.mjs
//
// A repository ruleset has no time conditions, so stopping writes AT the
// deadline needs something running at that instant. These cover both halves:
// which deadlines get a sentinel (find-armable) and what the sentinel does while
// it waits (deadline-sentinel).
//
// The properties that matter are the ones that keep it from making anything
// worse than not having run at all: it stops nothing itself, it gives up rather
// than overrunning its job, and every path leaves the nightly finalize intact.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { planSentinels, sentinelKey } from "../scripts/find-armable.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const sentinelScript = join(here, "..", "scripts", "deadline-sentinel.mjs");
const armableScript = join(here, "..", "scripts", "find-armable.mjs");

const HOUR = 3600_000;
const NOW = Date.parse("2026-09-10T18:00:00Z");
const at = (hoursFromNow) => new Date(NOW + hoursFromNow * HOUR).toISOString();
const published = (deadline_at, state = "published") => ({ state, deadline_at });

// --- which deadlines get a sentinel ------------------------------------------

test("a deadline inside the window is armed; outside it is not", () => {
  const { armed } = planSentinels(
    [
      { id: "soon", doc: published(at(3)) },
      { id: "far", doc: published(at(9)) },
      { id: "past", doc: published(at(-1)) },
    ],
    { now: NOW, org: "TestOrg" },
  );
  assert.deepEqual(armed.map((a) => a.assignment_ids).flat(), ["soon"]);
});

test("a deadline already past is the nightly's job, not a sentinel's", () => {
  // Arming for an instant that has gone duplicates work that is no longer
  // time-critical, on a job that would hold a runner slot to do it.
  const { armed } = planSentinels([{ id: "over", doc: published(at(-0.01)) }], { now: NOW, org: "TestOrg" });
  assert.deepEqual(armed, []);
});

test("assignments sharing an instant share one sentinel", () => {
  const { armed } = planSentinels(
    [
      { id: "lab-a", doc: published(at(2)) },
      { id: "lab-b", doc: published(at(2)) },
      { id: "lab-c", doc: published(at(4)) },
    ],
    { now: NOW, org: "TestOrg" },
  );
  assert.equal(armed.length, 2, "two instants, two sentinels - not three");
  assert.deepEqual(armed[0].assignment_ids, ["lab-a", "lab-b"]);
  assert.deepEqual(armed[1].assignment_ids, ["lab-c"]);
});

test("only an assignment students could have accepted into is watched", () => {
  const { armed } = planSentinels(
    [
      { id: "draft", doc: published(at(2), "draft") },
      { id: "archived", doc: published(at(2), "archived") },
      { id: "closed", doc: published(at(2), "closed") },
    ],
    { now: NOW, org: "TestOrg" },
  );
  assert.deepEqual(armed.flatMap((a) => a.assignment_ids), ["closed"]);
});

test("a missing or unparseable deadline is skipped rather than guessed", () => {
  const { armed } = planSentinels(
    [
      { id: "none", doc: { state: "published" } },
      { id: "junk", doc: published("next tuesday") },
      { id: "nothing", doc: null },
    ],
    { now: NOW, org: "TestOrg" },
  );
  assert.deepEqual(armed, []);
});

test("the cap keeps the soonest deadlines and reports what it dropped", () => {
  // A sentinel holds a runner slot for hours and Team allows 60 concurrent
  // jobs. What is dropped falls through to the nightly - but it must not be
  // dropped silently.
  const assignments = [4, 1, 3, 2].map((h) => ({ id: `a${h}`, doc: published(at(h)) }));
  const { armed, dropped } = planSentinels(assignments, { now: NOW, org: "TestOrg", max: 2 });
  assert.deepEqual(armed.flatMap((a) => a.assignment_ids), ["a1", "a2"]);
  assert.deepEqual(dropped.flatMap((a) => a.assignment_ids), ["a3", "a4"]);
});

test("the key is safe in a concurrency group and unique per instant", () => {
  assert.equal(sentinelKey("2026-09-10T22:00:00Z"), "20260910T220000Z");
  assert.match(sentinelKey("2026-09-10T22:00:00.000Z"), /^[0-9A-Z]+$/);
  assert.notEqual(sentinelKey("2026-09-10T22:00:00Z"), sentinelKey("2026-09-10T22:30:00Z"));
});

test("find-armable prints the armed list and names what it dropped", () => {
  const dir = mkdtempSync(join(tmpdir(), "pxl-armable-"));
  mkdirSync(join(dir, "assignments"), { recursive: true });
  const soon = new Date(Date.now() + 2 * HOUR).toISOString();
  const alsoSoon = new Date(Date.now() + 3 * HOUR).toISOString();
  writeFileSync(join(dir, "assignments", "a.yml"), `state: published\ndeadline_at: "${soon}"\n`);
  writeFileSync(join(dir, "assignments", "b.yml"), `state: published\ndeadline_at: "${alsoSoon}"\n`);

  const res = spawnSync("node", [armableScript, dir, "TestOrg"], {
    encoding: "utf8",
    env: { ...process.env, MAX_SENTINELS: "1" },
  });
  const armed = JSON.parse(res.stdout.trim());
  assert.equal(armed.length, 1);
  assert.equal(armed[0].org, "TestOrg");
  assert.deepEqual(armed[0].assignment_ids, ["a"]);
  assert.match(res.stderr, /NOT arming/);
  assert.match(res.stderr, /cap of 1/);
});

// --- what the sentinel does while it waits -----------------------------------

/**
 * Stub GitHub API. `deadlineFor(id)` is re-read every poll, which is how a
 * lecturer moving the deadline mid-watch is simulated.
 */
async function withStubApi(fn, { deadlineFor, pushedAt = () => "2026-09-10T21:12:00Z" } = {}) {
  const calls = [];
  const server = createServer((req, res) => {
    const send = (code, body) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const [path] = req.url.split("?");
    calls.push(`${req.method} ${path}`);

    if (/^\/orgs\/[^/]+\/repos$/.test(path)) {
      return send(200, [
        { name: "exam-alice", pushed_at: pushedAt("exam-alice", calls.length) },
        { name: "unrelated-repo", pushed_at: "2020-01-01T00:00:00Z" },
      ]);
    }
    const asgn = path.match(/\/contents\/assignments\/([^/.]+)\.ya?ml$/);
    if (asgn) {
      const deadline = deadlineFor?.(asgn[1], calls.length);
      if (!deadline) return send(404, { message: "Not Found" });
      const yaml = `state: published\ndeadline_at: "${deadline}"\n`;
      return send(200, { encoding: "base64", content: Buffer.from(yaml).toString("base64") });
    }
    return send(404, { message: "not stubbed: " + path });
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`, calls);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

function makeControlDir(logins = ["alice"]) {
  const dir = mkdtempSync(join(tmpdir(), "pxl-sentinel-"));
  mkdirSync(join(dir, "repositories", "exam"), { recursive: true });
  for (const login of logins) {
    writeFileSync(
      join(dir, "repositories", "exam", `${login}.json`),
      JSON.stringify({ github_login: login, repo_name: `TestOrg/exam-${login}`, repo_id: 42 }),
    );
  }
  return dir;
}

function runSentinel(dir, apiBase, { deadlineAt, pollMs = 40, maxRuntimeMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [sentinelScript], {
      env: {
        ...process.env,
        GITHUB_TOKEN: "stub-token",
        GITHUB_API_URL: apiBase,
        ORG: "TestOrg",
        DATA_DIR: dir,
        ASSIGNMENT_IDS: "exam",
        DEADLINE_AT: deadlineAt,
        SENTINEL_KEY: "TESTKEY",
        POLL_INTERVAL_MS: String(pollMs),
        SENTINEL_MAX_RUNTIME_MS: String(maxRuntimeMs),
        GITHUB_OUTPUT: join(dir, "out.env"),
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (status) => {
      const timelinePath = join(dir, "lockdowns", "exam", "sentinel-TESTKEY.json");
      const outPath = join(dir, "out.env");
      resolve({
        status, stdout, stderr,
        timeline: existsSync(timelinePath) ? JSON.parse(readFileSync(timelinePath, "utf8")) : null,
        outputs: existsSync(outPath) ? readFileSync(outPath, "utf8") : "",
      });
    });
  });
}

test("it waits for the instant, then reports that it fired", async () => {
  const deadline = new Date(Date.now() + 250).toISOString();
  await withStubApi(
    async (api) => {
      const res = await runSentinel(makeControlDir(), api, { deadlineAt: deadline });
      assert.equal(res.status, 0, res.stderr);
      assert.match(res.outputs, /outcome=fired/);
      assert.match(res.outputs, /fired=true/);
      assert.ok(res.timeline.polls >= 1, "it polled while it waited");
    },
    { deadlineFor: () => deadline },
  );
});

test("it stops nothing itself - the lock has exactly one implementation", async () => {
  // Everything that stops a write goes through lockdown's Phase 1. A sentinel
  // that flipped rulesets on its own would be a second copy of that rule.
  const deadline = new Date(Date.now() + 200).toISOString();
  await withStubApi(
    async (api, calls) => {
      await runSentinel(makeControlDir(), api, { deadlineAt: deadline });
      assert.deepEqual(
        calls.filter((c) => /rulesets|collaborators/.test(c)),
        [],
        `the sentinel must not lock anything: ${calls.join(", ")}`,
      );
      assert.deepEqual(calls.filter((c) => !c.startsWith("GET ")), [], "and must write nothing at all");
    },
    { deadlineFor: () => deadline },
  );
});

test("the push timeline is GitHub's own timestamps, for the watched repos only", async () => {
  // pushed_at is server-side: a student can set a commit date, not this. It is
  // the only thing that can answer "at 21:55 your last push was 21:12".
  const deadline = new Date(Date.now() + 250).toISOString();
  await withStubApi(
    async (api) => {
      const res = await runSentinel(makeControlDir(), api, { deadlineAt: deadline });
      const sample = res.timeline.samples[0];
      assert.ok(sample, "a sample was recorded");
      assert.equal(sample.pushed_at["exam-alice"], "2026-09-10T21:12:00Z");
      assert.ok(!("unrelated-repo" in sample.pushed_at), "other org repos are not this cohort's business");
      assert.ok(sample.observed_at, "when we looked is part of the evidence");
    },
    { deadlineFor: () => deadline },
  );
});

test("a deadline moved later while it waits is followed", async () => {
  const original = new Date(Date.now() + 150).toISOString();
  const moved = new Date(Date.now() + 600).toISOString();
  await withStubApi(
    async (api) => {
      const res = await runSentinel(makeControlDir(), api, { deadlineAt: original });
      assert.equal(res.status, 0, res.stderr);
      assert.equal(res.timeline.deadline_at, new Date(moved).toISOString());
      assert.equal(res.timeline.armed_for, original);
      assert.match(res.stdout, /deadline moved/);
      assert.match(res.outputs, /fired=true/);
    },
    { deadlineFor: () => moved },
  );
});

test("a deadline moved beyond reach gives up cleanly instead of holding the runner", async () => {
  const original = new Date(Date.now() + 150).toISOString();
  const wayOut = new Date(Date.now() + 10 * HOUR).toISOString();
  await withStubApi(
    async (api) => {
      const res = await runSentinel(makeControlDir(), api, { deadlineAt: original, maxRuntimeMs: 5_000 });
      assert.equal(res.status, 0, res.stderr);
      assert.match(res.outputs, /outcome=gave-up:moved/);
      assert.match(res.outputs, /fired=false/, "it must not trigger a stop it never waited for");
      assert.match(res.stdout, /a later cron firing will re-arm/);
    },
    { deadlineFor: () => wayOut },
  );
});

test("running out of runway gives up rather than being killed holding the evidence", async () => {
  const deadline = new Date(Date.now() + 10 * HOUR).toISOString();
  await withStubApi(
    async (api) => {
      const res = await runSentinel(makeControlDir(), api, { deadlineAt: deadline, maxRuntimeMs: 120 });
      assert.equal(res.status, 0, res.stderr);
      assert.match(res.outputs, /outcome=gave-up:runtime/);
      assert.match(res.outputs, /fired=false/);
      assert.ok(res.timeline, "the timeline it did gather is still written");
      assert.match(res.stdout, /the nightly finalize will handle it/);
    },
    { deadlineFor: () => deadline },
  );
});

test("an unreadable assignment keeps the armed target rather than guessing", async () => {
  const deadline = new Date(Date.now() + 200).toISOString();
  await withStubApi(
    async (api) => {
      const res = await runSentinel(makeControlDir(), api, { deadlineAt: deadline });
      assert.equal(res.status, 0, res.stderr);
      assert.equal(res.timeline.deadline_at, new Date(deadline).toISOString());
      assert.match(res.outputs, /fired=true/);
    },
    { deadlineFor: () => null }, // every contents read 404s
  );
});

test("it writes one timeline per watched assignment", async () => {
  const deadline = new Date(Date.now() + 150).toISOString();
  const dir = makeControlDir();
  mkdirSync(join(dir, "repositories", "lab-b"), { recursive: true });
  writeFileSync(
    join(dir, "repositories", "lab-b", "alice.json"),
    JSON.stringify({ github_login: "alice", repo_name: "TestOrg/lab-b-alice" }),
  );
  await withStubApi(
    async (api) => {
      await new Promise((resolve, reject) => {
        const child = spawn("node", [sentinelScript], {
          env: {
            ...process.env,
            GITHUB_TOKEN: "t", GITHUB_API_URL: api, ORG: "TestOrg", DATA_DIR: dir,
            ASSIGNMENT_IDS: "exam,lab-b", DEADLINE_AT: deadline, SENTINEL_KEY: "K",
            POLL_INTERVAL_MS: "40", GITHUB_OUTPUT: join(dir, "out.env"),
          },
        });
        child.on("error", reject);
        child.on("close", resolve);
      });
      for (const id of ["exam", "lab-b"]) {
        assert.ok(
          readdirSync(join(dir, "lockdowns", id)).includes("sentinel-K.json"),
          `${id} has its own timeline`,
        );
      }
    },
    { deadlineFor: () => deadline },
  );
});

test("bad input fails before it holds a runner for hours", async () => {
  await withStubApi(
    async (api) => {
      const dir = makeControlDir();
      const res = await runSentinel(dir, api, { deadlineAt: "not a date" });
      assert.equal(res.status, 1);
      assert.match(res.outputs, /outcome=fail:validation/);
    },
    { deadlineFor: () => null },
  );
});

// --- how many runner slots one firing can hold ------------------------------
//
// MAX_SENTINELS reads like a global cap and is not one: this script runs once
// per ORG (the `arm` job is a matrix over orgs), and `aggregate-armable` then
// flattens every org's list into a single `watch` matrix. With 22
// participating orgs the ceiling was 22 x 8 = 176 concurrent jobs, on a Team
// plan that allows 60 - from a cap whose own comment cited that limit.
//
// A sentinel holds its slot for up to 4h45m, so saturating the budget would
// starve daily-activity: the nightly this workflow is designed to degrade TO.
// Failing over into the thing you broke is not a fallback.

test("planSentinels caps PER ORG, which is why it cannot be the global bound", () => {
  const many = Array.from({ length: 5 }, (_, i) => ({
    id: `a${i}`,
    doc: published(at(1 + i * 0.5)),
  }));

  // Two orgs, each capped at 3, is six sentinels - not three.
  const a = planSentinels(many, { now: NOW, org: "OrgA", max: 3 });
  const b = planSentinels(many, { now: NOW, org: "OrgB", max: 3 });
  assert.equal(a.armed.length, 3);
  assert.equal(b.armed.length, 3);
  assert.equal(
    a.armed.length + b.armed.length,
    6,
    "the workflow flattens both lists into one matrix, so the totals add up",
  );
});

test("the watch matrix carries the global bound the per-org cap cannot", async () => {
  const { parse } = await import("yaml");
  const wf = parse(readFileSync(join(here, "..", ".github", "workflows", "deadline-sentinel.yml"), "utf8"));
  const watch = wf.jobs?.watch;

  assert.ok(watch, "the watch job must exist");
  const cap = watch.strategy?.["max-parallel"];
  assert.ok(
    Number.isInteger(cap) && cap > 0,
    "watch must cap max-parallel - it is the only thing bounding how many " +
      "sentinels hold runner slots at once across every org",
  );
  assert.ok(
    cap <= 20,
    `max-parallel of ${cap} is not a bound worth having against a 60-job plan ` +
      "that also has to run daily-activity, publishes and deploys",
  );
  // Capping concurrency, not the list: nothing may be silently discarded, and
  // a sentinel that starts late still stops writes.
  assert.equal(
    watch.strategy?.["fail-fast"],
    false,
    "one org's sentinel failing must not cancel every other org's",
  );
});
