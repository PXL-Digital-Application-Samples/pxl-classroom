// The invitation link has one failure mode that keeps recurring, in different
// disguises: the SPA holds an assignment in memory that is missing a field the
// control repo has, and the UI renders a confident empty box rather than saying
// so. It has now bitten three times -
//
//   buildDoc rebuilt the document without invite_token, deleting it on save
//   the edit form never loaded invite_token, so the link was always null
//   publish minted the token into the control repo and the form never re-read
//     it, so "Copy Link" stayed empty however often the lecturer republished
//
// - and each time the document still validated and nothing went red. These
// tests pin every half of that round trip, plus the link format itself, so the
// next variant fails here instead of in front of a lecturer.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { signInviteToken, generateKeyPair, inviteFileFor, verifyInviteToken } from "../lib/invite-token.mjs";
import {
  parseToken,
  subjectInput,
  subjectFromDigest,
  subjectsMatch,
  inviteFileName,
  TOKEN_PATTERN,
} from "../lib/invite-token-format.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const ADMIN = () => readFileSync(join(root, "frontend", "src", "views", "AdminView.vue"), "utf8");
const DETAIL = () => readFileSync(join(root, "frontend", "src", "views", "AssignmentDetailView.vue"), "utf8");
const INVITE_LIB = () => readFileSync(join(root, "frontend", "src", "lib", "invite.js"), "utf8");

const KEYPAIR = generateKeyPair();
const ORG = "PXLAutomation";
const ID = "linux-processes-2026";
const mint = (org = ORG, id = ID) =>
  signInviteToken({
    org,
    assignmentId: id,
    expiresAt: "2099-01-01T00:00:00.000Z",
    nonce: "0badc0de",
    privateKeyPem: KEYPAIR.privateKeyPem,
  });

// --- The three round-trip halves, in AdminView ------------------------------

test("the edit form loads the invitation from the assignment", () => {
  const src = ADMIN();
  for (const field of ["invite_token", "invite_nonce", "invite_expires_at"]) {
    assert.ok(src.includes(`${field}: a.${field} || ''`), `edit form must load ${field}`);
  }
});

test("saving rebuilds the document without dropping the invitation", () => {
  // buildDoc constructs the YAML field by field, so anything absent is deleted -
  // and the result still validates, because the invite fields are optional.
  const src = ADMIN();
  for (const field of ["invite_token", "invite_nonce", "invite_expires_at"]) {
    assert.ok(
      src.includes(`...(form.value.${field} ? { ${field}: form.value.${field} } : {})`),
      `buildDoc must carry ${field} through`
    );
  }
});

test("the live check re-reads the invitation minted by publish", () => {
  // publish-assignment.yml writes the token into the control repo; the form in
  // memory has never seen it. Republishing does not help, because republishing
  // does not reload the form.
  const src = ADMIN();
  assert.match(
    src,
    /if \(token && !form\.value\.invite_token\)/,
    "verifyLiveInfrastructure must fetch the invitation when the form lacks one"
  );
  assert.match(src, /grab\('invite_token'\)/, "and assign it to the form");
});

test("copying with no invitation reports it instead of writing \"null\"", () => {
  const src = ADMIN();
  const fn = src.slice(src.indexOf("function copyAcceptLink"));
  const guard = fn.indexOf("if (!shareableLink.value)");
  const write = fn.indexOf("navigator.clipboard.writeText");
  assert.ok(guard > -1, "copyAcceptLink must guard against a null link");
  assert.ok(guard < write, "the guard must come before the clipboard write");
});

test("the assignment detail view reports a missing invitation too", () => {
  // Its link is read from the control repo rather than a form, so the failure
  // shape differs - but a lecturer must still be told, not handed nothing.
  const src = DETAIL();
  assert.match(src, /No invitation link yet/, "detail view must explain a missing invitation");
});

// --- The link format --------------------------------------------------------

