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
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { planSentinels, sentinelKey } from "../scripts/find-armable.mjs";
import {
  assignmentsAtInstant, dueAssignments, handoverState, memberDeadlines, positiveNumber, resumeFrom,
  timelineFileName,
} from "../scripts/deadline-sentinel.mjs";

// A SET-BUT-EMPTY environment variable is the ordinary shape of an unset
// workflow input threaded through `env:`, and `env()` is `?? default` - so
// `Number(env("POLL_INTERVAL_MS", 300000))` returned 0, not the default. Zero
// means a tight loop against the GitHub API from a job that runs for hours, a
// runtime that exits before watching anything, and a page cap that samples
// nothing while reporting a clean read. lib/group-config.mjs reasons about the
// identical case for `max_team_size` and reaches the identical conclusion.
test("an empty or unusable sentinel setting falls back to its default", () => {
  const D = 300_000;
  for (const raw of ["", "  ", undefined, null, "abc", "0", "-5", "NaN"]) {
    assert.equal(positiveNumber(raw, D), D, `positiveNumber(${JSON.stringify(raw)}) must be the default`);
  }
  // A real value still wins, whitespace and all.
  assert.equal(positiveNumber("60", D), 60);
  assert.equal(positiveNumber(" 90 ", D), 90);
});

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
 * Stub GitHub API: the org's repository listing for `pushed_at`, and the control
 * repo as the sentinel re-reads it while it waits - the `assignments/` and
 * `repositories/<id>/` listings plus the blobs they name.
 *
 * Everything is a function of the call count, so a test can publish an
 * assignment, move a deadline or provision a student's repository *while the
 * sentinel is waiting*, which is the whole subject of this file.
 *
 *   `ids`            which assignments the control repo holds
 *   `deadlineFor`    that assignment's `deadline_at`, or null to leave it out
 *   `stateFor`       its `state`, default `published`
 *   `reposFor`       `repositories/<id>/`: logins with a provisioned repository
 *   `listStatus`     an HTTP status for the `assignments/` listing, to make the
 *                    read fail rather than come back empty
 */
