// Every CLI write decided from what it read asks the commit it lands on
// (review 2026-10-14: S3, S4, S9, S12, G13b). `unchangedSince` is the one
// precondition for a single file; the team guards live in
// lib/team-write-guard.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFileAtHead, unchangedSince } from "../src/lib/control-repo.mjs";
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

test("P2-8: a file is read at the branch head's COMMIT, as the write's check reads it - never by branch name", async () => {
  const asked = [];
  const octokit = {
    request: async (route, params) => {
      asked.push({ route, ...params });
      if (route.startsWith("GET /repos/{owner}/{repo}/git/ref/")) return { data: { object: { sha: "headsha" } } };
      return { data: { sha: "blobsha", content: Buffer.from("students: []\n").toString("base64") } };
    },
  };
  const file = await readFileAtHead(octokit, { org: "Org", path: ROSTER_PATH });
  assert.deepEqual(file, { text: "students: []\n", sha: "blobsha" });
  assert.equal(asked[1].ref, "headsha", "the contents read names the commit");
  // Absent is null; any other failure throws rather than reading as absent.
  const missing = { request: async (route) => { if (route.includes("git/ref")) return { data: { object: { sha: "h" } } }; throw Object.assign(new Error("nf"), { status: 404 }); } };
  assert.equal(await readFileAtHead(missing, { org: "Org", path: ROSTER_PATH }), null);
  const broken = { request: async (route) => { if (route.includes("git/ref")) return { data: { object: { sha: "h" } } }; throw Object.assign(new Error("boom"), { status: 502 }); } };
  await assert.rejects(readFileAtHead(broken, { org: "Org", path: ROSTER_PATH }), /boom/);
});
