// The confirm link, at the layer where relabelling it would be free.
//
// A confirmation and an acceptance ride the SAME assignment secret, the same
// nonce and the same broker - deliberately, so a confirmation inherits the
// assignment's kill switch (INVITE_ENABLED, flipped when the nightly finalizes)
// and its revocation (rotate the nonce and every link dies at once) instead of
// having a lifetime of its own that nobody would remember to end.
//
// Which puts the whole weight on one question: what stops somebody rewriting
// `pxl-confirm:` to `pxl-accept:`? The signature covers `<kid>.<payload>` and
// the prefix sits OUTSIDE it, so nothing would - a student sent a "confirm your
// email" link could turn it into an acceptance of an `open` assignment they
// were never invited to, and the broker would verify it happily.
//
// The purpose is therefore folded into the SIGNED SUBJECT (`confirm:<id>`
// rather than `<id>`), which costs no wire-format change - and that matters
// more here than anywhere, because every broker ever published checks the hub
// out at `main` and runs this code, so a payload byte cannot be added without
// breaking every live acceptance at once.
//
// The tests below are mostly one test asked from both directions, on purpose:
// an anti-swap rule that only holds one way is not a rule.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  generateAcceptanceKeypair,
  signAcceptanceTitle,
  verifyAcceptanceTitle,
  purposeForTitle,
  titlePrefixFor,
  signedSubjectFor,
  PURPOSE,
  TITLE_PREFIX,
  CONFIRM_TITLE_PREFIX,
  MAX_TITLE_LENGTH,
} from "../lib/acceptance-signature.mjs";
import { signedConfirmIssueTitle, confirmationUrl, invitationUrl } from "../frontend/src/lib/invite.js";

const ID = "open-exam-2026";
const GITHUB_ID = 12345678;
const KID = "a1";

let keys;
async function keypair() {
  if (!keys) keys = await generateAcceptanceKeypair();
  return keys;
}

async function titleFor(purpose, over = {}) {
  const { privateKey } = await keypair();
  return signAcceptanceTitle({
    privateKey,
    kid: KID,
    subject: ID,
    githubId: GITHUB_ID,
    nonce: "0badc0de",
    purpose,
    ...over,
  });
}

const verify = async (title, over = {}) =>
  verifyAcceptanceTitle({
    title,
    publicKey: (await keypair()).publicKey,
    expectedSubject: ID,
    ...over,
  });

// ------------------------------------------------------------- the anti-swap

test("THE SWAP IS REFUSED: a confirmation relabelled as an acceptance", async () => {
  // The whole reason the purpose is signed rather than prefixed. Without it
  // this title verifies perfectly and provisions a repository.
  const confirm = await titleFor(PURPOSE.CONFIRM);
  const swapped = TITLE_PREFIX + confirm.slice(CONFIRM_TITLE_PREFIX.length);

  assert.equal((await verify(confirm)).ok, true, "it verifies as what it is");
  const res = await verify(swapped);
  assert.equal(res.ok, false);
  assert.equal(res.reason, "wrong-assignment", "the digest it carries is not the one an accept needs");
});

test("…and the other direction too, which is the half that is usually missed", async () => {
  // An acceptance relabelled as a confirmation writes a claim record for an
  // account that never asked to be identified. Less damaging and just as wrong:
  // the output is a record asserting who somebody is.
  const accept = await titleFor(PURPOSE.ACCEPT);
  const swapped = CONFIRM_TITLE_PREFIX + accept.slice(TITLE_PREFIX.length);

  assert.equal((await verify(accept)).ok, true);
  assert.equal((await verify(swapped)).reason, "wrong-assignment");
});

test("the two titles for one assignment differ in the SIGNED part, not only the prefix", async () => {
  // A swap test passes vacuously if the payloads happen to be identical and
  // only the prefix differs - so assert the bytes actually diverge.
  const accept = await titleFor(PURPOSE.ACCEPT);
  const confirm = await titleFor(PURPOSE.CONFIRM);
  const signedPart = (t) => t.slice(t.indexOf(":") + 1);
  assert.notEqual(signedPart(accept), signedPart(confirm));
});

test("a verified result SAYS which purpose it was, so the broker forwards a checked value", async () => {
  // The broker must not re-read the prefix in bash: that would be a reading of
  // an unverified string that happens to agree, until somebody swaps it.
  assert.equal((await verify(await titleFor(PURPOSE.ACCEPT))).purpose, "accept");
  assert.equal((await verify(await titleFor(PURPOSE.CONFIRM))).purpose, "confirm");
});

// ------------------------------------------------------- backward compatibility

test("AN ACCEPTANCE SIGNED BEFORE ANY OF THIS covers exactly the same bytes", async () => {
  // Every broker ever published checks the hub out at `main`, so the moment
  // this merges it runs for assignments live right now. `accept` therefore
  // signs the bare id, exactly as it always did, and the purpose parameter
  // defaults to it.
  //
  // The SIGNED PART, not the whole title: ECDSA picks a fresh k per signature,
  // so two signings of identical input differ in their last 86 characters and
  // always will. Comparing titles would be asserting that ECDSA is broken.
  const { privateKey } = await keypair();
  const args = { privateKey, kid: KID, subject: ID, githubId: GITHUB_ID, nonce: "0badc0de" };
  const covered = (t) => t.slice(0, t.lastIndexOf("."));

  const withoutPurpose = await signAcceptanceTitle(args);
  const withPurpose = await signAcceptanceTitle({ ...args, purpose: PURPOSE.ACCEPT });
  assert.equal(covered(withoutPurpose), covered(withPurpose));
  assert.equal(signedSubjectFor(PURPOSE.ACCEPT, ID), ID, "accept signs the bare id");

  // And both are still accepted, which is the fact the brokers depend on.
  assert.equal((await verify(withoutPurpose)).ok, true);
  assert.equal((await verify(withPurpose)).ok, true);
});

