#!/usr/bin/env node
// PXL Classroom - public Pages data generator.
//
// Reads assignment definitions from the control repo and produces a public
// metadata JSON file containing ONLY public assignment information.
// No roster data, no per-student data, no tokens, no private repo URLs.
//
// The privacy scanner (scan.mjs) gates deployment: it fails the publish on
// anything matching the token wire shape or a private field name.
//
// Inputs via env: DATA_DIR, OUTPUT_DIR
// Outputs via GITHUB_OUTPUT: generated_count

import { readdir, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { loadYaml } from "../lib/yaml.mjs";
import { normalizeRosterMode } from "../lib/roster-mode.mjs";
import { inviteFileFor } from "../lib/invite-token.mjs";
import { linkSecretFrom } from "../lib/invite-token-format.mjs";
import { findPublicTextViolation, publicTextMessage } from "../lib/public-text.mjs";

async function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT)
    await appendFile(process.env.GITHUB_OUTPUT, `${name}=${value ?? ""}\n`);
}
async function summary(md) {
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(process.env.GITHUB_STEP_SUMMARY, md + "\n");
}

// Assignments get deleted, closed, or reverted to draft. Without pruning, the
// acceptance card of one that no longer exists stays fetchable on a public site
// for anyone who kept the link - and for a group assignment the teams file
// beside it lists member logins. Found by a live run: deleting a test
// assignment left its card behind.
//
// `git add public/` stages deletions, so removing the file here is enough for
// regenerate-dashboard.yml to publish the removal.
//
// But a card at a digest we no longer publish is not always rubbish. It is
// usually a link that just stopped working - `regenerate_invite` minted a fresh
// keypair, or the assignment migrated - and the student holding it did nothing
// wrong. Deleting it sends them to the not-found page, whose only honest
// wording is a guess between three causes.
//
// The card names its own assignment, so the generator can tell the difference
// without being told: if that assignment is still being published, the file
// becomes a superseded marker instead of disappearing. That is what makes
// rotation as survivable as migration, and it needs no record of retired
// secrets anywhere - which is the point, because a list of them on the
// assignment would be one more field `buildDoc` could silently drop.
/**
 * Turn an unexpected invitation file into a superseded marker, or say no.
 *
 * @returns true when the file was kept (as a marker), false to let the caller
 *          prune it.
 */
async function retireInvitationFile(inviteDir, name, liveAssignmentIds) {
  // A teams file is the cohort by another name (§4.3.3). A superseded link must
  // not be able to fetch one, so these are always pruned, never retired.
  if (!name.endsWith(".json") || name.endsWith(".teams.json")) return false;

  let doc;
  try {
    doc = JSON.parse(await readFile(join(inviteDir, name), "utf8"));
  } catch {
    return false;
  }

  // Already a marker from an earlier run. Keep it while its assignment is still
  // published, so the wording survives repeated regenerations - and let it be
  // pruned once the assignment is gone, or these would accumulate forever.
  if (doc?.superseded) return liveAssignmentIds.has(doc.assignment_id);

  const assignment = doc?.assignment;
  if (!assignment?.id || !liveAssignmentIds.has(assignment.id)) return false;

  await writeFile(
    join(inviteDir, name),
    JSON.stringify(
      {
        schema_version: 1,
        superseded: true,
        assignment_id: assignment.id,
        title: assignment.title,
        organization: assignment.organization,
      },
      null,
      2
    ) + "\n"
  );
  console.log(`[ok] Retired invitation file ${name} - the link it served no longer opens this assignment`);
  return true;
}

async function pruneStalePublicFiles(outputDir, expected, liveAssignmentIds) {
  const inviteDir = join(outputDir, "i");
  if (existsSync(inviteDir)) {
    for (const name of await readdir(inviteDir)) {
      if (expected.has(name)) continue;
      if (await retireInvitationFile(inviteDir, name, liveAssignmentIds)) continue;
      await rm(join(inviteDir, name), { force: true });
      console.log(`[ok] Pruned stale invitation file ${name}`);
    }
  }
  // public/teams/ predates the move behind the invitation digest. Anything
  // still there is a public cohort list for an assignment that no longer
  // publishes one.
  const legacyTeams = join(outputDir, "teams");
  if (existsSync(legacyTeams)) {
    await rm(legacyTeams, { recursive: true, force: true });
    console.log("[ok] Removed legacy public/teams - teams now live behind the invitation digest");
  }
}

