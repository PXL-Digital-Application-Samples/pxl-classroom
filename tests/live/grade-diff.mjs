#!/usr/bin/env node
// PXL Classroom - LIVE, READ-ONLY: read one assignment's cohort the way the
// nightly grades it (scripts/grade-at-deadline.mjs), in memory, and compare it
// with the grading summary on record. Not part of `npm test`.
//
//   $env:GRADE_DIFF_TOKEN = (gh auth token); node tests/live/grade-diff.mjs <org> <assignment-id>
//
// NOTHING IS WRITTEN. Every request goes through `readOnly`, which throws on
// anything but a GET before it is sent, so a grader that started writing would
// stop this run rather than touch the organization. That is what makes it safe
// on a real finished exam (PXL-Automation-II, TV-12), which is the best check a
// grading change has: real check runs, real hand-ins, real decisions.
//
// Exit 0 when every student reads as the summary says, 1 when any differs
// (each named, with both readings), 2 when it could not run.

import { parse } from "yaml";
import { gh } from "../../lib/gh.mjs";
import { gradeCohort, keepStoredOnFailedReads, failedKind } from "../../lib/grade-cohort.mjs";
import { readSubmissionMarker, submissionBranch } from "../../lib/submission-marker.mjs";
import { gradesInCi } from "../../lib/autograde-source.mjs";
import { assignmentPath, gradingSummaryPath, overridesDir } from "../../lib/control-layout.mjs";
import { CONTROL_REPO } from "../../lib/deployment.mjs";
import { normalizeLogin } from "../../lib/github-login.mjs";
import { decode, die } from "./live-kit.mjs";

const [org, id] = process.argv.slice(2);
if (!org || !id) die("usage: node tests/live/grade-diff.mjs <org> <assignment-id>   (token in GRADE_DIFF_TOKEN)");
const token = process.env.GRADE_DIFF_TOKEN;
if (!token) die("GRADE_DIFF_TOKEN is not set - $env:GRADE_DIFF_TOKEN = (gh auth token)");

let reads = 0;
/** The only door to GitHub in this script: a GET, or nothing. */
async function readOnly(method, path) {
  if (String(method).toUpperCase() !== "GET") throw new Error(`refused ${method} ${path}: this check writes nothing`);
  reads++;
  return gh("GET", path, undefined, { token });
}

const at = (path) => `/repos/${org}/${CONTROL_REPO}/contents/${path}`;
async function controlText(path) {
  const res = await readOnly("GET", at(path));
  if (res.status === 404) return null;
  if (!res.ok) die(`${path}: HTTP ${res.status}`);
  return decode(res.data.content);
}

const assignmentText = await controlText(assignmentPath(id));
if (!assignmentText) die(`${org} has no ${assignmentPath(id)}`);
const assignment = parse(assignmentText);
const marker = readSubmissionMarker(assignment);
if (!gradesInCi(assignment, { hasSubmissionMarker: Boolean(marker) })) die(`${id} is not graded in GitHub Actions - the nightly reads nothing for it`);

const storedText = await controlText(gradingSummaryPath(id));
if (!storedText) die(`${id} has no grading summary on record to compare with`);
const stored = JSON.parse(storedText);
const report = JSON.parse((await controlText(`reports/${id}.json`)) ?? "null");
if (!report?.students?.length) die(`${id} has no report rows`);

// Every override, as the nightly reads its checkout: an absent directory is
// nobody deciding anything, a file that does not read stops the run.
const listing = await readOnly("GET", at(overridesDir(id)));
const overrides = [];
if (listing.ok) {
  for (const f of (listing.data || []).filter((x) => x.name.endsWith(".json"))) {
    const text = await controlText(`${overridesDir(id)}/${f.name}`);
    if (text == null) die(`${f.name} could not be read`);
    overrides.push(JSON.parse(text));
  }
} else if (listing.status !== 404) die(`${overridesDir(id)}: HTTP ${listing.status}`);

console.log(`${org}/${id}: ${report.students.length} report rows, ${overrides.length} override(s); the summary on record is from ${stored.generated_at} (${stored.runner}${stored.graded_by ? `, @${stored.graded_by}` : ""})`);

const fallbackTotal = (assignment.autograde?.tests || []).reduce((acc, t) => acc + (t.points || 0), 0);
const res = await gradeCohort(readOnly, {
  students: report.students, marker, markerBranch: submissionBranch(assignment), fallbackTotal, concurrency: 4, overrides,
});
if (!res.ok) {
  console.log(`the nightly would write nothing: ${res.refusal}`);
  for (const f of [...(res.unreadable || []), ...res.failed].slice(0, 20)) console.log(`  ${f.login}: ${f.reason}`);
  process.exit(1);
}
const now = keepStoredOnFailedReads({ stored, graded: res.graded, failed: res.failed, failedReads: res.failedReads });

/** One student's reading, as a line two runs can be compared on. */
const describe = (row, failed) => failed
  ? `no score (${failedKind(row)}): ${row.reason}`
  : `${row.earned_points}/${row.total_points} on ${row.graded_sha?.slice(0, 7) ?? "no commit"}`;
const index = (graded, failed) => new Map([
  ...(graded || []).map((r) => [normalizeLogin(r.login), describe(r, false)]),
  ...(failed || []).map((r) => [normalizeLogin(r.login), describe(r, true)]),
]);
const before = index(stored.students, stored.failed);
const after = index(now.graded, now.failed);

let same = 0;
const differ = [];
for (const login of [...new Set([...before.keys(), ...after.keys()])].sort()) {
  const [b, a] = [before.get(login) ?? "absent", after.get(login) ?? "absent"];
  if (a === b) same++;
  else differ.push({ login, b, a });
}
for (const d of differ) console.log(`  DIFFERS ${d.login}\n    on record: ${d.b}\n    read now:  ${d.a}`);
for (const login of now.kept) console.log(`  ${login}: could not be read - the row on record is kept`);
console.log(`\n${same} read the same, ${differ.length} differ; ${reads} GET request(s), nothing written.`);
process.exit(differ.length ? 1 : 0);
