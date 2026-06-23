// PXL Classroom CLI — `roster` subcommand stub.
//
// Filled in by Feature 3 (CSV import). Registered here so the command tree
// is stable from the F2 commit onward.

import { Command } from "commander";

export function registerRosterCommand(program) {
  const roster = new Command("roster").description("Manage the org's student roster (students/roster.yml).");

  roster
    .command("import <csvFile>")
    .description("Import a CSV roster into the org's control repo. (Not yet implemented.)")
    .option("--org <login>", "GitHub org login (defaults to last used)")
    .option("--dry-run", "Validate and show diff without committing")
    .action(() => {
      process.stderr.write("roster import: not yet implemented (Feature 3 — pending).\n");
      process.exitCode = 2;
    });

  roster
    .command("list")
    .description("List the current roster. (Not yet implemented.)")
    .option("--org <login>", "GitHub org login (defaults to last used)")
    .action(() => {
      process.stderr.write("roster list: not yet implemented (Feature 3 — pending).\n");
      process.exitCode = 2;
    });

  program.addCommand(roster);
}
