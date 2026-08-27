// The claim's journey: browser -> public issue body -> hub.
//
// The body is UNTRUSTED - a public issue anyone can open by hand - and it is
// shared with the team payload, so two readers parse the same JSON and neither
// may break the other. This drives the REAL parser and the REAL crypto, so a
// change to either goes red here rather than at a student's accept button.
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseClaimFields, encryptClaim, decryptClaim, generateClaimKeypair } from "../lib/claim.mjs";
import { parseTeamPayload } from "../lib/team-payload.mjs";

const ID = 4242;
const ASSIGNMENT = "net-advanced-guts-2627";

test("a real sealed claim survives the body round trip", async () => {
  const { publicKey, privateKey } = await generateClaimKeypair();
  const sealed = await encryptClaim({
    publicKey, email: "alice@student.pxl.be", githubId: ID, assignmentId: ASSIGNMENT,
  });

  // Exactly what the SPA will write as the issue body.
  const body = JSON.stringify({ claim: sealed, claim_verified: true });

  const parsed = parseClaimFields({ body });
  assert.equal(parsed.claim_payload, sealed, "the ciphertext must survive byte-identically");
  assert.equal(parsed.claim_verified, true);

  const opened = await decryptClaim({ privateKey, payload: parsed.claim_payload });
  assert.equal(opened.email, "alice@student.pxl.be");
  assert.equal(opened.githubId, ID);
});

test("the two readers of one body do not interfere", async () => {
  // A group acceptance carries both. Each reader must see its own fields and
  // ignore the other's entirely.
  const { publicKey } = await generateClaimKeypair();
  const sealed = await encryptClaim({
    publicKey, email: "a@student.pxl.be", githubId: ID, assignmentId: ASSIGNMENT,
  });
  const body = JSON.stringify({
    team_slug: "team-alpha", team_name: "Alpha", team_action: "join",
    claim: sealed, claim_verified: true,
  });

  const team = parseTeamPayload({ body, title: "team:team-alpha" });
  assert.equal(team.team_slug, "team-alpha");
  assert.equal(team.team_action, "join");

  const claim = parseClaimFields({ body });
  assert.equal(claim.claim_payload, sealed);
  assert.equal(claim.claim_verified, true);

  // And a body with only team fields yields no claim, not a crash.
  const teamOnly = JSON.stringify({ team_slug: "team-alpha" });
  assert.deepEqual(parseClaimFields({ body: teamOnly }), { claim_payload: "", claim_verified: false });
});

test("claim_verified must be strictly true, never merely truthy", () => {
  // The field arrives in a JSON body a student can write by hand, and the
  // string "false" is truthy. Recording a forged-looking `true` because of a
  // loose check would corrupt the one signal a cohort review depends on.
  for (const v of ["true", "false", 1, "yes", {}, [], "TRUE"]) {
    assert.equal(
      parseClaimFields({ body: JSON.stringify({ claim_verified: v }) }).claim_verified,
      false,
      `claim_verified: ${JSON.stringify(v)} must not read as true`,
    );
  }
  assert.equal(parseClaimFields({ body: JSON.stringify({ claim_verified: true }) }).claim_verified, true);
});

test("a junk body yields no claim rather than reaching the crypto", () => {
  for (const body of [
    undefined, null, "", "   ", "not json", "[1,2,3]", '"a string"', "42",
    JSON.stringify({ claim: 12345 }),
    JSON.stringify({ claim: null }),
    JSON.stringify({ claim: "nodots" }),
    JSON.stringify({ claim: "only.three.parts" }),
    JSON.stringify({ claim: "a.b.c.d.e" }),
    JSON.stringify({ claim: "has spaces.b.c.d" }),
    JSON.stringify({ claim: `${"x".repeat(2000)}.b.c.d` }),
  ]) {
    const out = parseClaimFields({ body });
    assert.equal(out.claim_payload, "", `${String(body).slice(0, 40)} must not produce a payload`);
  }
});

test("the shape check is a filter, not validation - a well-shaped forgery still fails to open", async () => {
  // parseClaimFields only proves "this could be a payload", so nothing junk
  // reaches the crypto and an unbounded field cannot make the hub do work. The
  // real refusal is the AEAD tag, and it must still be the thing that decides.
  const { privateKey } = await generateClaimKeypair();
  const forged = `c1.${"A".repeat(122)}.${"B".repeat(16)}.${"C".repeat(40)}`;

  const parsed = parseClaimFields({ body: JSON.stringify({ claim: forged }) });
  assert.equal(parsed.claim_payload, forged, "well-shaped junk passes the cheap filter");

  await assert.rejects(
    () => decryptClaim({ privateKey, payload: parsed.claim_payload }),
    "and is refused by the crypto, which is where the decision belongs",
  );
});

test("a claim sealed for one account does not open as another", async () => {
  // The end-to-end form of the replay check: the hub compares the id inside
  // the sealed payload with the issue author, and the body cannot change it.
  const { publicKey, privateKey } = await generateClaimKeypair();
  const sealed = await encryptClaim({
    publicKey, email: "victim@student.pxl.be", githubId: ID, assignmentId: ASSIGNMENT,
  });
  const lifted = parseClaimFields({ body: JSON.stringify({ claim: sealed, claim_verified: true }) });
  const opened = await decryptClaim({ privateKey, payload: lifted.claim_payload });

  assert.equal(opened.githubId, ID);
  assert.notEqual(opened.githubId, 9999, "an attacker's own id is not what comes out");
});