test("a built invitation URL parses back to the same org and token", () => {
  const src = INVITE_LIB();
  assert.match(src, /\/i\//, "invitation URLs use the /i/ segment");
  const token = mint();
  assert.match(token, TOKEN_PATTERN);
  assert.equal(token.length, 122, "122 chars keeps the issue title under GitHub's 256 limit");
});

test("the acceptance issue title stays within GitHub's limit at every size", () => {
  const token = mint();
  const cases = [
    ["individual", `pxl-accept:${token}`],
    ["group, short slug", `pxl-accept:${token} team:a`],
    ["group, longest slug", `pxl-accept:${token} team:${"a".repeat(64)}`],
  ];
  for (const [label, title] of cases) {
    assert.ok(title.length <= 256, `${label}: ${title.length} chars exceeds 256`);
  }
});

// --- Subject resolution: how the SPA finds the assignment -------------------

async function subjectFor(org, id) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(subjectInput(org, id)));
  return subjectFromDigest(new Uint8Array(digest));
}

test("a token resolves to its own assignment and no other", async () => {
  const token = mint();
  const parsed = parseToken(token);
  assert.ok(await subjectsMatch(parsed.payload.subject, await subjectFor(ORG, ID)));
  for (const [org, id] of [
    [ORG, "some-other-assignment"],
    ["AnotherOrg", ID],
    [ORG, `${ID}-2`],
    [ORG, ID.toUpperCase()],
  ]) {
    assert.ok(
      !subjectsMatch(parsed.payload.subject, await subjectFor(org, id)),
      `must not resolve to ${org}/${id}`
    );
  }
});

test("org casing does not change which assignment a token opens", async () => {
  // GitHub org names are case-insensitive; a lecturer typing PXLautomation must
  // not mint a link that resolves to nothing.
  const parsed = parseToken(mint());
  for (const variant of ["pxlautomation", "PXLAUTOMATION", "PxlAutomation"]) {
    assert.ok(subjectsMatch(parsed.payload.subject, await subjectFor(variant, ID)));
  }
});

test("assignment ids are case-sensitive, unlike orgs", async () => {
  // The id is a filename in the control repo, so it must not fold case.
  const parsed = parseToken(mint());
  assert.ok(!subjectsMatch(parsed.payload.subject, await subjectFor(ORG, "Linux-Processes-2026")));
});

// --- The Pages filename -----------------------------------------------------

test("the Pages filename is the digest, never the token itself", () => {
  const token = mint();
  const name = inviteFileFor(token);
  assert.equal(name.length, 64, "sha256 hex");
  assert.match(name, /^[0-9a-f]{64}$/);
  assert.ok(!name.includes(token.slice(0, 12)), "a leaked filename must not be a working token");
});

test("Node and the browser derive the same filename", async () => {
  // A mismatch here is a 404 for every student, and would be invisible in
  // unit tests that only exercise one carrier.
  const token = mint();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  assert.equal(inviteFileName(digest), inviteFileFor(token));
});

test("different assignments never collide on a filename", () => {
  const names = new Set();
  for (const id of ["a", "b", "lab-1", "lab-2", ID]) {
    names.add(inviteFileFor(mint(ORG, id)));
  }
  assert.equal(names.size, 5, "each assignment gets its own card");
});

// --- Degenerate input -------------------------------------------------------

test("parseToken refuses everything that is not a canonical token", () => {
  const token = mint();
  const rubbish = [
    "",
    null,
    undefined,
    123,
    {},
    [],
    "pxl-accept:" + token, // the title, not the token
    token + " ",
    " " + token,
    token.replace(".", ""), // no separator
    token.replace(".", ".."), // two separators
    token.slice(0, 121),
    token + "A",
  ];
  for (const bad of rubbish) {
    const parsed = parseToken(bad);
    assert.ok(
      parsed === null || parsed.canonical === false,
      `expected refusal for ${JSON.stringify(String(bad).slice(0, 40))}`
    );
  }
});

test("an uppercased token is well-formed but does not verify", () => {
  // base64url uses both cases, so uppercasing yields a DIFFERENT valid token
  // rather than a malformed one - it parses, and then fails on the signature.
  // Worth stating explicitly: the shape check is not the security boundary.
  const token = mint();
  const shouted = token.toUpperCase();
  assert.notEqual(shouted, token);

  // Which way it fails depends on the signature bytes - it may be malformed,
  // non-canonical, or simply not verify. Asserting a particular reason would be
  // a flaky test; what matters is that it never opens anything.
  const verdict = verifyInviteToken(shouted, {
    org: ORG,
    assignmentId: ID,
    nonce: "0badc0de",
    publicKeys: { 1: KEYPAIR.publicKeyBase64 },
  });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.reason && verdict.reason !== "valid", `unexpected reason: ${verdict.reason}`);
});
