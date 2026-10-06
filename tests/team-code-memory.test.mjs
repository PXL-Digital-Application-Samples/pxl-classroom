// frontend/src/lib/team-code-memory.js: the join codes a browser was given, and
// what happens when it will not keep them.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  JOIN_CODES_KEY,
  forgetAnyJoinCode,
  forgetJoinCode,
  rememberJoinCode,
  rememberedJoinCode,
} from "../frontend/src/lib/team-code-memory.js";
import { formatJoinCode, newJoinCode } from "../lib/team-join-code.mjs";

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    raw: map,
  };
}
const blocked = {
  getItem() { throw new Error("SecurityError"); },
  setItem() { throw new Error("QuotaExceededError"); },
};
const key = (over = {}) => ({ org: "o", assignmentId: "lab", slug: "alpha", login: "ann", ...over });

test("a code is kept per account, organization, assignment and team, in any spelling of them", () => {
  const s = memoryStorage();
  const code = newJoinCode();
  rememberJoinCode(key({ org: "PXL-Org", slug: "Alpha", login: "Ann" }), formatJoinCode(code).toLowerCase(), s);
  assert.equal(rememberedJoinCode(key({ org: "pxl-org", login: "ann" }), s), code);
  assert.equal(rememberedJoinCode(key({ org: "pxl-org", slug: "beta" }), s), "");
  assert.equal(rememberedJoinCode(key({ org: "pxl-org", assignmentId: "lab-2" }), s), "");
  assert.equal(rememberedJoinCode(key({ org: "other-org" }), s), "");
});

test("a shared computer does not show one student's codes to the next", () => {
  const s = memoryStorage();
  rememberJoinCode(key({ login: "ann" }), newJoinCode(), s);
  assert.equal(rememberedJoinCode(key({ login: "bob" }), s), "");
  // And nothing is kept for nobody.
  rememberJoinCode(key({ login: "" }), newJoinCode(), s);
  assert.equal(rememberedJoinCode(key({ login: "" }), s), "");
});

test("forgetting removes only the code that was refused, never one a later attempt stored", () => {
  const s = memoryStorage();
  const [refused, later] = [newJoinCode(), newJoinCode()];
  rememberJoinCode(key(), refused, s);
  rememberJoinCode(key(), later, s);
  forgetJoinCode(key(), refused, s);
  assert.equal(rememberedJoinCode(key(), s), later);
  forgetJoinCode(key(), later, s);
  assert.equal(rememberedJoinCode(key(), s), "");
});

test("a team this browser tried to make, refused while the page was closed, is forgotten whatever its code", () => {
  const s = memoryStorage();
  rememberJoinCode(key({ slug: "gamma" }), newJoinCode(), s);
  rememberJoinCode(key({ slug: "delta" }), newJoinCode(), s);
  forgetAnyJoinCode(key({ slug: "gamma" }), s);
  assert.equal(rememberedJoinCode(key({ slug: "gamma" }), s), "");
  assert.notEqual(rememberedJoinCode(key({ slug: "delta" }), s), "", "only that team");
});

test("a browser that refuses storage still shows the creator the code they just made", () => {
  const code = newJoinCode();
  const k = key({ assignmentId: "blocked-lab" });
  assert.doesNotThrow(() => rememberJoinCode(k, code, blocked));
  assert.equal(rememberedJoinCode(k, blocked), code, "kept for this page");
  forgetJoinCode(k, code, blocked);
  assert.equal(rememberedJoinCode(k, blocked), "");
  assert.doesNotThrow(() => rememberedJoinCode(k, null));
});

test("junk in storage is read as nothing, never as a code", () => {
  const s = memoryStorage();
  const k = key({ assignmentId: "junk-lab" });
  s.setItem(JOIN_CODES_KEY, "{not json");
  assert.equal(rememberedJoinCode(k, s), "");
  s.setItem(JOIN_CODES_KEY, JSON.stringify({ "ann/o/junk-lab/alpha": "<script>" }));
  assert.equal(rememberedJoinCode(k, s), "");
  s.setItem(JOIN_CODES_KEY, "[1,2]");
  assert.equal(rememberedJoinCode(k, s), "");
});

test("nothing that is not a code is remembered", () => {
  const s = memoryStorage();
  rememberJoinCode(key({ slug: "gamma" }), "not-a-code", s);
  rememberJoinCode(key({ slug: "" }), newJoinCode(), s);
  assert.equal(s.raw.size, 0);
});
