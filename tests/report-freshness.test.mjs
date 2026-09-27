// PXL Classroom - report-freshness.test.mjs
//
// A delete copies reports/<id>.json into retired/ and removes the sources it
// was built from, in one commit. Since finalize stopped committing the report
// (1fa3882), the committed copy lags the lock and preservation by the minute
// the regeneration takes, and a drill deleted inside that minute retired a
// report saying nothing was preserved. lib/report-freshness.mjs is the judge;
// these pin its verdicts and the one rule it shares with the regeneration.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  deleteWaitsForReport, readReportSourceChanges, REGENERATED_STATES, reportFreshness,
} from "../lib/report-freshness.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const FINALIZED = "2026-09-27T02:56:30Z";

test("a report derived after the last source change is current", () => {
  assert.equal(reportFreshness({ generated_at: "2026-09-27T02:57:40Z" }, [FINALIZED, "2026-09-27T02:55:00Z"]), "current");
  assert.equal(reportFreshness({ generated_at: FINALIZED }, [FINALIZED]), "current", "the same instant is not older");
});

test("a report older than the lock or the preservation is stale (2026-09-27)", () => {
  // drill-20260927-0239: finalize at 02:56, deleted at 02:56:51, the report
  // still the one from before the deadline.
  assert.equal(reportFreshness({ generated_at: "2026-09-27T02:50:00Z" }, [FINALIZED, null]), "stale");
  assert.equal(reportFreshness({ generated_at: "2026-09-27T02:50:00Z" }, [null, FINALIZED]), "stale");
});

test("a Refresh counts as a derivation - it writes the report with the observations it read", () => {
  assert.equal(
    reportFreshness({ generated_at: "2026-09-27T01:00:00Z", live_refreshed_at: "2026-09-27T02:57:00Z" }, [FINALIZED]),
    "current",
  );
});

test("no report over sources that exist is stale; no sources at all is nothing to be behind", () => {
  assert.equal(reportFreshness(null, [FINALIZED, null]), "stale");
  assert.equal(reportFreshness({}, [FINALIZED]), "stale", "a report with no timestamp proves nothing");
  assert.equal(reportFreshness(null, [null, null]), "current");
});

test("a source that could not be read is unknown, never current", () => {
  assert.equal(reportFreshness({ generated_at: "2026-09-27T03:00:00Z" }, [FINALIZED, undefined]), "unknown");
  assert.equal(reportFreshness({ generated_at: "2026-09-27T03:00:00Z" }, ["not a date"]), "unknown");
  assert.equal(reportFreshness({ generated_at: "2026-09-27T03:00:00Z" }, undefined), "unknown");
});

test("readReportSourceChanges asks for the newest commit to each source directory", async () => {
  const asked = [];
  const answers = {
    "observations/lab-1": { ok: true, data: [{ commit: { committer: { date: FINALIZED } } }] },
    "lockdowns/lab-1": { ok: true, data: [] },
  };
  const request = async (method, path) => {
    const url = new URL(path, "https://api.github.com");
    asked.push(`${method} ${url.pathname} ${url.searchParams.get("path")} ${url.searchParams.get("per_page")}`);
    return answers[url.searchParams.get("path")];
  };
  const changes = await readReportSourceChanges(request, { owner: "Org", repo: "pxl-classroom-control", assignmentId: "lab-1" });
  assert.deepEqual(changes, [FINALIZED, null], "a directory with no commits is null, not a failure");
  assert.deepEqual(asked.sort(), [
    "GET /repos/Org/pxl-classroom-control/commits lockdowns/lab-1 1",
    "GET /repos/Org/pxl-classroom-control/commits observations/lab-1 1",
  ]);

  // `gh`-style failures resolve rather than throw, and must read as unknown.
  const failing = await readReportSourceChanges(async () => ({ ok: false, status: 500 }), { owner: "O", repo: "r", assignmentId: "x" });
  assert.deepEqual(failing, [undefined, undefined]);
  assert.equal(reportFreshness({ generated_at: FINALIZED }, failing), "unknown");
});

test("a delete waits only where a regeneration will end the wait", () => {
  // An archived or draft assignment's report is never rebuilt, so refusing it
  // as stale would refuse it for ever.
  assert.equal(deleteWaitsForReport("published"), true);
  assert.equal(deleteWaitsForReport("closed"), true);
  assert.equal(deleteWaitsForReport("archived"), false);
  assert.equal(deleteWaitsForReport("draft"), false);
  // And the regeneration reads the same list rather than spelling its own.
  const src = readFileSync(join(root, "scripts/generate-interim-reports.mjs"), "utf8");
  assert.match(src, /import \{ REGENERATED_STATES \} from "\.\.\/lib\/report-freshness\.mjs"/);
  assert.match(src, /REGENERATED_STATES\.includes\(assignment\.state\)/);
  assert.doesNotMatch(src, /state === "published"/);
  assert.deepEqual([...REGENERATED_STATES], ["published", "closed"]);
});

test("both deletes ask it before the broker goes", () => {
  // Before the broker, because that is the one step of a delete that cannot be
  // undone: a refusal after it leaves an assignment with no broker and no record.
  for (const file of ["frontend/src/views/AdminView.vue", "tests/live/drill.mjs"]) {
    const src = readFileSync(join(root, file), "utf8");
    const gate = src.indexOf("reportFreshness(");
    const broker = src.indexOf("DELETE", gate > -1 ? src.lastIndexOf("async function", gate) : 0);
    assert.ok(gate > -1, `${file} asks reportFreshness`);
    assert.ok(gate < broker, `${file} asks it before deleting anything`);
  }
});
