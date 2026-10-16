// The end-of-life step, driven for real against a stubbed transport.
//
// tests/close-acceptance.test.mjs reads the source and pins its shape. This
// one RUNS it: `lib/gh.mjs` goes through global `fetch`, and
// `close-acceptance.mjs` is plain Node with no bundler in its graph, so every
// branch can be exercised against a fake GitHub - which is the only way to know
// what happens on the second night, on a broker that was deleted, or when the
// key will not come off.
//
// The cases that matter are the ones with no operator watching: this step runs
// at 03:00 under `continue-on-error`, so anything it gets wrong is silent until
// somebody re-reads a log.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTROL_REPO } from "../lib/deployment.mjs";

const ORG = "PXL-Automation-II";
const ID = "2526-examen-aut2-ek2";

let dataDir;
let calls;
let reads;
let realFetch;
let logged;
let realLog;

/** A control checkout holding one assignment document. */
function controlDir(yaml = `id: ${ID}\ntitle: Exam\n`) {
  const dir = mkdtempSync(join(tmpdir(), "pxl-close-"));
  mkdirSync(join(dir, "assignments"), { recursive: true });
  writeFileSync(join(dir, "assignments", `${ID}.yml`), yaml, "utf8");
  return dir;
}

/**
 * Answer every request from `routes`, recording what was asked.
 *
 * A route is matched by "METHOD /path". Anything unrouted is a 400: loud,
 * because no route in this script legitimately produces one, and NOT 500 -
 * `lib/gh.mjs` treats 5xx as retryable and backs off, so an unrouted call made
 * a failing assertion take sixteen seconds to arrive. 404 would have been the
 * other mistake: it is a perfectly ordinary answer here (an absent secret), so
 * an unrouted call could have passed as the idempotent case.
 */
function stubFetch(routes) {
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method || "GET";
    const path = String(url).replace("https://api.github.com", "");
    const key = `${method} ${path}`;
    // The assignment as GitHub holds it now (R7-1) is asked before anything
    // else, and kept apart from `calls`, which are the broker's. Unrouted, it
    // is absent on GitHub, so the checkout decides as it always did.
    const isRead = key.startsWith(`GET ${CONTROL_CONTENTS}`);
    (isRead ? reads : calls).push(key);
    const hit = routes[key] ?? (isRead ? { status: 404, body: { message: "Not Found" } } : { status: 400, body: { message: `unrouted: ${key}` } });
    return {
      ok: hit.status >= 200 && hit.status < 300,
      status: hit.status,
      headers: new Map(),
      text: async () => (hit.body === undefined ? "" : JSON.stringify(hit.body)),
    };
  };
}

const CONTROL_CONTENTS = `/repos/${ORG}/${CONTROL_REPO}/contents/`;
const ON_GITHUB = `GET ${CONTROL_CONTENTS}assignments/${ID}.yml`;
const onGitHub = (yaml) => ({ status: 200, body: { content: Buffer.from(yaml).toString("base64") } });
const VAR = `PATCH /repos/${ORG}/broker-${ID}/actions/variables/INVITE_ENABLED`;
const KEY = `DELETE /repos/${ORG}/broker-${ID}/actions/secrets/PXL_BROKER_PRIVATE_KEY`;
const CID = `DELETE /repos/${ORG}/broker-${ID}/actions/secrets/PXL_BROKER_CLIENT_ID`;

/** Import fresh each time - the module caches nothing, but env is read at call. */
async function run({ org = ORG, id = ID, dir = dataDir } = {}) {
  process.env.ORG = org;
  process.env.ASSIGNMENT_ID = id;
  process.env.DATA_DIR = dir;
  process.env.GITHUB_TOKEN = "test-token";
  const { main } = await import("../scripts/close-acceptance.mjs");
  await main();
}

beforeEach(() => {
  calls = [];
  reads = [];
  logged = [];
  dataDir = controlDir();
  realFetch = globalThis.fetch;
  realLog = console.log;
  console.log = (...a) => logged.push(a.join(" "));
});

afterEach(() => {
  globalThis.fetch = realFetch;
  console.log = realLog;
  rmSync(dataDir, { recursive: true, force: true });
});

test("the happy path closes the door, then removes both halves of the credential", async () => {
  stubFetch({ [VAR]: { status: 204 }, [KEY]: { status: 204 }, [CID]: { status: 204 } });
  await run();

  assert.deepEqual(calls, [VAR, KEY, CID], "close first, then the key, then the client id");
  assert.ok(logged.some((l) => l.includes("acceptance closed")));
  assert.equal(logged.filter((l) => l.includes("::warning::")).length, 0, "a clean run warns about nothing");
});

