// PXL Classroom - report-freshness.test.mjs
//
// A delete copies reports/<id>.json into retired/ and removes the sources it
// was built from, in one commit. Since finalize stopped committing the report
// (1fa3882), the committed copy lags the lock and preservation by the minute
// the regeneration takes, and a drill deleted inside that minute retired a
// report saying nothing was preserved. lib/report-freshness.mjs is the judge.
//
// Commits, not clocks: the first version compared generated_at with the source
// commit's date and passed a regeneration that checked out before a finalize
// pushed and finished after it (review of v1.5.0). These pin the ancestry
// verdicts, the commit report.mjs records, and the rule both share with the
// regeneration.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  deleteWaitsForReport, readReportFreshness, REGENERATED_STATES, REPORT_SOURCE_DIRS, reportFreshness,
} from "../lib/report-freshness.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);

test("a source commit that is the report's commit or an ancestor of it is current", () => {
  assert.equal(reportFreshness(A, [{ sha: A, contained: true }, { sha: null }]), "current");
  assert.equal(reportFreshness(C, [{ sha: A, contained: true }, { sha: B, contained: true }]), "current");
});

test("a regeneration that read the tree before finalize pushed is stale, whatever its clock says", () => {
  // The race the timestamp version passed: checked out at A, finalize pushed B
  // on top of A, the report says derived_from A and was stamped after B.
  assert.equal(reportFreshness(A, [{ sha: B, contained: false }, { sha: A, contained: true }]), "stale");
});

test("a report that cannot say what it read is not current - Refresh, or an old report", () => {
  assert.equal(reportFreshness(undefined, [{ sha: B }]), "stale");
  assert.equal(reportFreshness("not-a-sha", [{ sha: B }]), "stale");
  // With no source ever committed there is nothing to be behind.
  assert.equal(reportFreshness(undefined, [{ sha: null }, { sha: null }]), "current");
});

test("a read that failed, or an ancestry question nobody answered, is unknown", () => {
  assert.equal(reportFreshness(A, [{ sha: undefined }, { sha: A, contained: true }]), "unknown");
  assert.equal(reportFreshness(A, [{ sha: B, contained: undefined }]), "unknown");
  assert.equal(reportFreshness(A, undefined), "unknown");
});

/** A request stub: newest commit per directory, and a compare answer per base. */
function stub({ newest, compare = {}, failCommits = false, failCompare = false }) {
  const asked = [];
  const request = async (method, path) => {
    asked.push(`${method} ${path}`);
    const url = new URL(path, "https://api.github.com");
    if (url.pathname.endsWith("/commits")) {
      if (failCommits) return { ok: false, status: 500 };
      const sha = newest[url.searchParams.get("path")];
      return { ok: true, data: sha ? [{ sha }] : [] };
    }
    const m = url.pathname.match(/\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/);
    if (m) return failCompare ? { ok: false, status: 404 } : { ok: true, data: { status: compare[m[1]] } };
    return { ok: false, status: 404 };
  };
  return { request, asked };
}

test("readReportFreshness asks the newest commit per source directory, then GitHub's ancestry", async () => {
  const where = { owner: "Org", repo: "pxl-classroom-control", assignmentId: "lab-1" };
  const [obs, locks] = REPORT_SOURCE_DIRS("lab-1");
  assert.deepEqual([obs, locks], ["observations/lab-1", "lockdowns/lab-1"]);

  const behind = stub({ newest: { [obs]: B, [locks]: A }, compare: { [B]: "behind" } });
  assert.equal(await readReportFreshness(behind.request, { ...where, derivedFrom: A }), "stale");
  assert.ok(behind.asked.includes(`GET /repos/Org/pxl-classroom-control/compare/${B}...${A}`), "base...head, the source first");
  assert.ok(!behind.asked.some((p) => p.includes(`/compare/${A}...`)), "the report's own commit is not compared with itself");

  const ahead = stub({ newest: { [obs]: B, [locks]: null }, compare: { [B]: "ahead" } });
  assert.equal(await readReportFreshness(ahead.request, { ...where, derivedFrom: C }), "current");
  const identical = stub({ newest: { [obs]: B }, compare: { [B]: "identical" } });
  assert.equal(await readReportFreshness(identical.request, { ...where, derivedFrom: C }), "current");
  const diverged = stub({ newest: { [obs]: B }, compare: { [B]: "diverged" } });
  assert.equal(await readReportFreshness(diverged.request, { ...where, derivedFrom: C }), "stale");

  assert.equal(await readReportFreshness(stub({ newest: {}, failCommits: true }).request, { ...where, derivedFrom: C }), "unknown");
  assert.equal(await readReportFreshness(stub({ newest: { [obs]: B }, failCompare: true }).request, { ...where, derivedFrom: C }), "unknown");
  assert.equal(await readReportFreshness(stub({ newest: { [obs]: B } }).request, { ...where, derivedFrom: undefined }), "stale");
});

test("report.mjs records the commit it read, and nothing when its sources are not that commit", () => {
  // The finalize job runs report.mjs over observations it has not committed
  // yet; naming HEAD there would claim data the report did not read.
  const dir = mkdtempSync(join(tmpdir(), "pxl-derived-"));
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
  try {
    git("init", "-q", "--initial-branch=main");
    mkdirSync(join(dir, "assignments"));
    writeFileSync(join(dir, "assignments", "lab-1.yml"),
      "schema_version: 1\nid: lab-1\ntitle: Lab\nstate: published\ndeadline_at: '2026-09-01T10:00:00Z'\n" +
      "opens_at: '2026-08-01T10:00:00Z'\nassignment_type: individual\n");
    mkdirSync(join(dir, "observations", "lab-1", "alice"), { recursive: true });
    writeFileSync(join(dir, "observations", "lab-1", "alice", ".gitkeep"), "");
    git("add", "-A");
    git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "seed");
    const head = git("rev-parse", "HEAD");

    const run = () => {
      const res = spawnSync("node", [join(root, "report", "report.mjs")], {
        env: { ...process.env, ASSIGNMENT_ID: "lab-1", DATA_DIR: dir, OUTPUT_FORMAT: "json", GITHUB_TOKEN: "", GITHUB_OUTPUT: "", GITHUB_STEP_SUMMARY: "" },
        encoding: "utf8",
      });
      assert.equal(res.status, 0, res.stderr + res.stdout);
      return JSON.parse(readFileSync(join(dir, "reports", "lab-1.json"), "utf8"));
    };
    assert.equal(run().derived_from, head, "a clean checkout: the commit it read");

    writeFileSync(join(dir, "observations", "lab-1", "alice", ".late"), "");
    assert.equal(run().derived_from, undefined, "uncommitted sources: not known, so absent");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Refresh does not carry the loaded report's commit into the report it rebuilt", () => {
  const src = readFileSync(join(root, "frontend/src/views/AssignmentDetailView.vue"), "utf8");
  const fn = src.slice(src.indexOf("function reportForStorage("), src.indexOf("function mergeGradesIntoReport("));
  assert.ok(fn.length > 0, "reportForStorage must be findable");
  assert.match(fn, /delete doc\.derived_from/);
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
    const gate = src.indexOf("readReportFreshness(");
    const broker = src.indexOf("DELETE", gate > -1 ? src.lastIndexOf("async function", gate) : 0);
    assert.ok(gate > -1, `${file} asks readReportFreshness`);
    assert.ok(gate < broker, `${file} asks it before deleting anything`);
  }
});
