// What happens to a link that was handed out BEFORE the assignment migrated to
// signed acceptance (CLAIM_PLAN Phase A).
//
// That link is dead, and not by choice: the migration puts INVITE_PUBKEY on the
// broker, and from that moment a legacy `pxl-accept:<token>` title is refused.
// The student holding it has done nothing wrong and has no way to know.
//
// Deleting its acceptance card would leave them on the "not found" page, whose
// only honest wording is a guess - "it may be out of date, incomplete, or the
// assignment isn't open yet". A page may not guess why it is stuck; that is the
// same rule that governs the provisioning wait screen, and it was written after
// a live report of a student being told to accept a repository invitation that
// did not exist. So the old digest keeps resolving, to a document that states
// which of those three it actually is.
//
// The three things this file exists to stop:
//
//   1. the live card landing at the OLD digest, which would leave the new link
//      404ing for everybody
//   2. the superseded marker overwriting the live card on an assignment that
//      has NOT migrated - it has one secret, and turning its card into a
//      tombstone would kill every working link at once
//   3. either file carrying a secret - the marker sits at the digest of the
//      token that was published in a public event, so it is the most reachable
//      file the generator writes

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";

import { signInviteToken, generateKeyPair, inviteFileFor } from "../lib/invite-token.mjs";
import { generateAcceptanceKeypair } from "../lib/acceptance-signature.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const generator = join(root, "pages", "generate.mjs");
const scanner = join(root, "pages", "scan.mjs");
const fix = (n) => join(here, "fixtures", n);

const ORG = "PXLAutomation";
const ID = "test-valid";
const SIGNING = generateKeyPair();

function mintToken(assignmentId = ID) {
  return signInviteToken({
    org: ORG,
    assignmentId,
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    nonce: "0badc0de",
    privateKeyPem: SIGNING.privateKeyPem,
  });
}

/**
 * Run the real generator over one assignment document.
 *
 * `extra` is appended verbatim, so a test can add or omit invitation fields the
 * way a hand-edited control repo would.
 */
function generate(extra, { file = "valid-assignment.yml", id = ID } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pxl-superseded-"));
  mkdirSync(join(dir, "assignments"));
  writeFileSync(
    join(dir, "assignments", `${id}.yml`),
    `${readFileSync(fix(file), "utf8")}${extra}`
  );
  const outDir = join(dir, "public");
  const res = spawnSync("node", [generator], {
    env: { ...process.env, DATA_DIR: dir, OUTPUT_DIR: outDir },
    encoding: "utf8",
  });
  assert.equal(res.status, 0, `generator failed: ${res.stderr}`);
  return {
    dir,
    outDir,
    stdout: res.stdout,
    stderr: res.stderr,
    files: readdirSync(join(outDir, "i")).sort(),
    read: (name) => JSON.parse(readFileSync(join(outDir, "i", `${name}.json`), "utf8")),
  };
}

test("after migration the live card moves to the KEY's digest", async () => {
  const token = mintToken();
  const key = await generateAcceptanceKeypair();
  const out = generate(
    `\ninvite_token: ${token}\ninvite_nonce: "0badc0de"\n` +
      `invite_key: ${key.privateKey}\ninvite_pubkey: ${key.publicKey}\n`
  );

  const live = out.read(inviteFileFor(key.privateKey));
  assert.equal(live.assignment?.id, ID, "the full card belongs at the digest of the link in use");
  assert.equal(live.assignment.state, "published");
  assert.ok(!live.superseded, "the live card must not be marked superseded");
});

test("the old link still resolves, to a document that says it was replaced", async () => {
  const token = mintToken();
  const key = await generateAcceptanceKeypair();
  const out = generate(
    `\ninvite_token: ${token}\ninvite_nonce: "0badc0de"\n` +
      `invite_key: ${key.privateKey}\ninvite_pubkey: ${key.publicKey}\n`
  );

  const old = out.read(inviteFileFor(token));
  assert.equal(old.superseded, true);
  assert.equal(old.assignment_id, ID, "the page has to say WHICH link went out of date");
  assert.equal(old.organization, ORG);
  assert.ok(old.title, "naming the assignment is the point - it is already in assignments.json");

  // Not nested under `assignment`, deliberately. A browser holding a cached
  // build from before this shape existed reads `data.assignment.id`; finding
  // nothing, it falls through to its own not-found state instead of rendering
  // an assignment with no deadline, no state and an Accept button.
  assert.equal(old.assignment, undefined, "a superseded card must not look like an assignment");
});

test("both cards survive the prune, and nothing else does", async () => {
  const token = mintToken();
  const key = await generateAcceptanceKeypair();
  const out = generate(
    `\ninvite_token: ${token}\ninvite_nonce: "0badc0de"\n` +
      `invite_key: ${key.privateKey}\ninvite_pubkey: ${key.publicKey}\n`
  );

  // pruneStalePublicFiles deletes anything not registered as expected, so
  // forgetting to register the marker would delete it on the same run that
  // wrote it - the failure would be invisible in the generator's own output.
  assert.deepEqual(out.files, [
    `${inviteFileFor(key.privateKey)}.json`,
    `${inviteFileFor(token)}.json`,
  ].sort());
});