test("TL-10: an assignment archived or sent back to draft is closed all the same - its state is not the broker's", async () => {
  // P2-25 finalizes one archived before its deadline with students in it; the
  // broker it published is as open as any other's.
  for (const state of ["archived", "draft", "closed"]) {
    calls = [];
    rmSync(dataDir, { recursive: true, force: true });
    dataDir = controlDir(`id: ${ID}\ntitle: Exam\nstate: ${state}\n`);
    stubFetch({ [VAR]: { status: 204 }, [KEY]: { status: 204 }, [CID]: { status: 204 } });
    await run();
    assert.deepEqual(calls, [VAR, KEY, CID], state);
  }
});

test("THE SECOND NIGHT: already closed and already stripped is silent, not a failure", async () => {
  // find-finalizable should not return an assignment twice, but a retry, a
  // re-run or a manual sweep all land here again - and a step that shouts on
  // its own idempotence trains people to ignore it.
  stubFetch({ [VAR]: { status: 204 }, [KEY]: { status: 404 }, [CID]: { status: 404 } });
  await run();

  assert.equal(logged.filter((l) => l.includes("::warning::")).length, 0, "404 on an absent secret is ordinary");
  assert.ok(logged.some((l) => l.includes("acceptance closed")));
});

test("no variable to set (or no broker) is closed: the key still comes off, and the record says done", async () => {
  // P2-34: a 404 stopped here with a warning, which left the key on a broker
  // that exists without the variable - and the broker's own `if:` reads an
  // absent variable as not `true`, so acceptance there is already closed.
  stubFetch({ [VAR]: { status: 404, body: { message: "Not Found" } }, [KEY]: { status: 204 }, [CID]: { status: 404 } });
  await run();

  assert.deepEqual(calls, [VAR, KEY, CID], "the credential is still taken off");
  assert.equal(logged.filter((l) => l.includes("::warning::")).length, 0);
  assert.ok(logged.some((l) => /has no INVITE_ENABLED to set - acceptance is closed/.test(l)));
  const rec = JSON.parse(readFileSync(join(dataDir, "lockdowns", ID, "broker-closed.json"), "utf8"));
  assert.deepEqual([rec.closed, rec.key_removed, rec.attempts], [true, true, 0]);
});

test("P2-34: what each pass did is recorded beside the lock record, and a pass that did not finish is counted", async () => {
  const record = () => JSON.parse(readFileSync(join(dataDir, "lockdowns", ID, "broker-closed.json"), "utf8"));
  stubFetch({ [VAR]: { status: 403, body: { message: "Resource not accessible by integration" } } });
  await run();
  assert.deepEqual([record().closed, record().key_removed, record().attempts], [false, false, 1]);
  assert.ok(logged.some((l) => l.includes("::warning::")), "still a warning in the log");
  // The door closed but the key would not come off: not done, the second try.
  stubFetch({ [VAR]: { status: 204 }, [KEY]: { status: 403, body: { message: "nope" } }, [CID]: { status: 204 } });
  await run();
  assert.deepEqual([record().closed, record().key_removed, record().attempts], [true, false, 2]);
  // Done: the count stays where it was, and nothing is owed.
  stubFetch({ [VAR]: { status: 204 }, [KEY]: { status: 404 }, [CID]: { status: 404 } });
  await run();
  assert.deepEqual([record().closed, record().key_removed, record().attempts], [true, true, 2]);
});

test("a key that will not come off still lets the other one be tried", async () => {
  // Two independent deletions. Aborting the loop on the first failure would
  // leave the client id behind for a reason that had nothing to do with it.
  stubFetch({
    [VAR]: { status: 204 },
    [KEY]: { status: 403, body: { message: "Resource not accessible by integration" } },
    [CID]: { status: 204 },
  });
  await run();

  assert.deepEqual(calls, [VAR, KEY, CID], "the second deletion must still be attempted");
  const warn = logged.find((l) => l.includes("PXL_BROKER_PRIVATE_KEY"));
  assert.ok(warn, "the one that failed is named");
  assert.match(warn, /still on this public repository/, "and what that means is spelled out");
});

test("the door closes even when the credential cannot be removed", async () => {
  // The ordering property, from the other side: a failed deletion must not
  // undo or skip the close that already succeeded.
  stubFetch({ [VAR]: { status: 204 }, [KEY]: { status: 403 }, [CID]: { status: 403 } });
  await run();
  assert.ok(logged.some((l) => l.includes("acceptance closed")), "the close still stands");
});

