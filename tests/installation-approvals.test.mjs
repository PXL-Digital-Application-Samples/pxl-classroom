// Who has actually approved the App's permissions?
//
// Widening a GitHub App's permissions leaves every existing installation on the
// OLD set until that org's owner accepts the request. The App looks correct,
// scripts/check-app-declaration.mjs passes, and the new feature is dead on the
// orgs nobody clicked through - with nothing red anywhere. On the 2026-08-25
// `members` + `organization_administration: write` rollout, 7 of 11 orgs could
// be confirmed from an owner account and 4 could not be seen at all.
//
// The two failure modes these tests exist to pin:
//   1. a lagging installation is not reported (the feature silently does
//      nothing on that org), and
//   2. "everyone has approved" is printed off a TRUNCATED read - the exact
//      one-page-is-not-the-list shape CLAUDE.md warns about, and the worst
//      possible answer because it is a confident all-clear.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { installationApprovalGaps, ACCOUNT_LEVEL_PERMISSIONS } from "../lib/audit.mjs";
import { generateAppJwt, MAX_LIFETIME_S, BACKDATE_S } from "../lib/app-jwt.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(root, "scripts", "check-installation-approvals.mjs");

// One 2048-bit key for the whole file - generating per test is ~100ms each.
const { privateKey: PRIVATE_KEY } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const DECLARED = { members: "write", organization_administration: "write", contents: "write" };

function installation(login, permissions, id = 1) {
  return { id, account: { login }, permissions };
}

// --------------------------------------------------------------------------
// installationApprovalGaps - the comparison itself
// --------------------------------------------------------------------------

test("gaps: an installation matching the declaration is not reported", () => {
  const gaps = installationApprovalGaps(DECLARED, [installation("OrgA", { ...DECLARED })]);
  assert.deepEqual(gaps, []);
});

test("gaps: a missing permission is reported with declared and actual", () => {
  const gaps = installationApprovalGaps(DECLARED, [
    installation("OrgA", { organization_administration: "write", contents: "write" }),
  ]);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].account, "OrgA");
  assert.deepEqual(gaps[0].missing, [
    { permission: "members", declared: "write", actual: null },
  ]);
});

test("gaps: a DOWNGRADED level counts as unapproved - read does not satisfy write", () => {
  // This is the whole 2026-08-25 case: organization_administration was `read`
  // and the rulesets feature needs `write`. An equality check would pass it.
  const gaps = installationApprovalGaps(DECLARED, [
    installation("OrgA", { ...DECLARED, organization_administration: "read" }),
  ]);
  assert.deepEqual(gaps[0].missing, [
    { permission: "organization_administration", declared: "write", actual: "read" },
  ]);
});

test("gaps: a level HIGHER than declared is not a gap", () => {
  const gaps = installationApprovalGaps({ contents: "read" }, [
    installation("OrgA", { contents: "write" }),
  ]);
  assert.deepEqual(gaps, []);
});

test("gaps: every missing permission on one installation is listed, not just the first", () => {
  const gaps = installationApprovalGaps(DECLARED, [installation("OrgA", { contents: "write" })]);
  assert.deepEqual(
    gaps[0].missing.map((m) => m.permission).sort(),
    ["members", "organization_administration"],
  );
});

test("gaps: an installation with no permissions object lags on everything", () => {
  const gaps = installationApprovalGaps(DECLARED, [installation("OrgA", undefined)]);
  assert.equal(gaps[0].missing.length, Object.keys(DECLARED).length);
});

test("gaps: results are sorted by account so the annotation order is stable", () => {
  const gaps = installationApprovalGaps(DECLARED, [
    installation("Zeta", {}),
    installation("Alpha", {}),
    installation("Mike", {}),
  ]);
  assert.deepEqual(gaps.map((g) => g.account), ["Alpha", "Mike", "Zeta"]);
});

test("gaps: an empty installation list is not a gap", () => {
  assert.deepEqual(installationApprovalGaps(DECLARED, []), []);
});

test("gaps: null/undefined installations do not throw", () => {
  assert.deepEqual(installationApprovalGaps(DECLARED, null), []);
  assert.deepEqual(installationApprovalGaps(DECLARED, undefined), []);
});

