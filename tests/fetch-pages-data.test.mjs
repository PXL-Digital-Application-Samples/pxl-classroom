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

/**
 * @param {object} o
 * @param {number} [o.cards]           cards in public/i (0: no i directory at all)
 * @param {boolean} [o.truncated]      GitHub cut the card listing short
 * @param {number} [o.treeStatus]      what the repository's top listing answers
 * @param {number|null} [o.failCard]   this card's blob answers 404
 * @param {boolean} [o.installed]      whether the App is installed on the org
 * @param {number} [o.mintFailTimes]   502s before the installation token is minted
 * @returns {{ log: string[], outDir: string, stdout: string }}
 */
function run({ cards = 3, truncated = false, assignmentsStatus = 200, assignmentsFailTimes = 0, treeStatus = 200, failCard = null, installed = true, mintFailTimes = 0, previous = null, allowFailure = false } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "pxl-pages-"));
  mkdirSync(join(cwd, "frontend", "public", "data"), { recursive: true });
  // What the previous deployment published, as the deploy unpacks it.
  const previousData = join(cwd, "prev", "data");
  for (const [path, content] of Object.entries(previous || {})) {
    mkdirSync(dirname(join(previousData, path)), { recursive: true });
    writeFileSync(join(previousData, path), content);
  }
  writeFileSync(join(cwd, "participating-orgs.yml"), `orgs:\n  - login: ${ORG}\n`);

  // The repository read one directory at a time: top, public/, public/i/.
  const top = [
    { path: "public", type: "tree", sha: "publicdir" },
    { path: "students", type: "tree", sha: "studentsdir" },
    { path: "README.md", type: "blob", sha: "readme" },
  ];
  const inPublic = [{ path: "assignments.json", type: "blob", sha: "index" }];
  if (cards > 0) inPublic.push({ path: "i", type: "tree", sha: "carddir" });
  const cardList = [];
  const blobRoutes = [];
  for (let i = 0; i < cards; i++) {
    const sha = `sha${i}`;
    cardList.push({ path: `${cardDigest(i)}.json`, type: "blob", sha });
    blobRoutes.push({
      match: `git/blobs/${sha}$`,
      status: i === failCard ? 404 : 200,
      body: i === failCard ? { message: "Not Found" } : { content: b64(JSON.stringify({ schema_version: 1, assignment: { id: `lab-${i}` } })) },
    });
  }

  const routes = [
    { match: "app/installations\\?", body: installed ? [{ id: 42, account: { login: ORG } }] : [] },
    { match: "app/installations/42/access_tokens", failTimes: mintFailTimes, failStatus: 502, body: { token: "ghs_stub" } },
    {
      match: "contents/public/assignments\\.json",
      status: assignmentsStatus,
      failTimes: assignmentsFailTimes,
      failStatus: 504,
      body:
        assignmentsStatus === 200
          ? { content: b64(JSON.stringify({ schema_version: 1, assignments: {} })) }
          : { message: "Server Error" },
    },
    { match: "git/trees/HEAD$", status: treeStatus, body: treeStatus === 200 ? { tree: top, truncated: false } : { message: treeStatus === 404 ? "Not Found" : "Server Error" } },
    { match: "git/trees/publicdir$", body: { tree: inPublic, truncated: false } },
    { match: "git/trees/carddir$", body: { tree: cardList, truncated } },
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
      ...(previous ? { PREVIOUS_SITE_DATA: previousData } : {}),
      KEPT_ORGS_FILE: join(cwd, "kept.json"),
      GITHUB_OUTPUT: join(cwd, "output.txt"),
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

test("the invitation cards are listed in three requests whatever their number, never one per file", () => {
  // One directory at a time (top, public/, public/i/): a recursive tree of the
  // whole repository grows with its observations and comes back truncated.
  const { log } = run({ cards: 5 });

  const trees = log.filter((l) => l.includes("git/trees/"));
  assert.equal(trees.length, 3, `expected three listings, got:\n  ${trees.join("\n  ")}`);
  assert.ok(!trees.some((l) => /recursive/.test(l)), "and never the whole repository at once");

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

test("a card listing GitHub cut short is never published as the cards", () => {
  // It was a warning, and the org went out with the cards before the cut:
  // every invitation link beyond it answered "not found".
  const kept = run({ cards: 2, truncated: true, previous: LAST, allowFailure: true });
  assert.equal(kept.status, 0, kept.stdout);
  assert.equal(readFileSync(join(kept.outDir, "assignments.json"), "utf8"), LAST[`${ORG}/assignments.json`], "kept as it was");
  const none = run({ cards: 2, truncated: true, allowFailure: true });
  assert.notEqual(none.status, 0, "and with nothing to keep, it stops the publish");
});

test("an org with no invitation cards is not an error", () => {
  const { stdout, outDir, log } = run({ cards: 0 });
  assert.match(stdout, /Saved 0 invitation file\(s\)/);
  assert.ok(existsSync(join(outDir, "assignments.json")), "the index is still written");
  assert.ok(!log.some((l) => l.includes("git/blobs/")), "nothing to download");
});

test("a card that cannot be read keeps the org as it was, never publishes the others without it", () => {
  // Every card or none: a 404 on one blob was swallowed as "no cards yet".
  const res = run({ cards: 3, failCard: 1, previous: LAST, allowFailure: true });
  assert.equal(res.status, 0, res.stdout);
  assert.ok(existsSync(join(res.outDir, "i", `${cardDigest(9)}.json`)), "its last complete cards");
  assert.ok(!existsSync(join(res.outDir, "i", `${cardDigest(0)}.json`)), "and none of this run's");
  const none = run({ cards: 3, failCard: 1, allowFailure: true });
  assert.notEqual(none.status, 0, "nothing to keep: the publish stops");
});

test("'not found' AFTER the index was read is a failed read, not an org with nothing published", () => {
  // The index was there a moment ago, so the org did not un-publish everything.
  const none = run({ cards: 1, treeStatus: 404, allowFailure: true });
  assert.notEqual(none.status, 0, `it must not drop the org from the index:\n${none.stdout}`);
  const kept = run({ cards: 1, treeStatus: 404, previous: LAST, allowFailure: true });
  assert.equal(kept.status, 0, kept.stdout);
  assert.ok(existsSync(join(kept.outDir, "i", `${cardDigest(9)}.json`)));
});

test("an org whose App was uninstalled keeps its pages and is reported, instead of vanishing", () => {
  const res = run({ installed: false, previous: LAST, allowFailure: true });
  assert.equal(res.status, 0, res.stdout);
  assert.ok(existsSync(join(res.outDir, "assignments.json")));
  assert.match(kept(res)[0].why, /not installed/);
  // Registered and never installed: nothing to keep, nothing to say.
  const fresh = run({ installed: false });
  assert.deepEqual(JSON.parse(readFileSync(join(fresh.dataDir, "index.json"), "utf8")).orgs, []);
  assert.deepEqual(kept(fresh), []);
});

test("a 502 while getting the org's access token is asked again, not a reason to keep old pages", () => {
  // A second token is a second token and nothing else; failing here kept an
  // org's old pages over one 502, and the run went green.
  const res = run({ cards: 1, mintFailTimes: 2, previous: LAST });
  assert.equal(res.log.filter((l) => /access_tokens/.test(l)).length, 3, "asked three times");
  assert.ok(existsSync(join(res.outDir, "i", `${cardDigest(0)}.json`)), "and this run's pages are published");
  assert.deepEqual(kept(res), []);
});

test("the run says when it kept an org, so the watchdog does not read it as up to date", () => {
  const output = (res) => (existsSync(join(res.cwd, "output.txt")) ? readFileSync(join(res.cwd, "output.txt"), "utf8") : "");
  assert.match(output(run({ cards: 1, assignmentsStatus: 500, previous: LAST, allowFailure: true })), /^kept=true$/m);
  assert.match(output(run({ cards: 1 })), /^kept=false$/m, "and says false when every org was read");
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

test("a gateway timeout that answers when asked again does not stop every organization's publish", () => {
  // 2026-10-06, a GitHub incident: one 504 on one organization's index failed
  // the deploy for all of them, and a lecturer watched "Publishing…" for a
  // quarter of an hour. The script now asks through lib/gh.mjs, whose retry
  // policy asks a GET again after a 5xx.
  const res = run({ cards: 1, assignmentsFailTimes: 2 });
  assert.equal(res.status, 0, res.stdout);
  assert.equal(res.log.filter((l) => /contents\/public\/assignments\.json/.test(l)).length, 3, "asked three times");
  assert.ok(existsSync(join(res.outDir, "assignments.json")), "and the organization is published");
});

// --- one organization does not stop the others --------------------------------

const LAST = {
  [`${ORG}/assignments.json`]: JSON.stringify({ schema_version: 1, assignments: { "old-lab": {} } }),
  [`${ORG}/i/${cardDigest(9)}.json`]: JSON.stringify({ schema_version: 1, assignment: { id: "old-lab" } }),
};
const kept = (res) => (existsSync(join(res.cwd, "kept.json")) ? JSON.parse(readFileSync(join(res.cwd, "kept.json"), "utf8")) : []);

test("an organization that cannot be read keeps its last published pages, and the deploy goes on", () => {
  // It used to fail the whole deploy: one org's lasting fault froze every
  // organization's student pages until somebody fixed it.
  const res = run({ cards: 1, assignmentsStatus: 500, previous: LAST, allowFailure: true });
  assert.equal(res.status, 0, res.stdout);
  assert.equal(readFileSync(join(res.outDir, "assignments.json"), "utf8"), LAST[`${ORG}/assignments.json`]);
  assert.ok(existsSync(join(res.outDir, "i", `${cardDigest(9)}.json`)), "its invitation cards too");
  const index = JSON.parse(readFileSync(join(res.dataDir, "index.json"), "utf8"));
  assert.deepEqual(index.orgs, [{ login: ORG }], "and it stays in the index its students find it through");
  assert.match(res.stdout, /::warning::.*kept as the previous deployment published them/);
  assert.equal(kept(res)[0].org, ORG, "and an administrator is told (report-kept-orgs.mjs)");
});

test("'not found' for an organization that had pages is kept and said, not silently emptied", () => {
  const res = run({ cards: 1, assignmentsStatus: 404, previous: LAST, allowFailure: true });
  assert.equal(res.status, 0, res.stdout);
  assert.ok(existsSync(join(res.outDir, "assignments.json")));
  assert.match(kept(res)[0].why, /repository access/);
});

test("cards that cannot be read are no longer published as missing - the org keeps its last complete pages", () => {
  // A failed card read was a warning, and the org went out WITHOUT its cards:
  // every invitation link it had handed out answered "not found".
  const res = run({ cards: 2, treeStatus: 500, previous: LAST, allowFailure: true });
  assert.equal(res.status, 0, res.stdout);
  // Its OWN last complete state: the old index with the old card, never this
  // run's new index beside a card list it could not read.
  assert.equal(readFileSync(join(res.outDir, "assignments.json"), "utf8"), LAST[`${ORG}/assignments.json`]);
  assert.ok(existsSync(join(res.outDir, "i", `${cardDigest(9)}.json`)));
  assert.ok(!existsSync(join(res.outDir, "i", `${cardDigest(0)}.json`)), "nothing half-read is mixed in");
});

test("with no earlier pages to keep, an unreadable organization still stops the publish", () => {
  const res = run({ cards: 1, treeStatus: 500, allowFailure: true });
  assert.notEqual(res.status, 0, res.stdout);
  assert.ok(!existsSync(join(res.dataDir, "index.json")));
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
