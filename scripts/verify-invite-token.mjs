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
import { verifyAcceptanceTitle, signerMatchesAuthor } from "../lib/acceptance-signature.mjs";

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

// --- Signed acceptance (CLAIM_PLAN Phase A) ---------------------------------
//
// The old invitation token is a BEARER credential that lands in a PUBLIC event:
// measured 2026-08-25, one unauthenticated GET against a broker's events feed
// returned a full, still-valid token on an issue that had already been deleted.
// The signed form replaces it - the title now carries a signature naming the
// account that made it, useless to anyone else.
//
// BACKWARD COMPATIBILITY IS NOT OPTIONAL HERE. Every broker checks the hub out
// at `ref: main`, so an old broker runs THIS file. Changing the input contract
// would break every live acceptance the moment this merged, before a single
// assignment had been republished. So: a broker that sends TITLE + PUBLIC_KEY
// gets the new path, and one that sends TOKEN keeps the old one until it is
// republished.
if (String(process.env.TITLE || "").trim()) {
  const title = process.env.TITLE;
  const publicKey = String(process.env.INVITE_PUBKEY || "").trim();

  // A link minted before this change. It cannot verify here, and saying
  // "malformed" would send the student hunting for a typo in a link that is
  // simply out of date.
  if (/^pxl-accept:[A-Za-z0-9_-]{35}\.[A-Za-z0-9_-]{86}( |$)/.test(title)) {
    console.error(
      "::error::This invitation link predates the signed-acceptance change and can no longer be used. " +
        "Republish the assignment to mint new links (CLAIM_PLAN Phase A).",
    );
    finish(false, "legacy-link");
    process.exit(0);
  }

  if (!publicKey) {
    // Same class as a missing nonce: a deployment fault, not a forged title.
    console.error(
      "::error::INVITE_PUBKEY is not set on this broker, so no acceptance can be verified. Republish the assignment to set it.",
    );
    finish(false, "no-public-key");
    process.exit(0);
  }

  const verified = await verifyAcceptanceTitle({ title, publicKey });
  if (!verified.ok) {
    finish(false, verified.reason);
    process.exit(0);
  }

  // The anti-replay check. A signature lifted out of the public archive names
  // the account that made it; anyone replaying it authors the issue as
  // themselves, so the two disagree. The hub checks this again - neither being
  // skipped may open the hole.
  const author = process.env.ISSUE_AUTHOR_ID;
  if (!signerMatchesAuthor(verified.payload, author)) {
    finish(false, "signer-mismatch");
    process.exit(0);
  }

  setOutput("github_id", String(verified.payload.githubId));
  setOutput("subject", verified.payload.subject);
  finish(true, "signed");
  process.exit(0);
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