async function withStubApi(fn, {
  deadlineFor,
  ids = ["exam"],
  stateFor = () => "published",
  reposFor = (id) => (id === "exam" ? ["alice"] : []),
  listStatus = () => null,
  pushedAt = () => "2026-09-10T21:12:00Z",
  repos,
} = {}) {
  const calls = [];
  const blobs = new Map();
  const blobFor = (text) => {
    const sha = createHash("sha1").update(text).digest("hex");
    blobs.set(sha, text);
    return sha;
  };

  const server = createServer((req, res) => {
    const send = (code, body) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const [path] = req.url.split("?");
    calls.push(`${req.method} ${path}`);

    if (/^\/orgs\/[^/]+\/repos$/.test(path)) {
      if (repos) return send(200, repos(Number(new URL(req.url, "http://x").searchParams.get("page") || 1)));
      return send(200, [
        { name: "exam-alice", pushed_at: pushedAt("exam-alice", calls.length) },
        { name: "unrelated-repo", pushed_at: "2020-01-01T00:00:00Z" },
      ]);
    }

    if (/\/contents\/assignments$/.test(path)) {
      const status = listStatus(calls.length);
      if (status) return send(status, { message: "listing refused" });
      const files = [];
      for (const id of ids) {
        const deadline = deadlineFor?.(id, calls.length);
        if (!deadline) continue;
        const yaml = `state: ${stateFor(id, calls.length)}\ndeadline_at: "${deadline}"\n`;
        files.push({ type: "file", name: `${id}.yml`, sha: blobFor(yaml) });
      }
      return send(200, files);
    }

    const repoDir = path.match(/\/contents\/repositories\/([^/]+)$/);
    if (repoDir) {
      const logins = reposFor(repoDir[1], calls.length);
      if (!logins.length) return send(404, { message: "Not Found" });
      return send(200, logins.map((login) => ({
        type: "file",
        name: `${login}.json`,
        sha: blobFor(JSON.stringify({ github_login: login, repo_name: `TestOrg/${repoDir[1]}-${login}` })),
      })));
    }

    const blob = path.match(/\/git\/blobs\/([0-9a-f]+)$/);
    if (blob) {
      const text = blobs.get(blob[1]);
      if (text === undefined) return send(404, { message: "Not Found" });
      return send(200, { encoding: "base64", content: Buffer.from(text).toString("base64") });
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

function runSentinel(dir, apiBase, {
  deadlineAt, pollMs = 40, maxRuntimeMs = 60_000, assignmentIds = "exam", maxPages,
  phaseMs, stateFile, armedAt,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [sentinelScript], {
      env: {
        ...process.env,
        GITHUB_TOKEN: "stub-token",
        GITHUB_API_URL: apiBase,
        ORG: "TestOrg",
        DATA_DIR: dir,
        ASSIGNMENT_IDS: assignmentIds,
        DEADLINE_AT: deadlineAt,
        SENTINEL_KEY: "TESTKEY",
        POLL_INTERVAL_MS: String(pollMs),
        SENTINEL_MAX_RUNTIME_MS: String(maxRuntimeMs),
        ...(maxPages ? { SENTINEL_MAX_PAGES: String(maxPages) } : {}),
        ...(phaseMs ? { SENTINEL_PHASE_MS: String(phaseMs) } : {}),
        ...(stateFile ? { SENTINEL_STATE_FILE: stateFile } : {}),
        ...(armedAt ? { SENTINEL_ARMED_AT: armedAt } : {}),
        // Pinned rather than inherited: CI sets these, and the timeline's file
        // name falls back to them when one is already there.
        GITHUB_RUN_ID: "999",
        GITHUB_RUN_ATTEMPT: "1",
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
    { deadlineFor: () => null }, // the assignment is in no listing
  );
});

test("a listing that fails keeps the deadlines it last read, not the armed instant", async () => {
  // The group is read in one listing now, so a single failed read used to take
  // every member's deadline with it - and an assignment positively read as
  // extended minutes ago would have become due against the armed instant and
  // been locked early. That is the failure this whole file exists to prevent.
  const original = new Date(Date.now() + 700).toISOString();
  const extended = new Date(Date.now() + 8 * HOUR).toISOString();
  const dir = makeControlDir();

  await withStubApi(
    async (api) => {
      const res = await runSentinel(dir, api, { deadlineAt: original, assignmentIds: "exam,exam-two", pollMs: 120 });
      assert.equal(res.status, 0, res.stderr);
      assert.match(res.outputs, /fired=true/);
      assert.match(
        res.outputs,
        /due_assignment_ids=exam\n/,
        `exam-two was read as extended before the listing failed:\n${res.outputs}`,
      );
      assert.match(res.stdout, /unreadable \(HTTP 403\)/);
    },
    {
      ids: ["exam", "exam-two"],
      deadlineFor: (id) => (id === "exam-two" ? extended : original),
      // Answers the first listing, then refuses: the deadlines are read once and
      // the sentinel waits out the rest of its target with nothing readable.
      listStatus: (n) => (n > 3 ? 403 : null),
    },
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
    { ids: ["exam", "lab-b"], deadlineFor: () => deadline },
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

// --- a group is not one assignment -------------------------------------------
//
// find-armable groups every assignment sharing an exact deadline instant into
// ONE sentinel. That is efficient and it made "the deadline moved" ambiguous:
// currentTargets() reports the earliest, so extending ONE assignment does not
// move it, the sentinel still fires, and the stop step used to lock the whole
// group - demoting the extended cohort to `pull` before its own deadline.
//
// lockdown.mjs will not catch that. Its comment is explicit: "Gated on
// `extended`, not on the deadline alone: a lecturer running a lockdown early
// still locks the cohort." It trusts its caller, so the caller has to be right.

test("dueAssignments skips only an assignment read as still in the future", () => {
  const now = Date.parse("2026-09-10T22:00:00Z");
  const byId = new Map([
    ["past", new Date(now - 1000)],
    ["exactly-now", new Date(now)],
    ["moved-later", new Date(now + 3600_000)],
  ]);
  assert.deepEqual(
    dueAssignments(["past", "exactly-now", "moved-later", "unreadable"], byId, now),
    // `unreadable` is due: the armed instant is the best evidence we have and it
    // has arrived. Only a deadline we positively READ as later is skipped.
    ["past", "exactly-now", "unreadable"],
  );
});

test("extending one assignment of a shared-instant group does not lock the others early", async () => {
  const original = new Date(Date.now() + 200).toISOString();
  const extended = new Date(Date.now() + 8 * HOUR).toISOString();
  const dir = makeControlDir();

  await withStubApi(
    async (api) => {
      const res = await runSentinel(dir, api, { deadlineAt: original, assignmentIds: "exam,exam-two" });
      assert.equal(res.status, 0, res.stderr);
      // It still fires: `exam` really is due, and the group's earliest has not
      // moved. That is the whole trap.
      assert.match(res.outputs, /fired=true/);
      assert.match(
        res.outputs,
        /due_assignment_ids=exam\n/,
        `only exam is due; exam-two was extended:\n${res.outputs}`,
      );

      const two = JSON.parse(readFileSync(join(dir, "lockdowns", "exam-two", "sentinel-TESTKEY.json"), "utf8"));
      assert.equal(two.due, false, "exam-two must be recorded as not stopped");
      // Its OWN deadline, not the group's instant - a record claiming a freeze
      // at a time that was never this assignment's deadline is a false record.
      assert.equal(two.deadline_at, new Date(extended).toISOString());

      const one = JSON.parse(readFileSync(join(dir, "lockdowns", "exam", "sentinel-TESTKEY.json"), "utf8"));
      assert.equal(one.due, true, "exam is due and must still be stopped");
    },
    { ids: ["exam", "exam-two"], deadlineFor: (id) => (id === "exam-two" ? extended : original) },
  );
});

test("a sample that ran out of pages is recorded as partial, not as a clean read", async () => {
  // The timeline is EVIDENCE - it settles "I pushed before the deadline". A
  // watched repository missing because the walk hit its page cap was
  // indistinguishable from one that was never pushed, and the sample said ok.
  // The sort is over ALL the org's repositories, so several cohorts pushing
  // near a shared deadline can carry a watched repo past the cap.
  const deadline = new Date(Date.now() + 250).toISOString();
  const fullPage = (page) =>
    Array.from({ length: 100 }, (_, i) => ({ name: `other-${page}-${i}`, pushed_at: "2026-09-10T21:59:00Z" }));

  await withStubApi(
    async (api) => {
      const res = await runSentinel(makeControlDir(), api, { deadlineAt: deadline, maxPages: 2 });
      assert.equal(res.status, 0, res.stderr);
      const sample = res.timeline.samples[0];
      assert.ok(sample.error, `a capped walk must record why it is incomplete: ${JSON.stringify(sample)}`);
      assert.match(sample.error, /capped at 2 page\(s\)/);
      assert.match(sample.error, /0 of 1 watched/);
    },
    { deadlineFor: () => deadline, repos: fullPage },
  );
});

test("a complete walk is still reported as clean", async () => {
  // The other half: the guard above must not mark an ordinary read partial.
  const deadline = new Date(Date.now() + 250).toISOString();
  await withStubApi(
    async (api) => {
      const res = await runSentinel(makeControlDir(), api, { deadlineAt: deadline });
      const sample = res.timeline.samples[0];
      assert.equal(sample.error, undefined, `an ordinary read carries no error: ${JSON.stringify(sample)}`);
      assert.equal(sample.pushed_at["exam-alice"], "2026-09-10T21:12:00Z");
    },
    { deadlineFor: () => deadline },
  );
});

// --- the armed list is where a sentinel starts, not what it stops -------------
//
// `assignment_ids` is fixed when the job is queued. A second group published
// with the same deadline arms another job in the same concurrency group, and
// that job can only WAIT behind the running one - past the instant, which is
// the one moment the sentinel exists for. Worse, GitHub keeps one pending job
// per group and the newest arrival cancels the one before it, so the list that
// survives in the queue is not even the freshest.
//
// Measured on pxl-classroom-testbed 2026-09-17: drill-20260917-1614 was
// published 5 minutes after a sentinel had been armed for 16:35:00 with
// drill-20260917-1609 alone. Both arms that named it were cancelled in the
// pending slot by a cron firing that had read the control repo BEFORE it
// existed, and it was locked by the finalize 143 seconds late, with no timeline
// at all.

test("assignmentsAtInstant is the arming rule, asked of what the org holds now", () => {
  const instant = "2026-09-10T22:00:00.000Z";
  const assignments = [
    { id: "exam", doc: published(instant) },
    { id: "exam-two", doc: published("2026-09-10T22:00:00Z") },          // same instant, written differently
    { id: "closed-one", doc: published(instant, "closed") },             // still has repositories to lock
    { id: "draft-one", doc: published(instant, "draft") },               // nobody could have accepted
    { id: "archived-one", doc: published(instant, "archived") },
    { id: "other-hour", doc: published("2026-09-10T23:00:00Z") },
    { id: "junk", doc: published("next tuesday") },
    { id: "no-deadline", doc: { state: "published" } },
    { id: "../escape", doc: published(instant) },                        // not a slug: it would reach a shell loop
  ];
  assert.deepEqual(assignmentsAtInstant(assignments, instant), ["closed-one", "exam", "exam-two"]);
});

test("what a sentinel stops is what arming would have given it", () => {
  // Two spellings of "which assignments share this instant" is how a running
  // watch and the arm queued behind it come to disagree about who is due, so
  // this derives one from the other rather than listing the answer twice.
  const assignments = [
    { id: "a", doc: published(at(1)) },
    { id: "b", doc: published(at(1)) },
    { id: "c", doc: published(at(2), "closed") },
    { id: "d", doc: published(at(2), "draft") },
    { id: "e", doc: published(at(3)) },
  ];
  const { armed } = planSentinels(assignments, { now: NOW, org: "TestOrg" });
  assert.ok(armed.length >= 2);
  for (const sentinel of armed) {
    assert.deepEqual(
      assignmentsAtInstant(assignments, sentinel.deadline_at),
      [...sentinel.assignment_ids].sort(),
      `the sentinel armed for ${sentinel.deadline_at} must stop exactly what arming grouped into it`,
    );
  }
});

test("memberDeadlines answers per member, and omits what it cannot read", () => {
  const assignments = [
    { id: "exam", doc: published("2026-09-10T22:00:00Z") },
    { id: "extended", doc: published("2026-09-11T09:00:00Z") },
    { id: "junk", doc: published("next tuesday") },
  ];
  const { byId, earliest } = memberDeadlines(["exam", "extended", "junk", "deleted"], assignments);
  assert.equal(byId.get("exam").toISOString(), "2026-09-10T22:00:00.000Z");
  assert.equal(byId.get("extended").toISOString(), "2026-09-11T09:00:00.000Z");
  assert.ok(!byId.has("junk") && !byId.has("deleted"), "unreadable is not a deadline - dueAssignments calls those due");
  assert.equal(earliest.toISOString(), "2026-09-10T22:00:00.000Z", "the group wakes at the soonest of its members");
});

test("an assignment published after the sentinel was armed is stopped at the instant", async () => {
  const startedAt = Date.now();
  const deadline = new Date(startedAt + 900).toISOString();
  // Published while the sentinel waits, sharing its instant. Nothing dispatched
  // to this run; the only job that can act at the instant is this one.
  const joined = (_id, _n) => Date.now() - startedAt > 300;
  const dir = makeControlDir();

  await withStubApi(
    async (api) => {
      const res = await runSentinel(dir, api, { deadlineAt: deadline, pollMs: 150 });
      assert.equal(res.status, 0, res.stderr);
      assert.match(res.stdout, /late-exam shares this instant/);
      assert.match(
        res.outputs,
        /due_assignment_ids=exam,late-exam\n/,
        `the assignment that joined must be stopped with the rest:\n${res.outputs}`,
      );

      const timeline = JSON.parse(readFileSync(join(dir, "lockdowns", "late-exam", "sentinel-TESTKEY.json"), "utf8"));
      assert.equal(timeline.due, true);
      assert.equal(timeline.armed_for, deadline, "the instant it was stopped at is still the armed one");
      assert.ok(timeline.joined_at, "a timeline says when its assignment joined, or it was armed with the sentinel");
      assert.ok(
        timeline.samples.every((s) => s.observed_at >= timeline.joined_at),
        "samples taken before it joined would read as 'nothing was pushed' for a cohort nobody was watching",
      );
      assert.ok(
        timeline.samples.some((s) => s["pushed_at"]["late-exam-bob"]),
        `its repositories are watched from the moment it joins: ${JSON.stringify(timeline.samples)}`,
      );
      const armedOne = JSON.parse(readFileSync(join(dir, "lockdowns", "exam", "sentinel-TESTKEY.json"), "utf8"));
      assert.equal(armedOne.joined_at, undefined, "the assignment it was armed with did not join anything");
    },
    {
      ids: ["exam", "late-exam"],
      deadlineFor: (id, n) => (id === "exam" || joined(id, n) ? deadline : null),
      reposFor: (id, n) => (id === "exam" ? ["alice"] : joined(id, n) ? ["bob"] : []),
      repos: () => [
        { name: "exam-alice", pushed_at: "2026-09-10T21:12:00Z" },
        { name: "late-exam-bob", pushed_at: "2026-09-10T21:40:00Z" },
      ],
    },
  );
});

test("a repository provisioned while the sentinel waits is watched from then on", async () => {
  // A sentinel armed at publish is running before anyone has accepted. Reading
  // the records once, at job start, is how drill-20260917-1609 polled six times
  // and recorded no push at all for the cohort it was watching.
  const startedAt = Date.now();
  const deadline = new Date(startedAt + 700).toISOString();
  const dir = mkdtempSync(join(tmpdir(), "pxl-sentinel-"));

  await withStubApi(
    async (api) => {
      const res = await runSentinel(dir, api, { deadlineAt: deadline, pollMs: 120 });
      assert.equal(res.status, 0, res.stderr);
      assert.ok(res.timeline, "a timeline is written even though the checkout knew no repositories");
      assert.ok(
        res.timeline.samples.some((s) => s["pushed_at"]["exam-alice"] === "2026-09-10T21:12:00Z"),
        `the repository that appeared mid-watch is in the timeline: ${JSON.stringify(res.timeline.samples)}`,
      );
    },
    {
      deadlineFor: () => deadline,
      // Nothing in `repositories/exam/` until the student accepts, 300ms in.
      reposFor: () => (Date.now() - startedAt > 300 ? ["alice"] : []),
    },
  );
});

test("a second sentinel for the same instant does not overwrite the first's timeline", () => {
  // The duplicate reaches the instant after it has passed and writes a
  // single-poll record. On 2026-09-17 that replaced the six-poll timeline of the
  // sentinel that actually stopped the cohort, at the same path.
  const key = "20260917T163500Z";
  const run = { runId: "35245195238", runAttempt: "1" };
  assert.equal(timelineFileName(key, [], run), `sentinel-${key}.json`);
  assert.equal(timelineFileName(key, ["lockdown-record.json"], run), `sentinel-${key}.json`);
  assert.equal(
    timelineFileName(key, [`sentinel-${key}.json`], run),
    `sentinel-${key}-35245195238-1.json`,
    "the run that fired keeps its record; lockdown.mjs reads every sentinel-*.json",
  );
  assert.match(timelineFileName(key, [`sentinel-${key}.json`], run), /^sentinel-.*\.json$/, "lockdown.mjs's own glob");
});

// --- a watch outlives its credential -----------------------------------------
//
// An App installation token lives for at most an hour; the watch waits for up
// to 4h45m. Every watch armed more than an hour out therefore polled 401 until
// the instant and then failed at `git pull`, which skips Stop writes: three
// real deadlines on PXL-Automation-II (runs 35220220960, 35181092340,
// 35120380004) went red having stopped nothing. So a watch runs in phases, and
// what one phase saw has to survive into the next, or the push record starts
// again from a cohort the new token has never looked at.

test("a phase that runs out of token hands over instead of firing", async () => {
  const deadline = new Date(Date.now() + 10 * HOUR).toISOString();
  const dir = makeControlDir();
  const state = join(dir, "handover.json");

  await withStubApi(
    async (api) => {
      const res = await runSentinel(dir, api, { deadlineAt: deadline, phaseMs: 250, stateFile: state, pollMs: 60 });
      assert.equal(res.status, 0, res.stderr);
      assert.match(res.outputs, /outcome=handover/);
      assert.match(res.outputs, /fired=false/, "it never reached the instant, so it must stop nothing");
      assert.match(res.outputs, /due_assignment_ids=\n/, "and name nothing as due");
      assert.equal(res.timeline, null, "no timeline: one watch writes one document, at the instant");

      const handed = JSON.parse(readFileSync(state, "utf8"));
      assert.ok(handed.samples.length >= 1, `the evidence it took is handed on: ${JSON.stringify(handed)}`);
      assert.deepEqual(handed.members, [{ id: "exam" }]);
      assert.ok(handed.polls >= 1);
    },
    { deadlineFor: () => deadline },
  );
});

test("the next phase continues the same watch, with the earlier evidence in it", async () => {
  const startedAt = Date.now();
  const deadline = new Date(startedAt + 1200).toISOString();
  const dir = makeControlDir();
  const state = join(dir, "handover.json");
  const joined = () => Date.now() - startedAt > 150;

  await withStubApi(
    async (api) => {
      // Phase one: out of token long before the instant.
      const first = await runSentinel(dir, api, { deadlineAt: deadline, phaseMs: 250, stateFile: state, pollMs: 60 });
      assert.match(first.outputs, /outcome=handover/);
      const handed = JSON.parse(readFileSync(state, "utf8"));
      assert.ok(
        handed.members.some((m) => m.id === "late-exam" && m.joined_at),
        `an assignment found in one phase is still a member in the next: ${JSON.stringify(handed.members)}`,
      );

      // Phase two, on a fresh token, reaching the instant.
      const second = await runSentinel(dir, api, { deadlineAt: deadline, stateFile: state, pollMs: 60 });
      assert.equal(second.status, 0, second.stderr);
      assert.match(second.outputs, /fired=true/);
      assert.match(second.outputs, /due_assignment_ids=exam,late-exam\n/, second.outputs);
      assert.match(second.stdout, /resuming a handover/);

      const timeline = second.timeline;
      assert.ok(
        timeline.samples.length > handed.samples.length,
        `the one timeline spans both phases: ${handed.samples.length} handed over, ${timeline.samples.length} written`,
      );
      assert.equal(
        timeline.samples[0].observed_at,
        handed.samples[0].observed_at,
        "and it starts where the first phase started, not where the new token did",
      );
      assert.ok(timeline.polls > handed.polls, "the poll count continues rather than restarting");
    },
    {
      ids: ["exam", "late-exam"],
      // Both share the instant; `late-exam` is published mid-watch.
      deadlineFor: (id) => (id === "exam" || joined() ? deadline : null),
      reposFor: (id) => (id === "exam" ? ["alice"] : []),
    },
  );
});

test("a later phase groups by the instant it was ARMED for, not the one it waits for", async () => {
  // The two come apart exactly when a lecturer moves a deadline while an
  // earlier phase watches: the group is the concurrency key every other arm for
  // that instant queues behind, and it does not move with one assignment.
  const armed = new Date(Date.now() + 9 * HOUR).toISOString();
  const waitingFor = new Date(Date.now() + 300).toISOString();
  const dir = makeControlDir();

  await withStubApi(
    async (api) => {
      const res = await runSentinel(dir, api, { deadlineAt: waitingFor, armedAt: armed, maxRuntimeMs: 60_000 });
      assert.equal(res.status, 0, res.stderr);
      assert.match(res.outputs, /fired=true/);
      assert.match(
        res.outputs,
        /due_assignment_ids=exam\n/,
        `only the assignment whose own deadline has arrived is stopped:\n${res.outputs}`,
      );
      const other = JSON.parse(readFileSync(join(dir, "lockdowns", "still-at-armed", "sentinel-TESTKEY.json"), "utf8"));
      assert.ok(other.joined_at, "the assignment still sitting on the armed instant is watched by this sentinel");
      assert.equal(other.due, false, "but it is not due yet, so it is not stopped");
      assert.equal(res.timeline.armed_for, armed, "the record names the instant the group is keyed on");
    },
    {
      ids: ["exam", "still-at-armed"],
      deadlineFor: (id) => (id === "exam" ? waitingFor : armed),
    },
  );
});

test("a phase budget with nowhere to hand over is refused before it holds a runner", async () => {
  // It would poll for 45 minutes and then throw away every sample it took and
  // every assignment it found, silently.
  const deadline = new Date(Date.now() + HOUR).toISOString();
  await withStubApi(
    async (api) => {
      const res = await runSentinel(makeControlDir(), api, { deadlineAt: deadline, phaseMs: 250 });
      assert.equal(res.status, 1);
      assert.match(res.outputs, /outcome=fail:validation/);
      assert.match(res.stderr, /SENTINEL_STATE_FILE/);
    },
    { deadlineFor: () => deadline },
  );
});

test("resumeFrom keeps the armed list as the start of the group", () => {
  const { members, joinedAt, samples, polls } = resumeFrom(
    {
      polls: 7,
      members: [{ id: "exam" }, { id: "joined-one", joined_at: "2026-09-10T20:05:00.000Z" }, { id: "../escape" }],
      samples: [{ observed_at: "2026-09-10T20:00:00.000Z", pushed_at: {} }],
    },
    ["exam", "armed-two"],
  );
  assert.deepEqual(members, ["exam", "armed-two", "joined-one"], "armed first, then what an earlier phase found");
  assert.equal(joinedAt.get("joined-one"), "2026-09-10T20:05:00.000Z");
  assert.equal(samples.length, 1);
  assert.equal(polls, 7);

  // A file that is missing or damaged costs the earlier evidence and nothing
  // else: the watch still knows what it was armed with.
  for (const bad of [null, undefined, {}, { members: "not a list", samples: 3, polls: -1 }]) {
    const fallback = resumeFrom(bad, ["exam"]);
    assert.deepEqual(fallback.members, ["exam"]);
    assert.deepEqual(fallback.samples, []);
    assert.equal(fallback.polls, 0);
  }
});

test("handoverState carries what the next phase cannot read for itself", () => {
  const state = handoverState({
    polls: 3,
    members: ["exam", "joined-one"],
    joinedAt: new Map([["joined-one", "2026-09-10T20:05:00.000Z"]]),
    samples: [{ observed_at: "2026-09-10T20:00:00.000Z", pushed_at: { "exam-alice": "2026-09-10T19:12:00Z" } }],
  });
  // Round-tripped through JSON, because that is how it travels.
  const back = resumeFrom(JSON.parse(JSON.stringify(state)), ["exam"]);
  assert.deepEqual(back.members, ["exam", "joined-one"]);
  assert.equal(back.joinedAt.get("joined-one"), "2026-09-10T20:05:00.000Z");
  assert.equal(back.samples[0].pushed_at["exam-alice"], "2026-09-10T19:12:00Z");
  assert.equal(back.polls, 3);
});

test("the duplicate writes its own timeline beside the one already there", async () => {
  const deadline = new Date(Date.now() + 250).toISOString();
  const dir = makeControlDir();
  mkdirSync(join(dir, "lockdowns", "exam"), { recursive: true });
  const first = join(dir, "lockdowns", "exam", "sentinel-TESTKEY.json");
  writeFileSync(first, JSON.stringify({ outcome: "fired", polls: 6, observer_run: "the one that stopped them" }));

  await withStubApi(
    async (api) => {
      const res = await runSentinel(dir, api, { deadlineAt: deadline });
      assert.equal(res.status, 0, res.stderr);
      assert.equal(
        JSON.parse(readFileSync(first, "utf8")).observer_run,
        "the one that stopped them",
        "the timeline of the sentinel that fired at the instant survives",
      );
      const mine = join(dir, "lockdowns", "exam", "sentinel-TESTKEY-999-1.json");
      assert.ok(existsSync(mine), `this run's own timeline: ${readdirSync(join(dir, "lockdowns", "exam")).join(", ")}`);
      assert.equal(JSON.parse(readFileSync(mine, "utf8")).outcome, "fired");
    },
    { deadlineFor: () => deadline },
  );
});
