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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ORG = "PXL-Automation-II";
const ID = "2526-examen-aut2-ek2";

let dataDir;
let calls;
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
    calls.push(key);
    const hit = routes[key] ?? { status: 400, body: { message: `unrouted: ${key}` } };
    return {
      ok: hit.status >= 200 && hit.status < 300,
      status: hit.status,
      headers: new Map(),
      text: async () => (hit.body === undefined ? "" : JSON.stringify(hit.body)),
    };
  };
}

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

test("THE SECOND NIGHT: already closed and already stripped is silent, not a failure", async () => {
  // find-finalizable should not return an assignment twice, but a retry, a
  // re-run or a manual sweep all land here again - and a step that shouts on
  // its own idempotence trains people to ignore it.
  stubFetch({ [VAR]: { status: 204 }, [KEY]: { status: 404 }, [CID]: { status: 404 } });
  await run();

  assert.equal(logged.filter((l) => l.includes("::warning::")).length, 0, "404 on an absent secret is ordinary");
  assert.ok(logged.some((l) => l.includes("acceptance closed")));
});

test("a broker that is gone warns and does NOT go on to delete secrets", async () => {
  // Deleting from a repository that answered 404 for its own variable is a
  // request nobody can act on, and two warnings for one cause is noise.
  stubFetch({ [VAR]: { status: 404, body: { message: "Not Found" } } });
  await run();

  assert.deepEqual(calls, [VAR], "it must stop after the failed close");
  const warn = logged.find((l) => l.includes("::warning::"));
  assert.ok(warn, "the failure has to be visible");
  assert.match(warn, /Could not close acceptance/);
  assert.match(warn, /Not Found/, "GitHub's own message travels with the status");
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
