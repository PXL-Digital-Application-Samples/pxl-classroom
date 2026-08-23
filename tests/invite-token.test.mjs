// Acceptance is triggered by a public event on a public repository, so anyone
// can ring the doorbell. The signed invitation token is what makes ringing it
// cost nothing: the broker verifies it BEFORE minting an App token, so a caller
// without a valid token never reaches a credential, a hub run, or a clone of
// the private control repo.
//
// The verifier is public, which is why this is asymmetric - an HMAC would put
// the minting secret on every broker. These tests pin the wire format (it has
// to fit in an issue title, which is what lets the broker read it without
// touching the issue body), every rejection path, and the step ordering in the
// broker workflow that the whole property depends on.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { parse } from "yaml";

import {
  signInviteToken,
  verifyInviteToken,
  generateKeyPair,
  newNonce,
  encodePayload,
  decodePayload,
  subjectFor,
  TOKEN_PATTERN,
} from "../lib/invite-token.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const BROKER = join(root, "acceptance", "broker-workflow.yml");

const kp = generateKeyPair();
const keys = { 1: kp.publicKeyBase64 };
const nonce = newNonce();
const ORG = "PXLAutomation";
const ID = "linux-processes-2026";
const future = new Date(Date.now() + 30 * 86400_000).toISOString();

function mint(overrides = {}) {
  return signInviteToken({
    org: ORG,
    assignmentId: ID,
    expiresAt: future,
    nonce,
    privateKeyPem: kp.privateKeyPem,
    ...overrides,
  });
}

const check = (token, overrides = {}) =>
  verifyInviteToken(token, { org: ORG, assignmentId: ID, nonce, publicKeys: keys, ...overrides });

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

// 64 bytes is 512 bits but 86 base64url chars carry 516, so the final character
// has two spare low bits that decoding discards. Flipping one of THOSE leaves a
// different string that decodes to the identical signature - which is exactly
// what the canonicality check exists to reject. Flipping the character to an
// arbitrary other letter would change significant bits instead, and report
// bad-signature.
function withDirtyPadding(token) {
  const last = token.at(-1);
  return token.slice(0, -1) + B64URL[B64URL.indexOf(last) ^ 1];
}

test("a freshly minted token verifies", () => {
  assert.equal(check(mint()).ok, true);
});

test("the token fits in a GitHub issue title", () => {
  // 256 chars is the hard limit. The title carries `pxl-accept:<token>` plus an
  // optional ` team:<slug>` of up to 64 chars - this is what lets the broker
  // read everything it needs without ever touching the issue body.
  const token = mint();
  assert.match(token, TOKEN_PATTERN);
  const worstCase = `pxl-accept:${token} team:${"a".repeat(64)}`;
  assert.ok(worstCase.length <= 256, `worst-case title is ${worstCase.length} chars`);
});

test("org matching is case-insensitive", () => {
  // GitHub org names are case-insensitive, and a lecturer typing PXLautomation
  // into the Admin Panel must not mint a token that no broker accepts.
  assert.equal(check(mint(), { org: "pxlautomation" }).ok, true);
});

test("every rejection path reports its own reason", () => {
  const token = mint();
  const cases = [
    ["a token for another assignment", () => check(token, { assignmentId: "other-2026" }), "wrong-assignment"],
    ["a token for another org", () => check(token, { org: "SomeOtherOrg" }), "wrong-assignment"],
    ["an expired token", () => check(token, { now: new Date(Date.now() + 60 * 86400_000) }), "expired"],
    ["a superseded token", () => check(token, { nonce: newNonce() }), "superseded"],
    ["a token signed by another key", () => check(token, { publicKeys: { 1: generateKeyPair().publicKeyBase64 } }), "bad-signature"],
    ["a token whose key id is unknown", () => check(token, { publicKeys: { 2: kp.publicKeyBase64 } }), "unknown-key"],
    // Byte 0 is the version, so tamper further in - otherwise the version
    // check answers before the signature ever gets a look.
    ["a tampered payload", () => check(`${token.slice(0, 8)}${token[8] === "A" ? "B" : "A"}${token.slice(9)}`), "bad-signature"],
    ["an unknown token version", () => check(`${token[0] === "A" ? "B" : "A"}${token.slice(1)}`), "unsupported-version"],
    ["a tampered signature", () => check(`${token.slice(0, 50)}${token[50] === "A" ? "B" : "A"}${token.slice(51)}`), "bad-signature"],
    // 26 and 64 bytes do not divide into 6-bit groups, so the final character
    // of each part carries bits that decoding discards. Without a canonicality
    // check the same link would have several valid spellings, and the last
    // character could be changed with no effect at all.
    ["a non-canonical encoding", () => check(withDirtyPadding(token)), "non-canonical"],
    ["a truncated token", () => check(token.slice(0, 60)), "malformed"],
    ["an empty token", () => check(""), "malformed"],
    ["a non-string token", () => check(null), "malformed"],
    ["arbitrary text", () => check("have-a-repo-please"), "malformed"],
  ];
  for (const [label, run, expected] of cases) {
    const result = run();
    assert.equal(result.ok, false, `${label} must be rejected`);
    assert.equal(result.reason, expected, `${label} should report "${expected}"`);
  }
});

