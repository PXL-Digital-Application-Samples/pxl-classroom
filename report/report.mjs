#!/usr/bin/env node
// PXL Classroom - deadline report generator.
//
// Reads observations, acceptances, repository records, and overrides for a
// given assignment and produces:
//   - reports/<id>.json - structured deadline report
//   - reports/<id>.csv  - CSV export (one row per student)
//   - reports/dashboard.json - aggregated dashboard data
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

  // Load teams (for group assignments)
  const teams = await readDirJsonFiles(
    join(dataDir, "teams", assignmentId)
  );
  const teamBySlug = new Map(teams.map((t) => [t.team_slug, t]));
  const teamByMemberLogin = new Map();
  for (const t of teams) {
    for (const m of t.members || []) {
      teamByMemberLogin.set(m.toLowerCase(), t);
    }
  }

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
    const studentTeam = teamByMemberLogin.get(login.toLowerCase()) || (acceptance?.team_slug ? teamBySlug.get(acceptance.team_slug) : null);

    // Determine submission status from observations.
    // Apply lecturer override on deadline if one exists for this student (P0-7).
    // In group assignments, propagate the most generous extension among team members
    // so the entire team repository is evaluated consistently.
    let effectiveDeadline = override?.deadline_at
      ? new Date(override.deadline_at)
      : deadlineAt;

    if (studentTeam && Array.isArray(studentTeam.members)) {
      for (const m of studentTeam.members) {
        const teamMemberOverride = overrideByLogin.get(m.toLowerCase()) || overrideByLogin.get(m);
        if (teamMemberOverride?.deadline_at) {
          const overrideDate = new Date(teamMemberOverride.deadline_at);
          if (!effectiveDeadline || overrideDate > effectiveDeadline) {
            effectiveDeadline = overrideDate;
          }
        }
      }
    }

    let lastOnTimeSha = null;
    let lastOnTimeObservedAt = null;
    let firstLateSha = null;
    let firstLateObservedAt = null;
    let latestObservedSha = null;
    let latestObservedAt = null;
    let latestCommitCount = null;
    let latestCommitDate = null;
    let latestCommitMessage = null;
    let latestAuthorName = null;
    let latestAuthorEmail = null;
    let uncertaintySeconds = null;

    // Tagged-submission observations are tracked separately so the UI can
    // surface them and so a tag - when present and on-time - wins over the
    // default-branch tip. See ARCHITECTURE.md §11.1a.
    let latestTagObservation = null;

    for (const obs of observations) {
      // Skip preservation records
      if (obs.collection_type === "preservation") continue;

      if (obs.commit_count != null) {
        latestCommitCount = obs.commit_count;
      }
      if (obs.commit_date) {
        latestCommitDate = obs.commit_date;
      }
      if (obs.commit_message) {
        latestCommitMessage = obs.commit_message;
      }
      if (obs.author_name) {
        latestAuthorName = obs.author_name;
      }
      if (obs.author_email) {
        latestAuthorEmail = obs.author_email;
      }

      if (obs.type === "tagged-submission") {
        if (!latestTagObservation || new Date(obs.observed_at) > new Date(latestTagObservation.observed_at)) {
          latestTagObservation = obs;
        }
        continue;
      }

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

    // If a submit/ tag was seen, prefer it as the authoritative submission.
    // observed_at is server-side (set by collect/), declared_at is the
    // student-supplied ISO timestamp baked into the tag name - we trust the
    // former for classification.
    if (latestTagObservation) {
      const tagObservedAt = new Date(latestTagObservation.observed_at);
      const onTime = effectiveDeadline ? tagObservedAt <= effectiveDeadline : true;
      if (onTime) {
        lastOnTimeSha = latestTagObservation.tagged_sha;
        lastOnTimeObservedAt = latestTagObservation.observed_at;
        // A late snapshot observed after the tag does not invalidate an
        // on-time tagged submission.
        firstLateSha = null;
        firstLateObservedAt = null;
      } else if (!firstLateSha) {
        firstLateSha = latestTagObservation.tagged_sha;
        firstLateObservedAt = latestTagObservation.observed_at;
      }
      latestObservedSha = latestTagObservation.tagged_sha;
      latestObservedAt = latestTagObservation.observed_at;
    }

    // Calculate uncertainty against the effective deadline
    if (effectiveDeadline && lastOnTimeObservedAt) {
      const lastOnTimeTime = new Date(lastOnTimeObservedAt);
      const gapMs = effectiveDeadline - lastOnTimeTime;
      uncertaintySeconds = Math.max(0, gapMs / 1000);
    }

    // Determine status using the effective (post-override) deadline.
    // A repo with 0 commits or only the single automatic "Initial commit" (commit_count <= 1)
    // without a submit/ tag represents an unstarted repository where the student submitted no work.
    const isUnstarted = !latestTagObservation && (latestCommitCount != null ? latestCommitCount <= 1 : false);

    let submissionStatus = "unknown";
    if (!acceptance || isUnstarted) {
      submissionStatus = "no-submission";
      noSubCount++;
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

    const team = teamByMemberLogin.get(login.toLowerCase()) || (acceptance?.team_slug ? teamBySlug.get(acceptance.team_slug) : null);
    const rosterEntry = rosterByLogin.get(login);
    students.push({
      github_login: login,
      team_slug: team?.team_slug ?? acceptance?.team_slug ?? null,
      team_name: team?.team_name ?? acceptance?.team_name ?? null,
      student_number: rosterEntry?.student_number ?? null,
      full_name: rosterEntry?.full_name ?? null,
      email: rosterEntry?.email ?? null,
      class_group: rosterEntry?.class_group ?? null,
      author_name: latestAuthorName ?? null,
      author_email: latestAuthorEmail ?? null,
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
      commit_date: latestCommitDate ?? null,
      latest_commit_date: latestCommitDate ?? null,
      commit_message: latestCommitMessage ?? null,
      latest_commit_message: latestCommitMessage ?? null,
      commit_count: latestCommitCount ?? null,
      uncertainty_interval_seconds: uncertaintySeconds,
      tagged_submission_tag: latestTagObservation?.tag ?? null,
      tagged_submission_sha: latestTagObservation?.tagged_sha ?? null,
      tagged_submission_observed_at: latestTagObservation?.observed_at ?? null,
      tagged_submission_declared_at: latestTagObservation?.declared_at ?? null,
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

  const teamsReport = teams.map((t) => {
    const members = t.members || [];
    const memberStudents = students.filter((s) =>
      members.map((m) => m.toLowerCase()).includes(s.github_login.toLowerCase())
    );
    const firstMember = memberStudents[0];
    const underCapacity = assignment.group_config?.min_team_size
      ? members.length < assignment.group_config.min_team_size
      : false;
    const warnings = [];
    if (underCapacity) warnings.push("under-capacity");
    return {
      team_slug: t.team_slug,
      team_name: t.team_name,
      members,
      repo_name: t.repo_name || firstMember?.repo_name || null,
      repo_url: t.repo_url || firstMember?.repo_url || null,
      repo_id: t.repo_id || firstMember?.repo_id || null,
      submission_status: firstMember?.submission_status || "no-submission",
      latest_observed_sha: firstMember?.latest_observed_sha || null,
      commit_count: firstMember?.commit_count || null,
      lock_down_at: firstMember?.lock_down_at || null,
      preservation_status: firstMember?.preservation_status || null,
      preserved_sha: firstMember?.preserved_sha || null,
      under_capacity: underCapacity,
      warnings,
    };
  });

  // Build report
  const report = {
    schema_version: 1,
    assignment_id: assignmentId,
    generated_at: new Date().toISOString(),
    generator_version: "1.0.0",
    source_revision: process.env.GITHUB_SHA || "unknown",
    ...(assignment.assignment_type === "group" ? { teams: teamsReport } : {}),
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
      "team_slug",
      "team_name",
      "student_number",
      "full_name",
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
      "commit_count",
      "uncertainty_interval_seconds",
      "tagged_submission_tag",
      "tagged_submission_sha",
      "tagged_submission_observed_at",
      "tagged_submission_declared_at",
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
        let str = Array.isArray(v) ? v.join("; ") : String(v);
        if (/^[=\+\-@]/.test(str)) {
          str = `'${str}`;
        }
        return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
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
