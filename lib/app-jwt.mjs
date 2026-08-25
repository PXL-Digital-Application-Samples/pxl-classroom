// PXL Classroom - GitHub App JWT minting.
//
// An App JWT (RS256, signed with PXL_APP_PRIVATE_KEY) is the only credential
// that can read App-level endpoints: `GET /app/installations` and
// `POST /app/installations/{id}/access_tokens`. An installation token cannot,
// and neither can a lecturer's user token - `GET /orgs/{org}/installation`
// answers `401 A JSON web token could not be decoded` to one.
//
// Extracted from scripts/fetch-pages-data.mjs, where it was a private helper,
// the moment a second caller needed it. Two copies of a signing routine is the
// fork lib/rate-limit.mjs was created to end, and this one would be worse: a
// drifted `exp` produces an intermittently invalid credential rather than a
// visible error.
//
// Server-side only. It imports node:crypto and must never be pulled into the
// SPA bundle - the private key lives in the `provisioning` environment and has
// no business anywhere near a browser.

import crypto from "node:crypto";

/** GitHub rejects a JWT whose `exp` is more than 10 minutes out. */
const MAX_LIFETIME_S = 600;

/** Clock-skew allowance on `iat`, as GitHub's own documentation recommends. */
const BACKDATE_S = 60;

/**
 * Mint a GitHub App JWT.
 *
 * @param {string} clientId      The App's client id, used as `iss`. GitHub
 *                               accepts either the client id or the numeric App
 *                               id here; this repo passes PXL_APP_CLIENT_ID,
 *                               which is a repository secret because a client
 *                               id is public by design.
 * @param {string} privateKeyPem PKCS#1 or PKCS#8 PEM.
 * @param {object} [opts]
 * @param {number} [opts.nowMs]  Injectable clock, so a test can assert the
 *                               claims without depending on wall time.
 * @returns {string} the signed JWT
 */
export function generateAppJwt(clientId, privateKeyPem, { nowMs = Date.now() } = {}) {
  if (!clientId) throw new Error("generateAppJwt: clientId is required");
  if (!privateKeyPem) throw new Error("generateAppJwt: privateKeyPem is required");

  const now = Math.floor(nowMs / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat: now - BACKDATE_S, exp: now + MAX_LIFETIME_S, iss: clientId };

  const base64Header = Buffer.from(JSON.stringify(header)).toString("base64url");
  const base64Payload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signatureInput = `${base64Header}.${base64Payload}`;

  const sign = crypto.createSign("RSA-SHA256");
  sign.update(signatureInput);
  return `${signatureInput}.${sign.sign(privateKeyPem, "base64url")}`;
}

export { MAX_LIFETIME_S, BACKDATE_S };