test("gaps: an empty declaration requires nothing of anybody", () => {
  assert.deepEqual(installationApprovalGaps({}, [installation("OrgA", {})]), []);
  assert.deepEqual(installationApprovalGaps(null, [installation("OrgA", {})]), []);
});

test("gaps: malformed installation entries are skipped rather than crashing", () => {
  const gaps = installationApprovalGaps(DECLARED, [null, "nonsense", 42, installation("OrgA", {})]);
  assert.deepEqual(gaps.map((g) => g.account), ["OrgA"]);
});

test("gaps: an installation with no account login is still reported", () => {
  // Reporting it as "(unknown account)" beats dropping it: a lagging org that
  // cannot be named is still a lagging org.
  const gaps = installationApprovalGaps(DECLARED, [{ id: 7, permissions: {} }]);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].account, "(unknown account)");
  assert.equal(gaps[0].installationId, 7);
});

test("gaps: a non-numeric installation id becomes null rather than leaking a string", () => {
  const gaps = installationApprovalGaps(DECLARED, [
    { id: "abc", account: { login: "OrgA" }, permissions: {} },
  ]);
  assert.equal(gaps[0].installationId, null);
});

test("gaps: account-level permissions are never counted against an installation", () => {
  // The first live run reported 14 of 14 installations "unapproved" because
  // `plan` and `starring` are ACCOUNT permissions - an org installation cannot
  // carry them, ever - which buried the 5 orgs that genuinely had not approved.
  // These are the exact permissions the live App declares.
  const declared = {
    members: "write",
    organization_administration: "write",
    plan: "read",
    starring: "write",
  };
  const approved = { members: "write", organization_administration: "write" };
  assert.deepEqual(installationApprovalGaps(declared, [installation("OrgA", approved)]), []);
});

test("gaps: an App declaring ONLY account-level permissions can have no gaps", () => {
  const gaps = installationApprovalGaps({ plan: "read", starring: "write" }, [
    installation("OrgA", {}),
  ]);
  assert.deepEqual(gaps, []);
});

test("gaps: a real org-level gap survives alongside account-level noise", () => {
  // The other half: filtering must not become a blanket amnesty.
  const declared = { members: "write", plan: "read", starring: "write" };
  const gaps = installationApprovalGaps(declared, [installation("Lagging", {})]);
  assert.deepEqual(gaps[0].missing, [{ permission: "members", declared: "write", actual: null }]);
});

test("gaps: every name in ACCOUNT_LEVEL_PERMISSIONS is actually ignored", () => {
  // Asserts the list is wired in, not merely exported - the sampling trap from
  // CLAUDE.md: a test can pass because it never reached the case it names.
  assert.ok(ACCOUNT_LEVEL_PERMISSIONS.includes("plan"));
  assert.ok(ACCOUNT_LEVEL_PERMISSIONS.includes("starring"));
  const declared = Object.fromEntries(ACCOUNT_LEVEL_PERMISSIONS.map((p) => [p, "write"]));
  assert.deepEqual(installationApprovalGaps(declared, [installation("OrgA", {})]), []);
});

test("gaps: the inputs are not mutated", () => {
  const declared = { ...DECLARED };
  const insts = [installation("OrgA", {})];
  const snapshot = JSON.stringify({ declared, insts });
  installationApprovalGaps(declared, insts);
  assert.equal(JSON.stringify({ declared, insts }), snapshot);
});

// --------------------------------------------------------------------------
// generateAppJwt
// --------------------------------------------------------------------------

function decodeSegment(seg) {
  return JSON.parse(Buffer.from(seg, "base64url").toString("utf8"));
}

test("jwt: has three base64url segments and an RS256 header", () => {
  const parts = generateAppJwt("Iv1.abc", PRIVATE_KEY).split(".");
  assert.equal(parts.length, 3);
  assert.deepEqual(decodeSegment(parts[0]), { alg: "RS256", typ: "JWT" });
});

test("jwt: iss is the client id, and the window is backdated 60s / 600s long", () => {
  const token = generateAppJwt("Iv1.abc", PRIVATE_KEY, { nowMs: 1_000_000_000_000 });
  const payload = decodeSegment(token.split(".")[1]);
  assert.equal(payload.iss, "Iv1.abc");
  assert.equal(payload.iat, 1_000_000_000 - BACKDATE_S);
  assert.equal(payload.exp, 1_000_000_000 + MAX_LIFETIME_S);
  // GitHub rejects exp more than 10 minutes out; this must never drift past it.
  assert.ok(payload.exp - payload.iat <= MAX_LIFETIME_S + BACKDATE_S);
});

