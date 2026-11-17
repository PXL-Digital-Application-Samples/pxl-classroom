// PXL Classroom - actions-allowed.test.mjs
//
// Can GitHub Actions run on a broker? PXL-Digital-SNE-Werkplekleren published a
// broker on 2026-09-09 with Actions switched off; on 2026-11-16 and 17, 30
// students sent 47 acceptance requests and GitHub started not one run, while
// their page said GitHub was busy. Nothing in this system said so.
//
// One judge (lib/audit.mjs `actionsAllowedFinding`) and one symptom
// (lib/broker-never-ran.mjs), asked by publish, the weekly check, System Health,
// the nightly and the student page. These pin the judge, the symptom, the
// script publish and the weekly check run, and that each surface asks.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { ACTIONS_SETTINGS_URL, actionsAllowedFinding, readActionsSettings } from "../lib/audit.mjs";
import { NEVER_RAN_AFTER_MS, brokerAllRunsPath, brokerNeverRan } from "../lib/broker-never-ran.mjs";
import { main as checkBrokerActions } from "../scripts/check-broker-actions.mjs";
import { attemptProgress, progressMessage, progressSteps } from "../frontend/src/lib/acceptance-progress.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ORG = "Org";
const ok = (data) => ({ status: 200, data });

test("actionsAllowedFinding: off for the org, off for the repository, not selected, local only - each a fail naming where to switch it on", () => {
  const off = actionsAllowedFinding({ org: ORG, broker: "broker-lab", orgPolicy: ok({ enabled_repositories: "none" }) });
  assert.equal(off.severity, "fail");
  assert.match(off.message, /switched off for every repository in Org/);
  assert.equal(off.detail.url, ACTIONS_SETTINGS_URL(ORG));

  const repoOff = actionsAllowedFinding({ org: ORG, broker: "broker-lab", orgPolicy: ok({ enabled_repositories: "all", allowed_actions: "all" }), repoPolicy: ok({ enabled: false }) });
  assert.equal(repoOff.severity, "fail");
  assert.match(repoOff.message, /switched off on broker-lab/);
  assert.equal(repoOff.detail.url, "https://github.com/Org/broker-lab/settings/actions");

  const notListed = actionsAllowedFinding({
    org: ORG, broker: "broker-lab",
    orgPolicy: ok({ enabled_repositories: "selected" }),
    selectedRepos: ok({ repositories: [{ name: "broker-other" }] }),
  });
  assert.equal(notListed.severity, "fail");
  assert.match(notListed.message, /broker-lab is not one of them/);

  const listed = actionsAllowedFinding({
    org: ORG, broker: "broker-lab",
    orgPolicy: ok({ enabled_repositories: "selected", allowed_actions: "all" }),
    selectedRepos: ok({ repositories: [{ name: "Broker-Lab" }] }),
  });
  assert.equal(listed.severity, "ok", "case does not matter");

  const local = actionsAllowedFinding({ org: ORG, orgPolicy: ok({ enabled_repositories: "all", allowed_actions: "local_only" }) });
  assert.equal(local.severity, "fail");
  assert.match(local.message, /actions\/checkout/);
});

test("actionsAllowedFinding: what it cannot settle is a warning or not checked, never a fail", () => {
  assert.equal(actionsAllowedFinding({ org: ORG, orgPolicy: ok({ enabled_repositories: "selected", allowed_actions: "all" }) }).severity, "warn", "no broker named: every new one must be added");
  assert.equal(actionsAllowedFinding({ org: ORG, broker: "b", orgPolicy: ok({ enabled_repositories: "selected" }), selectedRepos: { status: 403 } }).severity, "warn", "the list could not be read");
  assert.equal(actionsAllowedFinding({ org: ORG, orgPolicy: ok({ enabled_repositories: "all", allowed_actions: "selected" }) }).severity, "warn");
  const unread = actionsAllowedFinding({ org: ORG, broker: "b", orgPolicy: { status: 403 }, repoPolicy: { status: 404 } });
  assert.equal(unread.severity, "info", "a token that cannot read the settings is not evidence they are off");
  assert.match(unread.message, /Not checked/);
  assert.equal(actionsAllowedFinding({ org: ORG, broker: "b", orgPolicy: ok({ enabled_repositories: "all", allowed_actions: "all" }), repoPolicy: ok({ enabled: true, allowed_actions: "all" }) }).severity, "ok");
});

