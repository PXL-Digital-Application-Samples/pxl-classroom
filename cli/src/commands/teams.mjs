// PXL Classroom CLI - `teams` subcommand group.
//
// seed  - carry the groups of an earlier group assignment (or the roster's team
//         columns) into a target assignment, so students confirm the group they
//         already work in instead of forming teams from scratch.
// list  - print the team manifests of an assignment.
//
// The planning is shared with the SPA (lib/seed-teams.mjs); this command only
// reads the control repo, prints the plan, and commits it in one commit.

import { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { makeOctokit } from "../lib/octokit.mjs";
import { commitWithRebase } from "../lib/gittree.mjs";
import { resolveOrg } from "../lib/org.mjs";
import {
  getAssignment,
  listTeams,
  getRoster,
  listAssignments,
} from "../lib/control-repo.mjs";
import { planSeed, teamsFromRoster, seedCommitMessage } from "../../../lib/seed-teams.mjs";

const CONTROL_REPO = "pxl-classroom-control";
const HUB_OWNER_DEFAULT = "PXL-Digital-Application-Samples";
const HUB_REPO_DEFAULT = "pxl-classroom";

function out(text) {
  process.stdout.write(text);
}

function renderPlan(plan, { targetId, sourceLabel }) {
  const lines = [];
  lines.push(`\nSeeding ${targetId} from ${sourceLabel}\n`);

  if (!plan.ok) {
    lines.push(`\n  Nothing can be seeded:\n`);
    for (const e of plan.errors) lines.push(`    x ${e.message}\n`);
    return lines.join("");
  }

  lines.push(`\n  ${plan.stats.teams} team(s), ${plan.stats.students} student(s)`);
  if (plan.stats.skipped) lines.push(`, ${plan.stats.skipped} skipped`);
  lines.push(`\n\n`);

  for (const t of plan.teams) {
    const members = t.members.map((m) => `@${m}`).join(", ");
    lines.push(`    ${t.team_slug.padEnd(24)} ${String(t.members.length).padStart(2)}/${t.max_members}  ${members}\n`);
  }

  if (plan.warnings.length) {
    lines.push(`\n  Warnings:\n`);
    for (const w of plan.warnings) lines.push(`    ! ${w.message}\n`);
  }
  return lines.join("");
}

async function confirm(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(question);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

export function registerTeamsCommand(program, context = {}) {
  const teams = program.command("teams").description("Inspect and seed group-assignment teams.");

  teams
    .command("seed")
    .description("Carry an existing grouping into a group assignment.")
    .requiredOption("--to <assignment-id>", "Target group assignment")
    .option("--from <assignment-id>", "Source group assignment to copy the teams from")
    .option("--from-roster", "Use the roster's team_slug / team_name columns instead")
    .option("--org <login>", "Organization (defaults to the configured org)")
    .option("--dry-run", "Print the plan and exit without writing anything")
    .option("--yes", "Apply without prompting, even when the plan has warnings")
    .option("--hub-owner <login>", `Hub repo owner (default ${HUB_OWNER_DEFAULT})`, HUB_OWNER_DEFAULT)
    .option("--hub-repo <name>", `Hub repo name (default ${HUB_REPO_DEFAULT})`, HUB_REPO_DEFAULT)
    .option("--no-publish", "Skip the dashboard regeneration that makes the teams visible to students")
    .action(async (opts) => {
      if (!opts.from && !opts.fromRoster) {
        throw new Error("choose a source: --from <assignment-id> or --from-roster");
      }
      if (opts.from && opts.fromRoster) {
        throw new Error("--from and --from-roster are mutually exclusive");
      }

      const org = resolveOrg(opts.org);
      const octokit = makeOctokit();

      const targetAssignment = await getAssignment(octokit, { org, assignmentId: opts.to });
      targetAssignment.id = targetAssignment.id || opts.to;

      let sourceAssignment = null;
      let sourceTeams = [];
      const roster = await getRoster(octokit, { org });

      if (opts.fromRoster) {
        sourceTeams = teamsFromRoster(roster?.students || [], { assignmentId: targetAssignment.id });
      } else {
        sourceAssignment = await getAssignment(octokit, { org, assignmentId: opts.from });
        sourceAssignment.id = sourceAssignment.id || opts.from;
        if (sourceAssignment.assignment_type !== "group") {
          throw new Error(`${opts.from} is not a group assignment - it has no teams to carry over.`);
        }
        sourceTeams = await listTeams(octokit, { org, assignmentId: sourceAssignment.id });
      }

      const existingTeams = await listTeams(octokit, { org, assignmentId: targetAssignment.id });

      const plan = planSeed({
        sourceTeams,
        existingTeams,
        targetAssignment,
        sourceAssignment,
        roster,
        now: new Date().toISOString(),
        actor: "cli",
        source: opts.fromRoster ? "roster" : "assignment",
      });

      const sourceLabel = opts.fromRoster ? "the roster's team columns" : sourceAssignment.id;
      out(renderPlan(plan, { targetId: targetAssignment.id, sourceLabel }));

      if (!plan.ok) {
        process.exitCode = 2;
        return;
      }

      if (plan.teams.length === 0) {
        out(
          `\nNothing left to seed - every team from ${sourceLabel} already exists in ` +
            `${targetAssignment.id}, or its members have joined other teams there.\n`
        );
        return;
      }

      if (opts.dryRun) {
        out(`\nDry run - nothing was written.\n`);
        return;
      }

      if (plan.warnings.length && !opts.yes) {
        if (!process.stdin.isTTY) {
          process.stderr.write(
            `\nThe plan has ${plan.warnings.length} warning(s) and no TTY is available to confirm. ` +
              `Re-run with --yes to apply anyway, or --dry-run to review.\n`
          );
          process.exitCode = 1;
          return;
        }
        const ok = await confirm(`\nApply this plan? [y/N] `);
        if (!ok) {
          out(`Aborted.\n`);
          process.exitCode = 1;
          return;
        }
      }

      const result = await commitWithRebase(octokit, {
        owner: org,
        repo: CONTROL_REPO,
        branch: "main",
        message: seedCommitMessage(plan, { targetId: targetAssignment.id, sourceLabel }),
        changes: plan.changes,
      });
      out(`\nCommitted ${result.commitSha} (${plan.changes.length} file(s)).\n`);

      if (opts.publish === false) {
        out(`Skipped dashboard regeneration - students will not see these teams until it runs.\n`);
        return;
      }

      // Students read the generated public teams file, never the control repo.
      try {
        await octokit.request(
          "POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches",
          {
            owner: opts.hubOwner,
            repo: opts.hubRepo,
            workflow_id: "regenerate-dashboard.yml",
            ref: "main",
            inputs: { org },
          }
        );
        out(`Dispatched regenerate-dashboard.yml so students can see the teams.\n`);
      } catch (e) {
        process.stderr.write(
          `\nTeams were committed, but regenerate-dashboard.yml could not be dispatched (${e.message}). ` +
            `Run it from the hub's Actions tab, or the teams stay invisible to students.\n`
        );
        process.exitCode = 1;
      }
    });

  teams
    .command("list")
    .description("Print the team manifests of a group assignment.")
    .requiredOption("--assignment <assignment-id>", "Assignment ID")
    .option("--org <login>", "Organization (defaults to the configured org)")
    .option("--json", "Emit raw JSON")
    .action(async (opts) => {
      const org = resolveOrg(opts.org);
      const octokit = makeOctokit();
      const list = await listTeams(octokit, { org, assignmentId: opts.assignment });

      if (opts.json) {
        out(JSON.stringify(list, null, 2) + "\n");
        return;
      }
      if (list.length === 0) {
        out(`No teams in ${org}/${CONTROL_REPO} for ${opts.assignment}.\n`);
        return;
      }
      for (const t of list) {
        const members = (t.members || []).map((m) => `@${m}`).join(", ") || "(vacant)";
        const from = t.seeded_from
          ? `  [seeded from ${t.seeded_from.assignment_id || t.seeded_from.source}]`
          : "";
        out(`${t.team_slug.padEnd(24)} ${String((t.members || []).length).padStart(2)}/${t.max_members ?? "?"}  ${members}${from}\n`);
      }
    });

  // Kept for parity with the other command groups: an explicit list of the
  // org's group assignments makes `--from` discoverable without the SPA.
  teams
    .command("sources")
    .description("List the group assignments that can be used as a seeding source.")
    .option("--org <login>", "Organization (defaults to the configured org)")
    .action(async (opts) => {
      const org = resolveOrg(opts.org);
      const octokit = makeOctokit();
      const docs = (await listAssignments(octokit, { org })).filter(
        (a) => a.assignment_type === "group"
      );
      if (docs.length === 0) {
        out(`No group assignments in ${org}.\n`);
        return;
      }
      for (const a of docs) {
        const count = (await listTeams(octokit, { org, assignmentId: a.id })).filter(
          (t) => !t.vacant && (t.members || []).length > 0
        ).length;
        out(`${a.id.padEnd(32)} ${String(count).padStart(3)} team(s)  ${a.title || ""}\n`);
      }
    });

  return teams;
}
