// frontend/src/lib/control-repo-access.js - why a control repository said 404.
//
// Reported 2026-09-17: an owner of the HUB org, who was only an outside
// collaborator on PXL-Java-Essentials (through accepting her own test
// assignment), was badged Lecturer, told the course "needs its control
// repository", and offered a Set up button - over a course that had been
// running for days. She ran Setup Organization twice. The dashboard had treated
// hub write as "staff here"; it only ever meant "can run Setup".
//
// Run, not grepped: the decision is a function and these call it.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  UNREADABLE_CONTROL_REPO_VERDICTS,
  classifyUnreadableControlRepo,
  judgeUnreadableControlRepo,
} from "../frontend/src/lib/control-repo-access.js";
import { registryContentsPath } from "../lib/org-registry.mjs";

const ORG = "PXL-Java-Essentials";
const HUB = { hubOwner: "PXL-Digital-Application-Samples", hubRepo: "pxl-classroom" };

const registryBody = (text) => ({
  ok: true,
  status: 200,
  data: { content: Buffer.from(text, "utf8").toString("base64") },
});
const LISTED = registryBody(`orgs:\n  - login: ${ORG}\n    budget_owner_login: SamVanderstraeten\n`);
const UNLISTED = registryBody("orgs:\n  - login: PXL-Automation-II\n    budget_owner_login: tomcoolpxl\n");

/** A request stub answering the three reads, recording what was asked. */
function stub({ owner = false, push = false, registry = UNLISTED, throws = [] } = {}) {
  const asked = [];
  const request = async (method, path) => {
    asked.push(path);
    if (throws.includes(path)) throw new Error("network");
    if (path === `/orgs/${ORG}`) {
      return { ok: true, status: 200, data: { login: ORG, default_repository_permission: owner ? "read" : null } };
    }
    if (path === `/repos/${HUB.hubOwner}/${HUB.hubRepo}`) {
      return { ok: true, status: 200, data: { name: HUB.hubRepo, permissions: { push } } };
    }
    if (path === registryContentsPath(HUB.hubOwner, HUB.hubRepo)) return registry;
    return { ok: false, status: 404, data: {} };
  };
  return { request, asked };
}

const classify = (s) => classifyUnreadableControlRepo(s.request, { org: ORG, ...HUB });

test("the judge, over every combination", () => {
  const cases = [
    // An owner can see every repository, so an owner's 404 is absence.
    [{ orgAdmin: true, hubWritable: true, registry: "listed" }, "not-set-up"],
    [{ orgAdmin: true, hubWritable: false, registry: null }, "not-set-up"],
    // Not an owner and cannot run Setup: nothing to do here.
    [{ orgAdmin: false, hubWritable: false, registry: "listed" }, "no-access"],
    [{ orgAdmin: false, hubWritable: false, registry: null }, "no-access"],
    // Can run Setup, cannot see the org: the registry decides.
    [{ orgAdmin: false, hubWritable: true, registry: "listed" }, "no-org-access"],
    [{ orgAdmin: false, hubWritable: true, registry: "unlisted" }, "not-set-up"],
    [{ orgAdmin: false, hubWritable: true, registry: "unreadable" }, "unknown"],
    [{ orgAdmin: false, hubWritable: true, registry: null }, "unknown"],
  ];
  for (const [signals, verdict] of cases) {
    assert.equal(judgeUnreadableControlRepo(signals), verdict, JSON.stringify(signals));
    assert.ok(UNREADABLE_CONTROL_REPO_VERDICTS.includes(verdict));
  }
});

test("only a literal true admits - a truthy leftover is not a capability", () => {
  assert.equal(judgeUnreadableControlRepo({ orgAdmin: "none", hubWritable: false, registry: null }), "no-access");
  assert.equal(judgeUnreadableControlRepo({ orgAdmin: false, hubWritable: 1, registry: "listed" }), "no-access");
});

test("the reported case: hub write, not an owner, org listed", async () => {
  const s = stub({ push: true, registry: LISTED });
  const r = await classify(s);
  assert.equal(r.verdict, "no-org-access");
  assert.equal(r.hubWritable, true);
  assert.equal(r.orgAdmin, false);
  assert.equal(r.budgetOwner, "SamVanderstraeten");
});

test("a hub admin onboarding an org that is not listed is still offered setup", async () => {
  const r = await classify(stub({ push: true, registry: UNLISTED }));
  assert.equal(r.verdict, "not-set-up");
  assert.equal(r.budgetOwner, null);
});

test("an unreadable registry is unknown, never not-set-up", async () => {
  for (const registry of [{ ok: false, status: 500, data: {} }, registryBody("orgs: nope\n")]) {
    assert.equal((await classify(stub({ push: true, registry }))).verdict, "unknown");
  }
  const threw = stub({ push: true, throws: [registryContentsPath(HUB.hubOwner, HUB.hubRepo)] });
  assert.equal((await classify(threw)).verdict, "unknown");
});

test("the registry is not read where it cannot change the answer", async () => {
  const path = registryContentsPath(HUB.hubOwner, HUB.hubRepo);

  const owner = stub({ owner: true, push: true, registry: LISTED });
  assert.equal((await classify(owner)).verdict, "not-set-up");
  assert.ok(!owner.asked.includes(path), "an owner's 404 is already absence");

  const student = stub({ registry: LISTED });
  assert.equal((await classify(student)).verdict, "no-access");
  assert.ok(!student.asked.includes(path), "a student is refused whatever it says");
});

test("a failed or thrown capability read refuses rather than admits", async () => {
  const failed = {
    request: async (method, path) => (path === `/orgs/${ORG}`
      ? { ok: false, status: 500, data: { default_repository_permission: "read" } }
      : { ok: false, status: 500, data: { permissions: { push: true } } }),
  };
  const r = await classify(failed);
  assert.equal(r.orgAdmin, false);
  assert.equal(r.hubWritable, false);
  assert.equal(r.verdict, "no-access");

  const thrown = stub({ owner: true, push: true, throws: [`/orgs/${ORG}`, `/repos/${HUB.hubOwner}/${HUB.hubRepo}`] });
  assert.equal((await classify(thrown)).verdict, "no-access");
});

test("a blank budget owner is no name, not an empty mention", async () => {
  const blank = registryBody(`orgs:\n  - login: ${ORG}\n    budget_owner_login: "  "\n`);
  assert.equal((await classify(stub({ push: true, registry: blank }))).budgetOwner, null);
});