test("jwt: the signature verifies against the matching public key", () => {
  const token = generateAppJwt("Iv1.abc", PRIVATE_KEY);
  const [h, p, sig] = token.split(".");
  const verify = crypto.createVerify("RSA-SHA256");
  verify.update(`${h}.${p}`);
  assert.ok(verify.verify(crypto.createPublicKey(PRIVATE_KEY), Buffer.from(sig, "base64url")));
});

test("jwt: refuses to mint without a client id or a key", () => {
  assert.throws(() => generateAppJwt("", PRIVATE_KEY), /clientId is required/);
  assert.throws(() => generateAppJwt("Iv1.abc", ""), /privateKeyPem is required/);
});

// --------------------------------------------------------------------------
// The script, end to end against a stubbed fetch
// --------------------------------------------------------------------------

function runScript({
  app = { slug: "pxl-classroom-provisioner", permissions: DECLARED },
  pages = [[]],
  appStatus = 200,
  listStatus = 200,
  creds = true,
  privateKey = PRIVATE_KEY,
  // null = no participating-orgs.yml at all (the unreadable case).
  participating = undefined,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pxl-inst-approvals-"));
  const stub = join(dir, "stub-fetch.mjs");
  const participatingFile = join(dir, "participating-orgs.yml");
  if (participating !== null) {
    // Default: every account in the fixture is one of ours and none is missing,
    // so a test that says nothing about participation exercises only the
    // approval logic.
    const orgs =
      participating ??
      pages.flat().map((i) => i?.account?.login).filter(Boolean);
    writeFileSync(
      participatingFile,
      "schema_version: 1\norgs:\n" + orgs.map((o) => `  - login: ${o}\n`).join(""),
    );
  }
  writeFileSync(
    stub,
    [
      `const cfg = ${JSON.stringify({ app, pages, appStatus, listStatus })};`,
      "let listCalls = 0;",
      "globalThis.fetch = async (url) => {",
      "  if (/\\/app$/.test(url)) {",
      "    return { ok: cfg.appStatus === 200, status: cfg.appStatus, json: async () => cfg.app };",
      "  }",
      "  listCalls++;",
      "  const m = /[?&]page=(\\d+)/.exec(url);",
      "  const idx = m ? Number(m[1]) - 1 : 0;",
      "  const body = cfg.pages[idx] === undefined ? [] : cfg.pages[idx];",
      "  return { ok: cfg.listStatus === 200, status: cfg.listStatus, json: async () => body };",
      "};",
      "process.on('exit', () => { if (process.env.PXL_ECHO_CALLS) console.log('LIST_CALLS=' + listCalls); });",
      "",
    ].join("\n"),
  );

  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    PXL_ECHO_CALLS: "1",
    PARTICIPATING_FILE: participatingFile,
  };
  if (creds) {
    env.PXL_APP_CLIENT_ID = "Iv1.test";
    env.PXL_APP_PRIVATE_KEY = privateKey;
  }

  try {
    const stdout = execFileSync(
      process.execPath,
      ["--import", pathToFileURL(stub).href, SCRIPT],
      { encoding: "utf8", env },
    );
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status, stdout: String(err.stdout || "") };
  }
}

test("script: reports success when every installation has approved", () => {
  const res = runScript({ pages: [[installation("OrgA", { ...DECLARED })]] });
  assert.equal(res.code, 0);
  assert.match(res.stdout, /have approved its current permissions/);
  assert.doesNotMatch(res.stdout, /::error/);
});

test("script: a lagging installation is an error, names the org and the fix", () => {
  const res = runScript({
    pages: [[installation("PXL-2TIN-NetAdv-26-27", { contents: "write" })]],
  });
  assert.equal(res.code, 1);
  assert.match(res.stdout, /::error title=Unapproved App permissions on PXL-2TIN-NetAdv-26-27::/);
  assert.match(res.stdout, /members: has no access, App declares write/);
  assert.match(
    res.stdout,
    /organizations\/PXL-2TIN-NetAdv-26-27\/settings\/installations/,
  );
  assert.match(res.stdout, /1 participating org\(s\) have not approved/);
});

