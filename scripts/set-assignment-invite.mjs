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
// Outputs via GITHUB_OUTPUT: token, nonce, file, regenerated

import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

import { signInviteToken, newNonce } from "../lib/invite-token.mjs";

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
  if (pattern.test(text)) return text.replace(pattern, line);
  return text.replace(/\n*$/, "\n") + line + "\n";
}

function readYamlField(text, key) {
  const m = text.match(new RegExp(`^${key}:[ \\t]*(.*)$`, "m"));
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : null;
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
const readField = (key) => (isYaml ? readYamlField(raw, key) : doc[key] ?? null);

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

if (isYaml) {
  let next = upsertYamlField(raw, "invite_token", token);
  next = upsertYamlField(next, "invite_nonce", nonce);
  next = upsertYamlField(next, "invite_expires_at", expiresAt);
  writeFileSync(file, next);
} else {
  doc.invite_token = token;
  doc.invite_nonce = nonce;
  doc.invite_expires_at = expiresAt;
  writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
}

setOutput("token", token);
setOutput("nonce", nonce);
setOutput("file", file);
setOutput("regenerated", reuse ? "false" : "true");

const what = reuse ? "kept the existing" : "minted a new";
console.log(`[ok] ${what} invitation for ${org}/${assignmentId} (kid ${kid}, expires ${expiresAt})`);
