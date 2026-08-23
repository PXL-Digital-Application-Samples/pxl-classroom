#!/usr/bin/env node
// PXL Classroom - the deadline sentinel.
//
// Waits for one instant, recording what it can see while it waits, and stops
// when that instant arrives. It does NOT lock anything itself: the workflow runs
// lockdown's Phase 1 (`STOP_ONLY=1`) immediately afterwards, so there is exactly
// one implementation of "stop writes" and the sentinel cannot drift from it.
//
// It polls; it does not sleep. A job idling for hours is defensible-but-grey
// under GitHub's acceptable use, and the useful work happens to be exactly what
// the design was missing:
//
//     GET /orgs/{org}/repos?sort=pushed&direction=desc&per_page=100
//
// One call returns `pushed_at` for a hundred repositories. Polling each repo
// individually would be 200 x 36 = 7,200 requests against a 5,000/hr limit -
// that is the trap, and `sort=pushed` avoids it. Roughly three calls an
// iteration, ~36 iterations over three hours: about a hundred requests to watch
// a whole cohort.
//
// `pushed_at` is GitHub's own server-side timestamp and a student cannot set it,
// which is the point. A five-minute push timeline through the critical window is
// what ends the "I committed before the deadline" conversation: at 21:55 your
// last push was 21:12; at 22:05 it was 22:31. The `?until=` fallback
// (ARCHITECTURE §11.2.2) cannot do that - it filters on the committer date, and
// the committer date comes from the student's machine.
//
// The target is re-read every iteration, so a lecturer moving the assignment
// deadline while the sentinel waits is honoured without restarting anything.
// Per-student extensions are not this script's business: it wakes at the
// assignment deadline and lockdown's own planning excludes anyone still
// extended (ARCHITECTURE §6.2.2).
//
// Every failure degrades to the nightly. A dropped cron firing, a killed job, a
// deadline moved out of reach: all of them fall through to the ordinary pass,
// which locks on the first nightly after the deadline. Nothing here can make
// things worse than not having run.

import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gh } from "../lib/gh.mjs";
import { parseYaml } from "../lib/yaml.mjs";

const env = (k, d) => process.env[k] ?? d;
const cfg = {
  token: env("GITHUB_TOKEN"),
  org: env("ORG"),
  dataDir: env("DATA_DIR"),
  assignmentIds: (env("ASSIGNMENT_IDS", "") || "").split(",").map((s) => s.trim()).filter(Boolean),
  deadlineAt: env("DEADLINE_AT"),
  key: env("SENTINEL_KEY", "unkeyed"),
  pollIntervalMs: Number(env("POLL_INTERVAL_MS", 5 * 60_000)),
  // Below the job's own timeout, so the sentinel writes its timeline and exits
  // cleanly rather than being killed with the evidence still in memory.
  maxRuntimeMs: Number(env("SENTINEL_MAX_RUNTIME_MS", 4.75 * 3600_000)),
  maxPages: Number(env("SENTINEL_MAX_PAGES", 3)),
  runUrl: `${env("GITHUB_SERVER_URL", "https://github.com")}/${env("GITHUB_REPOSITORY", "_")}` +
          `/actions/runs/${env("GITHUB_RUN_ID", "0")}`,
};

const log = (msg) => console.log(`[sentinel] ${msg}`);
async function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `${name}=${value ?? ""}\n`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/;

function validate() {
  if (!cfg.token) return "GITHUB_TOKEN is required (App installation token)";
  if (!cfg.org || !NAME.test(cfg.org)) return `ORG="${cfg.org}" is not a valid GitHub name`;
  if (!cfg.dataDir) return "DATA_DIR is required";
  if (!cfg.assignmentIds.length) return "ASSIGNMENT_IDS is required";
  for (const id of cfg.assignmentIds) if (!SLUG.test(id)) return `ASSIGNMENT_ID="${id}" is not a valid slug`;
  const at = new Date(cfg.deadlineAt ?? "");
  if (Number.isNaN(at.getTime())) return `DEADLINE_AT="${cfg.deadlineAt}" is not a date`;
  return null;
}

