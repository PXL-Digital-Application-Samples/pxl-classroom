// lib/org-registry.mjs - "has this organization been set up?", asked of the hub.
//
// The dashboard now decides between "not set up" and "set up, not yours" on this
// answer (2026-09-17), so what it says for a failed read matters: unreadable must
// never come back as unlisted, or a hub admin is offered Setup Organization over
// a running course - the exact screen that was reported.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  REGISTRY_BRANCH,
  REGISTRY_FILE,
  lookupRegisteredOrg,
  registryContentsPath,
} from "../lib/org-registry.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const REGISTRY = `orgs:
  - login: PXL-Java-Essentials
    budget_owner_login: SamVanderstraeten
  - login: PXL-Automation-II
    budget_owner_login: tomcoolpxl
`;

const contents = (text) => ({
  ok: true,
  status: 200,
  data: { content: Buffer.from(text, "utf8").toString("base64"), encoding: "base64" },
});

test("an org in the file is listed, with its row", () => {
  const r = lookupRegisteredOrg(contents(REGISTRY), "PXL-Java-Essentials");
  assert.equal(r.state, "listed");
  assert.equal(r.entry.budget_owner_login, "SamVanderstraeten");
  assert.equal(r.reason, null);
});

test("an org login matches case-insensitively, as every login here does", () => {
  assert.equal(lookupRegisteredOrg(contents(REGISTRY), "pxl-java-essentials").state, "listed");
});

test("base64 with GitHub's line breaks decodes", () => {
  const res = contents(REGISTRY);
  res.data.content = res.data.content.replace(/(.{20})/g, "$1\n");
  assert.equal(lookupRegisteredOrg(res, "PXL-Automation-II").state, "listed");
});

test("a raw body is read too", () => {
  const r = lookupRegisteredOrg({ ok: true, status: 200, data: { raw: REGISTRY } }, "PXL-Automation-II");
  assert.equal(r.state, "listed");
});

test("an org not in the file is unlisted", () => {
  const r = lookupRegisteredOrg(contents(REGISTRY), "PXL-Someone-Else");
  assert.equal(r.state, "unlisted");
  assert.equal(r.reason, null);
});

test("a 404 is unlisted, and says the registry itself is missing", () => {
  // Before the first Setup Organization there is no branch and no file - and
  // scripts/get-participating-orgs.mjs reads that as "no orgs", deliberately.
  const r = lookupRegisteredOrg({ ok: false, status: 404, data: { message: "Not Found" } }, "PXL-Java-Essentials");
  assert.equal(r.state, "unlisted");
  assert.equal(r.reason, "no-registry");
});

test("any other failed read is unreadable, never unlisted", () => {
  for (const res of [
    { ok: false, status: 500, data: {} },
    { ok: false, status: 403, data: {} },
    { ok: false, status: 401, data: {} },
    { ok: false, status: null },
    null,
    undefined,
  ]) {
    const r = lookupRegisteredOrg(res, "PXL-Java-Essentials");
    assert.equal(r.state, "unreadable", `status ${res?.status}`);
    assert.equal(r.reason, "http");
  }
});

test("a file that does not parse is unreadable", () => {
  const r = lookupRegisteredOrg(contents("orgs: [\n  - login: x\n"), "x");
  assert.equal(r.state, "unreadable");
  assert.equal(r.reason, "parse");
  assert.ok(r.error);
});

test("a file of the wrong shape is unreadable, not a registry nobody is in", () => {
  // Reading `orgs: PXL-Java-Essentials` as "not listed" would offer Setup
  // Organization over every org on the hub.
  for (const text of ["orgs: PXL-Java-Essentials\n", "orgs:\n  login: PXL-Java-Essentials\n", "just a string\n"]) {
    const r = lookupRegisteredOrg(contents(text), "PXL-Java-Essentials");
    assert.equal(r.state, "unreadable", JSON.stringify(text));
    assert.equal(r.reason, "parse");
  }
});

test("an empty file is a registry nobody is in yet", () => {
  assert.equal(lookupRegisteredOrg(contents(""), "PXL-Java-Essentials").state, "unlisted");
  assert.equal(lookupRegisteredOrg(contents("orgs: []\n"), "PXL-Java-Essentials").state, "unlisted");
  assert.equal(lookupRegisteredOrg(contents("orgs:\n"), "PXL-Java-Essentials").state, "unlisted");
});

test("the path names the file on its branch", () => {
  assert.equal(
    registryContentsPath("PXL-Digital-Application-Samples", "pxl-classroom"),
    "/repos/PXL-Digital-Application-Samples/pxl-classroom/contents/participating-orgs.yml?ref=participating-orgs",
  );
});

test("Setup Organization writes the file and branch this module reads", () => {
  // The writer is a workflow, the readers are this module - two spellings in two
  // files, so the reader's spelling is checked against the writer's.
  const wf = readFileSync(join(root, ".github", "workflows", "setup-org.yml"), "utf8");
  assert.match(wf, new RegExp(`git checkout ${REGISTRY_BRANCH} \\|\\| git checkout --orphan ${REGISTRY_BRANCH}`));
  assert.match(wf, new RegExp(`git add ${REGISTRY_FILE.replace(".", "\\.")}\\b`));
  assert.match(wf, new RegExp(`git push origin ${REGISTRY_BRANCH}\\b`));
});
