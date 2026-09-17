// frontend/src/lib/auth-storage.js - where a sign-in is kept, and how tabs agree.
//
// Reported 2026-09-17: a lecturer copied a device code "every time", because the
// token lived in sessionStorage and so died with the tab. It is localStorage now,
// for everyone. These run every branch against fake storages, including ones that
// throw, because a throw on this path is a blank page or a sign-in loop.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AUTH_KEY,
  authChangeFromOtherTab,
  clearStoredAuth,
  loadStoredAuth,
  saveStoredAuth,
} from "../frontend/src/lib/auth-storage.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const NOW = new Date("2026-09-17T12:00:00Z");

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
  };
}

const throwing = {
  getItem() { throw new Error("SecurityError"); },
  setItem() { throw new Error("QuotaExceededError"); },
  removeItem() { throw new Error("SecurityError"); },
};

const record = (overrides = {}) => ({
  access_token: "ghu_live",
  user: { login: "lecturer" },
  expires_at: "2026-09-17T18:00:00Z",
  ...overrides,
});
const raw = (r) => JSON.stringify(r);

test("a live record in localStorage is the sign-in", () => {
  const local = memoryStorage({ [AUTH_KEY]: raw(record()) });
  const data = loadStoredAuth({ local, session: memoryStorage() }, NOW);
  assert.equal(data.access_token, "ghu_live");
  assert.equal(data.user.login, "lecturer");
});

test("nothing stored is signed out", () => {
  assert.equal(loadStoredAuth({ local: memoryStorage(), session: memoryStorage() }, NOW), null);
});

test("an expired record is removed, not restored", () => {
  const local = memoryStorage({ [AUTH_KEY]: raw(record({ expires_at: "2026-09-17T11:59:59Z" })) });
  assert.equal(loadStoredAuth({ local, session: null }, NOW), null);
  assert.equal(local.map.has(AUTH_KEY), false);
});

test("a record with no usable expiry or token is removed", () => {
  for (const bad of [
    raw(record({ expires_at: undefined })),
    raw(record({ expires_at: "not a date" })),
    raw(record({ access_token: "" })),
    "{not json",
    "null",
  ]) {
    const local = memoryStorage({ [AUTH_KEY]: bad });
    assert.equal(loadStoredAuth({ local, session: null }, NOW), null, bad);
    assert.equal(local.map.has(AUTH_KEY), false, bad);
  }
});

test("a tab signed in before the change is moved across once, so the deploy signs nobody out", () => {
  const local = memoryStorage();
  const session = memoryStorage({ [AUTH_KEY]: raw(record()) });
  const data = loadStoredAuth({ local, session }, NOW);
  assert.equal(data.access_token, "ghu_live");
  assert.equal(local.map.get(AUTH_KEY), raw(record()), "moved to localStorage");
  assert.equal(session.map.has(AUTH_KEY), false, "and not left behind in the tab");
});

test("localStorage wins over a leftover per-tab copy", () => {
  const local = memoryStorage({ [AUTH_KEY]: raw(record({ access_token: "ghu_new" })) });
  const session = memoryStorage({ [AUTH_KEY]: raw(record({ access_token: "ghu_old" })) });
  assert.equal(loadStoredAuth({ local, session }, NOW).access_token, "ghu_new");
});

test("an expired per-tab copy is dropped, not moved", () => {
  const local = memoryStorage();
  const session = memoryStorage({ [AUTH_KEY]: raw(record({ expires_at: "2026-09-17T08:00:00Z" })) });
  assert.equal(loadStoredAuth({ local, session }, NOW), null);
  assert.equal(session.map.has(AUTH_KEY), false);
  assert.equal(local.map.has(AUTH_KEY), false);
});

test("a storage that throws or is missing is signed out, never an exception", () => {
  assert.equal(loadStoredAuth({ local: throwing, session: throwing }, NOW), null);
  assert.equal(loadStoredAuth({ local: null, session: null }, NOW), null);
  assert.equal(saveStoredAuth({ local: throwing }, record()), false);
  assert.equal(saveStoredAuth({ local: null }, record()), true);
  assert.doesNotThrow(() => clearStoredAuth({ local: throwing, session: null }));
});

test("a per-tab copy still signs in this page when localStorage refuses the move", () => {
  const session = memoryStorage({ [AUTH_KEY]: raw(record()) });
  const local = { ...memoryStorage(), setItem() { throw new Error("QuotaExceededError"); } };
  assert.equal(loadStoredAuth({ local, session }, NOW).access_token, "ghu_live");
});

test("saving writes the record, and clearing removes it from both storages", () => {
  const local = memoryStorage();
  const session = memoryStorage({ [AUTH_KEY]: raw(record()) });
  assert.equal(saveStoredAuth({ local }, record()), true);
  assert.deepEqual(JSON.parse(local.map.get(AUTH_KEY)), record());
  clearStoredAuth({ local, session });
  assert.equal(local.map.has(AUTH_KEY), false);
  assert.equal(session.map.has(AUTH_KEY), false);
});

test("another tab signing out is a change", () => {
  const change = authChangeFromOtherTab({ key: AUTH_KEY, newValue: null }, "ghu_live");
  assert.deepEqual(change, { signedIn: false, login: null });
});

test("another tab signing in, or as someone else, is a change that names the account", () => {
  assert.deepEqual(
    authChangeFromOtherTab({ key: AUTH_KEY, newValue: raw(record()) }, null),
    { signedIn: true, login: "lecturer" },
  );
  assert.deepEqual(
    authChangeFromOtherTab({ key: AUTH_KEY, newValue: raw(record({ access_token: "ghu_b", user: { login: "other" } })) }, "ghu_live"),
    { signedIn: true, login: "other" },
  );
});

test("the same token, another key, or nothing signed in anywhere is not a change", () => {
  assert.equal(authChangeFromOtherTab({ key: AUTH_KEY, newValue: raw(record()) }, "ghu_live"), null,
    "a tab must not reload over its own sign-in");
  assert.equal(authChangeFromOtherTab({ key: "pxl_theme", newValue: "dark" }, "ghu_live"), null);
  assert.equal(authChangeFromOtherTab({ key: AUTH_KEY, newValue: null }, null), null);
  assert.equal(authChangeFromOtherTab(null, "ghu_live"), null);
});

test("localStorage.clear() in another tab is a sign-out", () => {
  assert.deepEqual(authChangeFromOtherTab({ key: null, newValue: null }, "ghu_live"), { signedIn: false, login: null });
});

test("auth.js keeps the token only through this module, and never in sessionStorage", () => {
  // The storage decision is one module's; a second write path elsewhere is how
  // one tab ends up signed in as somebody the others are not.
  const code = readFileSync(join(root, "frontend", "src", "lib", "auth.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/sessionStorage\.|localStorage\./.test(code), "no direct storage call in auth.js");
  assert.match(code, /saveStoredAuth\(browserStores\(\)/);
  assert.ok(!/refresh_token/.test(code), "GitHub's refresh token is not kept");
});
