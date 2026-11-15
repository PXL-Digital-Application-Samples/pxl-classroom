#!/usr/bin/env node
// Set the broker's INVITE_NONCE and INVITE_PUBKEY to the invitation STORED on
// the control repository's branch, as it is now - the last thing every publish
// does, whatever happened before it.
//
// The student's link is built from the stored invitation; the broker checks a
// link against its own two variables. A publish wrote the broker from what IT
// had minted, then committed: two publishes at once that each minted (two
// "Regenerate link" clicks, or two first publishes) each wrote the broker, and
// only one commit landed. Measured on the testbed, 2026-11-15: the branch held
// nonce 932c80c6, the broker 4dffabab, so every acceptance would have been
// refused while the one red run was the only sign.
//
// Read from the branch, never from this run's checkout or outputs: the run
// that finishes last then writes what landed, whichever run minted it, and the
// broker always matches the link. A stored invitation that cannot be read
// changes nothing and fails the step, so the run says so.
//
//   node scripts/match-broker-invite.mjs
//
// Env: GITHUB_TOKEN (the publish's org token: actions variables write on the
//      broker), ORG, ASSIGNMENT_ID, DATA_DIR (the control checkout, with
//      credentials for a fetch).

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { gh } from "../lib/gh.mjs";
import { assignmentPathsRead } from "../lib/control-layout.mjs";
import { CONTROL_REPO } from "../lib/deployment.mjs";
import { parseYaml } from "../lib/yaml.mjs";

const LOGIN = /^[A-Za-z0-9](?:-?[A-Za-z0-9]){0,38}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/;

/**
 * The invitation the stored assignment document carries, or null.
 * @param {string} text
 * @param {string} path
 */
export function storedInvite(text, path) {
  let doc;
  try {
    doc = path.endsWith(".json") ? JSON.parse(text) : parseYaml(text);
  } catch {
    return null;
  }
  const nonce = typeof doc?.invite_nonce === "string" ? doc.invite_nonce : null;
  const pubkey = typeof doc?.invite_pubkey === "string" ? doc.invite_pubkey : null;
  return nonce && pubkey ? { nonce, pubkey } : null;
}

/**
 * Is the stored document another publish's work - published, with an
 * invitation? Only then may a publish whose save conflicted take it as it is
 * (publish-assignment.yml): anything else, a lecturer's Back to draft landing
 * in between say, is a conflict for a person.
 * @param {string} text
 * @param {string} path
 */
export function anotherPublishLanded(text, path) {
  let doc;
  try {
    doc = path.endsWith(".json") ? JSON.parse(text) : parseYaml(text);
  } catch {
    return false;
  }
  return doc?.state === "published" && storedInvite(text, path) !== null;
}

/** The variable writes that bring the broker to `want`, given what it holds. */
export function writesNeeded(want, held) {
  const out = [];
  if (held.INVITE_NONCE !== want.nonce) out.push(["INVITE_NONCE", want.nonce]);
  if (held.INVITE_PUBKEY !== want.pubkey) out.push(["INVITE_PUBKEY", want.pubkey]);
  return out;
}

function git(dir, args) {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  return { ok: r.status === 0, out: r.stdout ?? "", err: (r.stderr ?? "").trim() };
}

export async function main({ env = process.env, call = gh } = {}) {
  const org = env.ORG || "";
  const id = env.ASSIGNMENT_ID || "";
  const dir = env.DATA_DIR || "control";
  if (!LOGIN.test(org) || !SLUG.test(id)) {
    console.log("::error::ORG and ASSIGNMENT_ID are required, in their usual shapes");
    return 1;
  }
  const branch = git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]).out.trim() || "main";
  // A fetch that fails is tried three times; the branch is the whole point.
  let fetched = false;
  for (let i = 0; i < 3 && !fetched; i++) fetched = git(dir, ["fetch", "-q", "origin", branch]).ok;
  if (!fetched) {
    console.log(`::error::Could not read ${org}/${CONTROL_REPO} at ${branch}, so the broker of ${id} was not checked against the stored invitation. Publish again to set it.`);
    return 1;
  }
  let want = null;
  for (const path of assignmentPathsRead(id)) {
    const shown = git(dir, ["show", `FETCH_HEAD:${path}`]);
    if (shown.ok) {
      want = storedInvite(shown.out, path);
      break;
    }
  }
  if (!want) {
    console.log(`::error::The stored assignment ${id} carries no readable invitation, so its broker was left as it is.`);
    return 1;
  }
  const repo = `/repos/${org}/broker-${id}/actions/variables`;
  const held = {};
  for (const name of ["INVITE_NONCE", "INVITE_PUBKEY"]) {
    const res = await call("GET", `${repo}/${name}`);
    held[name] = res.ok ? res.data?.value ?? null : null;
  }
  const writes = writesNeeded(want, held);
  if (!writes.length) {
    console.log(`[ok] the broker of ${id} checks links against the stored invitation (nonce ${want.nonce})`);
    return 0;
  }
  for (const [name, value] of writes) {
    let res = await call("PATCH", `${repo}/${name}`, { value });
    if (res.status === 404) res = await call("POST", repo, { name, value });
    if (!res.ok) {
      console.log(`::error::Could not set ${name} on broker-${id} (HTTP ${res.status}): its links may be refused. Publish again.`);
      return 1;
    }
  }
  console.log(
    `::notice::The broker of ${id} held ${held.INVITE_NONCE ?? "no nonce"} and the stored invitation is ${want.nonce} - ` +
      `another publish ran at the same time. The broker now matches the stored invitation, which is the one the students' link carries.`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; });
}
