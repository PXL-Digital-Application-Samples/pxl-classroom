#!/usr/bin/env node
// PXL Classroom — CLI entrypoint.
//
// Wires top-level commander subcommands. Implementation lives in src/commands/.

import { Command } from "commander";
import { registerAuthCommand } from "../src/commands/auth.mjs";
import { registerRosterCommand } from "../src/commands/roster.mjs";

const program = new Command();

program
  .name("pxl-classroom")
  .description("PXL Classroom companion CLI — lecturer roster, assignment, and audit operations.")
  .version("0.1.0");

const ac = new AbortController();
process.on("SIGINT", () => {
  ac.abort();
  process.exit(130);
});

const context = { signal: ac.signal };

registerAuthCommand(program, context);
registerRosterCommand(program, context);

program.parseAsync(process.argv).catch((err) => {
  if (err?.code === "ABORT") {
    process.exit(130);
  }
  process.stderr.write(`error: ${err.message ?? err}\n`);
  if (process.env.DEBUG) process.stderr.write(`${err.stack}\n`);
  process.exit(1);
});
