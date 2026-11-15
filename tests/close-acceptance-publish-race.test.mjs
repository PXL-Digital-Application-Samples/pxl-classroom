// The nightly's broker close and a publish of the same assignment, at once.
//
// The finalize closes an assignment's broker after its deadline: acceptance off,
// then the broker App's key off the public repository
// (scripts/close-acceptance.mjs). A lecturer who moves the deadline later in
// those minutes saves, and the save publishes, which switches acceptance on and
// puts the key back. The close asked GitHub for the deadline once, at its
// start. If the publish restored the key after that read and before the close's
// own DELETE, the close took the key off a broker that was open again: every
// acceptance would boot, find no key and hang, with nothing to reopen it but
// another publish. (Found by asking what two runs at once can break, 2026-11-15;
// not seen live.)
//
// So the close asks again right before each key it removes. A GitHub request
// is cut off near ten seconds, and a publish restores the key about 25 seconds
// after the save that started it - so any move the close misses is followed by
// a publish that puts the key back after the close is done.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTROL_REPO } from "../lib/deployment.mjs";

const ORG = "PXL-Automation-II";
const ID = "lab";
const PAST = "2026-11-10T12:00:00.000Z";
const FUTURE = "2027-06-30T21:00:00.000Z";
const BROKER = `/repos/${ORG}/broker-${ID}/actions`;
const doc = (deadline) => `id: ${ID}\ntitle: Lab\nstate: published\ndeadline_at: ${deadline}\n`;

let dataDir;
let realFetch;
let realLog;
let logged;

/**
 * GitHub as one state: the assignment's deadline, and the broker. `onClosePatch`
 * runs when the close switches acceptance off - the moment a lecturer's save and
 * its publish are put between the close's steps.
 */
function github({ onClosePatch = () => {} } = {}) {
  const state = { deadline: PAST, enabled: "true", secrets: new Set(["PXL_BROKER_PRIVATE_KEY", "PXL_BROKER_CLIENT_ID"]) };
  const publish = () => {
    state.deadline = FUTURE;
    state.enabled = "true";
    state.secrets.add("PXL_BROKER_PRIVATE_KEY");
    state.secrets.add("PXL_BROKER_CLIENT_ID");
  };
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method || "GET";
    const path = String(url).replace("https://api.github.com", "");
    const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: new Map(), text: async () => (body === undefined ? "" : JSON.stringify(body)) });
    if (method === "GET" && path.startsWith(`/repos/${ORG}/${CONTROL_REPO}/contents/assignments/${ID}.yml`)) {
      return reply(200, { content: Buffer.from(doc(state.deadline)).toString("base64") });
    }
    if (method === "GET" && path.startsWith(`/repos/${ORG}/${CONTROL_REPO}/contents/`)) return reply(404, { message: "Not Found" });
    if (method === "PATCH" && path === `${BROKER}/variables/INVITE_ENABLED`) {
      state.enabled = JSON.parse(init.body).value;
      onClosePatch(publish);
      return reply(204);
    }
    const secret = path.match(new RegExp(`^${BROKER}/secrets/(\\w+)$`));
    if (method === "DELETE" && secret) {
      state.secrets.delete(secret[1]);
      return reply(204);
    }
    return reply(400, { message: `unrouted: ${method} ${path}` });
  };
  return state;
}

async function close() {
  Object.assign(process.env, { ORG, ASSIGNMENT_ID: ID, DATA_DIR: dataDir, GITHUB_TOKEN: "test-token" });
  const { main } = await import("../scripts/close-acceptance.mjs");
  await main();
}

/** What a broker can do: accept only when it is on AND holds the key it dispatches with. */
const works = (s) => s.enabled === "true" && s.secrets.has("PXL_BROKER_PRIVATE_KEY") && s.secrets.has("PXL_BROKER_CLIENT_ID");

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "pxl-close-race-"));
  mkdirSync(join(dataDir, "assignments"), { recursive: true });
  writeFileSync(join(dataDir, "assignments", `${ID}.yml`), doc(PAST));
  realFetch = globalThis.fetch;
  realLog = console.log;
  logged = [];
  console.log = (...a) => logged.push(a.join(" "));
});

afterEach(() => {
  globalThis.fetch = realFetch;
  console.log = realLog;
  rmSync(dataDir, { recursive: true, force: true });
});

test("a publish that restores the broker between the close's two steps keeps a broker that works", async () => {
  // The close has read the old deadline and switched acceptance off; the
  // lecturer's save and its publish land before the close removes the key.
  const state = github({ onClosePatch: (publish) => publish() });
  await close();
  assert.ok(works(state), `the broker cannot accept: ${JSON.stringify({ ...state, secrets: [...state.secrets] })}`);
  assert.ok(logged.some((l) => /moved/.test(l)), logged.join("\n"));
});

test("a deadline moved after the key is gone is the publish's to restore: the close finishes as it started", async () => {
  // Nothing moved while the close ran: it closes, removes the key, and a later
  // publish restores both.
  const state = github();
  await close();
  assert.equal(state.enabled, "false");
  assert.equal(state.secrets.size, 0, "both halves of the credential are removed");
});

test("a deadline already moved when the close starts closes nothing", async () => {
  const state = github();
  state.deadline = FUTURE;
  await close();
  assert.ok(works(state));
});
