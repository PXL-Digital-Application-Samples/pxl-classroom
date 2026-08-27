// Unreadable is not evidence, Tier 5 edition.
//
// The acceptance-card check fetches `public/i/<digest>.json` and used to be a
// bare `cardRes.ok ? ok : fail`. A 404 genuinely means no card was compiled and
// the student's link will not resolve - that is the finding it exists for. But
// a 403, a 500 or a rate limit means we could not look, and reporting "the
// student's link will not resolve" off one of those tells a lecturer their
// cohort is broken on the strength of a failed request, and sends them to
// regenerate a dashboard that was never the problem.
//
// Nine other checks in lib/diagnostics.mjs already split 404 from the rest -
// the broker repo, the control repo, the assignment YAML, the roster, the
// template, the workflow file. This one did not.
import { test } from "node:test";
import assert from "node:assert/strict";

import { runDiagnostics } from "../lib/diagnostics.mjs";
import { signInviteToken, generateKeyPair } from "../lib/invite-token.mjs";

const ORG = "PXL-CSMobile";
const ID = "card-readability";
const KEYPAIR = generateKeyPair();
const NONCE = "a1b2c3d4";
const TOKEN = signInviteToken({
  org: ORG,
  assignmentId: ID,
  expiresAt: "2099-01-01T00:00:00.000Z",
  nonce: NONCE,
  kid: 1,
  privateKeyPem: KEYPAIR.privateKeyPem,
});

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

/** Everything healthy except the acceptance card, whose status is the variable. */
function mockRequest(cardStatus) {
  return async (_method, path) => {
    if (path.includes("/contents/public/i/")) {
      return cardStatus === 200
        ? { ok: true, status: 200, data: { content: b64("{}") } }
        : { ok: false, status: cardStatus, data: { message: "boom" } };
    }
    if (path.includes("invite-keys.json")) {
      return { ok: true, status: 200, data: { content: b64(JSON.stringify({ keys: { 1: KEYPAIR.publicKeyBase64 } })) } };
    }
    if (path.includes("/actions/variables")) {
      return {
        ok: true,
        status: 200,
        data: { variables: [{ name: "INVITE_NONCE", value: NONCE }, { name: "INVITE_ENABLED", value: "true" }] },
      };
    }
    if (path.includes("/issues?state=all")) return { ok: true, status: 200, data: [] };
    if (path.startsWith("/apps/")) return { ok: true, status: 200, data: { permissions: {} } };
    return { ok: true, status: 200, data: {} };
  };
}

async function cardCheck(cardStatus) {
  const res = await runDiagnostics({
    request: mockRequest(cardStatus),
    org: ORG,
    assignmentId: ID,
    formDoc: {
      schema_version: 1,
      id: ID,
      title: "Card Readability",
      organization: ORG,
      template: { owner: ORG, repository: "template-project" },
      repository_name_pattern: `${ID}-{github_login}`,
      opens_at: "2026-09-01T08:00:00Z",
      deadline_at: "2026-10-01T22:00:00Z",
      state: "published",
      invite_token: TOKEN,
      invite_nonce: NONCE,
    },
  });
  const all = (res?.tiers ?? []).flatMap((t) => t.checks ?? []).concat(res?.checks ?? []);
  return all.find((c) => c.id === "invitation-card") ?? null;
}

test("a 404 on the card is a real finding - the link will not resolve", async () => {
  const c = await cardCheck(404);
  assert.ok(c, "the invitation-card check must run");
  assert.equal(c.severity, "fail");
  assert.match(c.message, /will not resolve/i);
  assert.equal(c.fixAction?.type, "regen_dashboard", "and it offers the repair");
});

test("a 500 on the card is NOT evidence the link is broken", async () => {
  const c = await cardCheck(500);
  assert.ok(c, "the invitation-card check must still run");
  assert.notEqual(c.severity, "fail", "an unreadable card must not be reported as a broken link");
  assert.match(c.message, /could not read/i, "it must say it could not look");
  assert.match(c.message, /500/, "and name the status, so the cause is traceable");
  assert.ok(
    !/will not resolve/i.test(c.message),
    "it must not claim the student's link is broken",
  );
  assert.ok(!c.fixAction, "and must not send the lecturer to regenerate a dashboard that was not the problem");
});

test("a readable card still reports ok", async () => {
  const c = await cardCheck(200);
  assert.ok(c);
  assert.equal(c.severity, "ok");
});
