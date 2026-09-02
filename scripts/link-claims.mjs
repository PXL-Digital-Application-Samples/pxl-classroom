#!/usr/bin/env node
// Fold GitHub-VERIFIED claims into the roster, unattended.
//
// Under `roster_mode: claim` a student proves an institutional address, and the
// binding lands in `students/claims/<github_id>.json` - one file per student,
// never an edit to roster.yml, because acceptance is concurrent and two
// students accepting at once would clobber one shared file. The roster row
// therefore still says `github_login: null` afterwards, and making the binding
// permanent was a CLI command a lecturer had to know about and run.
//
// This removes that step for the case that needs no judgement. It runs inside
// the nightly, which is already serialised and already commits to the control
// repo, so it adds no workflow and no Actions minutes of its own.
//
// WHAT IT WILL NOT TOUCH, and this is the whole reason it is safe:
//
//   * a claim GitHub did not verify - the student typed the address rather than
//     confirming one already on their account. lib/claim.mjs: "Someone with a
//     shared link and a made-up address is always false."
//   * a claim naming a different account than the roster row already holds
//   * an address claimed by more than one account
//
// Each of those is a decision, and there is nobody here to make it. They are
// left exactly as they are, counted, and reported for a human.
//
// Exits 0 whether or not it changed anything: nothing here is a failure, and a
// red nightly over "one address needs a look" would train people to ignore it.

import { readFile, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

// Serialised by the library, never concatenated (CLAUDE.md) - and the same
// `stringify` the CLI writes this file with, so a nightly commit and a
// `pxl-classroom roster` commit produce the same bytes rather than a diff that
// is only formatting.
import { stringify as yamlStringify } from "yaml";
import { loadYaml } from "../lib/yaml.mjs";
import { ROSTER_PATH } from "../lib/roster-entries.mjs";
import { planClaimPromotion } from "../lib/promote-roster.mjs";

function arg(name, fallback = "") {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const dataDir = arg("data-dir", "control");
const dryRun = process.argv.includes("--dry-run");

async function readClaims(dir) {
  const claimsDir = join(dir, "students", "claims");
  if (!existsSync(claimsDir)) return [];
  const out = [];
  for (const file of await readdir(claimsDir)) {
    if (!file.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(await readFile(join(claimsDir, file), "utf8")));
    } catch (e) {
      // Unreadable is not evidence of nothing. Say so and carry on - one bad
      // file must not stop every other student being linked.
      process.stdout.write(`  ! ${file} could not be read (${e.message}) - skipped\n`);
    }
  }
  return out;
}

async function main() {
  const rosterPath = join(dataDir, ROSTER_PATH);
  if (!existsSync(rosterPath)) {
    process.stdout.write("link-claims: no roster - nothing to link into.\n");
    return;
  }

  const claims = await readClaims(dataDir);
  if (claims.length === 0) {
    process.stdout.write("link-claims: no claims recorded.\n");
    return;
  }

  const roster = await loadYaml(rosterPath);
  const plan = planClaimPromotion({
    claims,
    roster,
    actor: "nightly",
    verifiedOnly: true,
  });

  if (!plan.ok) {
    for (const e of plan.errors || []) process.stdout.write(`  ! ${e.message}\n`);
    process.stdout.write("link-claims: nothing written.\n");
    return;
  }

  const { updated, unverified, conflicts, ambiguous } = plan;
  const held = unverified.length + conflicts.length + ambiguous.length;

  if (updated.length === 0) {
    process.stdout.write(`link-claims: nothing to link${held ? `, ${held} waiting for review` : ""}.\n`);
  } else if (dryRun) {
    process.stdout.write(`link-claims: would link ${updated.length} student(s) (--dry-run).\n`);
  } else {
    await writeFile(rosterPath, yamlStringify(plan.nextRoster), "utf8");
    process.stdout.write(`link-claims: linked ${updated.length} student(s).\n`);
    for (const s of updated) process.stdout.write(`    ${s.email} -> @${s.github_login}\n`);
  }

  // Held cases are the output a lecturer acts on, so name them rather than
  // only counting them.
  for (const w of plan.warnings || []) process.stdout.write(`  - ${w.message}\n`);
}

main().catch((err) => {
  // Still not a failure of the nightly: collection, lockdown and reporting are
  // what it exists to do, and none of them depend on this.
  process.stdout.write(`link-claims: skipped (${err.message}).\n`);
});
