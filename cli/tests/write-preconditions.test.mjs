// Every CLI write decided from what it read asks the commit it lands on
// (review 2026-10-14: S3, S4, S9, S12, G13b). `unchangedSince` is the one
// precondition for a single file; the team guards live in
// lib/team-write-guard.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { unchangedSince } from "../src/lib/control-repo.mjs";
import { ROSTER_PATH } from "../../lib/roster-entries.mjs";

const at = (sha) => async () => (sha === 404 ? Promise.reject(Object.assign(new Error("Not Found"), { status: 404 })) : { data: { sha } });

test("unchangedSince: the version read is still there, or still absent", async () => {
  const check = unchangedSince("Org", ROSTER_PATH, "abc", "changed");
  assert.equal(await check({ request: at("abc"), parentSha: "p" }), null);
  assert.equal(await check({ request: at("def"), parentSha: "p" }), "changed");
  assert.equal(await check({ request: at(404), parentSha: "p" }), "changed", "deleted since");
  const absent = unchangedSince("Org", ROSTER_PATH, null, "changed");
  assert.equal(await absent({ request: at(404), parentSha: "p" }), null, "still absent");
  assert.equal(await absent({ request: at("new"), parentSha: "p" }), "changed", "made since");
  // Any other failure throws, which refuses the write rather than passing it.
  const boom = async () => Promise.reject(Object.assign(new Error("boom"), { status: 502 }));
  await assert.rejects(check({ request: boom, parentSha: "p" }), /boom/);
});

test("S12: every whole-roster write goes through the one guarded writer", () => {
  const src = readFileSync(new URL("../src/commands/roster.mjs", import.meta.url), "utf8");
  const writes = src.match(/changes: \[\{ path: ROSTER_PATH/g) || [];
  assert.equal(writes.length, 1, "one writer, in writeRoster");
  assert.match(src, /precondition: unchangedSince\(org, ROSTER_PATH, readSha \?\? null/);
  for (const sha of ["readSha", "claimReadSha", "promoteReadSha"]) {
    assert.match(src, new RegExp(`sha: ${sha} \\} = await fetchExistingRoster`), `${sha} is the version planned from`);
  }
});
