// PXL Classroom CLI — `roster` subcommand group.
//
// import   — read a CSV, validate against roster.schema.json, diff vs. the
//            committed roster, and commit (or just preview with --dry-run).
// list     — print the committed roster.
//
// CSV columns match the roster.schema.json field names directly:
//   student_number (required)
//   full_name      (required)
//   email          (optional)
//   class_group    (optional)
//   github_login   (optional)
//   github_id      (optional integer)
//   active         (optional boolean, default true)

import { Command } from "commander";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import Papa from "papaparse";
import { stringify as yamlStringify, parse as yamlParse } from "yaml";
import { makeOctokit } from "../lib/octokit.mjs";
import { commitWithRebase } from "../lib/gittree.mjs";
import { validateAgainst } from "../lib/validate.mjs";
import { saveConfig, loadConfig } from "../lib/config.mjs";
import { stableStringify } from "../lib/stable.mjs";
import { resolveOrg } from "../lib/org.mjs";

const CONTROL_REPO = "pxl-classroom-control";
const ROSTER_PATH = "students/roster.yml";



// Coerce a single CSV cell into the JSON value expected by the schema.
// Empty cells are dropped (undefined) so optional fields stay absent.
function coerceCell(field, raw) {
  if (raw === undefined || raw === null) return undefined;
  const v = String(raw).trim();
  if (v === "") return undefined;
  if (field === "github_id") {
    const n = Number(v);
    if (!Number.isInteger(n)) throw new Error(`github_id must be an integer, got "${v}"`);
    return n;
  }
  if (field === "active") {
    if (/^(true|1|yes|y)$/i.test(v)) return true;
    if (/^(false|0|no|n)$/i.test(v)) return false;
    throw new Error(`active must be boolean-ish (true|false|1|0|yes|no), got "${v}"`);
  }
  return v;
}

const KNOWN_COLUMNS = new Set([
  "student_number", "full_name", "email",
  "class_group", "github_login", "github_id", "active",
]);

function csvToRoster(csvText, filename) {
  const parsed = Papa.parse(csvText, {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (h) => h.trim(),
  });

  if (parsed.errors.length) {
    const e = parsed.errors[0];
    throw new Error(`CSV parse error at row ${e.row}: ${e.message}`);
  }

  const headers = parsed.meta.fields ?? [];
  const unknown = headers.filter((h) => !KNOWN_COLUMNS.has(h));
  if (unknown.length) {
    throw new Error(
      `unknown column(s) in ${filename}: ${unknown.join(", ")}. ` +
      `Known columns: ${[...KNOWN_COLUMNS].join(", ")}.`,
    );
  }
  for (const required of ["student_number", "full_name"]) {
    if (!headers.includes(required)) {
      throw new Error(`required CSV column missing: ${required}`);
    }
  }

  const students = [];
  const seenNumbers = new Set();
  for (let i = 0; i < parsed.data.length; i++) {
    const row = parsed.data[i];
    const lineNo = i + 2; // +1 for header, +1 for 1-based
    const entry = {};
    for (const field of KNOWN_COLUMNS) {
      try {
        const v = coerceCell(field, row[field]);
        if (v !== undefined) entry[field] = v;
      } catch (err) {
        throw new Error(`line ${lineNo} (${field}): ${err.message}`);
      }
    }
    if (!entry.student_number) throw new Error(`line ${lineNo}: student_number is required`);
    if (!entry.full_name) throw new Error(`line ${lineNo}: full_name is required`);
    if (seenNumbers.has(entry.student_number)) {
      throw new Error(`line ${lineNo}: duplicate student_number "${entry.student_number}"`);
    }
    seenNumbers.add(entry.student_number);
    students.push(entry);
  }

  return { schema_version: 2, students };
}

// Pretty-print the ajv errors so the user can find the bad row fast.
function formatAjvErrors(errors) {
  return errors
    .map((e) => `  ${e.instancePath || "/"}: ${e.message}` + (e.params?.allowedValue !== undefined ? ` (allowed: ${JSON.stringify(e.params.allowedValue)})` : ""))
    .join("\n");
}

async function fetchExistingRoster(octokit, { org }) {
  try {
    const res = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
      owner: org, repo: CONTROL_REPO, path: ROSTER_PATH,
    });
    const content = Buffer.from(res.data.content, "base64").toString("utf8");
    return { roster: yamlParse(content) || { schema_version: 2, students: [] }, sha: res.data.sha };
  } catch (err) {
    if (err.status === 404) return { roster: null, sha: null };
    throw err;
  }
}

function diffRosters(current, next) {
  const currentMap = new Map((current?.students ?? []).map((s) => [s.student_number, s]));
  const nextMap = new Map(next.students.map((s) => [s.student_number, s]));

  const added = [];
  const updated = [];
  const removed = [];

  for (const [num, entry] of nextMap) {
    const prev = currentMap.get(num);
    if (!prev) {
      added.push(entry);
    } else if (stableStringify(prev) !== stableStringify(entry)) {
      updated.push({ before: prev, after: entry });
    }
  }
  for (const [num, entry] of currentMap) {
    if (!nextMap.has(num)) removed.push(entry);
  }

  return { added, updated, removed };
}

