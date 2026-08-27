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

import { readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { loadYaml } from "../lib/yaml.mjs";
import { normalizeRosterMode, rosterGatesAcceptance } from "../lib/roster-mode.mjs";
import { maxTeamSize as teamMaxSize } from "../lib/group-config.mjs";
import { CLAIM_DOMAINS } from "../lib/deployment.mjs";
import {
  CLAIM_REJECTIONS,
  buildClaimRecord,
  claimAttemptsExhausted,
  claimAttemptsPath,
  claimPath,
  decryptClaim,
  domainAllowed,
  normalizeEmail,
  recordFailedAttempt,
  resolveClaimDomains,
  rosterEntryForEmail,
} from "../lib/claim.mjs";

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

// --- the claim gate ----------------------------------------------------------
//
// ORDERING IS WHERE THE COST IS SAVED. Under `claim` this step is a guessing
// oracle: whoever holds the link can submit addresses, and
// firstname.lastname@student.pxl.be is enumerable. Every attempt is an issue
// and a hub workflow run, on a system whose design goal is billing zero when
// idle - so the bill from a bored student with a loop bites well before the
// identity risk does.
//
// The checks are therefore ordered cheapest-refusal-first, and the two that
// cost nothing at all come before anything is decrypted or read:
//
//   1. already claimed  - idempotent, no re-prompt, no counter touched
//   2. attempts spent   - refuse before decrypting, before reading the roster
//   3. no payload       - does NOT count; an absent claim is a stale link or a
//                         client that did not prompt, not a guess
//   4. decrypt          - counts
//   5. author mismatch  - counts; this is the replay check
//   6. domain           - counts
//   7. roster match     - counts
//   8. address taken    - counts
//
// Nothing here touches a repository. A rejected claim must never reach
// provisioning, which is the expensive half.
async function runClaimGate({ assignment, assignmentId, roster, login, githubId, dataDir, now }) {
  const claimFile = join(dataDir, claimPath(githubId));
  const attemptsFile = join(dataDir, claimAttemptsPath(githubId));
  const iso = now.toISOString();

  const readJson = async (path) => {
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch {
      // A corrupt record is not evidence. Treated as absent everywhere here:
      // an unreadable counter must never lock a student out, and an unreadable
      // binding is re-established by the claim they are making right now.
      return null;
    }
  };

  // 1. Already bound. Org-scoped, so a second assignment never re-prompts.
  const existing = await readJson(claimFile);
  if (existing?.email) {
    log("claim", { ok: true, note: `@${login} is already claimed as ${existing.email}` });
    // domainAllowed is true by construction on this path: under `claim` an
    // address outside the list never reaches a record. Stated rather than left
    // undefined so both gates return the same shape.
    return { email: existing.email, verified: Boolean(existing.claim_verified), domainAllowed: true, reused: true };
  }

  // 2. The counter, before any work at all.
  const attempts = await readJson(attemptsFile);
  if (claimAttemptsExhausted(attempts)) {
    await reject(
      CLAIM_REJECTIONS.BLOCKED,
      `too many failed attempts to confirm an email address. Ask your lecturer to reset it.`,
    );
  }

  const countFailure = async () => {
    await mkdir(join(dataDir, "students", "claim-attempts"), { recursive: true });
    await writeFile(attemptsFile, JSON.stringify(recordFailedAttempt(attempts, iso), null, 2) + "\n");
  };

  // 3. No payload at all. Deliberately does NOT count against the limit: this
  //    is a link issued before the assignment moved to `claim`, or a client
  //    that never showed the prompt, and burning a student's attempts for a
  //    deployment fault is the `no-nonce` mistake in a new place.
  const payload = env("CLAIM_PAYLOAD", "").trim();
  if (!payload) {
    await reject(
      CLAIM_REJECTIONS.NO_CLAIM,
      `this assignment needs your school email address, and the acceptance did not carry one. Open the invitation link again and confirm your address.`,
    );
  }

  const privateKey = env("CLAIM_PRIVATE_KEY", "").trim();
  if (!privateKey) {
    // A deployment fault, never the student's. Fail (red) rather than reject,
    // and do not count it: without the key NOBODY can claim, and silently
    // spending every student's attempts would turn a missing secret into a
    // cohort locked out for good.
    await fail(
      "fail:config",
      `roster_mode is claim but PXL_CLAIM_PRIVATE_KEY is not set on the hub - no claim can be decrypted. See RUNBOOK 1.3.2.`,
    );
  }

  // 4. Decrypt. Every kind of failure is one failure on purpose.
  let opened = null;
  try {
    opened = await decryptClaim({ privateKey, payload });
  } catch {
    await countFailure();
    await reject(
      CLAIM_REJECTIONS.NO_CLAIM,
      `the email address could not be read from your acceptance. Open the invitation link again and confirm your address.`,
    );
  }

  // 5. The anti-replay check. A ciphertext copied out of the public event
  //    archive still decrypts - the hub holds the key - but it names the
  //    account it was minted for.
  if (opened.githubId !== githubId) {
    await countFailure();
    await reject(
      CLAIM_REJECTIONS.NO_CLAIM,
      `the confirmation did not come from this GitHub account. Open the invitation link again while signed in as @${login}.`,
    );
  }

  // 6. Domain. Absent claim_domains means the deployment default; an explicit
  //    [] means the lecturer opted out.
  const domains = resolveClaimDomains(assignment, CLAIM_DOMAINS);
  if (!domainAllowed(opened.email, domains)) {
    await countFailure();
    await reject(
      CLAIM_REJECTIONS.DOMAIN,
      `${opened.email} is not an accepted address for this assignment. Use your ${domains.join(" or ")} address.`,
    );
  }

  // 7. The roster IS the gate here - a fabricated address matches nothing.
  const entry = rosterEntryForEmail(roster, opened.email);
  if (!entry) {
    await countFailure();
    await reject(
      CLAIM_REJECTIONS.NO_MATCH,
      `${opened.email} is not on the roster for this course. Check the address, or ask your lecturer which one they registered.`,
    );
  }

  // 8. First come wins, and the real student complaining is the detector.
  const taken = await findClaimForEmail(dataDir, opened.email, githubId);
  if (taken) {
    await countFailure();
    await reject(
      CLAIM_REJECTIONS.TAKEN,
      `${opened.email} has already been claimed by another GitHub account. If that was not you, tell your lecturer - they can unlink it.`,
    );
  }

  // Bound. The counter is deleted rather than zeroed: an absent file and a
  // zeroed one read identically, and one fewer file is one fewer thing to
  // explain in the control repo.
  const record = buildClaimRecord({
    githubLogin: login,
    githubId,
    email: opened.email,
    // Client-supplied and NOT verifiable here - the hub cannot read a user's
    // email addresses, the same wall that killed org_member. Recorded as
    // evidence: the ordinary path sets it truthfully because the page lists
    // the student's own GitHub-verified addresses, and anyone crafting an
    // issue by hand can assert it. What it buys is that a cohort review can
    // see which bindings GitHub had already vouched for.
    claimVerified: env("CLAIM_VERIFIED", "") === "true",
    studentNumber: entry.student_number ?? null,
    assignmentId,
    now: iso,
  });
  await mkdir(join(dataDir, "students", "claims"), { recursive: true });
  await writeFile(claimFile, JSON.stringify(record, null, 2) + "\n");
  if (existsSync(attemptsFile)) await rm(attemptsFile);

  log("claim", {
    ok: true,
    note: `@${login} claimed ${opened.email}${entry.student_number ? ` (${entry.student_number})` : ""}, verified=${record.claim_verified}`,
  });
  return { email: opened.email, verified: record.claim_verified, domainAllowed: true, reused: false };
}

// --- the claim under `open` --------------------------------------------------
//
// OBSERVATION, NOT A GATE. Nothing in here refuses an acceptance and nothing
// counts against the attempt limit. `open` means anyone with the link and a
// seat inside the window gets a repository, and that does not change because
// they also told us an address.
//
// It has to work that way rather than as a matter of taste: the claim is
// OPTIONAL here. A link handed out before the assignment moved to `open`, a
// browser without WebCrypto, a student who dismissed the prompt - all must
// still get a repository. So anyone determined to take a second one simply
// omits the claim, which means the uniqueness check cannot be prevention. What
// it can be, and is, is ACCOUNTING: two accounts holding one address show up as
// a duplicate, and acceptances with no claim at all show up as a count. Both
// are review signals for a lecturer reading an exam cohort afterwards.
//
// ARCHITECTURE §16 overstated this while it was still a plan - it said the
// uniqueness check "would stop one person quietly taking several exam
// repositories". Writing it showed that it cannot, for the reason above, and
// the entry has been corrected rather than the code bent to match it.
//
// There is also no guessing oracle to defend here, which is why no attempt is
// counted: under `claim` a refusal tells the guesser whether an address is on
// the roster, and under `open` nothing is refused, so nothing is revealed.
async function observeOpenClaim({ assignment, assignmentId, roster, login, githubId, dataDir, now }) {
  const claimFile = join(dataDir, claimPath(githubId));
  const iso = now.toISOString();

  const readJson = async (path) => {
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch {
      return null;
    }
  };

  // Org-scoped, exactly as under `claim`: a student who bound on an earlier
  // assignment is not asked again.
  const existing = await readJson(claimFile);
  if (existing?.email) {
    log("claim", { ok: true, note: `@${login} is already bound to ${existing.email}` });
    return {
      email: existing.email,
      verified: Boolean(existing.claim_verified),
      domainAllowed: existing.domain_allowed !== false,
      reused: true,
    };
  }

  const payload = env("CLAIM_PAYLOAD", "").trim();
  if (!payload) {
    log("claim", { ok: true, note: "no address confirmed - open enrolment does not require one" });
    return null;
  }

  // A missing key is a deployment fault under `claim` and fails the run there,
  // because nobody could claim at all. Here it must NOT fail: the claim is a
  // review aid, and losing it is not worth refusing a student their repository.
  const privateKey = env("CLAIM_PRIVATE_KEY", "").trim();
  if (!privateKey) {
    log("claim", { ok: true, note: "PXL_CLAIM_PRIVATE_KEY is not set - address not recorded (see RUNBOOK 1.3.2)" });
    return null;
  }

  let opened = null;
  try {
    opened = await decryptClaim({ privateKey, payload });
  } catch {
    log("claim", { ok: true, note: "the confirmed address could not be read - not recorded" });
    return null;
  }

  // The anti-replay check is kept even though nothing is being gated, because
  // the OUTPUT is a record saying "this account is this person". Binding an
  // account to an address it did not sign for would write a false one, and a
  // false record is worse than no record.
  if (opened.githubId !== githubId) {
    log("claim", { ok: true, note: `the confirmation names another account - not recorded` });
    return null;
  }

  // Detection, not prevention: recorded either way, and the report is where a
  // lecturer sees it.
  const domains = resolveClaimDomains(assignment, CLAIM_DOMAINS);
  const domainOk = domainAllowed(opened.email, domains);

  // A roster is optional under `open` but often present - it stops deciding who
  // may accept without stopping being a roster. When the address is on it, the
  // student number comes along; when it is not, that is not an error here.
  const entry = rosterEntryForEmail(roster, opened.email);

  // Deliberately NOT refused when another account already holds this address.
  // The second record is written under its own github_id, so both survive and
  // lib/claim-bindings.mjs reports them as a duplicate - which is the accounting
  // this exists for. Refusing would be a gate, and a bypassable one.
  const taken = await findClaimForEmail(dataDir, opened.email, githubId);

  const record = buildClaimRecord({
    githubLogin: login,
    githubId,
    email: opened.email,
    claimVerified: env("CLAIM_VERIFIED", "") === "true",
    studentNumber: entry?.student_number ?? null,
    assignmentId,
    now: iso,
    domainAllowed: domainOk,
  });
  await mkdir(join(dataDir, "students", "claims"), { recursive: true });
  await writeFile(claimFile, JSON.stringify(record, null, 2) + "\n");

  log("claim", {
    ok: true,
    note:
      `@${login} confirmed ${opened.email}` +
      `${domainOk ? "" : " (OUTSIDE the allowed domains)"}` +
      `${taken ? ` (ALSO held by @${taken.github_login})` : ""}` +
      `${entry?.student_number ? ` (${entry.student_number})` : ""}` +
      `, verified=${record.claim_verified}`,
  });
  return { email: opened.email, verified: record.claim_verified, domainAllowed: domainOk, reused: false };
}

/** Is this address already bound to a DIFFERENT account? */
async function findClaimForEmail(dataDir, email, exceptGithubId) {
  const dir = join(dataDir, "students", "claims");
  if (!existsSync(dir)) return null;
  for (const name of await readdir(dir)) {
    if (!name.endsWith(".json")) continue;
    if (name === `${exceptGithubId}.json`) continue;
    try {
      const rec = JSON.parse(await readFile(join(dir, name), "utf8"));
      if (normalizeEmail(rec?.email) === email) return rec;
    } catch {
      // A record we cannot read cannot be shown to hold this address. It is
      // reported by the orphan diagnostic rather than silently blocking a
      // student who has done nothing wrong.
    }
  }
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
  const rosterMode = normalizeRosterMode(assignment.roster_mode);
  let claimResult = null;
  let roster = null;
  const rosterPath = join(dataDir, "students", "roster.yml");
  if (existsSync(rosterPath)) {
    try {
      roster = await loadYaml(rosterPath);
    } catch (err) {
      // Only `enforced` is stopped by an unreadable roster, because only there
      // is the roster the gate. Under `open` the file is read for team
      // pre-assignment columns; losing that is a degraded group resolution, not
      // grounds to refuse every student in the cohort.
      if (rosterGatesAcceptance(rosterMode)) {
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
    // The claim runs here too, but only to WRITE DOWN what it learns. See
    // observeOpenClaim: it never refuses and never counts an attempt, because
    // the claim is optional under `open` and a check anyone can skip is not a
    // gate.
    claimResult = await observeOpenClaim({
      assignment, assignmentId, roster, login, githubId: Number(githubId), dataDir, now,
    });
  } else if (rosterMode === "claim") {
    if (!roster) {
      await reject("rejected:no-roster", `roster file not found: ${rosterPath}`);
    }
    claimResult = await runClaimGate({
      assignment, assignmentId, roster, login, githubId: Number(githubId), dataDir, now,
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
    const maxTeamSize = teamMaxSize(assignment.group_config);

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

  // 7. Check per-assignment cap.
  //
  // A GUARDRAIL, NOT A HARD LIMIT, AND DELIBERATELY SO. Read this before
  // "fixing" it.
  //
  // The count below is read, compared, and then written to - a textbook
  // check-then-act. The acceptance concurrency group is
  // `accept-<org>-<id>-<team_hint || github_login>`, so acceptances by
  // DIFFERENT students are not serialized against each other: two students
  // arriving together both read 49, both see 49 < 50, and both write. The cap
  // can therefore overshoot by roughly the number of acceptances in flight at
  // once.
  //
  // Closing it means keying the concurrency group on the assignment instead of
  // the student, which serializes every acceptance for that assignment. A
  // 200-student cohort accepting in the first minutes of a lecture would then
  // run one at a time - roughly 30s each - on a system whose whole design goal
  // is billing zero minutes when idle (Wave 8). The overshoot is a handful of
  // repositories; the cure is an hour of queued runners and a room full of
  // students watching a spinner.
  //
  // Decided 2026-08-24: leave it. The cap exists to stop an unbounded link
  // being farmed, and it does that. It is not an exam-seat allocator. Nothing
  // in the UI may describe it as exact (C4) - see ARCHITECTURE §5.4.
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
        // NOT "queued for lecturer review". Nothing queues a rejected
        // acceptance and nothing retries one: Wave 8 removed the queue entirely
        // in favour of synchronous provisioning, and no code anywhere reads a
        // cap-reached rejection afterwards. This string is what lands in the
        // org's instructor tracking issue, so promising a queue leaves a
        // lecturer waiting for something that will never happen instead of
        // raising the cap.
        `per-assignment cap reached (${currentCount}/${maxAcceptances}). Nothing is held or retried automatically - raise the cap on the assignment, then the student can accept again.`
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
    // Only under `claim`. Written here as well as in students/claims/<id>.json
    // because the two answer different questions: the claim file is the
    // ORG-SCOPED binding ("who is this account"), and this is what THIS
    // acceptance was admitted on. They can legitimately differ later - a
    // lecturer unlinks and the student rebinds - and a report that silently
    // rewrote history would lose which address let them in at the time.
    //
    // The address is not secret from the lecturer; it is the thing they asked
    // for. It must never reach Pages, which pages/scan.mjs already enforces:
    // PUBLIC_TEXT_RULES carries an email-address rule that matches content
    // anywhere in a generated artefact.
    ...(claimResult
      ? {
          claimed_email: claimResult.email,
          claim_verified: claimResult.verified,
          // Under `claim` this is always true - a failing domain never gets
          // this far. Under `open` it is the detection half of the feature, and
          // the only place a lecturer can see that somebody enrolled with an
          // address the assignment does not recognise.
          claim_domain_allowed: claimResult.domainAllowed !== false,
        }
      : {}),
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
