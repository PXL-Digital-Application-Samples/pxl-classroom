// lib/team-join-code.mjs and the sealed code in lib/claim.mjs: the rules a
// team's join code is made, typed, checked and carried by.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  JOIN_CODE_ALPHABET,
  JOIN_CODE_LENGTH,
  formatJoinCode,
  isWellFormedJoinCode,
  joinCodeMatches,
  newJoinCode,
  normalizeJoinCode,
  requiresJoinCode,
  teamNeedsJoinCode,
} from "../lib/team-join-code.mjs";
import {
  decryptClaimWithAnyKey,
  decryptTeamCodeWithAnyKey,
  encryptClaim,
  encryptTeamCode,
  generateClaimKeypair,
} from "../lib/claim.mjs";

const ON = { require_join_code: true };

/** A deterministic stream of bytes, so a failure names the code it found. */
function seeded(seed) {
  let s = seed >>> 0;
  return (n) => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      out[i] = s >>> 24;
    }
    return out;
  };
}

const sample = (count) => Array.from({ length: count }, (_, i) => newJoinCode(seeded(i + 1)));

test("the alphabet is what a person reads off a screen: no 0/O, no 1/I/L, and a prime count", () => {
  assert.equal(JOIN_CODE_ALPHABET.length, 31);
  assert.equal(new Set(JOIN_CODE_ALPHABET).size, 31);
  for (const ch of "0O1IL") assert.ok(!JOIN_CODE_ALPHABET.includes(ch), ch);
});

test("the schema's pattern admits exactly the alphabet - derived, not spelled twice", () => {
  const schema = JSON.parse(readFileSync(new URL("../schemas/team.schema.json", import.meta.url), "utf8"));
  const pattern = new RegExp(schema.properties.join_code.pattern);
  for (const code of sample(50)) assert.match(code, pattern);
  for (let c = 0x21; c < 0x7f; c++) {
    const ch = String.fromCharCode(c);
    assert.equal(pattern.test(ch.repeat(JOIN_CODE_LENGTH)), JOIN_CODE_ALPHABET.includes(ch), `character ${ch}`);
  }
});

test("a new code is six characters of the alphabet and passes its own check", () => {
  for (const code of sample(500)) {
    assert.equal(code.length, JOIN_CODE_LENGTH);
    assert.ok([...code].every((ch) => JOIN_CODE_ALPHABET.includes(ch)), code);
    assert.ok(isWellFormedJoinCode(code), code);
  }
  // The real randomness too, not only the seeded stream.
  for (let i = 0; i < 50; i++) assert.ok(isWellFormedJoinCode(newJoinCode()));
});

test("bytes that would favour some characters are skipped, never folded in", () => {
  // 248..255 are the bytes `% 31` would map onto the first eight characters a
  // second time. A stream of nothing else must not produce a code from them.
  let calls = 0;
  const biased = (n) => {
    calls++;
    return calls < 3 ? new Uint8Array(n).fill(250) : new Uint8Array(n).fill(0);
  };
  const code = newJoinCode(biased);
  assert.equal(code.slice(0, 5), JOIN_CODE_ALPHABET[0].repeat(5));
  assert.ok(calls >= 3, "the biased bytes were read and discarded");
});

test("every single wrong character is caught before anything is sent", () => {
  for (const code of sample(200)) {
    for (let i = 0; i < JOIN_CODE_LENGTH; i++) {
      for (const ch of JOIN_CODE_ALPHABET) {
        if (ch === code[i]) continue;
        const typo = code.slice(0, i) + ch + code.slice(i + 1);
        assert.ok(!isWellFormedJoinCode(typo), `${code} -> ${typo}`);
      }
    }
  }
});

test("every swap of two different characters is caught, adjacent or not", () => {
  for (const code of sample(200)) {
    for (let i = 0; i < JOIN_CODE_LENGTH; i++) {
      for (let j = i + 1; j < JOIN_CODE_LENGTH; j++) {
        if (code[i] === code[j]) continue;
        const swapped = [...code];
        [swapped[i], swapped[j]] = [swapped[j], swapped[i]];
        assert.ok(!isWellFormedJoinCode(swapped.join("")), `${code} swap ${i},${j}`);
      }
    }
  }
});

test("what a person types is read the way they meant it", () => {
  const code = sample(1)[0];
  const shown = formatJoinCode(code);
  assert.match(shown, /^[2-9A-Z]{3}-[2-9A-Z]{3}$/);
  for (const typed of [code, code.toLowerCase(), shown, ` ${shown} `, shown.replace("-", " "), shown.toLowerCase()]) {
    assert.equal(normalizeJoinCode(typed), code, JSON.stringify(typed));
    assert.ok(isWellFormedJoinCode(typed));
  }
  for (const bad of ["", "ABC", "ABCDEFG", "ABC-DE0", "ABCDEI", "ABC_DEF", null, 42, undefined, {}]) {
    assert.equal(normalizeJoinCode(bad), "", JSON.stringify(bad));
    assert.equal(isWellFormedJoinCode(bad), false);
  }
  assert.equal(formatJoinCode("nonsense"), "");
});