test("a custom broker_repo is honoured, not composed over", async () => {
  // lib/broker-repo.mjs exists for exactly this, and publish-assignment.yml
  // still composes `broker-${id}` by hand in three places - so this is the half
  // of the contract that is correct, pinned before the other half is fixed.
  rmSync(dataDir, { recursive: true, force: true });
  dataDir = controlDir(`id: ${ID}\nbroker_repo: acceptance-desk-42\n`);
  const custom = `PATCH /repos/${ORG}/acceptance-desk-42/actions/variables/INVITE_ENABLED`;
  stubFetch({
    [custom]: { status: 204 },
    [`DELETE /repos/${ORG}/acceptance-desk-42/actions/secrets/PXL_BROKER_PRIVATE_KEY`]: { status: 204 },
    [`DELETE /repos/${ORG}/acceptance-desk-42/actions/secrets/PXL_BROKER_CLIENT_ID`]: { status: 204 },
  });
  await run();

  assert.ok(calls[0].includes("acceptance-desk-42"), "the recorded broker is the one touched");
  assert.ok(!calls.some((c) => c.includes(`broker-${ID}`)), "and the composed name is never used");
});

test("an unreadable assignment touches NOTHING", async () => {
  // The document is how the broker is identified. Without it the only
  // alternative is guessing a name, and guessing would close somebody else's
  // door - or, on a fork with a custom broker, none at all.
  stubFetch({});
  await run({ id: "does-not-exist" });

  assert.deepEqual(calls, [], "no request may be made on a guess");
  assert.ok(logged.some((l) => l.includes("::warning::") && l.includes("Could not read")));
  // R6-31: and a record, counted, so the nightly's ceiling ends the retries
  // rather than queueing this every night.
  const record = JSON.parse(readFileSync(join(dataDir, "lockdowns", "does-not-exist", "broker-closed.json"), "utf8"));
  assert.deepEqual([record.closed, record.key_removed, record.attempts], [false, false, 1]);
});

test("R6-31: an assignment stored as .yaml is read, as the finalize queue reads it", async () => {
  rmSync(join(dataDir, "assignments", `${ID}.yml`));
  writeFileSync(join(dataDir, "assignments", `${ID}.yaml`), `id: ${ID}\ntitle: Exam\n`, "utf8");
  stubFetch({ [VAR]: { status: 204 }, [KEY]: { status: 204 }, [CID]: { status: 204 } });
  await run();
  assert.deepEqual(calls, [VAR, KEY, CID]);
});

test("R7-1: a deadline moved later on GitHub after the checkout keeps acceptance open, and records nothing", async () => {
  // The finalize's checkout says the deadline passed; the lecturer moved it
  // to tonight and the save switched the broker on. Closing it here hung every
  // acceptance until someone published again (PXL-2TIN-DevOps-2627).
  const later = new Date(Date.now() + 3600_000).toISOString();
  stubFetch({ [ON_GITHUB]: onGitHub(`id: ${ID}\ntitle: Exam\nstate: published\ndeadline_at: "${later}"\n`) });
  await run();
  assert.deepEqual(reads, [ON_GITHUB]);
  assert.deepEqual(calls, [], "the broker is not touched");
  assert.ok(logged.some((l) => l.includes("still ahead")));
  assert.throws(() => readFileSync(join(dataDir, "lockdowns", ID, "broker-closed.json")), "no record: the finalize at that deadline closes it");
});

test("R7-1: a deadline that has passed on GitHub too closes as before, and GitHub's copy names the broker", async () => {
  const past = new Date(Date.now() - 600_000).toISOString();
  stubFetch({
    [ON_GITHUB]: onGitHub(`id: ${ID}\ntitle: Exam\ndeadline_at: "${past}"\nbroker_repo: acceptance-desk-42\n`),
    [`PATCH /repos/${ORG}/acceptance-desk-42/actions/variables/INVITE_ENABLED`]: { status: 204 },
    [`DELETE /repos/${ORG}/acceptance-desk-42/actions/secrets/PXL_BROKER_PRIVATE_KEY`]: { status: 204 },
    [`DELETE /repos/${ORG}/acceptance-desk-42/actions/secrets/PXL_BROKER_CLIENT_ID`]: { status: 204 },
  });
  await run();
  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => c.includes("acceptance-desk-42")), "the document as it is now, not the checkout's");
});

test("R7-1: GitHub not answering closes nothing, and the attempt is counted so the nightly asks again", async () => {
  stubFetch({ [ON_GITHUB]: { status: 403, body: { message: "rate limited" } } });
  await run();
  assert.deepEqual(calls, [], "an unknown is not 'nothing changed'");
  assert.ok(logged.some((l) => l.includes("::warning::") && l.includes("from GitHub")));
  const rec = JSON.parse(readFileSync(join(dataDir, "lockdowns", ID, "broker-closed.json"), "utf8"));
  assert.deepEqual([rec.closed, rec.key_removed, rec.attempts], [false, false, 1]);
});

test("a missing org or assignment is a no-op, not a warning", async () => {
  // The step is wired to a matrix; an empty value means there was nothing to
  // finalize, which is not a fault.
  stubFetch({});
  await run({ org: "" });
  assert.deepEqual(calls, []);
  assert.equal(logged.filter((l) => l.includes("::warning::")).length, 0);
  assert.ok(logged.some((l) => l.includes("[ok]")));
});