test("a signature over one assignment does not transfer to another", () => {
  // Without the subject binding, any valid token would open every broker, since
  // they all verify against the same public key.
  const other = signInviteToken({
    org: ORG,
    assignmentId: "databases-2026",
    expiresAt: future,
    nonce,
    privateKeyPem: kp.privateKeyPem,
  });
  assert.equal(check(other).reason, "wrong-assignment");
});

test("the payload codec round-trips", () => {
  const subject = subjectFor(ORG, ID);
  const encoded = encodePayload({ kid: 7, subject, expiresAt: "2026-10-05T21:59:59Z", nonce: "deadbeef" });
  const decoded = decodePayload(encoded);
  assert.equal(decoded.kid, 7);
  assert.equal(decoded.nonce, "deadbeef");
  assert.deepEqual([...decoded.subject], [...subject]);
  // Minute granularity must round up, or a token would expire before the
  // instant the lecturer asked for.
  assert.ok(decoded.expiresAt >= new Date("2026-10-05T21:59:59Z"));
});

test("the codec refuses out-of-range inputs", () => {
  const subject = subjectFor(ORG, ID);
  assert.throws(() => encodePayload({ kid: 0, subject, expiresAt: future, nonce: "deadbeef" }), /kid/);
  assert.throws(() => encodePayload({ kid: 256, subject, expiresAt: future, nonce: "deadbeef" }), /kid/);
  assert.throws(() => encodePayload({ kid: 1, subject: new Uint8Array(4), expiresAt: future, nonce: "deadbeef" }), /subject/);
  assert.throws(() => encodePayload({ kid: 1, subject, expiresAt: future, nonce: "nothex!!" }), /nonce/);
});

// --- The broker workflow: ordering is the whole property --------------------

const brokerDoc = parse(readFileSync(BROKER, "utf8"));
const brokerSteps = brokerDoc.jobs.dispatch.steps;
const indexOf = (predicate) => brokerSteps.findIndex(predicate);

test("verification happens before any credential is in scope", () => {
  const verifyAt = indexOf((s) => s.run?.includes("verify-invite-token.mjs"));
  const mintAt = indexOf((s) => s.uses?.startsWith("actions/create-github-app-token"));
  assert.ok(verifyAt > -1, "the broker must verify the invitation token");
  assert.ok(mintAt > -1, "the broker must mint an App token for the dispatch");
  assert.ok(verifyAt < mintAt, "verification must precede minting, or rejection still costs a credential");

  // Nothing before verification may touch a secret - that is what makes an
  // unauthorized trigger cost one boot on a free public runner and nothing else.
  for (const step of brokerSteps.slice(0, verifyAt + 1)) {
    const surface = JSON.stringify({ env: step.env || {}, with: step.with || {} });
    assert.ok(
      !surface.includes("secrets."),
      `step "${step.name || step.uses}" reads a secret before the token is verified`
    );
  }
});

test("minting and dispatching are gated on a valid token", () => {
  for (const step of brokerSteps) {
    const isMint = step.uses?.startsWith("actions/create-github-app-token");
    const isDispatch = step.run?.includes("client_payload[org]");
    if (!isMint && !isDispatch) continue;
    assert.equal(
      step.if,
      "steps.verify.outputs.valid == 'true'",
      `step "${step.name || step.uses}" must be gated on a valid invitation`
    );
  }
});

test("garbage is filtered before a runner is allocated", () => {
  // A job-level `if` is evaluated by GitHub before it schedules a runner, so a
  // random issue on a public broker costs nothing at all.
  const condition = brokerDoc.jobs.dispatch.if;
  assert.match(condition, /startsWith\(github\.event\.issue\.title, 'pxl-accept:'\)/);
  assert.match(condition, /vars\.INVITE_ENABLED != 'false'/, "the kill switch must be free to use");
});

