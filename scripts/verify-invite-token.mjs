#!/usr/bin/env node
// PXL Classroom - verify an invitation token on a broker, before any credential
// is in scope.
//
// This is the whole point of signed invitations: it runs on the PUBLIC broker,
// from a checkout of the public hub, with no secrets available to the step and
// no dependencies installed. A caller without a valid token dies here, having
// cost one boot on a free public runner - no App token minted, no hub run, no
// clone of the private control repo.
//
// Inputs via env: TOKEN, ORG, ASSIGNMENT_ID, INVITE_NONCE, KEYS_FILE
// Outputs via GITHUB_OUTPUT: valid (true|false), reason
//
// Exits 0 either way. The broker decides what to do with `valid`; a hard failure
// here would turn every forged token into a red run on the lecturer's broker.

import { readFileSync } from "node:fs";
import { appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { verifyInviteToken } from "../lib/invite-token.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_KEYS = join(here, "..", "acceptance", "invite-keys.json");

function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  }
}

function finish(valid, reason) {
  setOutput("valid", valid ? "true" : "false");
  setOutput("reason", reason);
  console.log(valid ? `[ok] invitation token accepted` : `[reject] invitation token ${reason}`);
}

let publicKeys;
try {
  publicKeys = JSON.parse(readFileSync(process.env.KEYS_FILE || DEFAULT_KEYS, "utf8"));
} catch (err) {
  // No key file is a deployment fault, not a forged token. Say so distinctly so
  // it is not mistaken for an attack in the broker's run log.
  console.error(`::error::Cannot read invitation public keys: ${err.message}`);
  finish(false, "no-keys");
  process.exit(0);
}

// No nonce is a deployment fault, like a missing key file - not a forged token.
// Saying so distinctly is what tells a lecturer to republish rather than
// hunt for a bad link, and verifyInviteToken now refuses rather than waving
// every token through.
if (!String(process.env.INVITE_NONCE || "").trim()) {
  console.error(
    "::error::INVITE_NONCE is not set on this broker, so no invitation can be verified. Republish the assignment to set it."
  );
}

const result = verifyInviteToken(process.env.TOKEN, {
  org: process.env.ORG,
  assignmentId: process.env.ASSIGNMENT_ID,
  nonce: process.env.INVITE_NONCE,
  publicKeys: publicKeys.keys || publicKeys,
});

finish(result.ok, result.reason);
