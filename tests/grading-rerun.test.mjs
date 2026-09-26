// Can a commit's grading be run again? lib/grading-rerun.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rerunAvailability, RERUN_WINDOW_DAYS } from "../lib/grading-rerun.mjs";

const NOW = new Date("2026-09-26T12:00:00Z");
const run = (over = {}) => ({ id: 42, event: "push", name: "Grading", status: "completed", created_at: "2026-09-20T12:00:00Z", ...over });
const marker = { value: "einde examen" };

test("a completed push run inside the window can run again", () => {
  assert.deepEqual(rerunAvailability({ runs: [run()], now: NOW }), { can: true, runId: 42, why: null });
});

test("THE GRADING WORKFLOW'S run, by its file - never another workflow's (third review, 2026-09-26)", () => {
  const lint = run({ id: 7, name: "Lint", path: ".github/workflows/lint.yml" });
  const grading = run({ id: 8, name: "Autograding Tests", path: ".github/workflows/classroom.yml" });
  const path = ".github/workflows/classroom.yml";
  assert.equal(rerunAvailability({ runs: [lint, grading], now: NOW, workflowPath: path }).runId, 8);
  const onlyLint = rerunAvailability({ runs: [lint], now: NOW, workflowPath: path });
  assert.equal(onlyLint.can, false, "another file's run is not re-run in its place");
  // Without the file: a run whose name says grading, or nothing - never push[0].
  assert.equal(rerunAvailability({ runs: [lint], now: NOW }).can, false);
  assert.equal(rerunAvailability({ runs: [lint, grading], now: NOW }).runId, 8);
});

test("no run at all: the commit was not the head of its push", () => {
  const r = rerunAvailability({ runs: [], now: NOW });
  assert.equal(r.can, false);
  assert.match(r.why, /not the newest commit of its push/);
});

test("a hand-in gate that skipped would skip again - never offered", () => {
  const r = rerunAvailability({ runs: [run()], marker, isHandIn: false, now: NOW });
  assert.equal(r.can, false);
  assert.match(r.why, /only runs for a "einde examen" commit/);
  assert.equal(rerunAvailability({ runs: [run()], marker, isHandIn: true, now: NOW }).can, true);
});

test(`older than ${RERUN_WINDOW_DAYS} days: GitHub will not, so neither does the button`, () => {
  const r = rerunAvailability({ runs: [run({ created_at: "2026-08-01T00:00:00Z" })], now: NOW });
  assert.equal(r.can, false);
  assert.match(r.why, /within 30 days.*56 days old/);
});

test("a run still going is waited for, not re-run", () => {
  assert.match(rerunAvailability({ runs: [run({ status: "in_progress" })], now: NOW }).why, /still going/);
});

test("of several workflows on one push, the grading one is picked; non-push runs never are", () => {
  const runs = [run({ id: 1, name: "lint" }), run({ id: 2, name: "Autograding" }), run({ id: 3, event: "workflow_dispatch", name: "grading" })];
  assert.equal(rerunAvailability({ runs, now: NOW }).runId, 2);
  assert.equal(rerunAvailability({ runs: [run({ id: 3, event: "pull_request" })], now: NOW }).can, false);
});

test("runs that could not be read are 'not known', never a button", () => {
  const r = rerunAvailability({ runs: null, now: NOW });
  assert.equal(r.can, false);
  assert.match(r.why, /not known/);
});
