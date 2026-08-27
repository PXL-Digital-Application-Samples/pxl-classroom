// PXL Classroom CLI - `roster` subcommand group.
//
// import   - read a CSV, validate against roster.schema.json, diff vs. the
//            committed roster, and commit (or just preview with --dry-run).
// list     - print the committed roster.
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
import { resolveOrg } from "../lib/org.mjs";
// Shared with frontend/src/lib/csv.js. The two copies had already forked - this
// one compared entries with a stable stringify, the SPA's with JSON.stringify -
// and both keyed the diff on student_number alone, which a promoted entry does
// not have. See lib/roster-entries.mjs.
import {
  ROSTER_PATH,
  diffRosters,
  describeRosterEntry,
} from "../../../lib/roster-entries.mjs";
import {
  planPromotion,
  promoteCommitMessage,
  promotionChangesAnything,
} from "../../../lib/promote-roster.mjs";
import { getAssignment, listAcceptances, listClaims, deleteClaim } from "../lib/control-repo.mjs";
// The one join between a claim and a roster entry. Four surfaces read it; see
// lib/claim-bindings.mjs for why it is not written out per surface.
import {
  rosterBindings,
  orphanClaims,
  claimSummary,
  describeBinding,
} from "../../../lib/claim-bindings.mjs";
import { normalizeEmail } from "../../../lib/claim.mjs";

const CONTROL_REPO = "pxl-classroom-control";



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
  "team_slug", "team_name",
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

