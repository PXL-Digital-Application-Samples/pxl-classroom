#!/usr/bin/env node
// PXL Classroom - read the cohort's autograding scores at the deadline.
//
// Runs inside the finalize job, after the report and before its commit. That
// is where it belongs and nowhere else:
//
//   * the deadline has passed, so the submission is DECIDED - the preserved
//     commit, or the hand-in the marker names, bounded by each student's own
//     effective deadline;
//   * the control repository is already checked out and already committed by
//     that job, so this adds no trigger, no credential and no idle minutes;
//   * one Checks read per student, inside a job that is running anyway.
//
// GRADING ON THE STUDENT'S PUSH IS NOT AVAILABLE AND IS NOT AN OVERSIGHT. The
// grading workflow already runs in the student's repository on every push; what
// is manual is reading the score BACK. For the hub to react to that push, the
// student's repository would need a credential to dispatch with - a credential
// in a repository the student administers, which is the incident
// scripts/close-acceptance.mjs exists to have ended. A webhook needs a
// receiver, and polling is what the minimal-minutes design refuses.
//
// IT NEVER OVERWRITES A HUMAN RUN. A summary carrying `graded_by` or written by
// a local runner is a lecturer's own result - they ran the checks on their
// machine, or pressed the button - and it outranks this one. Same shape as
// `email_source`, where an absent provenance marker means a person and outranks
// both writers. Re-grading over it is a button, not a side effect of a nightly.
//
// Exits 0 for every ordinary outcome including "nothing to do". A grading read
// that cannot be completed must not fail a finalize that has already locked the
// cohort and pushed its submissions to the archive.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { gh } from "../lib/gh.mjs";
import { loadYaml } from "../lib/yaml.mjs";
import { gradeCohort } from "../lib/grade-cohort.mjs";
import { buildGradingSummary } from "../lib/grading-summary.mjs";
import { readSubmissionMarker, submissionBranch } from "../lib/submission-marker.mjs";
import { gradesInCi } from "../lib/autograde-source.mjs";
import { validateAgainst } from "../lib/validate.mjs";
import { assignmentPath, gradingSummaryPath } from "../lib/control-layout.mjs";

const cfg = {
  dataDir: process.env.DATA_DIR || "control",
  assignmentId: process.env.ASSIGNMENT_ID || "",
};

const log = (ok, note) => console.log(`[${ok ? "ok" : "FAIL"}] grade ${cfg.assignmentId}${note ? ` - ${note}` : ""}`);

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

/** Has a person already produced this summary? */
function humanWrote(summary) {
  if (!summary) return false;
  // A named lecturer, or a runner only a person can drive. `github_actions` is
  // this path's own answer and is the one thing that may be replaced.
  if (summary.graded_by) return true;
  return summary.runner === "docker" || summary.runner === "host";
}

async function main() {
  if (!cfg.assignmentId) {
    console.error("ASSIGNMENT_ID is required");
    process.exit(1);
  }
  if (!process.env.GITHUB_TOKEN) {
    console.error("GITHUB_TOKEN is required");
    process.exit(1);
  }

  const assignment = await loadYaml(join(cfg.dataDir, assignmentPath(cfg.assignmentId))).catch(() => null);
  if (!assignment) return log(true, "no assignment document - nothing to grade");

  // THE SAME QUESTION THE ADMIN PANEL ASKS, from the same function. Asking it
  // differently here is how one surface comes to offer grading that the other
  // says does not exist - and getting it wrong the permissive way names every
  // student in the cohort as a grading failure on an assignment that grades
  // nothing at all.
  //
  // No `hasGrades`/`anyCiStatus` evidence is passed: an assignment whose only
  // reason to look is a summary this same job wrote is a loop, and a CI status
  // is a browser-side field the nightly does not have.
  const marker = readSubmissionMarker(assignment);
  if (!gradesInCi(assignment, { hasSubmissionMarker: Boolean(marker) })) {
    return log(true, "this assignment is not graded in GitHub Actions - nothing to read");
  }

  const summaryPath = join(cfg.dataDir, gradingSummaryPath(cfg.assignmentId));
  const existing = await readJson(summaryPath);
  if (humanWrote(existing)) {
    return log(
      true,
      `already graded by ${existing.graded_by ? `@${existing.graded_by}` : "a local runner"} ` +
        `via ${existing.runner} on ${existing.generated_at} - left alone. Use Re-grade to replace it.`,
    );
  }

  const report = await readJson(join(cfg.dataDir, "reports", `${cfg.assignmentId}.json`));
  const students = report?.students || [];
  if (students.length === 0) return log(true, "no report rows - nothing to grade");

  const fallbackTotal = (assignment.autograde?.tests || []).reduce((acc, t) => acc + (t.points || 0), 0);

  const res = await gradeCohort(gh, {
    students,
    marker,
    markerBranch: submissionBranch(assignment),
    fallbackTotal,
    concurrency: 4,
  });

  // Every refusal is REPORTED AND SURVIVED. This job has already locked the
  // cohort and archived their submissions; failing it now would re-queue all of
  // that to fix a score a lecturer can read with one button.
  if (!res.ok) {
    const why = {
      permission: "the App cannot read Checks here - an organization owner has to approve the Checks (read) permission",
      "api-errors": `${res.apiFailedCount} student(s) could not be read - nothing was written rather than a partial summary`,
      "nothing-graded": `no student had a readable grading run (${res.failed.length} named below)`,
    }[res.refusal];
    log(true, `not written: ${why}`);
    for (const f of res.failed.slice(0, 20)) console.log(`       ${f.login}: ${f.reason}`);
    return;
  }

  const doc = buildGradingSummary({
    assignmentId: cfg.assignmentId,
    // NULL, and the schema says so: "the session had no user on hand". This is
    // also what `humanWrote` reads on the next run, so a made-up bot login here
    // would make the nightly refuse to replace its own work.
    gradedBy: null,
    runner: "github_actions",
    students: res.graded,
    failed: res.failed,
  });

  const { valid, errors } = validateAgainst("grading-summary", doc);
  if (!valid) {
    // Refusing to write beats writing a document no reader can trust. Not a
    // failure of the finalize, for the reason above.
    log(true, `the summary came out malformed and was NOT written: ${JSON.stringify(errors?.slice(0, 3))}`);
    return;
  }

  await mkdir(join(cfg.dataDir, "grading", cfg.assignmentId), { recursive: true });
  await writeFile(summaryPath, JSON.stringify(doc, null, 2) + "\n");
  log(
    true,
    `${res.graded.length} graded, ${res.failed.length} named without a score` +
      (existing ? " (replacing this job's own earlier reading)" : ""),
  );
  for (const f of res.failed.slice(0, 20)) console.log(`       ${f.login}: ${f.reason}`);
}

main().catch((e) => {
  // Same reasoning as every refusal above: the lock and the archive are done.
  console.log(`[ok] grade ${cfg.assignmentId} - not written: ${e.message}`);
});
