#!/usr/bin/env node
// PXL Classroom — deadline report generator.
//
// Reads observations, acceptances, repository records, and overrides for a
// given assignment and produces:
//   - reports/<id>.json — structured deadline report
//   - reports/<id>.csv  — CSV export (one row per student)
//   - reports/dashboard.json — aggregated dashboard data
//
// The report classifies each student's submission as on-time, late, or
// no-submission based on the observation evidence. It does NOT treat Git
// commit dates as authoritative.
//
// Inputs via env: ASSIGNMENT_ID, DATA_DIR, OUTPUT_FORMAT
// Outputs via GITHUB_OUTPUT: student_count, on_time_count, late_count, outcome

import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { loadYaml } from "../lib/yaml.mjs";
import { buildDashboardEntry } from "../lib/dashboard-aggregate.mjs";

async function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT)
    await appendFile(process.env.GITHUB_OUTPUT, `${name}=${value ?? ""}\n`);
}
async function summaryMd(md) {
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(process.env.GITHUB_STEP_SUMMARY, md + "\n");
}

async function readJsonSafe(path) {
  try {
    return JSON.parse(await readFile(path, "utf-8"));
  } catch {
    return null;
  }
}

async function readDirJsonFiles(dir) {
  if (!existsSync(dir)) return [];
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  const results = [];
  for (const f of files) {
    const data = await readJsonSafe(join(dir, f));
    if (data) results.push(data);
  }
  return results;
}

