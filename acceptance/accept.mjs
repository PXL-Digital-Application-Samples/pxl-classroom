#!/usr/bin/env node
// PXL Classroom - acceptance handler.
//
// Runs in the private control repo, triggered by repository_dispatch from the
// public broker.  Validates the dispatch payload, checks assignment guardrails
// (open window, per-assignment cap), and records the acceptance.
//
// Inputs via env:  ASSIGNMENT_ID, GITHUB_LOGIN, GITHUB_ID, WORKFLOW_RUN_URL,
//                  ORG, CONTROL_REPO, DATA_DIR
// Outputs via GITHUB_OUTPUT:  assignment_id, github_login, github_id, outcome,
//                              target_repo

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { loadYaml } from "../lib/yaml.mjs";

const env = (k, d) => process.env[k] ?? d;

// --- Actions output / summary helpers ----------------------------------------
async function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT)
    await appendFile(process.env.GITHUB_OUTPUT, `${name}=${value ?? ""}\n`);
}
async function summary(md) {
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(process.env.GITHUB_STEP_SUMMARY, md + "\n");
}
const log = (step, detail) =>
  console.log(
    `[${detail.ok === false ? "FAIL" : "ok"}] ${step}${detail.note ? ` - ${detail.note}` : ""}`
  );

// A system error: the run should go red so somebody looks at it.
async function fail(category, note) {
  log(category, { ok: false, note });
  await setOutput("outcome", category);
  await summary(`### Acceptance FAILED: \`${category}\`\n\n${note ?? ""}`);
  process.exit(1);
}

// An expected outcome: the student is not on the roster, the window has closed,
// the cap is full. Exits 0 deliberately - a red workflow run for a rejection the
// system handled correctly teaches people to ignore red workflow runs, and
// buries the real failures next to it. The outcome string still gates every
// downstream step, and acceptance-handler.yml notifies the lecturer, which is
// where a rejection actually needs to surface.
async function reject(category, note) {
  log(category, { ok: false, note });
  await setOutput("outcome", category);
  await setOutput("reject_reason", note ?? "");
  await summary(`### Acceptance rejected: \`${category}\`\n\n${note ?? ""}`);
  process.exit(0);
}

// --- Strict input validation -------------------------------------------------
const SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

function validate(assignmentId, login, id) {
  if (!assignmentId) return "assignment_id is missing from dispatch payload";
  if (!SLUG.test(assignmentId))
    return `assignment_id="${assignmentId}" is not a valid slug`;
  if (!login) return "github_login is missing from dispatch payload";
  if (!LOGIN.test(login))
    return `github_login="${login}" is not a valid GitHub login`;
  if (!id || isNaN(Number(id)))
    return `github_id="${id}" is missing or not a number`;
  return null;
}