test("readActionsSettings walks the selected list whole, and only when it is needed", async () => {
  const asked = [];
  const page = (n, count) => ({ status: 200, data: { total_count: 150, repositories: Array.from({ length: count }, (_, i) => ({ name: `r${n}-${i}` })) } });
  const request = async (_m, path) => {
    asked.push(path);
    if (path === "/orgs/Org/actions/permissions") return ok({ enabled_repositories: "selected" });
    if (path.includes("permissions/repositories") && path.endsWith("page=1")) return page(1, 100);
    if (path.includes("permissions/repositories") && path.endsWith("page=2")) return { status: 200, data: { total_count: 150, repositories: [...page(2, 49).data.repositories, { name: "broker-lab" }] } };
    if (path === "/repos/Org/broker-lab/actions/permissions") return ok({ enabled: true });
    return { status: 404 };
  };
  const read = await readActionsSettings(request, { org: ORG, broker: "broker-lab" });
  assert.equal(read.selectedRepos.data.repositories.length, 150);
  assert.equal(actionsAllowedFinding({ org: ORG, broker: "broker-lab", ...read }).severity, "ok", "found on the second page");

  asked.length = 0;
  await readActionsSettings(async (_m, p) => (asked.push(p), p === "/orgs/Org/actions/permissions" ? ok({ enabled_repositories: "all" }) : { status: 404 }), { org: ORG });
  assert.deepEqual(asked, ["/orgs/Org/actions/permissions"], "no list and no repository read when they would say nothing");
});

test("brokerNeverRan: an empty list read whole is never; anything unread is not evidence", () => {
  assert.equal(brokerAllRunsPath("Org", "broker-lab"), "/repos/Org/broker-lab/actions/runs?per_page=1");
  assert.equal(brokerNeverRan(ok({ total_count: 0, workflow_runs: [] })), true);
  assert.equal(brokerNeverRan(ok({ total_count: 12, workflow_runs: [{ id: 1 }] })), false);
  assert.equal(brokerNeverRan({ status: 403, data: { message: "no" } }), null);
  assert.equal(brokerNeverRan(ok({ workflow_runs: [] })), null, "no count is not a count of zero");
  assert.equal(brokerNeverRan(null), null);
});

test("the student page says acceptance is not working, and stops offering 'send it again', only on a broker that never ran", () => {
  const sentAt = 0;
  // The title a request is opened with (tests/acceptance-progress.test.mjs): still
  // this title means the broker has not handed it over.
  const signed = "pxl-accept:a1.AAAA.BBBB team:fullhouse";
  const sent = (extra) => attemptProgress({ title: signed, sentAt, now: NEVER_RAN_AFTER_MS + 1000, ...extra });
  assert.equal(sent({}).step, "not-started", "the title reads as sent");
  assert.equal(sent({ neverRan: true }).step, "not-running");
  assert.equal(sent({ neverRan: true }).canRetry, false, "another request on a broker that never runs is another dead request");
  assert.equal(sent({ neverRan: true }).final, false, "keeps asking: a broker switched on meanwhile is seen");
  assert.notEqual(sent({ neverRan: false }).step, "not-running", "a broker that has run before is GitHub being slow");
  assert.notEqual(sent({ neverRan: null }).step, "not-running", "unread says nothing");
  assert.notEqual(sent({ now: NEVER_RAN_AFTER_MS - 1000, neverRan: true }).step, "not-running", "not before three minutes");
  assert.match(progressMessage("not-running"), /Tell your lecturer/);
  assert.doesNotMatch(progressMessage("not-running"), /send it again/i);
  assert.equal(progressSteps("not-running")[1].state, "failed");
});