async function main() {
  const dataDir = process.env.DATA_DIR || ".";
  const outputDir = process.env.OUTPUT_DIR || "public";

  await mkdir(outputDir, { recursive: true });

  const assignmentsDir = join(dataDir, "assignments");
  if (!existsSync(assignmentsDir)) {
    console.log("[ok] No assignments directory - generating empty output");
    const output = {
      schema_version: 1,
      generated_at: new Date().toISOString(),
      assignments: {},
    };
    await writeFile(join(outputDir, "assignments.json"), JSON.stringify(output, null, 2) + "\n");
    await setOutput("generated_count", "0");
    return;
  }

  const files = (await readdir(assignmentsDir)).filter((f) => f.endsWith(".yml"));
  const assignments = {};
  const expectedInviteFiles = new Set();

  for (const file of files) {
    const def = await loadYaml(join(assignmentsDir, file));

    // Only include published or closed assignments in public output
    if (def.state !== "published" && def.state !== "closed") continue;

    let acceptedCount = 0;
    const acceptancesDir = join(dataDir, "acceptances", def.id);
    if (existsSync(acceptancesDir)) {
      try {
        const accFiles = await readdir(acceptancesDir);
        acceptedCount = accFiles.filter((f) => f.endsWith(".json")).length;
      } catch (e) {
        console.error(`Error reading acceptances for ${def.id}:`, e.message);
      }
    }

    // Say which assignment, and which field, before the scanner sees a
    // digest-named file and reports a rule id.
    //
    // The scanner is a publish gate over generated output, so when a lecturer
    // wrote "Questions? Mail <address>" into a description it blocked the
    // publish with a message naming public/i/<64 hex>.json and [email-address].
    // The generate step failed, the org's whole dashboard regeneration failed
    // with it, and the site redeployed with stale data - for a sentence that
    // the Admin Panel had accepted without comment.
    for (const [field, value] of [["title", def.title], ["description", def.description]]) {
      const violation = findPublicTextViolation(value);
      if (violation) {
        throw new Error(
          `assignments/${file}: ${publicTextMessage(field, violation)} ` +
            `Edit it in the Admin Panel, or in assignments/${file} directly, then republish.`
        );
      }
    }

    // Extract ONLY public metadata - no roster, no repo URLs, no tokens
    const card = {
      id: def.id,
      title: def.title,
      description: def.description || null,
      organization: def.organization,
      state: def.state,
      opens_at: def.opens_at,
      deadline_at: def.deadline_at,
      timezone: def.timezone || "Europe/Brussels",
      acceptance_mode: def.acceptance_mode || "self-service",
      // Policy flag, not student data - the SPA uses it to explain accurately
      // why an acceptance may not complete. Never carries roster contents.
      roster_mode: normalizeRosterMode(def.roster_mode),
      // Pattern is public - it's a template, not student data. SPA needs it
      // to compute the expected repo URL after acceptance (P0-10).
      repository_name_pattern: def.repository_name_pattern || `${def.id}-{github_login}`,
      // The broker repo name is public (the broker is a public repo)
      broker_repo: def.state === "published" ? `broker-${def.id}` : null,
      // No cap means NO cap. `accept.mjs` reads `if (maxAcceptances && ...)`,
      // so an absent value is unlimited there - publishing `?? 150` invented a
      // limit the assignment does not have, and `AssignmentView` then refused
      // student 151 an acceptance the server would have granted.
      max_acceptances: def.max_acceptances ?? null,
      accepted_count: acceptedCount,
      assignment_type: def.assignment_type || "individual",
      group_config: def.assignment_type === "group" ? (def.group_config || null) : undefined,
      // The student's browser filters their own verified addresses by this and
      // refuses one outside it before sealing. Without it the page fell back to
      // the deployment default and enforced THAT: a lecturer who set
      // `claim_domains: ["howest.be"]` had students refused at the button for
      // an address the hub would have accepted, and one who set `[]` to lift
      // the restriction still had the defaults imposed on them.
      //
      // ABSENT and EMPTY stay different answers on the wire, exactly as in the
      // YAML: an array is published verbatim (including `[]`, the deliberate
      // opt-out) and an absent key is OMITTED, so the browser falls back to the
      // deployment default rather than to "no restriction".
      //
      // These are domains, not addresses - public by nature, and the scanner's
      // email-address rule needs an `@`, so a bare domain cannot trip it.
      claim_domains: Array.isArray(def.claim_domains) ? def.claim_domains : undefined,
    };

    // The full card is published under the DIGEST of the invitation token, so
    // fetching it requires the link. The org-wide index below keeps only the
    // fields the student portal needs to match a student's own repositories to
    // an assignment - students cannot read the control repo, so that list has
    // nowhere else to come from (ARCHITECTURE §4.3.3).
    assignments[def.id] = {
      id: card.id,
      title: card.title,
      organization: card.organization,
      opens_at: card.opens_at,
      deadline_at: card.deadline_at,
      timezone: card.timezone,
      repository_name_pattern: card.repository_name_pattern,
      assignment_type: card.assignment_type,
      // The lecturer dashboard's org status lights read this across every org
      // at zero API cost. It adds nothing an outsider could not infer from
      // opens_at and deadline_at, which the portal needs anyway.
      state: card.state,
    };

    // Which of the two secrets is the link is decided in ONE place, shared with
    // the Admin Panel and the diagnostic engine. A copy of that rule here would
    // be a 404 for every student the first time the three disagreed.
    const linkSecret = linkSecretFrom(def);
    const inviteFile = linkSecret ? inviteFileFor(linkSecret) : null;
    if (inviteFile) {
      await mkdir(join(outputDir, "i"), { recursive: true });
      await writeFile(
        join(outputDir, "i", `${inviteFile}.json`),
        JSON.stringify({ schema_version: 1, assignment: card }, null, 2) + "\n"
      );
      expectedInviteFiles.add(`${inviteFile}.json`);
    } else {
      // Published before signed invitations existed, or published by hand.
      // Republish mints one; until then the link cannot resolve.
      console.warn(`[warning] ${def.id} has no invitation secret - no invitation file generated`);
    }

    // The link a student was handed BEFORE this assignment migrated to signed
    // acceptance is now dead: the broker has INVITE_PUBKEY, so it refuses a
    // legacy `pxl-accept:<token>` title outright. Pruning that card would leave
    // the student on a page whose only honest answer is a guess - "it may be
    // out of date, incomplete, or not open yet". A page may not guess (the same
    // rule that governs the provisioning wait screen), so the old digest keeps
    // resolving, to a document that states the fact.
    //
    // Deliberately NOT nested under `assignment`: a browser holding a cached
    // build from before this existed reads `data.assignment.id`, finds nothing,
    // and falls through to its own not-found state rather than rendering an
    // assignment with no deadline and no state.
    // Phrased as "a secret that is no longer the link", not as "has both
    // fields", so it tracks linkSecretFrom rather than restating it. On an
    // assignment that has NOT migrated the token IS the link, and the two
    // spellings differ exactly there: this writes nothing, where a both-fields
    // test would replace that cohort's only working card with a tombstone.
    const supersededSecret =
      def.invite_token && def.invite_token !== linkSecret ? def.invite_token : null;
    if (supersededSecret) {
      const supersededFile = inviteFileFor(supersededSecret);
      await mkdir(join(outputDir, "i"), { recursive: true });
      await writeFile(
        join(outputDir, "i", `${supersededFile}.json`),
        JSON.stringify(
          {
            schema_version: 1,
            superseded: true,
            // All three are already in assignments.json, so naming the
            // assignment here discloses nothing new - and without them the page
            // cannot say WHICH link went out of date, which is the one thing a
            // student needs in order to ask for the right replacement.
            assignment_id: def.id,
            title: def.title,
            organization: def.organization,
          },
          null,
          2
        ) + "\n"
      );
      expectedInviteFiles.add(`${supersededFile}.json`);
    }

    // If group assignment, also generate sanitized public teams file
    if (def.assignment_type === "group") {
      const teamsDir = join(dataDir, "teams", def.id);
      // Behind the invitation digest too: the public teams file lists member
      // logins, so it is the cohort by another name.
      const publicTeamsDir = join(outputDir, "i");
      await mkdir(publicTeamsDir, { recursive: true });
      const publicTeams = [];

      if (existsSync(teamsDir)) {
        const teamFiles = (await readdir(teamsDir)).filter((f) => f.endsWith(".json"));
        for (const tf of teamFiles) {
          try {
            const tdata = JSON.parse(await readFile(join(teamsDir, tf), "utf-8"));
            if (!tdata.vacant) {
              const maxMem = tdata.max_members || def.group_config?.max_team_size || 3;
              publicTeams.push({
                team_slug: tdata.team_slug,
                team_name: tdata.team_name,
                members: tdata.members || [],
                member_count: (tdata.members || []).length,
                max_members: maxMem,
                is_full: (tdata.members || []).length >= maxMem,
                // Provenance only - the source assignment's id and title are
                // already public. Never the lecturer login or the seed time.
                ...(tdata.seeded_from
                  ? {
                      seeded_from: {
                        source: tdata.seeded_from.source,
                        ...(tdata.seeded_from.assignment_id
                          ? { assignment_id: tdata.seeded_from.assignment_id }
                          : {}),
                        ...(tdata.seeded_from.assignment_title
                          ? { assignment_title: tdata.seeded_from.assignment_title }
                          : {}),
                      },
                    }
                  : {}),
              });
            }
          } catch {}
        }
      }

      if (!inviteFile) {
        console.warn(`[warning] ${def.id} has no invitation secret - no teams file generated`);
        continue;
      }
      await writeFile(
        join(publicTeamsDir, `${inviteFile}.teams.json`),
        JSON.stringify({ schema_version: 1, assignment_id: def.id, teams: publicTeams }, null, 2) + "\n"
      );
      expectedInviteFiles.add(`${inviteFile}.teams.json`);
    }
  }

  const output = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    assignments,
  };

  await writeFile(
    join(outputDir, "assignments.json"),
    JSON.stringify(output, null, 2) + "\n"
  );

  // Only the assignments this run actually published. An orphaned card for one
  // that has been archived or deleted is pruned as before; one for an
  // assignment still on the site is a retired link, and keeps a page to land on.
  await pruneStalePublicFiles(outputDir, expectedInviteFiles, new Set(Object.keys(assignments)));

  const count = Object.keys(assignments).length;
  await setOutput("generated_count", String(count));
  await summary(
    `### Pages generation\n\n` +
      `Generated \`assignments.json\` with ${count} assignment(s).\n`
  );
  console.log(`[ok] Generated ${count} assignment(s) to ${outputDir}/assignments.json`);
}

main().catch((e) => {
  console.error(`[FAIL] ${e.message}`);
  process.exit(1);
});
