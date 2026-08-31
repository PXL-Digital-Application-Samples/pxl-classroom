// Nothing tracked by git carries a credential.
//
// GitHub's own secret scanning with push protection is enabled on the hub, and
// that is the real control - it BLOCKS a push carrying a recognised provider
// pattern, which no test here can do. This exists for the gap that control has:
// it only knows patterns GitHub recognises, and the two credentials this system
// mints itself are not among them.
//
//   - The invitation link's PKCS#8 P-256 private key (ARCHITECTURE §4.3.2).
//     184 base64url characters, no provider prefix, nothing for GitHub to key
//     on. `lib/public-text.mjs` already recognises it by its DER header for the
//     Pages publish gate; this points the same rule at the repository.
//   - The claim private key, same shape.
//
// The other half is `.env.test`, which holds four live classic PATs. It is
// gitignored and push protection would refuse `ghp_` anyway, so this is belt to
// those braces - and it is the braces that matter. The point of asserting the
// ignore rule is that removing it is a silent change: nothing else in the repo
// would notice, and the file would then be one `git add -A` from staged.
//
// Scanned from `git ls-files` rather than the filesystem, deliberately. The
// question is not "is there a secret on this machine" - there is, and it is
// meant to be there - but "is one TRACKED", which is the thing that travels.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PUBLIC_TEXT_RULES } from "../lib/public-text.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Provider tokens, which GitHub also blocks - kept so a local run says so. */
const PROVIDER_TOKEN = /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/g;

/** A PEM private key of any flavour, committed in full. */
const PEM_PRIVATE_KEY = /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g;

// The link-secret rule from the shared module, so the repository scan and the
// Pages publish gate cannot disagree about what a private key looks like.
const linkSecretRule = PUBLIC_TEXT_RULES.find((r) => /key/i.test(r.name) || /private/i.test(r.label ?? ""));

function trackedFiles() {
  return execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

// Files that legitimately contain the SHAPE of a credential while containing no
// credential: the fixtures that exist to prove a scanner fires, and the tests
// and docs that quote a pattern to explain it. Listed explicitly rather than
// pattern-matched on "tests/", so a real key committed into a test still fails.
// Each was read before being listed, and each is genuinely inert:
//   public-leaky.json          - the fixture that proves pages/scan.mjs fires.
//   public-text.test.mjs       - quotes header strings as scanner test cases.
//   installation-approvals     - "-----BEGIN PRIVATE KEY-----\nnot-a-key\n..."
//                                deliberately unmintable, to test DID NOT RUN.
//   e2e-fixtures.mjs           - E2E_CLAIM_KEYPAIR, a REAL P-256 keypair minted
//                                for the suite. Inert only because it is not the
//                                production one, which is why the test below
//                                asserts exactly that rather than trusting the
//                                filename.
const EXPECTED_SHAPES = new Set([
  "tests/fixtures/public-leaky.json",
  "tests/fixtures/e2e-fixtures.mjs",
  "tests/tracked-secrets.test.mjs",
  "tests/public-text.test.mjs",
  "tests/installation-approvals.test.mjs",
  "lib/public-text.mjs",
  "tests/public-text-token-shape.test.mjs",
]);

test("no tracked file carries a provider token or a PEM private key", () => {
  const findings = [];
  let scanned = 0;

  for (const file of trackedFiles()) {
    const path = join(root, file);
    if (!existsSync(path)) continue; // a deletion staged but not committed
    let text;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue; // binary
    }
    scanned++;
    if (EXPECTED_SHAPES.has(file)) continue;

    for (const [label, re] of [
      ["provider token", PROVIDER_TOKEN],
      ["PEM private key", PEM_PRIVATE_KEY],
    ]) {
      // Rebuilt per file: these carry /g, and a leftover lastIndex would make
      // the scan catch things only sometimes - the bug findPublicTextViolation
      // already documents.
      for (const m of text.matchAll(new RegExp(re.source, re.flags))) {
        findings.push(`${file}: ${label} (${m[0].slice(0, 12)}…)`);
      }
    }
  }

  assert.deepEqual(findings, [], findings.join("\n"));
  // A floor: a walk that silently stops matching looks exactly like a clean repo.
  assert.ok(scanned > 200, `expected to scan the repo, only read ${scanned} files`);
});

test("no tracked file carries an invitation or claim PRIVATE key", () => {
  // GitHub cannot see these - they have no provider prefix - so this is the only
  // thing looking. The rule comes from lib/public-text.mjs so the repository
  // scan and the Pages publish gate cannot drift on what a key looks like.
  assert.ok(linkSecretRule, "lib/public-text.mjs must still carry a private-key rule to share");

  const findings = [];
  for (const file of trackedFiles()) {
    if (EXPECTED_SHAPES.has(file)) continue;
    const path = join(root, file);
    if (!existsSync(path)) continue;
    let text;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    for (const m of text.matchAll(new RegExp(linkSecretRule.re.source, linkSecretRule.re.flags))) {
      findings.push(`${file}: ${linkSecretRule.label} (${m[0].slice(0, 16)}…)`);
    }
  }
  assert.deepEqual(findings, [], findings.join("\n"));
});

test("the e2e fixture keypair is NOT the production one", () => {
  // The allowlist above exempts tests/fixtures/e2e-fixtures.mjs because it holds
  // a real P-256 private key on purpose. That exemption is only safe while the
  // key is a throwaway - so this is the assertion the exemption rests on, and
  // it is the one that would fire the day somebody pastes the live claim key
  // into a fixture to make a test pass. Verified 2026-08-31: the two differ.
  const fixture = readFileSync(join(root, "tests", "fixtures", "e2e-fixtures.mjs"), "utf8");
  const live = JSON.parse(readFileSync(join(root, "acceptance", "claim-keys.json"), "utf8"));

  for (const publicKey of Object.values(live.keys ?? {})) {
    assert.ok(
      !fixture.includes(publicKey),
      "the production claim public key appears in the e2e fixture - its private half may have followed it",
    );
  }
});

test("acceptance/claim-keys.json holds only PUBLIC halves", () => {
  // Already covered by tests/claim-keys.test.mjs on length; asserted here too
  // because this file is the one someone reads when asking "what stops a key
  // being committed", and an answer that omits the file most likely to receive
  // one is not an answer.
  const doc = JSON.parse(readFileSync(join(root, "acceptance", "claim-keys.json"), "utf8"));
  for (const [kid, key] of Object.entries(doc.keys ?? {})) {
    assert.equal(key.length, 122, `claim key ${kid} is ${key.length} chars - a PRIVATE key is 184`);
  }
});

test(".env* stays gitignored, and the file itself is untracked", () => {
  // Removing the ignore rule is a silent change: nothing else in the repo would
  // notice, and .env.test - four live classic PATs - would be one `git add -A`
  // from staged. Push protection would refuse the push, but a local commit
  // still puts them in the history of every clone that pulls before it is
  // rewritten.
  const ignore = readFileSync(join(root, ".gitignore"), "utf8");
  assert.match(ignore, /^\.env\*$/m, ".gitignore must still cover every .env file");

  const tracked = new Set(trackedFiles());
  for (const file of tracked) {
    assert.ok(!/^\.env(\.|$)/.test(file), `${file} is tracked and must not be`);
  }
});
