// PXL Classroom - public-data-contract.test.mjs
//
// Verifies that the Pages public data generator outputs the contract shape
// expected by the SPA (an object keyed by assignment ID instead of an array).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import { signInviteToken, generateKeyPair, inviteFileFor } from "../lib/invite-token.mjs";

// Assignments need an invitation before the generator will publish their
// acceptance card - the card lives at public/i/<sha256(token)>.json, and the
// org-wide index deliberately no longer carries it.
const KEYPAIR = generateKeyPair();
function mintToken(org, assignmentId) {
  return signInviteToken({
    org,
    assignmentId,
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    nonce: "0badc0de",
    privateKeyPem: KEYPAIR.privateKeyPem,
  });
}

const here = dirname(fileURLToPath(import.meta.url));
const generator = join(here, "..", "pages", "generate.mjs");
const fix = (n) => join(here, "fixtures", n);

test("public-clean.json fixture has assignments as an object", () => {
  const content = readFileSync(fix("public-clean.json"), "utf8");
  const data = JSON.parse(content);
  assert.equal(data.schema_version, 1);
  assert.ok(data.assignments && typeof data.assignments === "object" && !Array.isArray(data.assignments), "assignments must be a non-array object");
  assert.ok(data.assignments["automation-pe-1"], "should have automation-pe-1 key");
  const a = data.assignments["automation-pe-1"];
  assert.equal(a.id, "automation-pe-1");
  assert.equal(a.title, "Automation Practice 1");
  assert.equal(a.state, "published");
});

test("generate.mjs outputs assignments as an object keyed by ID", () => {
  const dir = mkdtempSync(join(tmpdir(), "pxl-gen-test-"));
  const assignmentsDir = join(dir, "assignments");
  mkdirSync(assignmentsDir);
  copyFileSync(fix("valid-assignment.yml"), join(assignmentsDir, "test-valid.yml"));

  const outDir = join(dir, "public");

  const res = spawnSync("node", [generator], {
    env: {
      ...process.env,
      DATA_DIR: dir,
      OUTPUT_DIR: outDir,
    },
    encoding: "utf8",
  });

  assert.equal(res.status, 0, `generator failed: ${res.stderr}`);

  const outputContent = readFileSync(join(outDir, "assignments.json"), "utf8");
  const output = JSON.parse(outputContent);

  assert.equal(output.schema_version, 1);
  assert.ok(output.assignments && typeof output.assignments === "object" && !Array.isArray(output.assignments), "assignments output must be a non-array object");
  assert.ok(output.assignments["test-valid"], "should have test-valid key");
  const a = output.assignments["test-valid"];
  assert.equal(a.id, "test-valid");
  assert.equal(a.title, "Test Valid Assignment"); // from valid-assignment.yml title
  assert.equal(a.state, "published"); // from valid-assignment.yml state
});

test("generate.mjs publishes roster_mode on the invitation card, defaulting to enforced", () => {
  const scanner = join(here, "..", "pages", "scan.mjs");

  const run = (yamlExtra) => {
    const dir = mkdtempSync(join(tmpdir(), "pxl-gen-rm-"));
    const assignmentsDir = join(dir, "assignments");
    mkdirSync(assignmentsDir);
    const token = mintToken("PXLAutomation", "test-valid");
    const base = readFileSync(fix("valid-assignment.yml"), "utf8");
    writeFileSync(
      join(assignmentsDir, "test-valid.yml"),
      `${base}${yamlExtra}\ninvite_token: ${token}\ninvite_nonce: 0badc0de\n`
    );
    const outDir = join(dir, "public");
    const res = spawnSync("node", [generator], {
      env: { ...process.env, DATA_DIR: dir, OUTPUT_DIR: outDir },
      encoding: "utf8",
    });
    assert.equal(res.status, 0, `generator failed: ${res.stderr}`);
    const card = JSON.parse(
      readFileSync(join(outDir, "i", `${inviteFileFor(token)}.json`), "utf8")
    ).assignment;
    const index = JSON.parse(readFileSync(join(outDir, "assignments.json"), "utf8"));
    return { mode: card.roster_mode, card, index, outDir, token };
  };

  // Absent -> enforced; explicit open -> open; garbage -> fails closed.
  assert.equal(run("").mode, "enforced");
  assert.equal(run("\nroster_mode: open\n").mode, "open");
  assert.equal(run("\nroster_mode: enforced\n").mode, "enforced");
  assert.equal(run("\nroster_mode: Open\n").mode, "enforced");

  // The field name contains "roster" - make sure publishing it does not trip
  // the privacy gate, which would block every Pages deploy.
  const { outDir } = run("\nroster_mode: open\n");
  const scan = spawnSync("node", [scanner, outDir], { encoding: "utf8" });
  assert.equal(scan.status, 0, `privacy scanner blocked roster_mode: ${scan.stdout}${scan.stderr}`);
});