test("the hub checkout carries no credentials", () => {
  const checkout = brokerSteps.find((s) => s.uses?.startsWith("actions/checkout"));
  assert.ok(checkout, "the broker checks out the hub to get the verifier and the public keys");
  assert.equal(checkout.with["persist-credentials"], false);
  assert.equal(checkout.with.repository, "PXL-Digital-Application-Samples/pxl-classroom");
});

// --- publish: republish must not silently retire a live link ----------------

test("republishing keeps the link, regenerating retires it", () => {
  const dir = mkdtempSync(join(tmpdir(), "pxl-invite-"));
  mkdirSync(join(dir, "assignments"), { recursive: true });
  const file = join(dir, "assignments", `${ID}.yml`);
  writeFileSync(file, `schema_version: 1\nid: ${ID}\nstate: draft\n\n# a lecturer comment\n`);

  const run = (regenerate) => {
    const outFile = join(dir, "out.txt");
    writeFileSync(outFile, "");
    execFileSync(process.execPath, [join(root, "scripts", "set-assignment-invite.mjs")], {
      env: {
        ...process.env,
        DATA_DIR: dir,
        ASSIGNMENT_ID: ID,
        ORG,
        INVITE_SIGNING_KEY: kp.privateKeyPem,
        REGENERATE: String(regenerate),
        GITHUB_OUTPUT: outFile,
      },
      stdio: "pipe",
    });
    return Object.fromEntries(
      readFileSync(outFile, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)])
    );
  };

  const first = run(false);
  const republished = run(false);
  const regenerated = run(true);
  const after = run(false);

  // Republish is a repair operation. Minting a new token there would silently
  // break every link already handed out - the day before a deadline, say.
  assert.equal(republished.token, first.token, "republishing must keep the existing link alive");
  assert.notEqual(regenerated.token, first.token, "regenerating must retire the previous link");
  assert.equal(after.token, regenerated.token, "the new link must be stable in turn");
  assert.equal(republished.regenerated, "false");
  assert.equal(regenerated.regenerated, "true");

  const written = readFileSync(file, "utf8");
  assert.match(written, /# a lecturer comment/, "lecturer-authored comments must survive");
  assert.equal(written.match(/^invite_token:/gm).length, 1, "no duplicate keys after repeated publishes");
  assert.match(written, /^invite_nonce: [0-9a-f]{8}$/m);

  // The token in the file must verify against the nonce the broker gets.
  assert.equal(
    verifyInviteToken(regenerated.token, {
      org: ORG,
      assignmentId: ID,
      nonce: regenerated.nonce,
      publicKeys: keys,
    }).ok,
    true
  );
});

test("the invitation token never reaches public Pages output", () => {
  // Generate for real and read the artifact, rather than grepping the source:
  // the generator legitimately reads invite_token now, to derive the filename
  // it publishes the card under. What matters is that the value itself never
  // lands in anything world-readable.
  const dir = mkdtempSync(join(tmpdir(), "pxl-pages-"));
  mkdirSync(join(dir, "assignments"), { recursive: true });
  const token = mint();
  writeFileSync(
    join(dir, "assignments", `${ID}.yml`),
    [
      "schema_version: 1",
      `id: ${ID}`,
      "title: Linux Processes",
      `organization: ${ORG}`,
      "state: published",
      "opens_at: 2026-09-01T06:00:00Z",
      "deadline_at: 2026-10-05T21:59:59Z",
      `repository_name_pattern: ${ID}-{github_login}`,
      `invite_token: ${token}`,
      "invite_nonce: 0badc0de",
      "",
    ].join("\n")
  );
  const outDir = join(dir, "public");
  execFileSync(process.execPath, [join(root, "pages", "generate.mjs")], {
    env: { ...process.env, DATA_DIR: dir, OUTPUT_DIR: outDir },
    stdio: "pipe",
  });

  for (const file of readdirSync(outDir, { recursive: true })) {
    const full = join(outDir, String(file));
    if (!statSync(full).isFile()) continue;
    assert.ok(
      !readFileSync(full, "utf8").includes(token),
      `${file} contains the invitation token`
    );
  }

  // And the privacy scanner is the backstop if a future field ever carries one.
  const scan = execFileSync(process.execPath, [join(root, "pages", "scan.mjs"), outDir], {
    encoding: "utf8",
  });
  assert.match(scan, /clean/);
});
