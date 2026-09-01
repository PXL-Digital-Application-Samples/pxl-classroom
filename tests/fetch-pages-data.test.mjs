// The Pages data fetch runs on every frontend deploy, for every participating
// org. It used to walk the Contents API: one request to list `public/i`, then
// one more per invitation card. An org with fifty published assignments paid
// fifty-one requests for a directory it could have read in one - and the
// Contents directory listing silently caps at 1000 entries, so a long-running
// org would eventually have lost cards with no error at all.
//
// These drive the real script against a stubbed fetch and assert on the CALL
// PATTERN, because "stop making N requests" is not something a source-text
// assertion can check.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const SCRIPT = join(root, "scripts", "fetch-pages-data.mjs");
const STUB = join(here, "fixtures", "fetch-stub.mjs");

// The script signs a JWT with it; the stub never verifies, but it has to parse.
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const ORG = "PXLAutomation";
const b64 = (s) => Buffer.from(s).toString("base64");

function cardDigest(n) {
  return String(n).padStart(64, "0");
}

/** @returns {{ log: string[], outDir: string, stdout: string }} */
function run({ cards = 3, truncated = false, assignmentsStatus = 200, allowFailure = false } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "pxl-pages-"));
  mkdirSync(join(cwd, "frontend", "public", "data"), { recursive: true });
  writeFileSync(join(cwd, "participating-orgs.yml"), `orgs:\n  - login: ${ORG}\n`);

  const tree = [];
  const blobRoutes = [];
  for (let i = 0; i < cards; i++) {
    const sha = `sha${i}`;
    tree.push({ path: `public/i/${cardDigest(i)}.json`, type: "blob", sha });
    blobRoutes.push({
      match: `git/blobs/${sha}$`,
      body: { content: b64(JSON.stringify({ schema_version: 1, assignment: { id: `lab-${i}` } })) },
    });
  }
  // Files outside public/i must be ignored, not downloaded.
  tree.push({ path: "students/roster.yml", type: "blob", sha: "roster" });
  tree.push({ path: "public/i", type: "tree", sha: "dir" });

  const routes = [
    { match: "app/installations\\?", body: [{ id: 42, account: { login: ORG } }] },
    { match: "app/installations/42/access_tokens", body: { token: "ghs_stub" } },
    {
      match: "contents/public/assignments\\.json",
      status: assignmentsStatus,
      body:
        assignmentsStatus === 200
          ? { content: b64(JSON.stringify({ schema_version: 1, assignments: {} })) }
          : { message: "Server Error" },
    },
    { match: "git/trees/HEAD", body: { tree, truncated } },
    ...blobRoutes,
    { match: "contents/public/teams", status: 404, body: { message: "Not Found" } },
  ];

  const logFile = join(cwd, "fetch.log");
  writeFileSync(logFile, "");
  // console.warn is where the script reports a truncated tree, so stderr has to
  // be captured too - asserting only on stdout missed it entirely.
  const proc = spawnSync(process.execPath, [SCRIPT], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      // A file:// URL, not a path: the ESM loader rejects `C:\...` outright.
      NODE_OPTIONS: `--import ${pathToFileURL(STUB).href}`,
      FETCH_STUB_ROUTES: JSON.stringify(routes),
      FETCH_STUB_LOG: logFile,
      PXL_APP_CLIENT_ID: "Iv1.stub",
      PXL_APP_PRIVATE_KEY: PEM,
    },
  });
  if (!allowFailure) assert.equal(proc.status, 0, `script failed:\n${proc.stderr}`);

  return {
    status: proc.status,
    log: readFileSync(logFile, "utf8").split("\n").filter(Boolean),
    outDir: join(cwd, "frontend", "public", "data", ORG),
    dataDir: join(cwd, "frontend", "public", "data"),
    stdout: `${proc.stdout}\n${proc.stderr}`,
    cwd,
  };
}

test("the invitation cards are listed in ONE request, not one per file", () => {
  const { log } = run({ cards: 5 });

  const trees = log.filter((l) => l.includes("git/trees/"));
  assert.equal(trees.length, 1, `expected a single tree call, got:\n  ${trees.join("\n  ")}`);

  // The old shape: a directory listing plus a per-entry `item.url` fetch.
  const contentsDirListing = log.filter((l) => /contents\/public\/i(\?|$)/.test(l));
  assert.deepEqual(contentsDirListing, [], "the contents directory walk must be gone");
});