function printDiff(diff, { org }) {
  process.stdout.write(`\nDiff for ${org}/${CONTROL_REPO}:${ROSTER_PATH}\n`);
  process.stdout.write(
    `  + added:   ${diff.added.length}\n` +
    `  ~ updated: ${diff.updated.length}\n` +
    `  - removed: ${diff.removed.length}\n`,
  );
  for (const s of diff.added) {
    process.stdout.write(`    + ${s.student_number}  ${s.full_name}${s.github_login ? ` (@${s.github_login})` : ""}\n`);
  }
  for (const u of diff.updated) {
    const changed = Object.keys(u.after).filter((k) => JSON.stringify(u.after[k]) !== JSON.stringify(u.before[k]));
    process.stdout.write(`    ~ ${u.after.student_number}  ${u.after.full_name}  [${changed.join(", ")}]\n`);
  }
  for (const s of diff.removed) {
    process.stdout.write(`    - ${s.student_number}  ${s.full_name}\n`);
  }
}

export function registerRosterCommand(program) {
  const roster = new Command("roster").description("Manage the org's student roster (students/roster.yml).");

  roster
    .command("import <csvFile>")
    .description("Import a CSV roster into the org's control repo.")
    .option("--org <login>", "GitHub org login (defaults to last used)")
    .option("--dry-run", "Validate and show diff without committing", false)
    .option("--force", "Skip the confirmation prompt when the import removes students", false)
    .action(async (csvFile, opts) => {
      const org = resolveOrg(opts.org);
      const csvText = readFileSync(csvFile, "utf8");

      const rosterDoc = csvToRoster(csvText, csvFile);
      const { valid, errors } = validateAgainst("roster", rosterDoc);
      if (!valid) {
        process.stderr.write(`Roster failed schema validation:\n${formatAjvErrors(errors)}\n`);
        process.exit(1);
      }
      process.stdout.write(`Parsed ${rosterDoc.students.length} student(s) from ${csvFile}.\n`);

      const octokit = makeOctokit();
      const { roster: existing } = await fetchExistingRoster(octokit, { org });
      const diff = diffRosters(existing, rosterDoc);
      printDiff(diff, { org });

      if (opts.dryRun) {
        process.stdout.write(`\n(--dry-run; no commit made.)\n`);
        return;
      }
      if (diff.added.length + diff.updated.length + diff.removed.length === 0) {
        process.stdout.write(`\nRoster unchanged — nothing to commit.\n`);
        return;
      }

      // Removals are the destructive part of the diff (an accidental partial
      // CSV wipes everyone not in it) — same confirmation the Admin Panel asks.
      if (diff.removed.length > 0 && !opts.force) {
        if (!process.stdin.isTTY) {
          process.stderr.write(
            `\nThis import removes ${diff.removed.length} student(s) (listed above) and no TTY is ` +
            `available to confirm. Re-run with --force to allow removals, or --dry-run to preview.\n`,
          );
          process.exit(1);
        }
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const answer = (await rl.question(
          `\nThis import removes ${diff.removed.length} student(s) from the roster. Continue? [y/N] `,
        )).trim().toLowerCase();
        rl.close();
        if (answer !== "y" && answer !== "yes") {
          process.stdout.write(`Aborted — nothing committed.\n`);
          return;
        }
      }

      const yamlText = yamlStringify(rosterDoc);
      const message = `Update students/roster.yml via CLI (+${diff.added.length} ~${diff.updated.length} -${diff.removed.length})`;

      const result = await commitWithRebase(octokit, {
        owner: org, repo: CONTROL_REPO, branch: "main",
        message,
        changes: [{ path: ROSTER_PATH, content: yamlText }],
      });
      process.stdout.write(`\nCommitted ${result.commitSha} (${result.attempts} attempt${result.attempts === 1 ? "" : "s"}).\n`);
    });

  roster
    .command("list")
    .description("Print the committed roster.")
    .option("--org <login>", "GitHub org login (defaults to last used)")
    .action(async (opts) => {
      const org = resolveOrg(opts.org);
      const octokit = makeOctokit();
      const { roster: existing } = await fetchExistingRoster(octokit, { org });
      if (!existing || !existing.students?.length) {
        process.stdout.write(`No roster at ${org}/${CONTROL_REPO}:${ROSTER_PATH}.\n`);
        return;
      }
      const rows = existing.students;
      const widths = {
        student_number: Math.max(14, ...rows.map((r) => (r.student_number ?? "").length)),
        full_name:      Math.max(9,  ...rows.map((r) => (r.full_name ?? "").length)),
        github_login:   Math.max(12, ...rows.map((r) => (r.github_login ?? "").length)),
        class_group:    Math.max(11, ...rows.map((r) => (r.class_group ?? "").length)),
      };
      const pad = (s, n) => String(s ?? "").padEnd(n);
      const header = `${pad("student_number", widths.student_number)}  ${pad("full_name", widths.full_name)}  ${pad("github_login", widths.github_login)}  ${pad("class_group", widths.class_group)}  active`;
      process.stdout.write(header + "\n" + "-".repeat(header.length) + "\n");
      for (const r of rows) {
        process.stdout.write(
          `${pad(r.student_number, widths.student_number)}  ${pad(r.full_name, widths.full_name)}  ${pad(r.github_login, widths.github_login)}  ${pad(r.class_group, widths.class_group)}  ${r.active === false ? "no " : "yes"}\n`,
        );
      }
      process.stdout.write(`\n${rows.length} student(s) in ${org}/${CONTROL_REPO}.\n`);
    });

  program.addCommand(roster);
}
