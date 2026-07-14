#!/usr/bin/env node
// PXL Classroom — public Pages data generator.
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
    console.log("[ok] No assignments directory — generating empty output");
    const output = {
      schema_version: 1,
      generated_at: new Date().toISOString(),
      assignments: [],
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

    // Extract ONLY public metadata — no roster, no repo URLs, no tokens
    assignments[def.id] = {
      id: def.id,
      title: def.title,
      description: def.description || null,
      organization: def.organization,
      state: def.state,
      opens_at: def.opens_at,
      deadline_at: def.deadline_at,
      timezone: def.timezone || "Europe/Brussels",
      acceptance_mode: def.acceptance_mode || "self-service",
      // Pattern is public — it's a template, not student data. SPA needs it
      // to compute the expected repo URL after acceptance (P0-10).
      repository_name_pattern: def.repository_name_pattern || `${def.id}-{github_login}`,
      // The broker repo name is public (the broker is a public repo)
      broker_repo: def.state === "published" ? `broker-${def.id}` : null,
    };
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

  await setOutput("generated_count", String(assignments.length));
  await summary(
    `### Pages generation\n\n` +
      `Generated \`assignments.json\` with ${assignments.length} assignment(s).\n`
  );
  console.log(`[ok] Generated ${assignments.length} assignment(s) to ${outputDir}/assignments.json`);
}

main().catch((e) => {
  console.error(`[FAIL] ${e.message}`);
  process.exit(1);
});
