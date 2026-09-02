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
import { effectiveDeadlineFor, indexOverrides } from "../lib/effective-deadline.mjs";
// GitHub logins are case-insensitive, so every index below is keyed lowercased
// and the spelling shown is chosen separately. See lib/github-login.mjs for the
// row-doubling this prevents.
import { displayLogins, indexByLogin, normalizeLogin } from "../lib/github-login.mjs";
import { CONTROL_REPO } from "../lib/deployment.mjs";

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

// A file that will not parse is DROPPED, and it has to say so.
//
// This reads overrides/, acceptances/, repositories/ and observations/, and a
// silent drop means something different and bad in each: a lost override is a
// student's extension vanishing, a lost observation is missing evidence, a lost
// acceptance is a student absent from their own cohort report.
//
// The override case is the sharp one. lockdown.mjs's reader logs a failure line
// for exactly this, on the reasoning that an unreadable extension file is the
// only trace a lecturer would have - but this reader stayed quiet, so a file
// readable by one and not the other produced the divergence that made
// extensions worth fixing in the first place: the report telling a lecturer the
// extension was running while lockdown demoted the student anyway.
//
// An ABSENT directory is still simply "none" - git cannot store an empty one,
// and most assignments have no overrides at all.
async function readDirJsonFiles(dir) {
  if (!existsSync(dir)) return [];
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  const results = [];
  for (const f of files) {
    const data = await readJsonSafe(join(dir, f));
    if (data) results.push(data);
    else console.error(`[warn] unreadable, skipped: ${join(dir, f)}`);
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

  // Load roster (now that we have a real YAML parser, arrays parse correctly)
  const rosterPath = join(dataDir, "students", "roster.yml");
  let roster = [];
  if (existsSync(rosterPath)) {
    const rosterData = await loadYaml(rosterPath);
    if (Array.isArray(rosterData?.students)) roster = rosterData.students;
  }
  const rosterByLogin = indexByLogin(roster);

  // Load acceptances
  const acceptances = await readDirJsonFiles(
    join(dataDir, "acceptances", assignmentId)
  );
  const acceptanceByLogin = indexByLogin(acceptances);

  // Load repository records
  const repos = await readDirJsonFiles(
    join(dataDir, "repositories", assignmentId)
  );
  const repoByLogin = indexByLogin(repos);

  // Load observations.
  //
  // The DIRECTORY name is kept beside the parsed documents: it is the spelling
  // lockdown.mjs wrote and the only one `preservation.json` can be found under,
  // so it cannot be reconstructed from the normalised key.
  const obsDir = join(dataDir, "observations", assignmentId);
  const observationsByLogin = new Map();
  const obsDirNameByLogin = new Map();
  if (existsSync(obsDir)) {
    const loginDirs = await readdir(obsDir);
    for (const dirName of loginDirs) {
      const key = normalizeLogin(dirName);
      if (!key) continue;
      const loginPath = join(obsDir, dirName);
      const obs = await readDirJsonFiles(loginPath);
      observationsByLogin.set(
        key,
        obs.sort((a, b) => new Date(a.observed_at) - new Date(b.observed_at))
      );
      obsDirNameByLogin.set(key, dirName);
    }
  }

  // Load overrides
  const overrides = await readDirJsonFiles(
    join(dataDir, "overrides", assignmentId)
  );
  const overrideByLogin = indexOverrides(overrides);

  // THE LOCKDOWN RECORD IS THE AUTHORITY ON WHEN WRITES STOPPED.
  //
  // The report used to take `lock_down_at` from the lockdown OBSERVATION's
  // `observed_at` - which is when the nightly happened to look, not when the
  // student stopped being able to push. Those are the same only when the
  // nightly is what froze them; with a deadline sentinel they are hours apart,
  // and the record already carries the right instant (per target, credited to a
  // fired sentinel). Nothing read it, so that correctness was invisible.
  //
  // It also carries the freeze DELAY, which is the number the preservation
  // banner claims to show and did not have.
  const lockdownRecord = await readJsonSafe(
    join(dataDir, "lockdowns", assignmentId, "lockdown-record.json")
  );
  const lockdownByLogin = indexByLogin(lockdownRecord?.results || []);

  // Load teams (for group assignments)
  const teams = await readDirJsonFiles(
    join(dataDir, "teams", assignmentId)
  );
  const teamBySlug = new Map(teams.map((t) => [t.team_slug, t]));
  const teamByMemberLogin = new Map();
  for (const t of teams) {
    for (const m of t.members || []) {
      teamByMemberLogin.set(normalizeLogin(m), t);
    }
  }

  // Build per-student report.
  // Include roster students who haven't accepted yet so the dashboard shows
  // the full population, not just the active acceptors.
  //
  // ONE ROW PER ACCOUNT, not one per spelling. The four indexes are keyed
  // lowercased, so a roster entry a lecturer typed as `Alice-PXL` and the
  // acceptance GitHub dispatched as `alice-pxl` are the same student here -
  // they used to be two, and the accepted one carried no name or student
  // number. The SHOWN spelling comes from GitHub where we have it, and falls
  // back to the roster's only when the student has not accepted.
  const displayByLogin = displayLogins(
    acceptances.map((a) => a?.github_login),
    repos.map((r) => r?.github_login),
    obsDirNameByLogin.values(),
    roster.map((s) => s?.github_login),
  );
  const allLogins = new Set(displayByLogin.keys());

  const students = [];
  let onTimeCount = 0;
  let lateCount = 0;
  let noSubCount = 0;
  // The worst evidence gap in the cohort, for ONE notification at the end.
  let worstUncertaintySeconds = 0;
  let worstUncertaintyLogin = null;

  for (const key of [...allLogins].sort()) {
    // `key` looks things up; `login` is what a lecturer reads.
    const login = displayByLogin.get(key) ?? key;
    const acceptance = acceptanceByLogin.get(key);
    const repo = repoByLogin.get(key);
    const observations = observationsByLogin.get(key) || [];
    const studentTeam = teamByMemberLogin.get(key) || (acceptance?.team_slug ? teamBySlug.get(acceptance.team_slug) : null);

    // Determine submission status from observations, against the deadline that
    // applies to *this* student (P0-7): the assignment's, moved by any
    // extension granted to them or - on a group assignment, where the team
    // shares one repository - to any of their team-mates.
    //
    // lib/effective-deadline.mjs is the single implementation, shared with
    // lockdown.mjs and find-finalizable.mjs. It must not fork: this file's
    // inline version read a field the Admin Panel stopped writing in June 2026,
    // so every extension silently did nothing here while the lockdown demoted
    // the student anyway.
    const effective = effectiveDeadlineFor(assignment, login, {
      overrides: overrideByLogin,
      team: studentTeam,
    });
    const effectiveDeadline = effective.deadline;

    let lastOnTimeSha = null;
    let lastOnTimeObservedAt = null;
    let firstLateSha = null;
    let firstLateObservedAt = null;
    let latestObservedSha = null;
    let latestObservedAt = null;
    let latestCommitCount = null;
    let latestCommitDate = null;
    // Counted by the collector against this student's effective deadline. null
    // means "not known" - an assignment collected before the field existed, or
    // a count the API would not answer - and is deliberately distinct from 0.
    let latestLateCommitCount = null;
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
      if (obs.late_commit_count != null) {
        latestLateCommitCount = obs.late_commit_count;
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

      // A LOCKDOWN OBSERVATION IS A SYSTEM EVENT, NOT A SUBMISSION.
      //
      // lockdown.mjs writes one when it freezes a repository, to record WHAT it
      // froze (`collection_type: "lockdown"`). It carries no commit_date, and
      // its observed_at is necessarily after the deadline because that is when
      // lockdown runs - so letting it into the comparison marks every frozen
      // student late on the strength of the system's own clock. It was the
      // source of the false `first_late_sha === last_on_time_sha` rows.
      //
      // Worse, it claims `first_late_sha`, and the `!firstLateSha` guard below
      // then stops a GENUINELY late commit from ever being recorded - which
      // reports a late submission as on-time. Caught by a deliberately-late test
      // commit on 2526-examen-aut2-ek2 (2026-09-02) that the report called
      // on-time 52 hours after the deadline. Failing open is the one direction
      // this must never fail in.
      if (obs.collection_type === "lockdown") continue;

      // THE COMMIT'S OWN TIMESTAMP DECIDES, not when the collector looked.
      //
      // `observed_at` is when the nightly ran. A student who pushes at 13:00 on
      // the deadline day is not SEEN until the run at 00:34 the next morning, so
      // comparing observation time against the deadline marks them late for
      // finishing early. It is exactly the mistake this file already fixed one
      // field over for `lock_down_at` - "when the nightly happened to look, not
      // when the student stopped being able to push" - and the systematic shape
      // is the worst possible one for grading: it penalises precisely the
      // students who work up to the deadline, and nobody else.
      //
      // Measured on PXL-Automation-II/2526-examen-aut2-ek2 (2026-09-02): every
      // student in a finished exam had committed BEFORE the deadline, zero
      // commits existed after it, and the two marked late were the two whose
      // last commit fell between the two nightly runs.
      //
      // `observed_at` remains the fallback when an observation carries no
      // commit_date, and `uncertainty_interval_seconds` below still measures the
      // observation window - so the tamper-evidence the old rule gave is
      // recorded rather than thrown away.
      const commitTime = obs.commit_date ? new Date(obs.commit_date) : null;
      const decidingTime =
        commitTime && !Number.isNaN(commitTime.getTime()) ? commitTime : obsTime;

      if (effectiveDeadline && decidingTime <= effectiveDeadline) {
        lastOnTimeSha = obs.sha;
        lastOnTimeObservedAt = obs.observed_at;
      } else if (effectiveDeadline && decidingTime > effectiveDeadline && !firstLateSha) {
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

    // How stale our last pre-deadline evidence was: the gap between the final
    // on-time observation and the student's own deadline.
    //
    // ONLY ONCE THE DEADLINE HAS PASSED. Before it, this same subtraction is
    // simply the time REMAINING - the deadline minus a recent observation - and
    // calling that "uncertainty" was not a rounding error but a different
    // quantity wearing the name. Live 2026-08-26: an assignment due on the 30th
    // reported "116h" for every student, which was the four days left to run.
    if (effectiveDeadline && lastOnTimeObservedAt && effectiveDeadline <= new Date()) {
      const lastOnTimeTime = new Date(lastOnTimeObservedAt);
      const gapMs = effectiveDeadline - lastOnTimeTime;
      uncertaintySeconds = Math.max(0, gapMs / 1000);
      if (uncertaintySeconds > worstUncertaintySeconds) {
        worstUncertaintySeconds = uncertaintySeconds;
        worstUncertaintyLogin = login;
      }
    }

    // Determine status using the effective (post-override) deadline.
    // A repo with 0 commits or only the single automatic "Initial commit" (commit_count <= 1)
    // without a submit/ tag represents an unstarted repository where the student submitted no work.
    const isUnstarted = !latestTagObservation && (latestCommitCount != null ? latestCommitCount <= 1 : false);

    // LATE ACTIVITY IS A DIFFERENT SHA, NOT A LATER OBSERVATION.
    //
    // Observations are COLLECTOR RUNS, not commits. The nightly, the lockdown
    // pass and preservation all re-read an untouched repository after the
    // deadline and record an observation whose `observed_at` is "now" and whose
    // `sha` is still the student's last on-time commit - so `firstLateSha`
    // comes back equal to `lastOnTimeSha` for a repo nobody touched.
    //
    // The status logic has always known this. The `warnings` array did not, and
    // used the weaker `if (firstLateSha)`, so an entire finished exam cohort was
    // flagged "late activity" while every row's status read "on-time" (reported
    // from live use, PXLAutomation, 2026-09-02). One boolean now, so the two
    // cannot drift apart again.
    const hasLateActivity = Boolean(firstLateSha) && firstLateSha !== lastOnTimeSha;

    let submissionStatus = "unknown";
    if (!acceptance || isUnstarted) {
      submissionStatus = "no-submission";
      noSubCount++;
    } else if (lastOnTimeSha) {
      if (hasLateActivity) {
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
    const lockdownRow = lockdownByLogin.get(key);

    // Find preservation info. The directory is whatever spelling preserve.mjs
    // wrote, not the normalised key - there is nothing to read otherwise.
    const preservationPath = join(obsDir, obsDirNameByLogin.get(key) ?? login, "preservation.json");
    const preservation = existsSync(preservationPath)
      ? await readJsonSafe(preservationPath)
      : null;

    const warnings = [];
    if (repo && !repo.repo_id) warnings.push("missing-repo-id");
    if (acceptance && !repo) warnings.push("accepted-not-provisioned");
    if (hasLateActivity) warnings.push("late-activity-detected");

    const team = studentTeam;
    const rosterEntry = rosterByLogin.get(key);
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
      // What this acceptance was admitted on. accept.mjs has written these
      // since roster_mode: claim shipped and NOTHING had ever read them - the
      // `preserved_sha` shape again, a field written at one end with nobody at
      // the other.
      //
      // Under `claim` the Roster tab answers "who is bound" from the org-scoped
      // binding. Under `open` there is often no roster at all, so this report
      // is the ONLY surface a lecturer has, and it is where the detection half
      // of the claim has to land: an address outside `claim_domains` is
      // recorded rather than refused, and a lecturer who cannot see it might as
      // well not have it.
      claimed_email: acceptance?.claimed_email ?? null,
      claim_verified: acceptance?.claim_verified ?? null,
      // Null, not true, when there is no claim: "inside the allowed domains" is
      // a statement about an address, and there is no address to make it about.
      claim_domain_allowed: acceptance?.claimed_email ? acceptance.claim_domain_allowed !== false : null,
      effective_deadline_at: effectiveDeadline?.toISOString() ?? null,
      // "an extension moved this student's deadline", not "an override document
      // exists" - the columns sit beside effective_deadline_at and an
      // annotation or exemption override must not read as extra time.
      override_applied: effective.extended,
      override_reason: effective.reason,
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
      late_commit_count: latestLateCommitCount ?? null,
      uncertainty_interval_seconds: uncertaintySeconds,
      tagged_submission_tag: latestTagObservation?.tag ?? null,
      tagged_submission_sha: latestTagObservation?.tagged_sha ?? null,
      tagged_submission_observed_at: latestTagObservation?.observed_at ?? null,
      tagged_submission_declared_at: latestTagObservation?.declared_at ?? null,
      // The record first: it is when writes actually stopped. The observation's
      // timestamp is only when the nightly looked, and falls back to it for a
      // control repo whose record predates this field.
      lock_down_at: lockdownRow?.lockdown_at ?? lockdownObs?.observed_at ?? null,
      lock_down_outcome: lockdownObs || lockdownRow ? "locked" : null,
      // How long after their own deadline this student could still push. NOT
      // `uncertainty_interval_seconds` below, which is the opposite side of the
      // deadline - the gap between the last observation and the deadline, i.e.
      // how stale the evidence was going in. The preservation banner promised
      // this one and was showing that one.
      lockdown_delay_seconds: lockdownRow?.uncertainty_seconds ?? null,
      preservation_status: preservation?.verified
        ? "preserved"
        : preservation
          ? "failed"
          : "not-required",
      // `source_sha`, which is what preserve.mjs actually writes. It read
      // `preservation.preserved_sha` - a field that has never existed in that
      // document - so `preserved_sha` was null on EVERY report ever generated,
      // including the one real preservation in production, whose
      // preservation.json carries `source_sha: a7655427…` beside
      // `preservation_status: "preserved"` and a null sha.
      //
      // The name is right and the source was wrong: preserve pushes this exact
      // commit to the archive and verifies the remote SHA equals it, so the
      // preserved SHA and the source SHA are the same object by construction.
      //
      // Everything gated on the field being truthy was dead: the archive link
      // in the student table, `pxl-classroom download`, `pxl-classroom grade`,
      // and the export manifest. Same class as the `earned_points` bug already
      // recorded in CLAUDE.md - a report field every consumer reads and nothing
      // writes - and it survived for the same reason: the fixtures supplied it.
      preserved_sha: preservation?.source_sha ?? null,
      // Which archive repository holds it. Archives are per assignment now
      // (`pxl-classroom-archive-<id>`), so "the org's archive" is no longer a
      // thing any consumer can assume - and a submission preserved before that
      // change is in the old per-org repository and must keep resolving there.
      //
      // preserve.mjs has always written this field; nothing had ever read it,
      // which is the `preserved_sha` shape one field over. The record is the
      // authority, not lib/archive-repo.mjs's naming rule: derive the name and
      // every pre-change archive link 404s.
      archive_repo: preservation?.archive_repo ?? null,
      // The ref the push actually targeted. Reconstructing it from the login is
      // what every archive link in the SPA did, and it is wrong for a group
      // assignment: a team shares one repository and preserve.mjs pushes to
      // `preserved/<id>/<team-slug>`, so every group submission linked to a
      // branch that does not exist.
      archive_ref: preservation?.preserved_ref ?? null,
      warnings,
    });

    // Fire notifications for anomalies
    if (process.env.ORG && process.env.GITHUB_TOKEN) {
      const { notifyEvent } = await import("../notify/notify.mjs");
      if (firstLateSha) {
        await notifyEvent({
          org: process.env.ORG,
          controlRepo: CONTROL_REPO,
          eventType: "late-activity",
          assignmentId: assignmentId,
          details: `Late activity detected for student \`${login}\`. First late SHA: \`${firstLateSha}\`.`,
          dedupKey: `late-${assignmentId}-${login}`,
        }).catch(e => console.error(`Failed to notify late activity for ${login}: ${e.message}`));
      }
    }
  }

  // ONE deadline-gap notification for the cohort, not one per student.
  //
  // This fired at a 1-hour threshold, per student, on every report run - and
  // the nightly collect only observes once a day, so the gap between the last
  // pre-deadline observation and the deadline is routinely many hours by
  // construction. It was therefore guaranteed to fire for everybody, always:
  // measured live 2026-08-26, PXL-Automation-II's tracking issue held six
  // comments for six students, every one of them a deadline-gap.
  //
  // An alarm that always fires is not an alarm. The threshold is now tied to
  // the observation cadence, so it means the thing a lecturer would act on:
  // a nightly did not run, and the evidence for this cohort is older than it
  // should be. One comment, naming the worst case.
  const NIGHTLY_MS = 24 * 3600;
  const GAP_ALERT_SECONDS = NIGHTLY_MS + 2 * 3600; // a missed nightly, plus slack
  if (
    process.env.ORG &&
    process.env.GITHUB_TOKEN &&
    worstUncertaintySeconds > GAP_ALERT_SECONDS
  ) {
    const { notifyEvent } = await import("../notify/notify.mjs");
    await notifyEvent({
      org: process.env.ORG,
      controlRepo: CONTROL_REPO,
      eventType: "deadline-gap",
      assignmentId,
      details:
        `The last observation before the deadline was ${Math.round(worstUncertaintySeconds / 3600)}h ` +
        `old (worst case: \`${worstUncertaintyLogin}\`). The nightly observes once a day, so a gap ` +
        `this large means a run was missed - submission times for this cohort rest on GitHub's own ` +
        `\`pushed_at\` in the lockdown record rather than on an observation close to the deadline.`,
      dedupKey: `gap-${assignmentId}`,
    }).catch((e) => console.error(`Failed to notify deadline gap: ${e.message}`));
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
      archive_repo: firstMember?.archive_repo || null,
      archive_ref: firstMember?.archive_ref || null,
      under_capacity: underCapacity,
      ...(t.seeded_from ? { seeded_from: t.seeded_from } : {}),
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
      "claimed_email",
      "claim_verified",
      "claim_domain_allowed",
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
      "lockdown_delay_seconds",
      "preservation_status",
      "preserved_sha",
      "archive_repo",
      "archive_ref",
      "warnings",
    ];

    const csvRows = [csvHeaders.join(",")];
    for (const s of students) {
      const row = csvHeaders.map((h) => {
        const v = s[h];
        if (v === null || v === undefined) return "";
        let str = Array.isArray(v) ? v.join("; ") : String(v);
        if (/^[=+\-@]/.test(str)) {
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

  // Drop entries whose assignment no longer exists.
  //
  // This file was APPEND-ONLY: every run added or updated the entry for its own
  // assignment and nothing ever removed one. Delete an assignment and its card
  // stayed on the lecturer's dashboard for ever, linking to a detail page whose
  // YAML and report both 404 - which is exactly what happened to
  // `phasea-live-sysex` in PXL-Systems-Expert, and it took the page down before
  // the view learned to guard itself.
  //
  // UNREADABLE IS NOT EVIDENCE. Only a directory we could actually list is
  // grounds for deciding an assignment is gone; if the read fails, every entry
  // is left alone. Removing a live cohort's card because a listing hiccuped
  // would be far worse than the stale card this fixes.
  let onDisk = null;
  try {
    onDisk = new Set(
      (await readdir(join(dataDir, "assignments")))
        .filter((f) => /\.ya?ml$/.test(f))
        .map((f) => f.replace(/\.ya?ml$/, ""))
    );
  } catch (e) {
    console.error(`[warn] could not list assignments/, leaving dashboard entries untouched: ${e.message}`);
  }
  if (onDisk && onDisk.size > 0) {
    for (const id of Object.keys(dashboard.assignments)) {
      // Never the assignment this run just generated - it is on disk by
      // definition, and a rename mid-run must not delete the entry just written.
      if (id === assignmentId) continue;
      if (!onDisk.has(id)) {
        delete dashboard.assignments[id];
        console.error(`[ok] pruned dashboard entry for ${id} - assignments/${id}.yml no longer exists`);
      }
    }
  }

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