test("only the invitation cards are downloaded, one blob each", () => {
  const { log } = run({ cards: 5 });
  const blobs = log.filter((l) => l.includes("git/blobs/"));
  assert.equal(blobs.length, 5, "one blob per card");
  assert.ok(!blobs.some((l) => l.includes("roster")), "a file outside public/i must not be fetched");
});

test("the cards land on disk under their digest names", () => {
  const { outDir } = run({ cards: 3 });
  for (let i = 0; i < 3; i++) {
    const file = join(outDir, "i", `${cardDigest(i)}.json`);
    assert.ok(existsSync(file), `${file} must be written`);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).assignment.id, `lab-${i}`);
  }
});

test("request count grows by one per card, not two", () => {
  const small = run({ cards: 2 }).log.length;
  const large = run({ cards: 12 }).log.length;
  assert.equal(large - small, 10, `10 more cards must cost 10 more requests, not 20 (got ${large - small})`);
});

test("a truncated tree is reported rather than silently short", () => {
  // The git tree API truncates very large trees. Saying nothing would look
  // exactly like an org that simply has fewer assignments.
  const { stdout } = run({ cards: 2, truncated: true });
  assert.match(stdout, /truncated/i, "a truncated tree must be called out");
});

test("an org with no invitation cards is not an error", () => {
  const { stdout, outDir } = run({ cards: 0 });
  assert.match(stdout, /Saved 0 invitation file\(s\)/);
  assert.ok(existsSync(join(outDir, "assignments.json")), "the index is still written");
});

// --- what must NOT be published ----------------------------------------------

test("public/teams is not fetched - the generator deletes it for a reason", () => {
  // pages/generate.mjs removes `public/teams/` on every regeneration and says
  // why: "Anything still there is a public cohort list for an assignment that no
  // longer publishes one." This script used to copy that directory onto the
  // world-readable site, so any org whose control repo had not regenerated since
  // the retirement had its cohort lists republished on every deploy.
  //
  // pages/scan.mjs does not catch it: it looks for email addresses and
  // invitation-token shapes, and a teams file is `members: ["alice", …]` -
  // GitHub logins, which match neither rule. Nothing in the SPA reads it either.
  const res = run({ cards: 1 });
  assert.deepEqual(
    res.log.filter((line) => /public\/teams/.test(line)),
    [],
    `the teams directory must not be requested at all:\n${res.log.join("\n")}`,
  );
  assert.ok(!existsSync(join(res.outDir, "teams")), "and nothing may be written there");
});

test("an org that cannot be read stops the publish instead of vanishing from the index", () => {
  // index.json is rebuilt from the orgs that succeeded THIS run, and HomeView
  // discovers participating orgs through it - so an org silently dropped is an
  // org whose students open the site and see none of their assignments. A
  // transient 500 while reading one org used to do exactly that, with the run
  // still exiting 0 and the deploy going ahead.
  const res = run({ cards: 1, assignmentsStatus: 500, allowFailure: true });

  assert.notEqual(res.status, 0, `the run must fail:\n${res.stdout}`);
  assert.match(res.stdout, /students would see no assignments/);
  assert.ok(
    !existsSync(join(res.dataDir, "index.json")),
    "and no index may be written - the previous deployment stays live instead",
  );
});

test("a 404 is still an answer, not a failure", () => {
  // The other half: an org with nothing published yet, or one whose control repo
  // does not exist, is a real state and must not stop every other org's deploy.
  const res = run({ cards: 1, assignmentsStatus: 404, allowFailure: true });
  assert.equal(res.status, 0, `a 404 must not fail the run:\n${res.stdout}`);
  assert.ok(existsSync(join(res.dataDir, "index.json")), "the index is still published");
  const index = JSON.parse(readFileSync(join(res.dataDir, "index.json"), "utf8"));
  assert.deepEqual(index.orgs, [], "and the org with nothing published is simply not in it");
});