test("an assignment that has NOT migrated keeps a working card at its token", () => {
  // The dangerous inverse of the feature. One secret, so the marker must not be
  // written at all - a tombstone here would kill every live link in the cohort.
  const token = mintToken();
  const out = generate(`\ninvite_token: ${token}\ninvite_nonce: "0badc0de"\n`);

  assert.deepEqual(out.files, [`${inviteFileFor(token)}.json`]);
  const card = out.read(inviteFileFor(token));
  assert.equal(card.assignment?.id, ID);
  assert.ok(!card.superseded);
});

test("a key with no token publishes one card and no marker", async () => {
  // Hand-edited, or a future writer that stops emitting the old token. There is
  // nothing to supersede, and inventing a second file would only add a digest
  // nobody holds a link for.
  const key = await generateAcceptanceKeypair();
  const out = generate(`\ninvite_key: ${key.privateKey}\ninvite_pubkey: ${key.publicKey}\n`);

  assert.deepEqual(out.files, [`${inviteFileFor(key.privateKey)}.json`]);
  assert.equal(out.read(inviteFileFor(key.privateKey)).assignment?.id, ID);
});

test("neither file carries a secret, and the publish gate agrees", async () => {
  const token = mintToken();
  const key = await generateAcceptanceKeypair();
  const out = generate(
    `\ninvite_token: ${token}\ninvite_nonce: "0badc0de"\n` +
      `invite_key: ${key.privateKey}\ninvite_pubkey: ${key.publicKey}\n`
  );

  for (const name of out.files) {
    const text = readFileSync(join(out.outDir, "i", name), "utf8");
    assert.ok(!text.includes(token), `${name} carries the invitation token`);
    assert.ok(!text.includes(key.privateKey), `${name} carries the invitation key`);
  }

  // The scanner is the backstop rather than the assertion: it now knows the key
  // shape, so a generator that leaked one would fail the deploy instead of
  // publishing it. Running it here proves the two agree on this output.
  const scan = spawnSync("node", [scanner, out.outDir], { encoding: "utf8" });
  assert.equal(scan.status, 0, `privacy scanner blocked a clean output: ${scan.stdout}${scan.stderr}`);
});

test("a group assignment's teams file follows the live card, not the marker", async () => {
  const token = mintToken("group-valid");
  const key = await generateAcceptanceKeypair();

  const dir = mkdtempSync(join(tmpdir(), "pxl-superseded-teams-"));
  mkdirSync(join(dir, "assignments"));
  mkdirSync(join(dir, "teams", "group-valid"), { recursive: true });
  writeFileSync(
    join(dir, "teams", "group-valid", "alpha.json"),
    JSON.stringify({ team_slug: "alpha", team_name: "Alpha", members: ["stud-a"], max_members: 3 })
  );
  writeFileSync(
    join(dir, "assignments", "group-valid.yml"),
    [
      "id: group-valid",
      "title: Group Valid",
      `organization: ${ORG}`,
      "state: published",
      "assignment_type: group",
      "opens_at: 2026-01-01T00:00:00Z",
      "deadline_at: 2099-01-01T00:00:00Z",
      "repository_name_pattern: group-valid-{team_slug}",
      "group_config:",
      "  max_team_size: 3",
      `invite_token: ${token}`,
      'invite_nonce: "0badc0de"',
      `invite_key: ${key.privateKey}`,
      `invite_pubkey: ${key.publicKey}`,
      "",
    ].join("\n")
  );

  const outDir = join(dir, "public");
  const res = spawnSync("node", [generator], {
    env: { ...process.env, DATA_DIR: dir, OUTPUT_DIR: outDir },
    encoding: "utf8",
  });
  assert.equal(res.status, 0, `generator failed: ${res.stderr}`);

  const files = readdirSync(join(outDir, "i")).sort();
  assert.deepEqual(
    files,
    [
      `${inviteFileFor(key.privateKey)}.json`,
      `${inviteFileFor(key.privateKey)}.teams.json`,
      `${inviteFileFor(token)}.json`,
    ].sort(),
    "the cohort list belongs behind the link in use - a superseded link must not fetch it"
  );

  const teams = JSON.parse(
    readFileSync(join(outDir, "i", `${inviteFileFor(key.privateKey)}.teams.json`), "utf8")
  );
  assert.equal(teams.teams[0].team_slug, "alpha");
});

// ============================================================ ROTATION
//
// `regenerate_invite` mints a fresh keypair, which is how a lecturer answers a
// leaked link. Migration is not the only way a link dies, and it is not even the
// common one - rotation is the recurring case.
//
// The generator used to prune the old card, so a rotated-away link landed on the
// not-found page: "It may be out of date, incomplete, or the assignment isn't
// open yet" - a guess between three causes, one of which is right. The card
// names its own assignment, so the generator can tell without being told: if
// that assignment is still published, the file becomes a marker instead of
// disappearing. No record of retired secrets is kept anywhere, which matters,
// because a list of them on the assignment is one more field `buildDoc` could
// silently drop.