test("a code matches its team's in any spelling, and an unreadable one matches nothing", () => {
  const [a, b] = sample(2);
  assert.ok(joinCodeMatches(a, formatJoinCode(a).toLowerCase()));
  assert.ok(!joinCodeMatches(a, b));
  assert.ok(!joinCodeMatches(a, ""));
  assert.ok(!joinCodeMatches("garbage", "garbage"), "a stored code nobody can read is not matched by typing it back");
  assert.ok(!joinCodeMatches(undefined, a));
});

test("only an explicit true asks for codes - absent is how every assignment before the field behaved", () => {
  assert.equal(requiresJoinCode(ON), true);
  for (const off of [undefined, null, {}, { require_join_code: false }, { require_join_code: "true" }, { require_join_code: 1 }]) {
    assert.equal(requiresJoinCode(off), false, JSON.stringify(off));
  }
});

test("a team needs its code only while codes are asked for, and only if it has one", () => {
  const code = sample(1)[0];
  assert.equal(teamNeedsJoinCode(ON, { join_code: code }), true);
  assert.equal(teamNeedsJoinCode(ON, {}), false, "made before the setting, seeded, or the lecturer's: open");
  assert.equal(teamNeedsJoinCode({}, { join_code: code }), false, "unticking the setting opens every team");
  // Fails closed: a code that is THERE but unreadable locks, it does not open -
  // empty and null included, because absent and empty are different answers.
  for (const unreadable of ["h4nd-edited!", 12345, "", null]) {
    assert.equal(teamNeedsJoinCode(ON, { join_code: unreadable }), true, JSON.stringify(unreadable));
    assert.equal(joinCodeMatches(unreadable, ""), false);
  }
  assert.equal(teamNeedsJoinCode(ON, null), false);
});

// --- the sealed code ---------------------------------------------------------

const keys = await generateClaimKeypair();
const seal = (over = {}) =>
  encryptTeamCode({ publicKey: keys.publicKey, code: "K7P4QX", githubId: 101, assignmentId: "lab", teamSlug: "alpha", ...over });

test("a sealed code opens at the hub and says whose, for which assignment and team", async () => {
  const payload = await seal();
  assert.match(payload, /^t1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.ok(!payload.includes("K7P4QX"));
  const opened = await decryptTeamCodeWithAnyKey({ privateKeys: [keys.privateKey], payload });
  assert.deepEqual(opened, { code: "K7P4QX", githubId: 101, assignmentId: "lab", teamSlug: "alpha" });
  // Two seals of the same code are different bytes: the public archive cannot
  // tell two students typed the same thing.
  assert.notEqual(await seal(), payload);
});

test("a claim and a team code cannot be opened as each other", async () => {
  const claim = await encryptClaim({ publicKey: keys.publicKey, email: "ann.peeters@student.pxl.be", githubId: 101, assignmentId: "lab" });
  await assert.rejects(decryptTeamCodeWithAnyKey({ privateKeys: [keys.privateKey], payload: claim }));
  const code = await seal();
  await assert.rejects(decryptClaimWithAnyKey({ privateKeys: [keys.privateKey], payload: code }));
  // Same bytes relabelled: the key derivation differs, so the tag fails.
  const relabelled = "c1" + code.slice(2);
  await assert.rejects(decryptClaimWithAnyKey({ privateKeys: [keys.privateKey], payload: relabelled }));
  await assert.rejects(decryptTeamCodeWithAnyKey({ privateKeys: [keys.privateKey], payload: "t1" + claim.slice(2) }));
});

test("tampered, truncated or foreign ciphertext fails the same way", async () => {
  const payload = await seal();
  const parts = payload.split(".");
  const flip = (s) => (s[5] === "A" ? s.slice(0, 5) + "B" + s.slice(6) : s.slice(0, 5) + "A" + s.slice(6));
  const other = await generateClaimKeypair();
  const messages = new Set();
  for (const bad of [
    [parts[0], parts[1], parts[2], flip(parts[3])].join("."),
    [parts[0], parts[1], flip(parts[2]), parts[3]].join("."),
    parts.slice(0, 3).join("."),
    "",
    "t1.a.b.c",
  ]) {
    await assert.rejects(decryptTeamCodeWithAnyKey({ privateKeys: [keys.privateKey], payload: bad }), (e) => {
      messages.add(e.message);
      return true;
    });
  }
  await assert.rejects(decryptTeamCodeWithAnyKey({ privateKeys: [other.privateKey], payload }), (e) => {
    messages.add(e.message);
    return true;
  });
  assert.deepEqual([...messages], ["team code could not be read"], "one failure for every cause");
  await assert.rejects(decryptTeamCodeWithAnyKey({ privateKeys: [], payload }));
});

test("a code sealed before a key rotation still opens with the retired key", async () => {
  const payload = await seal();
  const next = await generateClaimKeypair();
  const opened = await decryptTeamCodeWithAnyKey({ privateKeys: [next.privateKey, keys.privateKey], payload });
  assert.equal(opened.code, "K7P4QX");
});

test("sealing refuses to seal nothing", async () => {
  await assert.rejects(seal({ code: "" }));
  await assert.rejects(seal({ githubId: 0 }));
  await assert.rejects(seal({ teamSlug: "" }));
  await assert.rejects(seal({ assignmentId: "" }));
});
