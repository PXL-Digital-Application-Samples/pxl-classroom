// PXL Classroom - match-broker-invite.test.mjs
//
// Two publishes at once that each minted an invitation left the broker on one
// and the control repository on the other: every student link refused.
// Measured on the testbed 2026-11-15 (two "Regenerate link" publishes a second
// apart: branch 932c80c6, broker 4dffabab). Every publish now ends by setting
// the broker to what is STORED on the branch (scripts/match-broker-invite.mjs).
//
// A real git remote for the branch, a stub for the broker's variables.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { main, storedInvite, writesNeeded } from "../scripts/match-broker-invite.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ID = ["-c", "user.name=test", "-c", "user.email=test@users.noreply.github.com"];
const git = (cwd, ...args) => {
  const r = spawnSync("git", [...ID, ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
const doc = (nonce, pubkey) => `state: published\ntitle: Lab\ninvite_nonce: "${nonce}"\ninvite_pubkey: ${pubkey}\n`;

/**
 * A control checkout taken BEFORE another run's commit landed, as a slow
 * publish's is: its own file says `local`, the branch says `landed`.
 */
function checkoutBehind({ local, landed }) {
  const base = mkdtempSync(join(tmpdir(), "pxl-invite-"));
  const remote = join(base, "remote.git");
  git(base, "init", "-q", "--bare", "-b", "main", remote);
  const other = join(base, "other");
  git(base, "clone", "-q", remote, other);
  mkdirSync(join(other, "assignments"));
  writeFileSync(join(other, "assignments", "lab.yml"), doc("00000000", "OLD"));
  git(other, "add", "-A");
  git(other, "commit", "-qm", "seed");
  git(other, "push", "-q", "origin", "HEAD:main");
  const control = join(base, "control");
  git(base, "clone", "-q", remote, control);
  writeFileSync(join(control, "assignments", "lab.yml"), local);
  if (landed) {
    writeFileSync(join(other, "assignments", "lab.yml"), landed);
    git(other, "commit", "-qam", "Publish assignment lab");
    git(other, "push", "-q", "origin", "HEAD:main");
  }
  return control;
}

/** The broker's variables, and every call made to them. */
function broker(held) {
  const vars = { ...held };
  const calls = [];
  const call = async (method, path, body) => {
    calls.push(`${method} ${path}`);
    const name = path.split("/").pop();
    if (method === "GET") return name in vars ? { ok: true, status: 200, data: { name, value: vars[name] } } : { ok: false, status: 404 };
    if (method === "PATCH") {
      if (!(name in vars)) return { ok: false, status: 404 };
      vars[name] = body.value;
      return { ok: true, status: 204 };
    }
    if (method === "POST") {
      vars[body.name] = body.value;
      return { ok: true, status: 201 };
    }
    return { ok: false, status: 405 };
  };
  return { vars, calls, call };
}

const env = (dir) => ({ ORG: "Org", ASSIGNMENT_ID: "lab", DATA_DIR: dir });

test("the broker is set to the invitation on the BRANCH, not to what this run minted", async () => {
  // This run minted 4dffabab and wrote it to the broker; another run's
  // 932c80c6 is what landed.
  const dir = checkoutBehind({ local: doc("4dffabab", "MINE"), landed: doc("932c80c6", "LANDED") });
  const b = broker({ INVITE_NONCE: "4dffabab", INVITE_PUBKEY: "MINE" });
  assert.equal(await main({ env: env(dir), call: b.call }), 0);
  assert.deepEqual(b.vars, { INVITE_NONCE: "932c80c6", INVITE_PUBKEY: "LANDED" });
});

test("a broker that already matches is left alone: two reads, no write", async () => {
  const dir = checkoutBehind({ local: doc("932c80c6", "LANDED"), landed: null });
  writeFileSync(join(dir, "assignments", "lab.yml"), doc("932c80c6", "LANDED"));
  git(dir, "commit", "-qam", "Publish assignment lab");
  git(dir, "push", "-q", "origin", "HEAD:main");
  const b = broker({ INVITE_NONCE: "932c80c6", INVITE_PUBKEY: "LANDED" });
  assert.equal(await main({ env: env(dir), call: b.call }), 0);
  assert.deepEqual(b.calls.filter((c) => !c.startsWith("GET")), []);
});

test("a variable the broker does not have yet is created", async () => {
  const dir = checkoutBehind({ local: doc("x", "y"), landed: doc("932c80c6", "LANDED") });
  const b = broker({});
  assert.equal(await main({ env: env(dir), call: b.call }), 0);
  assert.deepEqual(b.vars, { INVITE_NONCE: "932c80c6", INVITE_PUBKEY: "LANDED" });
});

test("a stored document with no invitation changes nothing and fails the step", async () => {
  const dir = checkoutBehind({ local: doc("a", "b"), landed: "state: published\ntitle: Lab\n" });
  const b = broker({ INVITE_NONCE: "a", INVITE_PUBKEY: "b" });
  assert.equal(await main({ env: env(dir), call: b.call }), 1);
  assert.deepEqual(b.vars, { INVITE_NONCE: "a", INVITE_PUBKEY: "b" });
});

test("storedInvite and writesNeeded", () => {
  assert.deepEqual(storedInvite(doc("n", "p"), "assignments/lab.yml"), { nonce: "n", pubkey: "p" });
  assert.deepEqual(storedInvite(JSON.stringify({ invite_nonce: "n", invite_pubkey: "p" }), "assignments/lab.json"), { nonce: "n", pubkey: "p" });
  assert.equal(storedInvite("state: draft\n", "assignments/lab.yml"), null);
  assert.equal(storedInvite("{ nope", "assignments/lab.json"), null);
  assert.deepEqual(writesNeeded({ nonce: "n", pubkey: "p" }, { INVITE_NONCE: "n", INVITE_PUBKEY: "p" }), []);
  assert.deepEqual(writesNeeded({ nonce: "n", pubkey: "p" }, { INVITE_NONCE: "m", INVITE_PUBKEY: "p" }), [["INVITE_NONCE", "n"]]);
});

test("every publish ends by matching the broker, after its last write to either side", () => {
  const steps = parse(readFileSync(join(root, ".github", "workflows", "publish-assignment.yml"), "utf8")).jobs;
  const all = Object.values(steps).flatMap((j) => j.steps ?? []);
  const at = (pred) => all.findIndex(pred);
  const match = at((s) => s.run === "node scripts/match-broker-invite.mjs");
  assert.ok(match > -1, "the step exists");
  assert.match(all[match].if, /always\(\)/, "it runs when an earlier step failed - the conflicting run is the one that needs it");
  assert.match(all[match].if, /steps\.broker\.outcome/, "only where the broker step ran");
  for (const name of ["Create and configure broker repo", "Update assignment state", "Revert to prior state on failure"]) {
    const i = at((s) => s.name === name);
    assert.ok(i > -1 && i < match, `${name} comes before it`);
  }
  assert.equal(all.find((s) => s.name === "Create and configure broker repo").id, "broker");
  // Nothing after it writes the broker's invitation.
  for (const s of all.slice(match + 1)) assert.doesNotMatch(String(s.run ?? ""), /INVITE_(NONCE|PUBKEY)/, s.name);
});
