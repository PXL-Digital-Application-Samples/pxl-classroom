// PXL Classroom - publish-two-at-once.test.mjs
//
// Two publishes of one assignment at once (a lecturer saving twice quickly, or
// clicking Regenerate link twice) both write the state, the invitation and the
// broker mark. The second one's save conflicted and the run went red over a
// publish that had worked (PXL-2TIN-CloudEssentials-2627, 2026-11-15); on the
// testbed, two that each minted left the broker and the stored invitation
// apart. This runs publish-assignment.yml's own "Update assignment state"
// shell, read out of the workflow, against two real checkouts of one remote.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { anotherPublishLanded } from "../scripts/match-broker-invite.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const IDENT = ["-c", "user.name=test", "-c", "user.email=test@users.noreply.github.com"];
const git = (cwd, ...args) => {
  const r = spawnSync("git", [...IDENT, ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
const FILE = "assignments/lab.yml";
const doc = (state, nonce) => `state: ${state}\ntitle: Lab\ndeadline_at: 2027-06-30T21:00:00.000Z\ninvite_nonce: "${nonce}"\ninvite_pubkey: KEY-${nonce}\n`;

/** The step's shell, with the control checkout's path put where it says `control`. */
function stepScript(controlDir) {
  const wf = parse(readFileSync(join(root, ".github", "workflows", "publish-assignment.yml"), "utf8"));
  const step = Object.values(wf.jobs).flatMap((j) => j.steps ?? []).find((s) => s.name === "Update assignment state");
  const path = controlDir.replace(/\\/g, "/");
  const script = step.run.replace(/(?<![\w-])control(?=[\s/";)]|$)/gm, path);
  // Every mention replaced, or the run cd's into a directory that is not there.
  assert.doesNotMatch(script, /(?<![\w-])control(?![\w-])/, "a `control` the substitution missed");
  return script;
}

/** One publish: its own invitation in its checkout, its mark, then the step. */
function publish(controlDir, nonce) {
  const text = readFileSync(join(controlDir, FILE), "utf8").replace(/invite_nonce: "[^"]*"/, `invite_nonce: "${nonce}"`).replace(/invite_pubkey: \S+/, `invite_pubkey: KEY-${nonce}`);
  writeFileSync(join(controlDir, FILE), text);
  spawnSync(process.execPath, [join(root, "scripts", "mark-broker-reopened.mjs")], { env: { ...process.env, ASSIGNMENT_ID: "lab", DATA_DIR: controlDir } });
  return spawnSync("bash", ["-c", stepScript(controlDir)], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ASSIGNMENT_ID: "lab", GITHUB_WORKSPACE: root, MAX_RETRIES: "2" },
  });
}

function setup() {
  const base = mkdtempSync(join(tmpdir(), "pxl-pub-"));
  const remote = join(base, "remote.git");
  git(base, "init", "-q", "--bare", "-b", "main", remote);
  const seed = join(base, "seed");
  git(base, "clone", "-q", remote, seed);
  mkdirSync(join(seed, "assignments"));
  writeFileSync(join(seed, FILE), doc("published", "00000000"));
  git(seed, "add", "-A");
  git(seed, "commit", "-qm", "seed");
  git(seed, "push", "-q", "origin", "HEAD:main");
  const a = join(base, "a");
  const b = join(base, "b");
  git(base, "clone", "-q", remote, a);
  git(base, "clone", "-q", remote, b);
  const landed = (path) => spawnSync("git", ["--git-dir", remote, "show", `main:${path}`], { encoding: "utf8" }).stdout;
  return { seed, a, b, landed };
}

test("two publishes that both minted: the second takes what landed and finishes green", () => {
  const { a, b, landed } = setup();
  const first = publish(a, "aaaaaaaa");
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const second = publish(b, "bbbbbbbb");
  assert.equal(second.status, 0, `the second run went red: ${second.stdout}${second.stderr}`);
  assert.match(second.stdout, /Another publish of lab saved first; its invitation stands/);
  assert.match(landed(FILE), /invite_nonce: "aaaaaaaa"/, `the invitation that landed first stands\n${first.stdout}${first.stderr}\n---\n${second.stdout}${second.stderr}`);
  assert.match(landed(FILE), /^state: published$/m);
  assert.ok(JSON.parse(landed("lockdowns/lab/broker-reopened.json")).reopened_at, "the broker is marked on");
});

test("a conflict with anything but another publish still fails, and overwrites nothing", () => {
  const { seed, b, landed } = setup();
  // A lecturer's Back to draft lands while this publish runs.
  writeFileSync(join(seed, FILE), doc("draft", "aaaaaaaa"));
  git(seed, "commit", "-qam", "Back to draft");
  git(seed, "push", "-q", "origin", "HEAD:main");
  const run = publish(b, "bbbbbbbb");
  assert.notEqual(run.status, 0, "a person's change is not taken over silently");
  assert.match(landed(FILE), /^state: draft$/m, "the lecturer's state stands");
});

test("anotherPublishLanded: published with an invitation, and nothing else", () => {
  assert.equal(anotherPublishLanded(doc("published", "n"), FILE), true);
  assert.equal(anotherPublishLanded(doc("draft", "n"), FILE), false);
  assert.equal(anotherPublishLanded("state: published\ntitle: x\n", FILE), false);
  assert.equal(anotherPublishLanded(JSON.stringify({ state: "published", invite_nonce: "n", invite_pubkey: "p" }), "assignments/lab.json"), true);
  assert.equal(anotherPublishLanded("{ nope", "assignments/lab.json"), false);
});
