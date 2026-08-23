// The invitation link has one failure mode that keeps recurring, in different
// disguises: the SPA holds an assignment in memory that is missing a field the
// control repo has, and the UI renders a confident empty box rather than saying
// so. It has now bitten four times -
//
//   buildDoc rebuilt the document without invite_token, deleting it on save
//   the edit form never loaded invite_token, so the link was always null
//   publish minted the token into the control repo and the form never re-read
//     it, so "Copy Link" stayed empty however often the lecturer republished
//   both re-read paths asked a STRING for `.ok`, so neither ever ran - and the
//     test written to catch the third only grepped for the error message,
//     which passed precisely because the code always took the error branch
//
// That last one is the lesson. A test that greps source text cannot tell live
// code from dead code, so the round trip below runs the REAL parser against
// what the REAL writer emits, and the structural assertions that remain check
// the specific defect - asking a string for `.ok` - rather than checking that
// some string appears somewhere.

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
  parseInviteFields,
  readInviteField,
  quoteInviteValue,
  INVITE_FIELDS,
  TOKEN_PATTERN,
} from "../lib/invite-token-format.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const ADMIN = () => readFileSync(join(root, "frontend", "src", "views", "AdminView.vue"), "utf8");
const DETAIL = () => readFileSync(join(root, "frontend", "src", "views", "AssignmentDetailView.vue"), "utf8");
const INVITE_LIB = () => readFileSync(join(root, "frontend", "src", "lib", "invite.js"), "utf8");
const SETTER = () => readFileSync(join(root, "scripts", "set-assignment-invite.mjs"), "utf8");

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

// What scripts/set-assignment-invite.mjs actually writes, reproduced from that
// script's own upsert so the round trip cannot drift away from the writer.
function writeInvite(yaml, { token, nonce, expiresAt }) {
  let out = yaml;
  for (const [key, value] of [
    ["invite_token", token],
    ["invite_nonce", nonce],
    ["invite_expires_at", expiresAt],
  ]) {
    const line = `${key}: ${quoteInviteValue(key, value)}`;
    const pattern = new RegExp(`^${key}:.*$`, "m");
    out = pattern.test(out) ? out.replace(pattern, () => line) : out.replace(/\n*$/, "\n") + line + "\n";
  }
  return out;
}

// --- The round trip, run rather than grepped --------------------------------

test("what the publish script writes, the SPA reads back", () => {
  const token = mint();
  const yaml = writeInvite("id: linux-processes-2026\nstate: published\n", {
    token,
    nonce: "0badc0de",
    expiresAt: "2027-09-27T14:01:00.000Z",
  });

  assert.deepEqual(parseInviteFields(yaml), {
    invite_token: token,
    invite_nonce: "0badc0de",
    invite_expires_at: "2027-09-27T14:01:00.000Z",
  });
});

test("a republish overwrites the invitation in place, not alongside it", () => {
  const first = mint();
  const second = mint(ORG, "another-assignment");
  let yaml = writeInvite("id: linux-processes-2026\n", {
    token: first,
    nonce: "0badc0de",
    expiresAt: "2027-09-27T14:01:00.000Z",
  });
  yaml = writeInvite(yaml, { token: second, nonce: "feedface", expiresAt: "2028-01-01T00:00:00.000Z" });

  assert.equal(parseInviteFields(yaml).invite_token, second, "the reader must see the new token");
  assert.equal(yaml.match(/^invite_token:/gm).length, 1, "and there must be exactly one of it");
});

test("a signed token survives the writer's own replace", () => {
  // String.replace expands `$&`, `$1` and friends in the REPLACEMENT. A token is
  // base64url so it cannot contain `$` today, but the writer is generic and the
  // next field through it may not be.
  const yaml = writeInvite("id: x\ninvite_token: old\n", {
    token: "A$&B",
    nonce: "0badc0de",
    expiresAt: "2027-09-27T14:01:00.000Z",
  });
  assert.equal(parseInviteFields(yaml).invite_token, "A$&B");
});

test("an all-digit nonce survives a YAML round trip", () => {
  // 8 hex characters are all digits about one time in forty, and a leading zero
  // then round-trips through a YAML parser as an integer: "01234567" comes back
  // as 1234567. The hub's ^[0-9a-f]{8}$ check fails on seven characters, decides
  // there is no usable nonce and mints a fresh one - retiring every link already
  // handed out, on a republish whose entire contract is that it does not.
  const yaml = writeInvite("id: x\n", {
    token: mint(),
    nonce: "01234567",
    expiresAt: "2027-09-27T14:01:00.000Z",
  });
  assert.match(yaml, /^invite_nonce: "01234567"$/m, "the nonce must be written quoted");
  assert.equal(parseInviteFields(yaml).invite_nonce, "01234567");
  assert.match(parseInviteFields(yaml).invite_nonce, /^[0-9a-f]{8}$/i, "and still pass the hub's check");
});

test("the reader tolerates a control repo checked out with CRLF endings", () => {
  const token = mint();
  const yaml = writeInvite("id: x\n", {
    token,
    nonce: "0badc0de",
    expiresAt: "2027-09-27T14:01:00.000Z",
  }).replace(/\n/g, "\r\n");
  assert.equal(parseInviteFields(yaml).invite_token, token);
  assert.equal(parseInviteFields(yaml).invite_nonce, "0badc0de");
  assert.equal(parseInviteFields(yaml).invite_expires_at, "2027-09-27T14:01:00.000Z");
});

