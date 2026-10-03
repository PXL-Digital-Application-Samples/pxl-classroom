// The one-time "New look" card: which storage remembers it, and that a storage
// that misbehaves shows it again rather than breaking the page.

import test from "node:test";
import assert from "node:assert/strict";
import {
  whatsNewStorage,
  whatsNewSeen,
  markWhatsNewSeen,
  WHATS_NEW_VERSION,
} from "../frontend/src/lib/whats-new.js";

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
}

test("the live app remembers it in the browser, beta only for the session", () => {
  const local = memoryStorage();
  const session = memoryStorage();
  const win = { localStorage: local, sessionStorage: session };
  assert.equal(whatsNewStorage("", win), local);
  assert.equal(whatsNewStorage("beta", win), session, "beta must not use up the live app's one showing");
});

test("seen once dismissed, and only for this version", () => {
  const s = memoryStorage();
  assert.equal(whatsNewSeen(s), false);
  markWhatsNewSeen(s);
  assert.equal(whatsNewSeen(s), true);
  // A later notice gets a new version, so an old dismissal does not hide it.
  const older = memoryStorage();
  older.setItem("pxl_seen_new_look", "something-earlier");
  assert.equal(whatsNewSeen(older), false);
  assert.ok(WHATS_NEW_VERSION);
});

test("a storage that throws shows the card and does not throw", () => {
  const broken = {
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("blocked"); },
  };
  assert.equal(whatsNewSeen(broken), false);
  assert.doesNotThrow(() => markWhatsNewSeen(broken));
  assert.equal(whatsNewSeen(null), false);
  assert.doesNotThrow(() => markWhatsNewSeen(null));
  const hostile = {};
  Object.defineProperty(hostile, "localStorage", { get() { throw new Error("SecurityError"); } });
  assert.equal(whatsNewStorage("", hostile), null);
});