/** Run the generator twice over the same output dir, rotating in between. */
async function rotate({ archiveAfter = false, group = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pxl-rotate-"));
  mkdirSync(join(dir, "assignments"));
  const outDir = join(dir, "public");
  const base = readFileSync(fix("valid-assignment.yml"), "utf8");

  const write = (token, key, state = "published") => {
    let text = `${base}\ninvite_token: ${token}\ninvite_nonce: "0badc0de"\n` +
      `invite_key: ${key.privateKey}\ninvite_pubkey: ${key.publicKey}\n`;
    if (group) {
      text += "assignment_type: group\ngroup_config:\n  max_team_size: 3\n";
    }
    if (state !== "published") text = text.replace(/^state:.*$/m, `state: ${state}`);
    writeFileSync(join(dir, "assignments", `${ID}.yml`), text);
  };
  const run = () => {
    const res = spawnSync("node", [generator], {
      env: { ...process.env, DATA_DIR: dir, OUTPUT_DIR: outDir },
      encoding: "utf8",
    });
    assert.equal(res.status, 0, `generator failed: ${res.stderr}`);
    return res;
  };

  if (group) {
    mkdirSync(join(dir, "teams", ID), { recursive: true });
    writeFileSync(
      join(dir, "teams", ID, "alpha.json"),
      JSON.stringify({ team_slug: "alpha", team_name: "Alpha", members: ["stud-a"], max_members: 3 })
    );
  }

  const oldToken = mintToken();
  const oldKey = await generateAcceptanceKeypair();
  write(oldToken, oldKey);
  run();
  const before = readdirSync(join(outDir, "i")).sort();

  const newToken = mintToken(`${ID}-rotated`);
  const newKey = await generateAcceptanceKeypair();
  write(newToken, newKey, archiveAfter ? "archived" : "published");
  run();

  return {
    outDir,
    before,
    after: readdirSync(join(outDir, "i")).sort(),
    oldKey,
    newKey,
    oldToken,
    newToken,
    read: (n) => JSON.parse(readFileSync(join(outDir, "i", `${n}.json`), "utf8")),
  };
}

test("a rotated-away link still resolves, and says it was replaced", async () => {
  const r = await rotate();
  const retired = r.read(inviteFileFor(r.oldKey.privateKey));
  assert.equal(retired.superseded, true);
  assert.equal(retired.assignment_id, ID);
  assert.ok(retired.title, "the student has to know which link went out of date");
  assert.equal(retired.assignment, undefined, "a marker must not look like an assignment");
});

test("and the new link is the live one", async () => {
  const r = await rotate();
  const live = r.read(inviteFileFor(r.newKey.privateKey));
  assert.equal(live.assignment?.id, ID);
  assert.ok(!live.superseded);
});

test("the retired card carries no secret, old or new", async () => {
  const r = await rotate();
  const text = readFileSync(join(r.outDir, "i", `${inviteFileFor(r.oldKey.privateKey)}.json`), "utf8");
  for (const secret of [r.oldKey.privateKey, r.newKey.privateKey, r.oldToken, r.newToken]) {
    assert.ok(!text.includes(secret), "a retired card must not carry any invitation");
  }
});

test("a retired GROUP link cannot fetch the cohort list", async () => {
  // The teams file is the roster by another name. It is pruned rather than
  // retired, so an old link resolves to the marker and nothing else.
  const r = await rotate({ group: true });
  assert.ok(
    r.after.includes(`${inviteFileFor(r.oldKey.privateKey)}.json`),
    "the old card should have been retired",
  );
  assert.ok(
    !r.after.includes(`${inviteFileFor(r.oldKey.privateKey)}.teams.json`),
    "but its teams file must be gone",
  );
  assert.ok(r.after.includes(`${inviteFileFor(r.newKey.privateKey)}.teams.json`));
});

test("markers do not survive the assignment itself", async () => {
  // Otherwise every rotation leaves a file behind for ever, including for
  // assignments that have been archived and pruned from the site.
  const r = await rotate({ archiveAfter: true });
  assert.deepEqual(r.after, [], "an archived assignment publishes nothing at all");
});

test("retiring is idempotent across regenerations", async () => {
  // regenerate-dashboard runs on every acceptance. A marker that got rewritten,
  // renamed or dropped on the second pass would be a link that worked once.
  const r = await rotate();
  const first = r.read(inviteFileFor(r.oldKey.privateKey));
  const res = spawnSync("node", [generator], {
    env: { ...process.env, DATA_DIR: dirname(dirname(r.outDir)), OUTPUT_DIR: r.outDir },
    encoding: "utf8",
  });
  // The data dir is the parent of public/, which is how the helper laid it out.
  assert.equal(res.status, 0, `generator failed: ${res.stderr}`);
  assert.deepEqual(r.read(inviteFileFor(r.oldKey.privateKey)), first);
});
