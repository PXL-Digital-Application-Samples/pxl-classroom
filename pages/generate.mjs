#!/usr/bin/env node
// PXL Classroom - public Pages data generator.
//
// Reads assignment definitions from the control repo and produces a public
// metadata JSON file containing ONLY public assignment information.
// No roster data, no per-student data, no tokens, no private repo URLs.
//
// Output shape matches spikes/06-pages-privacy/public-sample.json.
// The privacy scanner (scan.mjs) gates deployment.
//
// Inputs via env: DATA_DIR, OUTPUT_DIR
// Outputs via GITHUB_OUTPUT: generated_count

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { loadYaml } from "../lib/yaml.mjs";
import { inviteFileFor } from "../lib/invite-token.mjs";

async function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT)
    await appendFile(process.env.GITHUB_OUTPUT, `${name}=${value ?? ""}\n`);
}
async function summary(md) {
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(process.env.GITHUB_STEP_SUMMARY, md + "\n");
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
      roster_mode: def.roster_mode === "open" ? "open" : "enforced",
      // Pattern is public - it's a template, not student data. SPA needs it
      // to compute the expected repo URL after acceptance (P0-10).
      repository_name_pattern: def.repository_name_pattern || `${def.id}-{github_login}`,
      // The broker repo name is public (the broker is a public repo)
      broker_repo: def.state === "published" ? `broker-${def.id}` : null,
      max_acceptances: def.max_acceptances ?? 150,
      accepted_count: acceptedCount,
      assignment_type: def.assignment_type || "individual",
      group_config: def.assignment_type === "group" ? (def.group_config || null) : undefined,
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

    const inviteFile = def.invite_token ? inviteFileFor(def.invite_token) : null;
    if (inviteFile) {
      await mkdir(join(outputDir, "i"), { recursive: true });
      await writeFile(
        join(outputDir, "i", `${inviteFile}.json`),
        JSON.stringify({ schema_version: 1, assignment: card }, null, 2) + "\n"
      );
    } else {
      // Published before signed invitations existed, or published by hand.
      // Republish mints one; until then the link cannot resolve.
      console.warn(`[warning] ${def.id} has no invite_token - no invitation file generated`);
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
        console.warn(`[warning] ${def.id} has no invite_token - no teams file generated`);
        continue;
      }
      await writeFile(
        join(publicTeamsDir, `${inviteFile}.teams.json`),
        JSON.stringify({ schema_version: 1, assignment_id: def.id, teams: publicTeams }, null, 2) + "\n"
      );
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