test("script: one lagging org among approved ones still fails the run", () => {
  const res = runScript({
    pages: [[
      installation("Good1", { ...DECLARED }),
      installation("Lagging", { ...DECLARED, members: "read" }),
      installation("Good2", { ...DECLARED }),
    ]],
  });
  assert.equal(res.code, 1);
  assert.match(res.stdout, /1 participating org\(s\) have not approved/);
  assert.match(res.stdout, /members: has read, App declares write/);
  assert.doesNotMatch(res.stdout, /Good1/);
});

test("script: WALKS PAST PAGE 1 - a gap on page 2 is found", () => {
  // The one-page-is-not-the-list case. A full first page must not terminate the
  // walk. Put the bug back (drop the loop) and this goes red: the lagging org
  // on page 2 is never seen and the script prints a confident all-clear.
  const fullPage = Array.from({ length: 100 }, (_, i) =>
    installation(`Approved${i}`, { ...DECLARED }, i + 1),
  );
  const res = runScript({
    pages: [fullPage, [installation("LateOrg", { contents: "write" }, 999)]],
  });
  assert.equal(res.code, 1, "a gap on the second page must fail the run");
  assert.match(res.stdout, /LateOrg/);
  assert.match(res.stdout, /1 participating org\(s\) have not approved/);
  assert.match(res.stdout, /LIST_CALLS=2/);
});

test("script: a full page followed by an empty one terminates", () => {
  const fullPage = Array.from({ length: 100 }, (_, i) =>
    installation(`Approved${i}`, { ...DECLARED }, i + 1),
  );
  const res = runScript({ pages: [fullPage, []] });
  assert.equal(res.code, 0);
  assert.match(res.stdout, /100 participating org\(s\) have/);
  assert.match(res.stdout, /LIST_CALLS=2/);
});

test("script: a short first page costs exactly one list call", () => {
  const res = runScript({ pages: [[installation("OrgA", { ...DECLARED })]] });
  assert.match(res.stdout, /LIST_CALLS=1/);
});

test("script: missing credentials say the check DID NOT RUN, and exit 0", () => {
  // Exit 0 because a missing secret is not evidence of drift - but it must be
  // loud, or a check that quietly never ran looks exactly like a passing one.
  const res = runScript({ creds: false });
  assert.equal(res.code, 0);
  assert.match(res.stdout, /DID NOT RUN/);
  assert.match(res.stdout, /environment: provisioning/);
  assert.doesNotMatch(res.stdout, /have approved/);
});

test("script: an unmintable JWT says DID NOT RUN rather than reporting drift", () => {
  const res = runScript({ privateKey: "-----BEGIN PRIVATE KEY-----\nnot-a-key\n-----END PRIVATE KEY-----" });
  assert.equal(res.code, 0);
  assert.match(res.stdout, /DID NOT RUN/);
  assert.doesNotMatch(res.stdout, /::error/);
});

test("script: an unreadable GET /app is not evidence of drift", () => {
  const res = runScript({ appStatus: 500 });
  assert.equal(res.code, 0);
  assert.match(res.stdout, /DID NOT RUN/);
  assert.match(res.stdout, /GET \/app/);
});

test("script: an unreadable installation list is not evidence of drift", () => {
  const res = runScript({ listStatus: 403 });
  assert.equal(res.code, 0);
  assert.match(res.stdout, /DID NOT RUN/);
  assert.doesNotMatch(res.stdout, /All 0 installation/);
});

test("script: a non-array installation list is refused, not treated as empty", () => {
  // GET /orgs/{org}/installations returns an OBJECT, and reading a paginated
  // endpoint as the wrong shape is a documented past bug in this repo. An
  // object here must not silently read as "no installations, all approved".
  const res = runScript({ pages: [{ total_count: 3, installations: [] }] });
  assert.equal(res.code, 0);
  assert.match(res.stdout, /DID NOT RUN/);
  assert.match(res.stdout, /not an array/);
});

test("script: an App declaring nothing cannot produce gaps", () => {
  const res = runScript({
    app: { slug: "x", permissions: {} },
    pages: [[installation("OrgA", {})]],
  });
  assert.equal(res.code, 0);
});