test("the org-wide index carries no acceptance detail, only what the portal matches on", () => {
  // Anyone can fetch this file. It exists solely so a signed-in student can map
  // their own repositories to an assignment - students cannot read the control
  // repo, so it has nowhere else to come from. Everything an outsider could use
  // to size up or reach an assignment belongs on the invitation card instead.
  const dir = mkdtempSync(join(tmpdir(), "pxl-gen-index-"));
  const assignmentsDir = join(dir, "assignments");
  mkdirSync(assignmentsDir);
  const token = mintToken("PXLAutomation", "test-valid");
  const base = readFileSync(fix("valid-assignment.yml"), "utf8");
  writeFileSync(
    join(assignmentsDir, "test-valid.yml"),
    `${base}\ninvite_token: ${token}\ninvite_nonce: 0badc0de\n`
  );
  const outDir = join(dir, "public");
  const res = spawnSync("node", [generator], {
    env: { ...process.env, DATA_DIR: dir, OUTPUT_DIR: outDir },
    encoding: "utf8",
  });
  assert.equal(res.status, 0, `generator failed: ${res.stderr}`);

  const entry = JSON.parse(readFileSync(join(outDir, "assignments.json"), "utf8"))
    .assignments["test-valid"];
  for (const withheld of [
    "broker_repo",
    "roster_mode",
    "acceptance_mode",
    "max_acceptances",
    "accepted_count",
    "description",
    "group_config",
    "invite_token",
  ]) {
    assert.ok(!(withheld in entry), `${withheld} must not be in the public index`);
  }

  const card = JSON.parse(
    readFileSync(join(outDir, "i", `${inviteFileFor(token)}.json`), "utf8")
  ).assignment;
  assert.equal(card.broker_repo, "broker-test-valid");
  assert.ok(card.max_acceptances);

  // The card is named by the digest, and the token itself appears nowhere.
  assert.ok(!readFileSync(join(outDir, "i", `${inviteFileFor(token)}.json`), "utf8").includes(token));
  assert.ok(!readFileSync(join(outDir, "assignments.json"), "utf8").includes(token));
});

test("generate.mjs outputs assignments as an empty object if no assignments directory exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "pxl-gen-test-empty-"));
  const outDir = join(dir, "public");

  const res = spawnSync("node", [generator], {
    env: {
      ...process.env,
      DATA_DIR: dir,
      OUTPUT_DIR: outDir,
    },
    encoding: "utf8",
  });

  assert.equal(res.status, 0, `generator failed: ${res.stderr}`);

  const outputContent = readFileSync(join(outDir, "assignments.json"), "utf8");
  const output = JSON.parse(outputContent);

  assert.equal(output.schema_version, 1);
  assert.ok(output.assignments && typeof output.assignments === "object" && !Array.isArray(output.assignments), "assignments output must be a non-array object");
  assert.equal(Object.keys(output.assignments).length, 0);
});