function controlDir(assignments) {
  const dir = mkdtempSync(join(tmpdir(), "pxl-actions-"));
  mkdirSync(join(dir, "assignments"));
  for (const [id, yml] of Object.entries(assignments)) writeFileSync(join(dir, "assignments", `${id}.yml`), yml);
  return dir;
}

test("check-broker-actions: publish refuses a broker Actions cannot run on, and passes one it can or cannot read", async () => {
  const dir = controlDir({ lab: "state: draft\n" });
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(" "));
  try {
    const off = async (_m, p) => (p === "/orgs/Org/actions/permissions" ? ok({ enabled_repositories: "none" }) : { status: 404 });
    assert.equal(await checkBrokerActions([dir, "--assignment", "lab"], { request: off, env: { ORG } }), 1);
    assert.ok(logs.some((l) => l.startsWith("::error::") && /switched off for every repository/.test(l)), logs.join("\n"));

    const on = async (_m, p) => (p === "/orgs/Org/actions/permissions" ? ok({ enabled_repositories: "all", allowed_actions: "all" }) : ok({ enabled: true, allowed_actions: "all" }));
    assert.equal(await checkBrokerActions([dir, "--assignment", "lab"], { request: on, env: { ORG } }), 0);

    const unread = async () => ({ status: 403 });
    assert.equal(await checkBrokerActions([dir, "--assignment", "lab"], { request: unread, env: { ORG } }), 0, "unread never refuses");
  } finally {
    console.log = orig;
  }
});

test("check-broker-actions --published checks every published assignment's broker, by its recorded name", async () => {
  const dir = controlDir({
    lab: "state: published\n",
    custom: "state: published\nbroker_repo: broker-renamed\n",
    old: "state: closed\n",
  });
  const asked = [];
  const request = async (_m, p) => {
    asked.push(p);
    if (p === "/orgs/Org/actions/permissions") return ok({ enabled_repositories: "selected", allowed_actions: "all" });
    if (p.includes("permissions/repositories")) return ok({ total_count: 1, repositories: [{ name: "broker-lab" }] });
    return { status: 404 };
  };
  const orig = console.log;
  const logs = [];
  console.log = (...a) => logs.push(a.join(" "));
  try {
    assert.equal(await checkBrokerActions([dir, "--published"], { request, env: { ORG } }), 1, "broker-renamed is not selected");
  } finally {
    console.log = orig;
  }
  assert.ok(logs.some((l) => /broker-renamed is not one of them/.test(l)), logs.join("\n"));
  assert.ok(!asked.some((p) => p.includes("broker-old")), "a closed assignment's broker is not asked");
});

test("publish asks after the broker exists, and the weekly check, System Health and the nightly ask too", () => {
  const wf = (f) => parse(readFileSync(join(root, ".github", "workflows", f), "utf8"));
  const steps = Object.values(wf("publish-assignment.yml").jobs).flatMap((j) => j.steps ?? []);
  const at = (pred) => steps.findIndex(pred);
  const check = at((s) => /check-broker-actions\.mjs control --assignment/.test(s.run ?? ""));
  assert.ok(check > at((s) => s.name === "Push broker workflow"), "after the broker and its workflow exist");
  assert.ok(check < at((s) => s.name === "Update assignment state"), "before the assignment is marked published");
  assert.equal(steps[check]["continue-on-error"], undefined, "a fail refuses the publish");

  const weekly = wf("weekly-usage-report.yml").jobs.usage.steps.find((s) => /check-broker-actions\.mjs control --published/.test(s.run ?? ""));
  assert.ok(weekly, "the weekly check runs it");

  const diag = readFileSync(join(root, "lib", "diagnostics.mjs"), "utf8");
  assert.match(diag, /actionsAllowedFinding\(\{ org, \.\.\.\(await readActionsSettings\(req, \{ org \}\)\) \}\)/, "System Health, organization");
  assert.match(diag, /actionsAllowedFinding\(\{ org, broker: brokerName/, "System Health, broker");
  assert.match(diag, /brokerNeverRan\(/, "System Health, the symptom");
  assert.match(readFileSync(join(root, "scripts", "find-unanswered-attempts.mjs"), "utf8"), /brokerNeverRan\(/, "the nightly");
});
