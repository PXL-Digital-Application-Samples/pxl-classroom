// One organization's failure must not skip another organization's finalize,
// and must not switch the nightly off either.
//
// On 2026-09-16 and 2026-09-17 PXL-Java-Essentials' collect leg failed (a
// submission_ref naming a branch its repositories do not have). Every other leg
// was green, and still `aggregate-finalizable`, `finalize` and `check-idle` were
// skipped for EVERY organization: a failed job skips everything downstream of it
// through the whole needs chain, and `aggregate-finalizable` had no `if:`.
// `find-finalizable` itself had `always()` and succeeded in every organization,
// which is what proves the propagation is transitive. `labo-api` and
// `test-pe-2` sat past their deadlines, unfinalized, their broker keys on
// public repositories.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

import { aggregateFinalizable } from "../scripts/aggregate-finalizable.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const workflow = parse(readFileSync(join(root, ".github", "workflows", "daily-activity.yml"), "utf8"));
const jobs = workflow.jobs;
const needsOf = (job) => [].concat(jobs[job]?.needs ?? []);

const ORGS = ["org-a", "org-b", "org-c"];
const counts = (entries) => Object.fromEntries(entries.map(([org, n]) => [org, { active: n }]));

test("a complete scan counts every organization and may say the hub is idle", () => {
  const r = aggregateFinalizable({
    findResult: "success",
    expectedOrgs: ORGS,
    finalizable: { "org-a": [], "org-b": [], "org-c": [] },
    active: counts([["org-a", 0], ["org-b", 0], ["org-c", 0]]),
  });
  assert.deepEqual(r, { finalizable: [], activeCount: 0, complete: true, missing: [] });
});

test("THE REGRESSION: a failed leg still leaves every other organization's plan intact", () => {
  const r = aggregateFinalizable({
    findResult: "failure",
    expectedOrgs: ORGS,
    finalizable: {
      "org-a": [{ org: "org-a", assignment_id: "labo-api" }],
      "org-c": [{ org: "org-c", assignment_id: "test-pe-2" }],
    },
    active: counts([["org-a", 1], ["org-c", 1]]),
  });
  assert.deepEqual(r.finalizable.map((f) => f.assignment_id), ["labo-api", "test-pe-2"]);
  assert.equal(r.complete, false, "a missing organization makes the count a partial one");
  assert.deepEqual(r.missing, ["org-b"]);
});

test("a zero from an incomplete scan is not an idle hub", () => {
  // The trap beside the fix: the only active assignment lives in the org whose
  // scan failed, so the sum is 0. That must never read as "nothing active".
  const r = aggregateFinalizable({
    findResult: "failure",
    expectedOrgs: ORGS,
    finalizable: { "org-a": [], "org-c": [] },
    active: counts([["org-a", 0], ["org-c", 0]]),
  });
  assert.equal(r.activeCount, 0);
  assert.equal(r.complete, false);
});

test("unreadable is not evidence: a garbled count or a job that did not succeed is incomplete", () => {
  const garbled = aggregateFinalizable({
    findResult: "success",
    expectedOrgs: ORGS,
    finalizable: {},
    active: { "org-a": { active: 0 }, "org-b": undefined, "org-c": { active: "0" } },
  });
  assert.equal(garbled.complete, false);
  assert.deepEqual(garbled.missing, ["org-b", "org-c"]);

  for (const findResult of ["failure", "cancelled", "skipped", ""]) {
    const r = aggregateFinalizable({ findResult, expectedOrgs: ORGS, finalizable: {}, active: counts(ORGS.map((o) => [o, 0])) });
    assert.equal(r.complete, false, `find-finalizable ${JSON.stringify(findResult)} cannot vouch for the count`);
  }
  assert.equal(
    aggregateFinalizable({ findResult: "success", expectedOrgs: [], finalizable: {}, active: {} }).complete,
    false,
    "no organizations is no statement about the hub",
  );
});

test("every job downstream of the per-org collect runs on failure, and checks what it needs", () => {
  // Derived from the needs graph, so a job added after collect later is held
  // to it too. Without always(), a job inherits any upstream failure even when
  // every job it needs directly succeeded.
  const downstream = new Set();
  let grew = true;
  while (grew) {
    grew = false;
    for (const name of Object.keys(jobs)) {
      if (downstream.has(name)) continue;
      if (needsOf(name).some((n) => n === "collect" || downstream.has(n))) {
        downstream.add(name);
        grew = true;
      }
    }
  }
  assert.ok(downstream.has("finalize") && downstream.has("check-idle"), `sanity: ${[...downstream].join(", ")}`);

  const missing = [...downstream].filter((name) => !/\balways\(\)/.test(String(jobs[name].if ?? "")));
  assert.deepEqual(missing, [], "these jobs are skipped for every organization when one organization's collect fails");

  assert.match(String(jobs["aggregate-finalizable"].if), /needs\.find-finalizable\.result/);
  assert.match(String(jobs.finalize.if), /needs\.aggregate-finalizable\.result == 'success'/);
});

test("inside finalize, every step after collect runs past an earlier step's failure", () => {
  // The same cascade one level down. `2. Lockdown` had no condition, so a
  // failed `1. Collect` skipped the lock itself - although lockdown reads
  // nothing collect writes - and `3. Preserve` was given always() only after a
  // failed lockdown skipped a whole cohort's archive (2026-09-03). A step with
  // no `if:` inherits every earlier failure; each one here decides explicitly.
  const steps = jobs.finalize.steps;
  const collectAt = steps.findIndex((s) => s.uses === "./collect");
  assert.ok(collectAt >= 0, "sanity: finalize collects first");

  const after = steps.slice(collectAt + 1);
  assert.ok(after.length >= 5, `sanity: expected lockdown, preserve, report and more, found ${after.length}`);
  const unguarded = after
    .filter((s) => !/\balways\(\)|!\s*cancelled\(\)|\bfailure\(\)/.test(String(s.if ?? "")))
    .map((s) => s.name ?? s.uses ?? s.run?.split("\n")[0]);
  assert.deepEqual(unguarded, [], "these finalize steps are skipped by any earlier failure in the job");

  const lockdown = after.find((s) => s.uses === "./lockdown");
  assert.match(String(lockdown.if), /!\s*cancelled\(\)/, "a hand-cancelled run must not go on to lock a cohort");
});

test("the nightly switches itself off only on a complete count", () => {
  const cond = String(jobs["check-idle"].if);
  assert.match(cond, /needs\.aggregate-finalizable\.outputs\.complete == 'true'/);
  assert.match(cond, /needs\.aggregate-finalizable\.outputs\.active_count == '0'/);

  // The output check-idle reads must be the one the aggregate job declares and
  // the script writes, or `'' == 'true'` is false and the guard is decoration.
  assert.equal(jobs["aggregate-finalizable"].outputs.complete, "${{ steps.agg.outputs.complete }}");
  const script = readFileSync(join(root, "scripts", "aggregate-finalizable.mjs"), "utf8");
  assert.match(script, /`complete=\$\{result\.complete\}\\n`/);

  const agg = jobs["aggregate-finalizable"].steps.find((s) => s.id === "agg");
  assert.equal(agg.env.FIND_RESULT, "${{ needs.find-finalizable.result }}");
  assert.equal(agg.env.EXPECTED_ORGS, "${{ needs.find-orgs.outputs.orgs }}");
  assert.ok(needsOf("aggregate-finalizable").includes("find-orgs"), "EXPECTED_ORGS needs find-orgs in needs");
});