test("a title with neither prefix is not one of ours", async () => {
  const res = await verify(`pxl-something:${(await titleFor(PURPOSE.ACCEPT)).slice(11)}`);
  assert.equal(res.reason, "not-an-acceptance-title");
});

test("the confirm title fits GitHub's issue title budget", async () => {
  // `pxl-confirm:` is one character longer than `pxl-accept:`, and the check
  // inside signAcceptanceTitle would throw rather than mint an unusable title -
  // this asserts the headroom rather than waiting to find out.
  const t = await titleFor(PURPOSE.CONFIRM);
  assert.ok(t.length <= MAX_TITLE_LENGTH, `${t.length} chars`);
  assert.ok(t.startsWith(CONFIRM_TITLE_PREFIX));
});

// ------------------------------------------------------------- the table itself

test("purposeForTitle reads the prefix, and refuses anything else", () => {
  assert.equal(purposeForTitle("pxl-accept:x"), "accept");
  assert.equal(purposeForTitle("pxl-confirm:x"), "confirm");
  for (const bad of ["pxl-confirm", "PXL-CONFIRM:x", " pxl-accept:x", "", null, undefined, 42]) {
    assert.equal(purposeForTitle(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test("an unknown purpose THROWS rather than defaulting to either", () => {
  // Defaulting to accept would provision off a purpose nobody established;
  // defaulting to confirm would silently stop provisioning a cohort. Neither
  // guess is survivable.
  for (const bad of ["", "Accept", "reject", null, undefined]) {
    assert.throws(() => titlePrefixFor(bad), /unknown acceptance purpose/);
    assert.throws(() => signedSubjectFor(bad, ID), /unknown acceptance purpose/);
  }
});

test("the prefixes are distinct and neither is a prefix of the other", () => {
  // purposeForTitle checks them in object order, which is only safe while this
  // holds. If one ever became a prefix of the other, the order would silently
  // decide the answer.
  assert.notEqual(TITLE_PREFIX, CONFIRM_TITLE_PREFIX);
  assert.ok(!TITLE_PREFIX.startsWith(CONFIRM_TITLE_PREFIX));
  assert.ok(!CONFIRM_TITLE_PREFIX.startsWith(TITLE_PREFIX));
});

// --------------------------------------------------------------- the SPA half

test("signedConfirmIssueTitle produces a title the verifier takes", async () => {
  const { privateKey } = await keypair();
  const t = await signedConfirmIssueTitle({ inviteSecret: privateKey, assignmentId: ID, githubId: GITHUB_ID });
  const res = await verify(t);
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.purpose, "confirm");
});

test("a PRE-MIGRATION link cannot confirm, and says so in words a student can act on", async () => {
  // It carries a bearer token rather than a key, so there is nothing to sign
  // with - and its broker would not accept a confirmation anyway. Without this
  // branch `fromBase64Url` throws "not base64url", which the page renders
  // verbatim at somebody who did nothing wrong.
  const legacy = `${"A".repeat(35)}.${"B".repeat(86)}`;
  await assert.rejects(
    () => signedConfirmIssueTitle({ inviteSecret: legacy, assignmentId: ID, githubId: GITHUB_ID }),
    /too old to confirm/,
  );
});

test("a session with no account id refuses to sign rather than minting a title nothing accepts", async () => {
  const { privateKey } = await keypair();
  for (const id of [undefined, null, 0, -1, "12345678"]) {
    await assert.rejects(
      () => signedConfirmIssueTitle({ inviteSecret: privateKey, assignmentId: ID, githubId: id }),
      /GitHub account id is missing/,
      `expected a refusal for ${JSON.stringify(id)}`,
    );
  }
});

test("confirmationUrl and the invitation differ only in the route segment", () => {
  // Both read `window.location.origin`, so the origin is stubbed rather than
  // the function reimplemented - the point is the shape it builds, and a second
  // copy of that here would be the thing this repo keeps being bitten by.
  const had = "window" in globalThis;
  globalThis.window = { location: { origin: "https://example.test" } };
  try {
    assert.equal(
      confirmationUrl("PXL-Org", "SECRET", "/pxl-classroom/"),
      "https://example.test/pxl-classroom/PXL-Org/c/SECRET",
    );
    assert.equal(
      invitationUrl("PXL-Org", "SECRET", "/pxl-classroom/"),
      "https://example.test/pxl-classroom/PXL-Org/i/SECRET",
    );
  } finally {
    if (!had) delete globalThis.window;
  }
});

test("the confirm link is the SAME secret - a second one would be a second thing to revoke", () => {
  // The link inherits the assignment's kill switch and nonce rotation only
  // because it IS the assignment's secret. A separate secret would need its own
  // lifetime, which is the design this deliberately avoided.
  const had = "window" in globalThis;
  globalThis.window = { location: { origin: "https://example.test" } };
  try {
    const a = invitationUrl("PXL-Org", "SECRET", "/b/");
    const c = confirmationUrl("PXL-Org", "SECRET", "/b/");
    assert.equal(a.replace("/i/", "/ /"), c.replace("/c/", "/ /"));
  } finally {
    if (!had) delete globalThis.window;
  }
});
