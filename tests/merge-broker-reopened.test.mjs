// PXL Classroom - merge-broker-reopened.test.mjs
//
// Two publishes at once both write lockdowns/<id>/broker-reopened.json, and the
// second one's rebase stopped on it: a red run over a publish that had done
// everything else (PXL-2TIN-CloudEssentials-2627, 2026-11-15, a lecturer who
// saved twice fourteen seconds apart). publish-assignment.yml now registers a
// merge driver for that file in its control checkout, and the later
// switch-on time stands.
//
// The real git, the real push script, and the driver lines read out of the
// workflow itself, so the test and the workflow cannot spell them differently.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { laterMark } from "../scripts/merge-broker-reopened.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const MARK = "lockdowns/lab/broker-reopened.json";
const ID = ["-c", "user.name=test", "-c", "user.email=test@users.noreply.github.com"];

const mark = (at, run) => JSON.stringify({ schema_version: 1, assignment_id: "lab", reopened_at: at, deadline_at: "2026-11-17T14:45:00.000Z", observer_run: run }, null, 2) + "\n";

function git(cwd, ...args) {
  const r = spawnSync("git", [...ID, ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/** The two lines the publish step uses to register the driver, from the workflow. */
function driverLines() {
  const doc = parse(readFileSync(join(root, ".github", "workflows", "publish-assignment.yml"), "utf8"));
  const step = Object.values(doc.jobs).flatMap((j) => j.steps ?? []).find((s) => s.name === "Update assignment state");
  const attributes = step.run.match(/echo "([^"]+)" >> control\/\.git\/info\/attributes/)?.[1];
  const driver = step.run.match(/git -C control config (merge\.[a-z-]+\.driver) "(.+)"$/m);
  assert.ok(attributes && driver, "the publish step registers the driver");
  // The driver runs before the push script, or the push never meets it.
  assert.ok(step.run.indexOf("merge.") < step.run.indexOf("scripts/git-push-with-retry.sh"));
  return { attributes, key: driver[1], command: driver[2].replace(/\\"/g, '"').replace("${GITHUB_WORKSPACE}", root.replace(/\\/g, "/")) };
}

/** A bare remote, and two checkouts that each publish a mark at their own time. */
function race({ register, first, second }) {
  const base = mkdtempSync(join(tmpdir(), "pxl-mark-"));
  const remote = join(base, "remote.git");
  git(base, "init", "-q", "--bare", "-b", "main", remote);
  const seed = join(base, "seed");
  git(base, "clone", "-q", remote, seed);
  mkdirSync(join(seed, "lockdowns", "lab"), { recursive: true });
  writeFileSync(join(seed, MARK), mark("2026-11-14T19:21:30.000Z", "run/0"));
  git(seed, "add", "-A");
  git(seed, "commit", "-qm", "seed");
  git(seed, "push", "-q", "origin", "HEAD:main");
  const a = join(base, "a");
  const b = join(base, "b");
  for (const dir of [a, b]) {
    git(base, "clone", "-q", remote, dir);
    git(dir, "config", "user.name", "pxl-classroom[bot]");
    git(dir, "config", "user.email", "pxl-classroom[bot]@users.noreply.github.com");
  }
  writeFileSync(join(a, MARK), first);
  git(a, "commit", "-qam", "Publish assignment lab");
  writeFileSync(join(b, MARK), second);
  git(b, "commit", "-qam", "Publish assignment lab");
  if (register) {
    const { attributes, key, command } = driverLines();
    mkdirSync(join(b, ".git", "info"), { recursive: true });
    appendFileSync(join(b, ".git", "info", "attributes"), attributes + "\n");
    git(b, "config", key, command);
  }
  git(a, "push", "-q", "origin", "HEAD:main");
  const push = spawnSync("sh", [join(root, "scripts", "git-push-with-retry.sh"), b], { encoding: "utf8", env: { ...process.env, MAX_RETRIES: "2" } });
  const landed = spawnSync("git", ["--git-dir", remote, "show", `main:${MARK}`], { encoding: "utf8" }).stdout;
  return { push, landed };
}

test("laterMark: the later reopened_at stands, and anything without one is not merged", () => {
  const early = mark("2026-11-15T08:48:31.378Z", "run/1");
  const late = mark("2026-11-15T08:48:40.000Z", "run/2");
  assert.equal(laterMark(early, late), late);
  assert.equal(laterMark(late, early), late);
  assert.equal(laterMark(early, early), early);
  assert.equal(laterMark(early, "not json"), null);
  assert.equal(laterMark(early, JSON.stringify({ schema_version: 1 })), null);
  assert.equal(laterMark("null", late), null);
});

test("two publishes at once: the second push merges the mark to the later time instead of failing", () => {
  const first = mark("2026-11-15T08:48:31.378Z", "run/first");
  const second = mark("2026-11-15T08:48:40.000Z", "run/second");
  const { push, landed } = race({ register: true, first, second });
  assert.equal(push.status, 0, push.stdout + push.stderr);
  assert.equal(landed, second);
});

test("whichever finishes first, the later switch-on time is what lands", () => {
  // The second push is the EARLIER mark: the first run's commit was slower.
  const later = mark("2026-11-15T08:48:40.000Z", "run/later");
  const earlier = mark("2026-11-15T08:48:31.378Z", "run/earlier");
  const { push, landed } = race({ register: true, first: later, second: earlier });
  assert.equal(push.status, 0, push.stdout + push.stderr);
  assert.equal(landed, later);
});

test("without the driver it is the conflict it was, so the test can tell the two apart", () => {
  const { push } = race({ register: false, first: mark("2026-11-15T08:48:31.378Z", "a"), second: mark("2026-11-15T08:48:40.000Z", "b") });
  assert.notEqual(push.status, 0);
  assert.match(push.stderr, /conflicted on: lockdowns\/lab\/broker-reopened\.json/);
});

test("a mark that does not parse is left a conflict, never guessed over", () => {
  const { push } = race({ register: true, first: mark("2026-11-15T08:48:31.378Z", "a"), second: "{ broken\n" });
  assert.notEqual(push.status, 0);
  assert.match(push.stderr, /conflicted on: lockdowns\/lab\/broker-reopened\.json/);
});