test("script: an EMPTY participating list is an answer, not an unreadable one", () => {
  // The participating-orgs branch genuinely starts as `orgs: []`. Treating that
  // as "could not read" would turn every installation into a third party and
  // silence every real approval gap at once.
  const res = runScript({ participating: [], pages: [[installation("kolfadser1", {})]] });
  assert.equal(res.code, 0);
  assert.doesNotMatch(res.stdout, /Could not read/);
  assert.match(res.stdout, /0 participating org\(s\) have/);
  assert.match(res.stdout, /::notice title=Third-party installation: kolfadser1/);
});

test("script: zero installations is reported, not silently passed over", () => {
  const res = runScript({ participating: [], pages: [[]] });
  assert.equal(res.code, 0);
  assert.match(res.stdout, /0 participating org\(s\) have/);
});

// --------------------------------------------------------------------------
// Ours, theirs, and missing
// --------------------------------------------------------------------------

test("script: a THIRD-PARTY installation is named but does not fail the run", () => {
  // The App is publicly listed - the hub-and-spoke model needs it to be - so
  // any account can install it, and one did on 2026-08-22. Failing every Sunday
  // over an org we cannot make approve anything is a permanent false positive
  // sitting beside the real ones.
  const res = runScript({
    participating: ["OrgA"],
    pages: [[installation("OrgA", { ...DECLARED }), installation("kolfadser1", {})]],
  });
  assert.equal(res.code, 0, "a stranger's stale installation must not fail the run");
  assert.match(res.stdout, /::notice title=Third-party installation: kolfadser1/);
  assert.doesNotMatch(res.stdout, /::error/);
});

test("script: a PARTICIPATING org that has not approved still fails, beside a third party", () => {
  // The half that matters: filtering must not become a blanket amnesty.
  const res = runScript({
    participating: ["Lagging"],
    pages: [[installation("Lagging", {}), installation("kolfadser1", {})]],
  });
  assert.equal(res.code, 1);
  assert.match(res.stdout, /::error title=Unapproved App permissions on Lagging/);
  assert.match(res.stdout, /::notice title=Third-party installation: kolfadser1/);
});

test("script: a participating org with NO installation is an error", () => {
  // Nothing else in the system notices this; RUNBOOK section 11 carried it as a
  // manual checklist item.
  const res = runScript({
    participating: ["OrgA", "Forgotten"],
    pages: [[installation("OrgA", { ...DECLARED })]],
  });
  assert.equal(res.code, 1);
  assert.match(res.stdout, /::error title=App not installed on Forgotten/);
  assert.match(res.stdout, /nothing can be provisioned there/);
});

test("script: participation matching is case-insensitive", () => {
  // participating-orgs.yml and GitHub's account login can differ in case, and
  // treating our own org as a stranger would silently downgrade a real gap.
  const res = runScript({
    participating: ["pxl-2tin-netadv-26-27"],
    pages: [[installation("PXL-2TIN-NetAdv-26-27", {})]],
  });
  assert.equal(res.code, 1);
  assert.match(res.stdout, /::error title=Unapproved App permissions on PXL-2TIN-NetAdv-26-27/);
});

test("script: an UNREADABLE participating list over-reports rather than under-reports", () => {
  // "Could not read it" is not "it is fine". Treating everything as third-party
  // would silence every real approval gap at once.
  const res = runScript({
    participating: null,
    pages: [[installation("Lagging", {})]],
  });
  assert.equal(res.code, 1);
  assert.match(res.stdout, /::warning::Could not read/);
  assert.match(res.stdout, /::error title=Unapproved App permissions on Lagging/);
});

test("script: everything in order reports against the participating count", () => {
  const res = runScript({
    participating: ["OrgA"],
    pages: [[installation("OrgA", { ...DECLARED }), installation("kolfadser1", { ...DECLARED })]],
  });
  assert.equal(res.code, 0);
  assert.match(res.stdout, /1 participating org\(s\) have/);
});

test("script: the success line names the permissions that were checked", () => {
  // Without this the green line is unfalsifiable - it would read the same
  // whether it compared three permissions or none.
  const res = runScript({ pages: [[installation("OrgA", { ...DECLARED })]] });
  assert.match(res.stdout, /members=write/);
  assert.match(res.stdout, /organization_administration=write/);
});