async function main() {
  const assignmentId = process.env.ASSIGNMENT_ID;
  const dataDir = process.env.DATA_DIR || ".";
  const outputFormat = process.env.OUTPUT_FORMAT || "both";

  if (!assignmentId) {
    console.error("[FAIL] ASSIGNMENT_ID is required");
    await setOutput("outcome", "fail:validation");
    process.exit(1);
  }

  // Load assignment definition
  const assignmentPath = join(dataDir, "assignments", `${assignmentId}.yml`);
  if (!existsSync(assignmentPath)) {
    console.error(`[FAIL] Assignment not found: ${assignmentPath}`);
    await setOutput("outcome", "fail:no-assignment");
    process.exit(1);
  }
  const assignment = await loadYaml(assignmentPath);
  const deadlineAt = assignment.deadline_at ? new Date(assignment.deadline_at) : null;

  // Load roster (now that we have a real YAML parser, arrays parse correctly)
  const rosterPath = join(dataDir, "students", "roster.yml");
  let roster = [];
  if (existsSync(rosterPath)) {
    const rosterData = await loadYaml(rosterPath);
    if (Array.isArray(rosterData?.students)) roster = rosterData.students;
  }
  const rosterByLogin = new Map(
    roster.filter((s) => s.github_login).map((s) => [s.github_login, s])
  );

  // Load acceptances
  const acceptances = await readDirJsonFiles(
    join(dataDir, "acceptances", assignmentId)
  );
  const acceptanceByLogin = new Map(acceptances.map((a) => [a.github_login, a]));

  // Load repository records
  const repos = await readDirJsonFiles(
    join(dataDir, "repositories", assignmentId)
  );
  const repoByLogin = new Map(repos.map((r) => [r.github_login, r]));

  // Load observations
  const obsDir = join(dataDir, "observations", assignmentId);
  const observationsByLogin = new Map();
  if (existsSync(obsDir)) {
    const loginDirs = await readdir(obsDir);
    for (const login of loginDirs) {
      const loginPath = join(obsDir, login);
      const obs = await readDirJsonFiles(loginPath);
      observationsByLogin.set(
        login,
        obs.sort((a, b) => new Date(a.observed_at) - new Date(b.observed_at))
      );
    }
  }

  // Load overrides
  const overrides = await readDirJsonFiles(
    join(dataDir, "overrides", assignmentId)
  );
  const overrideByLogin = new Map(overrides.map((o) => [o.github_login, o]));

  // Build per-student report.
  // Include roster students who haven't accepted yet so the dashboard shows
  // the full population, not just the active acceptors.
  const allLogins = new Set([
    ...acceptanceByLogin.keys(),
    ...repoByLogin.keys(),
    ...observationsByLogin.keys(),
    ...rosterByLogin.keys(),
  ]);

  const students = [];
  let onTimeCount = 0;
  let lateCount = 0;
  let noSubCount = 0;

  for (const login of [...allLogins].sort()) {
    const acceptance = acceptanceByLogin.get(login);
    const repo = repoByLogin.get(login);
    const observations = observationsByLogin.get(login) || [];
    const override = overrideByLogin.get(login);

    // Determine submission status from observations.
    // Apply lecturer override on deadline if one exists for this student
    // (P0-7). The effective deadline is what classifies on-time vs late.
    const effectiveDeadline = override?.deadline_at
      ? new Date(override.deadline_at)
      : deadlineAt;

    let lastOnTimeSha = null;
    let lastOnTimeObservedAt = null;
    let firstLateSha = null;
    let firstLateObservedAt = null;
    let latestObservedSha = null;
    let latestObservedAt = null;
    let uncertaintySeconds = null;

    for (const obs of observations) {
      // Skip preservation records
      if (obs.collection_type === "preservation") continue;

      const obsTime = new Date(obs.observed_at);
      latestObservedSha = obs.sha;
      latestObservedAt = obs.observed_at;

      if (effectiveDeadline && obsTime <= effectiveDeadline) {
        lastOnTimeSha = obs.sha;
        lastOnTimeObservedAt = obs.observed_at;
      } else if (effectiveDeadline && obsTime > effectiveDeadline && !firstLateSha) {
        firstLateSha = obs.sha;
        firstLateObservedAt = obs.observed_at;
      }
    }

    // Calculate uncertainty against the effective deadline
    if (effectiveDeadline && lastOnTimeObservedAt) {
      const lastOnTimeTime = new Date(lastOnTimeObservedAt);
      const gapMs = effectiveDeadline - lastOnTimeTime;
      uncertaintySeconds = Math.max(0, gapMs / 1000);
    }

    // Determine status using the effective (post-override) deadline.
    let submissionStatus = "unknown";
    if (!acceptance) {
      submissionStatus = "no-submission";
    } else if (lastOnTimeSha) {
      if (firstLateSha && firstLateSha !== lastOnTimeSha) {
        submissionStatus = "late";
        lateCount++;
      } else {
        submissionStatus = "on-time";
        onTimeCount++;
      }
    } else if (latestObservedSha) {
      submissionStatus = effectiveDeadline ? "late" : "unknown";
      if (effectiveDeadline) lateCount++;
    } else {
      submissionStatus = "no-submission";
      noSubCount++;
    }

    // Find lockdown info from observations
    const lockdownObs = observations.find((o) => o.collection_type === "lockdown");

    // Find preservation info
    const preservationPath = join(obsDir, login, "preservation.json");
    const preservation = existsSync(preservationPath)
      ? await readJsonSafe(preservationPath)
      : null;

    const warnings = [];
    if (repo && !repo.repo_id) warnings.push("missing-repo-id");
    if (acceptance && !repo) warnings.push("accepted-not-provisioned");
    if (firstLateSha) warnings.push("late-activity-detected");

    const rosterEntry = rosterByLogin.get(login);
    students.push({
      github_login: login,
      student_id: rosterEntry?.student_id ?? null,
      display_name: rosterEntry?.display_name ?? null,
      class_group: rosterEntry?.class_group ?? null,
      acceptance_state: acceptance?.status ?? "not-accepted",
      effective_deadline_at: effectiveDeadline?.toISOString() ?? null,
      override_applied: !!override,
      override_reason: override?.reason ?? null,
      repo_id: repo?.repo_id ?? null,
      repo_name: repo?.repo_name ?? null,
      repo_url: repo?.repo_url ?? null,
      submission_status: submissionStatus,
      last_on_time_sha: lastOnTimeSha,
      last_on_time_observed_at: lastOnTimeObservedAt,
      first_late_sha: firstLateSha,
      first_late_observed_at: firstLateObservedAt,
      latest_observed_sha: latestObservedSha,
      latest_observed_at: latestObservedAt,
      uncertainty_interval_seconds: uncertaintySeconds,
      lock_down_at: lockdownObs?.observed_at ?? null,
      lock_down_outcome: lockdownObs ? "locked" : null,
      preservation_status: preservation?.verified
        ? "preserved"
        : preservation
          ? "failed"
          : "not-required",
      preserved_sha: preservation?.preserved_sha ?? null,
      warnings,
    });

    // Fire notifications for anomalies
    if (process.env.ORG && process.env.GITHUB_TOKEN) {
      const { notifyEvent } = await import("../notify/notify.mjs");
      if (uncertaintySeconds && uncertaintySeconds > 3600) {
        await notifyEvent({
          org: process.env.ORG,
          controlRepo: "pxl-classroom-control",
          eventType: "deadline-gap",
          assignmentId: assignmentId,
          details: `Large uncertainty interval (${Math.round(uncertaintySeconds/3600)}h) for student \`${login}\`.`,
          dedupKey: `gap-${assignmentId}-${login}`,
        }).catch(e => console.error(`Failed to notify deadline gap for ${login}: ${e.message}`));
      }
      if (firstLateSha) {
        await notifyEvent({
          org: process.env.ORG,
          controlRepo: "pxl-classroom-control",
          eventType: "late-activity",
          assignmentId: assignmentId,
          details: `Late activity detected for student \`${login}\`. First late SHA: \`${firstLateSha}\`.`,
          dedupKey: `late-${assignmentId}-${login}`,
        }).catch(e => console.error(`Failed to notify late activity for ${login}: ${e.message}`));
      }
    }
  }

  // Build report
  const report = {
    schema_version: 1,
    assignment_id: assignmentId,
    generated_at: new Date().toISOString(),
    generator_version: "1.0.0",
    source_revision: process.env.GITHUB_SHA || "unknown",
    students,
  };

  // Write outputs
  const reportsDir = join(dataDir, "reports");
  await mkdir(reportsDir, { recursive: true });

  if (outputFormat === "json" || outputFormat === "both") {
    await writeFile(
      join(reportsDir, `${assignmentId}.json`),
      JSON.stringify(report, null, 2) + "\n"
    );
    console.log(`[ok] Wrote reports/${assignmentId}.json`);
  }

  if (outputFormat === "csv" || outputFormat === "both") {
    const csvHeaders = [
      "github_login",
      "student_id",
      "display_name",
      "class_group",
      "acceptance_state",
      "submission_status",
      "effective_deadline_at",
      "override_applied",
      "override_reason",
      "repo_name",
      "repo_url",
      "last_on_time_sha",
      "last_on_time_observed_at",
      "first_late_sha",
      "first_late_observed_at",
      "latest_observed_sha",
      "latest_observed_at",
      "uncertainty_interval_seconds",
      "lock_down_at",
      "preservation_status",
      "preserved_sha",
      "warnings",
    ];

    const csvRows = [csvHeaders.join(",")];
    for (const s of students) {
      const row = csvHeaders.map((h) => {
        const v = s[h];
        if (v === null || v === undefined) return "";
        if (Array.isArray(v)) return `"${v.join("; ")}"`;
        const str = String(v);
        return str.includes(",") || str.includes('"')
          ? `"${str.replace(/"/g, '""')}"`
          : str;
      });
      csvRows.push(row.join(","));
    }

    await writeFile(
      join(reportsDir, `${assignmentId}.csv`),
      csvRows.join("\n") + "\n"
    );
    console.log(`[ok] Wrote reports/${assignmentId}.csv`);
  }

  // Generate dashboard aggregate
  const dashboardPath = join(reportsDir, "dashboard.json");
  let dashboard = { schema_version: 1, assignments: {} };
  if (existsSync(dashboardPath)) {
    dashboard = await readJsonSafe(dashboardPath) || dashboard;
  }
  dashboard.assignments[assignmentId] = buildDashboardEntry(assignment, students);
  dashboard.generated_at = new Date().toISOString();
  await writeFile(dashboardPath, JSON.stringify(dashboard, null, 2) + "\n");

  // Set outputs
  await setOutput("student_count", String(students.length));
  await setOutput("on_time_count", String(onTimeCount));
  await setOutput("late_count", String(lateCount));
  await setOutput("outcome", "generated");

  await summaryMd(
    `### Report: \`${assignmentId}\`\n\n` +
      `| metric | count |\n|---|---|\n` +
      `| total | ${students.length} |\n` +
      `| on-time | ${onTimeCount} |\n` +
      `| late | ${lateCount} |\n` +
      `| no submission | ${noSubCount} |\n` +
      `| warnings | ${students.filter((s) => s.warnings.length > 0).length} |\n`
  );
  console.log(`[ok] Report generated for ${assignmentId}: ${students.length} students`);
}

main().catch(async (e) => {
  console.error(`[FAIL] ${e.message}`);
  await setOutput("outcome", "fail:exception");
  process.exit(1);
});
