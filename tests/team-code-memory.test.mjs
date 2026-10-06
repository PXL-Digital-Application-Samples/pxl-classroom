// frontend/src/lib/team-code-memory.js: the join codes a browser was given, and
// what happens when it will not keep them.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  JOIN_CODES_KEY,
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

test("a code is kept per organization, assignment and team, in any spelling of them", () => {
  const s = memoryStorage();
  const code = newJoinCode();
  rememberJoinCode("PXL-Org", "lab", "Alpha", formatJoinCode(code).toLowerCase(), s);
  assert.equal(rememberedJoinCode("pxl-org", "lab", "alpha", s), code);
  assert.equal(rememberedJoinCode("pxl-org", "lab", "beta", s), "");
  assert.equal(rememberedJoinCode("pxl-org", "lab-2", "alpha", s), "");
  assert.equal(rememberedJoinCode("other-org", "lab", "alpha", s), "");
});

test("forgetting removes only the code that was refused, never one a later attempt stored", () => {
  const s = memoryStorage();
  const [refused, later] = [newJoinCode(), newJoinCode()];
  rememberJoinCode("o", "lab", "alpha", refused, s);
  rememberJoinCode("o", "lab", "alpha", later, s);
  forgetJoinCode("o", "lab", "alpha", refused, s);
  assert.equal(rememberedJoinCode("o", "lab", "alpha", s), later);
  forgetJoinCode("o", "lab", "alpha", later, s);
  assert.equal(rememberedJoinCode("o", "lab", "alpha", s), "");
});

test("a browser that refuses storage still shows the creator the code they just made", () => {
  const code = newJoinCode();
  assert.doesNotThrow(() => rememberJoinCode("o", "blocked-lab", "alpha", code, blocked));
  assert.equal(rememberedJoinCode("o", "blocked-lab", "alpha", blocked), code, "kept for this page");
  forgetJoinCode("o", "blocked-lab", "alpha", code, blocked);
  assert.equal(rememberedJoinCode("o", "blocked-lab", "alpha", blocked), "");
  assert.doesNotThrow(() => rememberedJoinCode("o", "blocked-lab", "alpha", null));
});

test("junk in storage is read as nothing, never as a code", () => {
  const s = memoryStorage();
  s.setItem(JOIN_CODES_KEY, "{not json");
  assert.equal(rememberedJoinCode("o", "junk-lab", "alpha", s), "");
  s.setItem(JOIN_CODES_KEY, JSON.stringify({ "o/junk-lab/alpha": "<script>" }));
  assert.equal(rememberedJoinCode("o", "junk-lab", "alpha", s), "");
  s.setItem(JOIN_CODES_KEY, "[1,2]");
  assert.equal(rememberedJoinCode("o", "junk-lab", "alpha", s), "");
});

test("nothing that is not a code is remembered", () => {
  const s = memoryStorage();
  rememberJoinCode("o", "lab", "gamma", "not-a-code", s);
  rememberJoinCode("o", "lab", "", newJoinCode(), s);
  assert.equal(s.raw.size, 0);
});