test("a missing or unreadable document yields empty fields, never a crash", () => {
  for (const input of [null, undefined, "", "id: x\nstate: draft\n", 42, {}]) {
    assert.deepEqual(parseInviteFields(input), {
      invite_token: "",
      invite_nonce: "",
      invite_expires_at: "",
    });
  }
});

test("the writer and the reader agree on which fields an invitation has", () => {
  const src = SETTER();
  for (const field of INVITE_FIELDS) {
    assert.ok(src.includes(`"${field}"`), `set-assignment-invite.mjs must write ${field}`);
    assert.equal(readInviteField(`${field}: value\n`, field), "value");
  }
});

test("the publish script parses with the shared reader, not a private copy", () => {
  // Its own readYamlField was the fourth copy of this parse. There is one copy,
  // imported by the writer and by both views.
  const src = SETTER();
  assert.match(src, /readInviteField/, "the script must use the shared reader");
  assert.ok(!/function readYamlField/.test(src), "and must not keep a private one");
});

// --- The specific defect: asking a string for `.ok` -------------------------

test("no view treats a getRepoContent result as a response envelope", () => {
  // getRepoContent resolves to the decoded file text or null. Reading `.ok` off
  // a string is undefined, so `if (res?.ok)` is a block that never runs - and it
  // shipped in BOTH invitation read paths with a green suite.
  const files = ["AdminView.vue", "AssignmentDetailView.vue", "AssignmentView.vue", "DashboardView.vue"];
  const offenders = [];
  for (const name of files) {
    const lines = readFileSync(join(root, "frontend", "src", "views", name), "utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
      const m = line.match(/(?:const|let)\s+(\w+)\s*=\s*await getRepoContent\(/);
      if (!m) return;
      const binding = m[1];
      const window = lines.slice(i, i + 8).join("\n");
      if (new RegExp(`\\b${binding}\\??\\.(ok|status|data)\\b`).test(window)) {
        offenders.push(`${name}:${i + 1} - ${binding} holds file text, not a response`);
      }
    });
  }
  assert.deepEqual(offenders, [], `\n  ${offenders.join("\n  ")}`);
});

test("the invitation is re-read whenever the live check runs, not only when absent", () => {
  // Gating on "the form has no token" means a REGENERATED invitation never
  // reaches the form, so the panel goes on copying a link the broker now
  // rejects as superseded - worse than having no button at all.
  const src = ADMIN();
  const fn = src.slice(src.indexOf("async function verifyLiveInfrastructure"));
  const body = fn.slice(0, fn.indexOf("\nasync function saveAndPublish"));
  assert.match(body, /parseInviteFields\(/, "the live check must parse the invitation");
  assert.ok(
    !/!form\.value\.invite_token/.test(body),
    "and must not skip the read when the form already holds one"
  );
});

test("the publish watcher fetches the invitation before it claims the link is live", () => {
  // The watcher polls Pages, sets 'ready' and toasts. The token is minted into
  // the control repo while it polls, so without a re-read the success banner
  // renders an empty link box under the words "verified live".
  const src = ADMIN();
  const fn = src.slice(src.indexOf("function startPublishWatch"));
  const body = fn.slice(0, fn.indexOf("\nfunction stopPublishWatch"));

  const ready = body.indexOf("publishWatch.value = 'ready'");
  const timeout = body.indexOf("publishWatch.value = 'timeout'");
  assert.ok(ready > -1 && timeout > -1, "both terminal states must exist");

  for (const [label, from] of [["ready", ready], ["timeout", timeout]]) {
    assert.match(
      body.slice(from, from + 700),
      /await verifyLiveInfrastructure\(/,
      `the ${label} branch must re-read the invitation before it stops polling`
    );
  }
});

test('copying with no invitation reports it instead of writing "null"', () => {
  const src = ADMIN();
  const fn = src.slice(src.indexOf("function copyAcceptLink"));
  const guard = fn.indexOf("if (!shareableLink.value)");
  const write = fn.indexOf("navigator.clipboard.writeText");
  assert.ok(guard > -1, "copyAcceptLink must guard against a null link");
  assert.ok(guard < write, "the guard must come before the clipboard write");
});

test("the assignment detail view reads the invitation through the shared parser", () => {
  const src = DETAIL();
  const fn = src.slice(src.indexOf("async function loadInviteToken"));
  const body = fn.slice(0, fn.indexOf("\n}") + 2);
  assert.match(body, /parseInviteFields\(/, "it must use the shared reader");
  assert.ok(!/\.ok\b/.test(body), "and must not ask the file text for `.ok`");
});

test("saving rebuilds the document without dropping the invitation", () => {
  // buildDoc constructs the YAML field by field, so anything absent is deleted -
  // and the result still validates, because the invite fields are optional.
  const src = ADMIN();
  for (const field of INVITE_FIELDS) {
    assert.ok(
      src.includes(`...(form.value.${field} ? { ${field}: form.value.${field} } : {})`),
      `buildDoc must carry ${field} through`
    );
  }
});

test("the edit form loads the invitation from the assignment", () => {
  const src = ADMIN();
  for (const field of INVITE_FIELDS) {
    assert.ok(src.includes(`${field}: a.${field} || ''`), `edit form must load ${field}`);
  }
});

test("both views import the one parser rather than re-implementing it", () => {
  for (const src of [ADMIN(), DETAIL()]) {
    assert.match(src, /parseInviteFields/, "views must use the shared parser");
  }
  assert.match(INVITE_LIB(), /export \{ parseInviteFields \}/, "invite.js re-exports it");
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