function printDiff(diff, { org }) {
  process.stdout.write(`\nDiff for ${org}/${CONTROL_REPO}:${ROSTER_PATH}\n`);
  process.stdout.write(
    `  + added:   ${diff.added.length}\n` +
    `  ~ updated: ${diff.updated.length}\n` +
    `  - removed: ${diff.removed.length}\n`,
  );
  // describeRosterEntry, not `${student_number}  ${full_name}`: a promoted
  // entry has neither, and printing "undefined undefined" in the REMOVED list -
  // the one place a lecturer is asked to confirm a destructive change - is how
  // a student gets dropped without anyone recognising the row.
  for (const s of diff.added) {
    process.stdout.write(`    + ${describeRosterEntry(s)}\n`);
  }
  for (const u of diff.updated) {
    const changed = Object.keys(u.after).filter((k) => JSON.stringify(u.after[k]) !== JSON.stringify(u.before[k]));
    process.stdout.write(`    ~ ${describeRosterEntry(u.after)}  [${changed.join(", ")}]\n`);
  }
  for (const s of diff.removed) {
    process.stdout.write(`    - ${describeRosterEntry(s)}\n`);
  }
  const unkeyed = diff.unkeyed.current.length + diff.unkeyed.next.length;
  if (unkeyed > 0) {
    process.stdout.write(
      `  ! ${unkeyed} entr(ies) identify nobody (no student_number, no github_login) and could not be matched.\n`,
    );
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
        process.stdout.write(`\nRoster unchanged - nothing to commit.\n`);
        return;
      }

      // Removals are the destructive part of the diff (an accidental partial
      // CSV wipes everyone not in it) - same confirmation the Admin Panel asks.
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
          process.stdout.write(`Aborted - nothing committed.\n`);
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
      // Claims are org-scoped and separate files, so the binding a student
      // actually accepts with is not in roster.yml at all. Printing the roster
      // without it answers "who is enrolled" while looking like it answers
      // "who can accept", which under `claim` are different questions.
      let claims = { records: [], unreadable: [] };
      try {
        claims = await listClaims(octokit, { org });
      } catch (e) {
        // Unreadable is not evidence of none: say so rather than printing a
        // column of "not claimed" over bindings that exist.
        process.stderr.write(`  ! could not read students/claims: ${e.message}\n`);
        claims = null;
      }

      const bound = claims ? rosterBindings(existing, claims.records) : null;
      const bindingText = (i) => (bound ? describeBinding(bound[i].binding) : "?");

      const rows = existing.students;
      const widths = {
        student_number: Math.max(14, ...rows.map((r) => (r.student_number ?? "").length)),
        full_name:      Math.max(9,  ...rows.map((r) => (r.full_name ?? "").length)),
        class_group:    Math.max(11, ...rows.map((r) => (r.class_group ?? "").length)),
        binding:        Math.max(7,  ...rows.map((_, i) => bindingText(i).length)),
      };
      const pad = (s, n) => String(s ?? "").padEnd(n);
      const header = `${pad("student_number", widths.student_number)}  ${pad("full_name", widths.full_name)}  ${pad("binding", widths.binding)}  ${pad("class_group", widths.class_group)}  active`;
      process.stdout.write(header + "\n" + "-".repeat(header.length) + "\n");
      for (const [i, r] of rows.entries()) {
        process.stdout.write(
          `${pad(r.student_number, widths.student_number)}  ${pad(r.full_name, widths.full_name)}  ${pad(bindingText(i), widths.binding)}  ${pad(r.class_group, widths.class_group)}  ${r.active === false ? "no " : "yes"}\n`,
        );
      }
      process.stdout.write(`\n${rows.length} student(s) in ${org}/${CONTROL_REPO}.\n`);

      if (claims) {
        const s = claimSummary(existing, claims.records);
        process.stdout.write(
          `${s.bound} bound (${s.claimed} claimed, ${s.pre_linked} from the roster), ` +
          `${s.unclaimed} not claimed, ${s.unclaimable} with no email.\n`,
        );
        // Each of these is a lecturer action, so each gets a line rather than
        // being folded into a healthy-looking total.
        if (s.conflicts) {
          process.stdout.write(
            `  ! ${s.conflicts} binding(s) disagree with the roster's own github_login. ` +
            `Resolve with: pxl-classroom roster unlink --login <account>\n`,
          );
        }
        if (s.duplicates) {
          process.stdout.write(`  ! ${s.duplicates} address(es) are claimed by more than one account.\n`);
        }
        for (const o of orphanClaims(existing, claims.records)) {
          process.stdout.write(`  ! orphan claim: @${o.github_login} holds ${o.email}, which is on no roster entry.\n`);
        }
        if (claims.unreadable.length) {
          process.stdout.write(`  ! ${claims.unreadable.length} claim file(s) could not be read; the counts above are incomplete.\n`);
        }
      }
    });

  roster
    .command("unlink")
    .description("Remove a student's claim binding so they can claim again.")
    .option("--org <login>", "GitHub org login (defaults to last used)")
    .option("--login <username>", "GitHub account whose binding to remove")
    .option("--email <address>", "Address whose binding to remove")
    .option("--dry-run", "Show what would be removed without deleting", false)
    .option("--force", "Skip the confirmation prompt (required when not a TTY)", false)
    .action(async (opts) => {
      if (!opts.login && !opts.email) {
        process.stderr.write("Give --login or --email: unlink has to name one binding.\n");
        process.exit(1);
      }
      const org = resolveOrg(opts.org);
      const octokit = makeOctokit();

      const { records, unreadable } = await listClaims(octokit, { org });
      // Deleting on the strength of a partial read could unlink the wrong
      // student, or report "no such binding" for one sitting in a file that
      // would not load. Same rule the promote modal carries.
      if (unreadable.length) {
        process.stderr.write(
          `Refusing to unlink: ${unreadable.length} claim file(s) could not be read, ` +
          `so this list is incomplete:\n  ${unreadable.join("\n  ")}\n`,
        );
        process.exit(1);
      }

      const wanted = opts.login
        ? records.filter((c) => String(c.github_login ?? "").toLowerCase() === opts.login.toLowerCase())
        : records.filter((c) => normalizeEmail(c.email) === normalizeEmail(opts.email));

      if (wanted.length === 0) {
        process.stdout.write(`No claim binding for ${opts.login ? `@${opts.login}` : opts.email} in ${org}.\n`);
        return;
      }

      for (const c of wanted) {
        process.stdout.write(`  - @${c.github_login} (id ${c.github_id}) is bound to ${c.email}, claimed via ${c.claimed_via}\n`);
      }
      process.stdout.write(
        `\nUnlinking removes the binding and the failed-attempt counter, so the student can claim again.\n` +
        `Their repository and acceptance are untouched.\n`,
      );

      if (opts.dryRun) {
        process.stdout.write(`\n(--dry-run; nothing deleted.)\n`);
        return;
      }

      // Destructive, so it confirms - the rule `roster import` already follows
      // for removals.
      if (!opts.force) {
        if (!process.stdin.isTTY) {
          process.stderr.write("\nRefusing to unlink without --force when not attached to a terminal.\n");
          process.exit(1);
        }
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const answer = await rl.question(`Unlink ${wanted.length} binding(s)? [y/N] `);
        rl.close();
        if (!/^y(es)?$/i.test(answer.trim())) {
          process.stdout.write("Aborted.\n");
          return;
        }
      }

      for (const c of wanted) {
        const removed = await deleteClaim(octokit, {
          org,
          githubId: c.github_id,
          message: `Unlink claim for @${c.github_login} (${c.email})`,
        });
        process.stdout.write(`  unlinked @${c.github_login}: removed ${removed.length} file(s)\n`);
      }
    });

  roster
    .command("promote")
    .description("Add students who accepted an assignment to the roster (roster_mode: open).")
    .requiredOption("--assignment <id>", "Assignment whose acceptances to promote")
    .option("--org <login>", "GitHub org login (defaults to last used)")
    .option("--dry-run", "Show the plan without committing", false)
    .action(async (opts) => {
      const org = resolveOrg(opts.org);
      const octokit = makeOctokit();

      const assignment = await getAssignment(octokit, { org, assignmentId: opts.assignment });
      const acceptances = await listAcceptances(octokit, { org, assignmentId: opts.assignment });
      const { roster: existing } = await fetchExistingRoster(octokit, { org });

      const plan = planPromotion({
        acceptances,
        roster: existing,
        assignment: { ...assignment, id: assignment.id || opts.assignment },
        actor: "pxl-classroom-cli",
      });

      for (const w of plan.warnings) process.stdout.write(`  ! ${w.message}\n`);

      if (!plan.ok) {
        for (const e of plan.errors) process.stderr.write(`Cannot promote: ${e.message}\n`);
        process.exit(1);
      }

      process.stdout.write(
        `\n${plan.stats.acceptances} acceptance(s) for ${opts.assignment}: ` +
        `${plan.stats.added} to add, ${plan.stats.already_on_roster} already on the roster.\n`,
      );
      for (const s of plan.added) process.stdout.write(`    + ${describeRosterEntry(s)}\n`);

      // Validate before writing, not after: the roster is what acceptance reads
      // to decide who gets a repository. A clone, because ajv runs with
      // useDefaults and would otherwise inject values into what we serialise.
      const { valid, errors } = validateAgainst("roster", structuredClone(plan.nextRoster));
      if (!valid) {
        process.stderr.write(`Refusing to write an invalid roster:\n${formatAjvErrors(errors)}\n`);
        process.exit(1);
      }

      if (opts.dryRun) {
        process.stdout.write(`\n(--dry-run; no commit made.)\n`);
        return;
      }
      if (!promotionChangesAnything(plan)) {
        process.stdout.write(`\nRoster unchanged - nothing to commit.\n`);
        return;
      }

      // Promotion only ever appends, so there is nothing destructive to confirm
      // - unlike `roster import`, which replaces the file wholesale.
      const result = await commitWithRebase(octokit, {
        owner: org, repo: CONTROL_REPO, branch: "main",
        message: promoteCommitMessage(plan, { assignmentId: opts.assignment }),
        changes: [{ path: ROSTER_PATH, content: yamlStringify(plan.nextRoster) }],
      });
      process.stdout.write(`\nCommitted ${result.commitSha} (${result.attempts} attempt${result.attempts === 1 ? "" : "s"}).\n`);
    });

  program.addCommand(roster);
}