/** The repositories this sentinel is watching: name -> assignment id. */
async function watchedRepos() {
  const byName = new Map();
  for (const id of cfg.assignmentIds) {
    const dir = join(cfg.dataDir, "repositories", id);
    let files;
    try { files = await readdir(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      try {
        const rec = JSON.parse(await readFile(join(dir, f), "utf8"));
        const name = rec.repo_name?.split("/")?.[1] ?? rec.repo_name;
        if (name) byName.set(name, id);
      } catch { /* a malformed record is not worth failing a watch over */ }
    }
  }
  return byName;
}

/**
 * `pushed_at` for the watched repositories, newest push first.
 *
 * Paginated because a cohort can exceed a page, but capped: the ordering means
 * everything that has moved recently is on page one, and a repo that has not
 * been pushed to is not the one anyone will argue about.
 */
async function samplePushedAt(watched) {
  const seen = {};
  for (let page = 1; page <= cfg.maxPages; page++) {
    const res = await gh("GET", `/orgs/${cfg.org}/repos?sort=pushed&direction=desc&per_page=100&page=${page}`);
    if (!res.ok) return { ok: false, reason: `list repos HTTP ${res.status}`, pushed: seen };
    const list = Array.isArray(res.data) ? res.data : [];
    for (const repo of list) {
      if (watched.has(repo.name)) seen[repo.name] = repo.pushed_at;
    }
    if (list.length < 100) break;
    if (Object.keys(seen).length >= watched.size) break;
  }
  return { ok: true, reason: null, pushed: seen };
}

/**
 * The assignment's current deadline, read live so a lecturer moving it is
 * honoured without restarting the sentinel.
 */
async function currentTarget() {
  let earliest = null;
  for (const id of cfg.assignmentIds) {
    let doc = null;
    for (const ext of ["yml", "yaml"]) {
      const res = await gh("GET", `/repos/${cfg.org}/pxl-classroom-control/contents/assignments/${id}.${ext}`);
      // An assignment YAML is far below the 1 MB point where the Contents API
      // starts answering 200 with an empty body, so base64 is safe here.
      if (res.ok && res.data?.encoding === "base64" && res.data.content) {
        doc = Buffer.from(res.data.content, "base64").toString("utf8");
        break;
      }
    }
    // Unreadable: keep the target we were armed with rather than guessing.
    if (!doc) continue;
    let at;
    try {
      at = new Date(parseYaml(doc)?.deadline_at ?? "");
    } catch { continue; }
    if (Number.isNaN(at.getTime())) continue;
    if (!earliest || at < earliest) earliest = at;
  }
  return earliest;
}

async function main() {
  const bad = validate();
  if (bad) {
    console.error(`[sentinel] ${bad}`);
    await setOutput("outcome", "fail:validation");
    process.exit(1);
  }

  const startedAt = Date.now();
  let target = new Date(cfg.deadlineAt);
  const watched = await watchedRepos();
  log(`watching ${watched.size} repository/repositories across ${cfg.assignmentIds.join(", ")} until ${target.toISOString()}`);

  const samples = [];
  let polls = 0;
  let outcome = "fired";

  // Sample first, then look at the clock. A sentinel armed close to the instant
  // still records where the cohort stood when it fired, which is the evidence
  // the whole job exists to produce - and an empty timeline would be worse than
  // a short one.
  while (true) {
    if (watched.size) {
      const sample = await samplePushedAt(watched);
      polls++;
      samples.push({ observed_at: new Date().toISOString(), pushed_at: sample.pushed, error: sample.reason ?? undefined });
      if (!sample.ok) log(`poll ${polls}: ${sample.reason}`);
    } else {
      polls++;
    }

    const moved = await currentTarget();
    if (moved && moved.getTime() !== target.getTime()) {
      log(`deadline moved: ${target.toISOString()} -> ${moved.toISOString()}`);
      target = moved;
      if (target.getTime() > startedAt + cfg.maxRuntimeMs) {
        outcome = "gave-up:moved";
        log("the new deadline is beyond this sentinel's reach - a later cron firing will re-arm");
        break;
      }
    }

    const now = Date.now();
    if (now >= target.getTime()) break;

    if (now - startedAt >= cfg.maxRuntimeMs) {
      // Out of runway. The nightly finalize still locks and reconstructs; the
      // only thing lost is the precision this job exists for.
      outcome = "gave-up:runtime";
      log(`out of runtime before ${target.toISOString()} - the nightly finalize will handle it`);
      break;
    }

    await sleep(Math.min(cfg.pollIntervalMs, target.getTime() - now));
  }

  // Persist the timeline before anything else can fail. It sits beside the
  // lockdown record it explains; nothing globs that directory.
  for (const id of cfg.assignmentIds) {
    const dir = join(cfg.dataDir, "lockdowns", id);
    await mkdir(dir, { recursive: true });
    const doc = {
      schema_version: 1,
      assignment_id: id,
      organization: cfg.org,
      deadline_at: target.toISOString(),
      armed_for: cfg.deadlineAt,
      outcome,
      polls,
      observer_run: cfg.runUrl,
      // GitHub's own push timestamps through the critical window. A student can
      // set a commit date; they cannot set these.
      samples: samples.map((s) => ({
        observed_at: s.observed_at,
        error: s.error,
        pushed_at: Object.fromEntries(
          Object.entries(s.pushed_at).filter(([name]) => watched.get(name) === id)
        ),
      })),
    };
    await writeFile(join(dir, `sentinel-${cfg.key}.json`), JSON.stringify(doc, null, 2) + "\n");
  }

  await setOutput("outcome", outcome);
  await setOutput("polls", polls);
  await setOutput("target_at", target.toISOString());
  // Only a sentinel that actually reached its instant should trigger the stop.
  await setOutput("fired", outcome === "fired" ? "true" : "false");
  log(`${outcome} after ${polls} poll(s); target ${target.toISOString()}`);
}

main().catch(async (e) => {
  console.error(`[sentinel] ${e.stack || e.message}`);
  await setOutput("outcome", "fail:exception");
  await setOutput("fired", "false");
  process.exit(1);
});