async function main() {
  const assignmentId = env("ASSIGNMENT_ID");
  const login = env("GITHUB_LOGIN");
  const githubId = env("GITHUB_ID");
  const workflowRunUrl = env("WORKFLOW_RUN_URL", "");
  const org = env("ORG");
  const dataDir = env("DATA_DIR", ".");

  // 1. Validate inputs
  const bad = validate(assignmentId, login, githubId);
  if (bad) await fail("fail:validation", bad);
  log("validate", { ok: true, note: `${assignmentId} / ${login} / ${githubId}` });

  // 2. Load assignment definition
  const assignmentPath = join(dataDir, "assignments", `${assignmentId}.yml`);
  if (!existsSync(assignmentPath))
    await reject("rejected:no-assignment", `assignment file not found: ${assignmentPath}`);

  const assignment = await loadYaml(assignmentPath);
  log("assignment", { ok: true, note: `state=${assignment.state} title="${assignment.title}"` });

  // 3. Check assignment state
  if (assignment.state !== "published")
    await reject("rejected:not-published", `assignment state is "${assignment.state}", not "published"`);

  // 4. Check open window (guardrail)
  const now = new Date();
  const bypassWindow = env("BYPASS_WINDOW") === "true";
  if (bypassWindow) {
    log("window", { ok: true, note: `bypassing open window checks (BYPASS_WINDOW=true)` });
  } else {
    if (assignment.opens_at) {
      const opens = new Date(assignment.opens_at);
      if (now < opens)
        await reject("rejected:not-open", `assignment opens at ${assignment.opens_at}, current time is ${now.toISOString()}`);
    }
    if (assignment.deadline_at) {
      const deadline = new Date(assignment.deadline_at);
      if (now > deadline)
        await reject("rejected:past-deadline", `assignment deadline was ${assignment.deadline_at}, current time is ${now.toISOString()}`);
    }
    log("window", { ok: true, note: `within open window` });
  }

  // 4.5 Check roster registration.
  //
  // roster_mode: "open" restores the v1 behaviour for assignments (typically
  // exams) whose cohort isn't known up front: any GitHub account may accept,
  // and the lecturer reconciles github_login -> student afterward. The window
  // and max_acceptances remain the guardrails. Absent/unknown values are
  // treated as "enforced" so existing assignments stay roster-gated.
  const rosterMode = assignment.roster_mode === "open" ? "open" : "enforced";
  let roster = null;
  const rosterPath = join(dataDir, "students", "roster.yml");
  if (existsSync(rosterPath)) {
    try {
      roster = await loadYaml(rosterPath);
    } catch (err) {
      if (rosterMode !== "open") {
        await fail("fail:exception", `roster YAML parsing failed: ${err.message}`);
      }
    }
  }

  if (rosterMode === "open") {
    if (!assignment.max_acceptances) {
      await fail(
        "fail:config",
        `assignment has roster_mode: open without max_acceptances - open enrollment requires a cap, since it is the only remaining limit. Set max_acceptances in the assignment YAML.`
      );
    }
    log("roster", {
      ok: true,
      note: `roster_mode=open - roster gate skipped (window + cap of ${assignment.max_acceptances} still enforced)`,
    });
  } else {
    if (!roster) {
      await reject("rejected:no-roster", `roster file not found: ${rosterPath}`);
    }
    const onRoster = (roster?.students || []).some(
      (s) => s.github_login?.toLowerCase() === login.toLowerCase()
    );
    if (!onRoster) {
      await reject("rejected:not-on-roster", `student @${login} is not registered in the roster`);
    }
    log("roster", { ok: true, note: `@${login} is on the roster` });
  }

  // 5. Group assignment team resolution & checks
  const isGroup = assignment.assignment_type === "group";
  let teamSlug = env("TEAM_SLUG", "");
  let teamName = env("TEAM_NAME", "");
  let previousTeamSlug = null;
  let previousRepo = null;
  let isFirstMember = true;

  if (isGroup) {
    const teamsDir = join(dataDir, "teams", assignmentId);
    await mkdir(teamsDir, { recursive: true });

    // Which team already lists this student? Scanned before anything else,
    // because a manifest that names them - a team seeded from last assignment,
    // one a lecturer created, or one they joined earlier - is the strongest
    // statement of where they belong.
    let oldTeam = null;
    let oldTeamFile = null;
    if (existsSync(teamsDir)) {
      const teamFiles = (await readdir(teamsDir)).filter((f) => f.endsWith(".json")).sort();
      for (const tf of teamFiles) {
        try {
          const tdata = JSON.parse(await readFile(join(teamsDir, tf), "utf-8"));
          if (tdata.members?.some((m) => m.toLowerCase() === login.toLowerCase())) {
            oldTeam = tdata;
            oldTeamFile = join(teamsDir, tf);
            break;
          }
        } catch {}
      }
    }

    // Pre-assignment resolution: team manifest first, roster columns second.
    let assignedSlug = oldTeam?.team_slug || null;
    let assignedName = oldTeam?.team_name || null;
    if (!assignedSlug && roster) {
      const rosterStudent = (roster.students || []).find(
        (s) => s.github_login?.toLowerCase() === login.toLowerCase()
      );
      const preassigned = rosterStudent?.teams?.[assignmentId] || rosterStudent?.team_slug;
      if (preassigned) {
        assignedSlug = preassigned;
        assignedName = rosterStudent.team_name || preassigned;
      }
    }

    const formationMode =
      assignment.group_config?.formation_mode === "pre-assigned" ? "pre-assigned" : "self-service";
    const unassignedFallback =
      assignment.group_config?.unassigned_fallback === "self-service" ? "self-service" : "block";

    if (formationMode === "pre-assigned" && assignedSlug) {
      // The grouping is the lecturer's. A payload naming a different team is a
      // stale tab or a hand-crafted request, never a legitimate switch - honour
      // the assignment rather than silently redirecting, so the student is told.
      const requested = teamSlug || slugify(teamName);
      if (requested && requested.toLowerCase() !== assignedSlug.toLowerCase()) {
        await reject(
          "rejected:team-not-assigned",
          `@${login} is assigned to team "${assignedSlug}"; teams are pre-assigned for this assignment and students cannot change them`
        );
      }
      teamSlug = assignedSlug;
      teamName = assignedName || assignedSlug;
    } else if (formationMode === "pre-assigned" && unassignedFallback === "block") {
      await reject("rejected:no-assigned-team", `student @${login} has no pre-assigned team in the roster`);
    } else if (!teamSlug && !teamName && assignedSlug) {
      // Self-service (or pre-assigned falling back): the assigned team is the
      // default only when the student named none. Naming a different one is a
      // switch, and switching stays open until the deadline.
      teamSlug = assignedSlug;
      teamName = assignedName || assignedSlug;
    }

    if (assignedSlug && teamSlug === assignedSlug) {
      log("assigned-team", { ok: true, note: `resolved assigned team ${assignedSlug}` });
    }

    if (formationMode === "pre-assigned" && !assignedSlug) {
      log("unassigned-fallback", {
        ok: true,
        note: `@${login} has no pre-assigned team - unassigned_fallback: self-service`,
      });
    }

    if (!teamSlug && teamName) {
      teamSlug = slugify(teamName);
    }
    if (!teamSlug) {
      await reject("rejected:no-team", "team_slug or team_name is required for group assignments");
    }
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(teamSlug)) {
      await reject("rejected:invalid-team-slug", `team_slug "${teamSlug}" is not a valid slug`);
    }

    const teamFile = join(teamsDir, `${teamSlug}.json`);
    const maxTeamSize = assignment.group_config?.max_team_size || 3;

    if (oldTeam) {
      if (oldTeam.team_slug === teamSlug) {
        log("team-idempotent", { ok: true, note: `already in team ${teamSlug}` });
      } else {
        log("team-switch", { ok: true, note: `switching from ${oldTeam.team_slug} to ${teamSlug}` });
        previousTeamSlug = oldTeam.team_slug;
        previousRepo = deriveRepoName(assignment.repository_name_pattern, oldTeam.team_slug, login);
        oldTeam.members = oldTeam.members.filter((m) => m.toLowerCase() !== login.toLowerCase());
        if (oldTeam.members.length === 0) {
          oldTeam.vacant = true;
        }
        await writeFile(oldTeamFile, JSON.stringify(oldTeam, null, 2) + "\n");
      }
    }

    if (existsSync(teamFile)) {
      const teamData = JSON.parse(await readFile(teamFile, "utf-8"));
      if (!teamData.members.some((m) => m.toLowerCase() === login.toLowerCase())) {
        if (teamData.members.length >= (teamData.max_members || maxTeamSize)) {
          await reject(
            "rejected:team-full",
            `team "${teamSlug}" has reached its capacity (${teamData.members.length}/${teamData.max_members || maxTeamSize})`
          );
        }
        teamData.members.push(login);
        teamData.vacant = false;
        await writeFile(teamFile, JSON.stringify(teamData, null, 2) + "\n");
      }
      teamName = teamData.team_name || teamName || teamSlug;
      // Members, not acceptances, was the wrong question. A lecturer-seeded
      // team is listed with all of its members before anybody has accepted, so
      // the FIRST student through this door saw members.length === 3 and was
      // told they were not the first - and a team of one that was seeded and
      // then joined by somebody else got `true` twice.
      //
      // Nothing consumes the output today (provisioning is idempotent on repo
      // existence, which is why this never showed up), so it is advisory - but
      // it is declared on the action, and a wrong advisory value is a trap for
      // whoever wires it up next.
      isFirstMember = await isFirstAcceptanceInTeam(dataDir, assignmentId, teamData.members, login);
    } else {
      if (assignment.group_config?.allow_team_creation === false) {
        await reject("rejected:team-creation-disabled", "creating new teams is disabled for this assignment");
      }
      const newTeam = {
        schema_version: 1,
        assignment_id: assignmentId,
        team_slug: teamSlug,
        team_name: teamName || teamSlug,
        members: [login],
        max_members: maxTeamSize,
        created_at: now.toISOString(),
        created_by: login,
      };
      await writeFile(teamFile, JSON.stringify(newTeam, null, 2) + "\n");
      teamName = newTeam.team_name;
      isFirstMember = true;
    }
  }

  // 6. Check idempotency - already accepted?
  const acceptDir = join(dataDir, "acceptances", assignmentId);
  const acceptFile = join(acceptDir, `${login}.json`);
  const targetRepo = isGroup
    ? deriveRepoName(assignment.repository_name_pattern, teamSlug, login)
    : deriveRepoName(assignment.repository_name_pattern, login, login);

  if (existsSync(acceptFile) && !previousTeamSlug) {
    const existing = JSON.parse(await readFile(acceptFile, "utf-8"));
    log("idempotent", { ok: true, note: `already accepted at ${existing.accepted_at}` });

    await setOutput("assignment_id", assignmentId);
    await setOutput("github_login", login);
    await setOutput("github_id", githubId);
    await setOutput("outcome", "already-accepted");
    await setOutput("target_repo", targetRepo);
    await setOutput("team_slug", teamSlug);
    await setOutput("team_name", teamName);
    await setOutput("is_first_member", isFirstMember ? "true" : "false");
    await setOutput("previous_repo", previousRepo || "");
    await setOutput("template_owner", assignment.template.owner);
    await setOutput("template_repo", assignment.template.repository);
    await setOutput("feedback_pr", assignment.feedback_pr === true ? "true" : "false");
    await setOutput("feedback_pr_baseline_branch", assignment.feedback_pr_baseline_branch || "pxl-baseline");
    await summary(`### Acceptance: \`already-accepted\`\n\n${login} already accepted ${assignmentId}.`);
    process.exit(0);
  }

  // 7. Check per-assignment cap (guardrail)
  const maxAcceptances = assignment.max_acceptances;
  if (maxAcceptances && !previousTeamSlug) {
    let currentCount = 0;
    if (existsSync(acceptDir)) {
      const files = await readdir(acceptDir);
      currentCount = files.filter((f) => f.endsWith(".json")).length;
    }
    if (currentCount >= maxAcceptances)
      await reject(
        "rejected:cap-reached",
        `per-assignment cap reached (${currentCount}/${maxAcceptances}). Acceptance queued for lecturer review.`
      );
    log("cap", { ok: true, note: `${currentCount + 1}/${maxAcceptances}` });
  }

  log("repo-name", { ok: true, note: targetRepo });

  // 8. Record acceptance
  await mkdir(acceptDir, { recursive: true });
  // A team switch falls through the idempotency check above (it has work to do),
  // so it reaches here with an existing record - and rewriting accepted_at with
  // `now` moved a student's acceptance time forward every time they changed
  // team. That timestamp is what says whether they accepted before the
  // deadline, so it is the original or nothing.
  let acceptedAt = now.toISOString();
  if (existsSync(acceptFile)) {
    try {
      const prior = JSON.parse(await readFile(acceptFile, "utf-8"));
      if (typeof prior.accepted_at === "string" && prior.accepted_at) acceptedAt = prior.accepted_at;
    } catch {
      // Unreadable prior record - `now` is the best we have.
    }
  }
  const record = {
    schema_version: 1,
    assignment_id: assignmentId,
    github_login: login,
    github_id: Number(githubId),
    accepted_at: acceptedAt,
    star_event_ref: workflowRunUrl || null,
    status: "accepted",
    ...(isGroup ? { team_slug: teamSlug, team_name: teamName } : {}),
  };
  await writeFile(acceptFile, JSON.stringify(record, null, 2) + "\n");
  log("record", { ok: true, note: `wrote ${acceptFile}` });

  // 9. Set outputs
  await setOutput("assignment_id", assignmentId);
  await setOutput("github_login", login);
  await setOutput("github_id", githubId);
  await setOutput("outcome", "accepted");
  await setOutput("target_repo", targetRepo);
  await setOutput("team_slug", teamSlug);
  await setOutput("team_name", teamName);
  await setOutput("is_first_member", isFirstMember ? "true" : "false");
  await setOutput("previous_repo", previousRepo || "");
  await setOutput("template_owner", assignment.template.owner);
  await setOutput("template_repo", assignment.template.repository);
  await setOutput("feedback_pr", assignment.feedback_pr === true ? "true" : "false");
  await setOutput("feedback_pr_baseline_branch", assignment.feedback_pr_baseline_branch || "pxl-baseline");

  await summary(
    `### Acceptance: \`accepted\`\n\n` +
      `| field | value |\n|---|---|\n` +
      `| assignment | ${assignmentId} |\n| student | ${login} (id ${githubId}) |\n` +
      `| repo | ${org}/${targetRepo} |\n` +
      (isGroup ? `| team | ${teamName} (${teamSlug}) |\n` : "") +
      `| time | ${now.toISOString()} |\n`
  );
  log("done", { ok: true, note: "accepted" });
}

// True when nobody in this team has an acceptance record yet - i.e. this
// acceptance is the one that brings the team into existence, and the one
// provisioning will create the repository for.
async function isFirstAcceptanceInTeam(dataDir, assignmentId, members, login) {
  const acceptDir = join(dataDir, "acceptances", assignmentId);
  if (!existsSync(acceptDir)) return true;
  const me = login.toLowerCase();
  for (const member of members || []) {
    if (String(member).toLowerCase() === me) continue;
    if (existsSync(join(acceptDir, `${member}.json`))) return false;
  }
  return true;
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function deriveRepoName(pattern, teamSlugOrLogin, login) {
  if (!pattern) return teamSlugOrLogin;
  return pattern
    .replace("{team_slug}", teamSlugOrLogin)
    .replace("{github_login}", login || teamSlugOrLogin);
}

main().catch(async (e) => {
  await fail("fail:exception", e.message);
});
