#!/usr/bin/env node
// PXL Classroom - mint an assignment's invitation token and record it.
//
// Runs in the hub during publish-assignment.yml, the only place the signing key
// exists. One script rather than read/sign/write steps, because the three are a
// single decision: whether this publish keeps the existing invitation link alive
// or retires it.
//
//   - Republishing REUSES the recorded nonce, so links already handed out keep
//     working. Republish is a repair operation; it must not silently invalidate
//     an assignment's link the day before a deadline.
//   - REGENERATE=true mints a fresh nonce, which retires every previously issued
//     link the moment the broker's INVITE_NONCE variable is updated.
//
// The token lands in the PRIVATE control repo. It must never reach Pages output.
//
// Inputs via env: DATA_DIR, ASSIGNMENT_ID, ORG, INVITE_SIGNING_KEY, INVITE_KID,
//                 REGENERATE, EXPIRES_AT
// Outputs via GITHUB_OUTPUT: nonce, file, regenerated, pubkey
//
// NOT the token. See the note beside setOutput("pubkey", ...) below.

import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

import { signInviteToken, newNonce } from "../lib/invite-token.mjs";
import { readInviteField, quoteInviteValue } from "../lib/invite-token-format.mjs";
import { generateAcceptanceKeypair } from "../lib/acceptance-signature.mjs";

function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  }
}

function die(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

// Line-level edits rather than a YAML round-trip: assignment files are
// lecturer-authored and re-serialising them would strip their comments and
// reorder their keys, which is why "Update assignment state" edits state the
// same way.
function upsertYamlField(text, key, value) {
  const line = `${key}: ${value}`;
  const pattern = new RegExp(`^${key}:.*$`, "m");
  // Replacer function, not a replacement string: `$&` and friends inside a
  // signed token would otherwise be expanded by String.replace.
  if (pattern.test(text)) return text.replace(pattern, () => line);
  return text.replace(/\n*$/, "\n") + line + "\n";
}

const dataDir = process.env.DATA_DIR || "control";
const assignmentId = process.env.ASSIGNMENT_ID;
const org = process.env.ORG;
const privateKeyPem = process.env.INVITE_SIGNING_KEY;

if (!assignmentId || !org) die("ASSIGNMENT_ID and ORG are required");
if (!privateKeyPem) {
  die(
    "INVITE_SIGNING_KEY is not set on the hub. Generate a keypair with " +
      "`node scripts/generate-invite-keypair.mjs` and see RUNBOOK §1.3."
  );
}

const yamlPath = join(dataDir, "assignments", `${assignmentId}.yml`);
const jsonPath = join(dataDir, "assignments", `${assignmentId}.json`);
const isYaml = existsSync(yamlPath);
const file = isYaml ? yamlPath : jsonPath;
if (!existsSync(file)) die(`Assignment file not found: ${yamlPath}`);

const raw = readFileSync(file, "utf8");
const doc = isYaml ? null : JSON.parse(raw);
// readInviteField is the SPA's reader too (lib/invite-token-format.mjs), so a
// value this script writes and the Admin Panel cannot read back is a test
// failure rather than an empty link box in front of a lecturer.
const readField = (key) => (isYaml ? readInviteField(raw, key) || null : doc[key] ?? null);

const existingNonce = readField("invite_nonce");
const existingExpiry = readField("invite_expires_at");

const regenerate = process.env.REGENERATE === "true";
const nonceOk = typeof existingNonce === "string" && /^[0-9a-f]{8}$/i.test(existingNonce);
// Both halves must be reused, or a republish a minute later would mint a
// different token for the same link: the expiry has minute granularity and is
// otherwise derived from the clock.
const expiryOk =
  typeof existingExpiry === "string" && Number.isFinite(new Date(existingExpiry).getTime());
const reuse = !regenerate && nonceOk && expiryOk;

const nonce = reuse ? existingNonce.toLowerCase() : newNonce();
const kid = Number(process.env.INVITE_KID || 1);
// Links deliberately outlive the deadline: extending a deadline must not also
// mean reissuing every student's link. The opens_at..deadline_at window and
// max_acceptances in accept.mjs are what actually close acceptance.
const expiresAt = reuse
  ? existingExpiry
  : process.env.EXPIRES_AT?.trim() ||
    new Date(Date.now() + 400 * 24 * 60 * 60 * 1000).toISOString();

const token = signInviteToken({ org, assignmentId, expiresAt, nonce, kid, privateKeyPem });

// The signed-acceptance keypair (CLAIM_PLAN Phase A). The PRIVATE half becomes
// the link secret; the PUBLIC half is copied to the broker as INVITE_PUBKEY,
// where the student's signature is checked. The old token is still written, so
// an assignment that has not migrated keeps working and an out-of-date link
// still resolves to a page that says so.
//
// Reused on republish for exactly the reason the nonce is: republish is a
// repair operation and must not silently invalidate every link handed out. Only
// REGENERATE mints a new pair, and that retires them deliberately.
const existingKey = readField("invite_key");
const existingPubkey = readField("invite_pubkey");
const keypairOk = Boolean(existingKey) && Boolean(existingPubkey);
const keypair =
  !regenerate && keypairOk
    ? { privateKey: existingKey, publicKey: existingPubkey }
    : await generateAcceptanceKeypair();

if (isYaml) {
  let next = raw;
  for (const [key, value] of [
    ["invite_token", token],
    ["invite_nonce", nonce],
    ["invite_expires_at", expiresAt],
    ["invite_key", keypair.privateKey],
    ["invite_pubkey", keypair.publicKey],
  ]) {
    next = upsertYamlField(next, key, quoteInviteValue(key, value));
  }
  writeFileSync(file, next);
} else {
  doc.invite_token = token;
  doc.invite_nonce = nonce;
  doc.invite_expires_at = expiresAt;
  doc.invite_key = keypair.privateKey;
  doc.invite_pubkey = keypair.publicKey;
  writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
}

setOutput("nonce", nonce);
setOutput("file", file);
setOutput("regenerated", reuse ? "false" : "true");
// The workflow copies this onto the broker as INVITE_PUBKEY. The PRIVATE half
// is never an output: outputs are readable in the run log, and this one is the
// link secret.
//
// THE TOKEN IS NOT AN OUTPUT EITHER, for exactly the same reason, and it was
// one until 2026-08-26 - four lines above this comment, contradicting it.
// On a MIGRATED assignment the token is not the link and the exposure is
// bounded; on an unmigrated one the token IS the bearer credential, and those
// are still live (acceptanceIssueTitle stays until none are). It was written
// unmasked - nothing here calls ::add-mask:: - from a workflow on the PUBLIC
// hub. Nothing consumed it: publish-assignment.yml declared it in a step's
// `env:` and the script never read it, and dropping that dead reference is
// what showed this one had no consumer left at all.
//
// The token's home is the assignment file in the PRIVATE control repo, which
// this script has already written. Anything that needs it reads it from there
// with parseInviteFields - including tests/invite-token.test.mjs, which used
// this output as an observation channel.
setOutput("pubkey", keypair.publicKey);

const what = reuse ? "kept the existing" : "minted a new";
console.log(`[ok] ${what} invitation for ${org}/${assignmentId} (kid ${kid}, expires ${expiresAt})`);
