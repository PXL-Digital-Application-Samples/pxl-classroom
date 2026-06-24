// PXL Classroom CLI — `audit` command.
//
// Runs the read-only audit checks from lib/audit.mjs against an org's PXL
// Classroom install. Exit codes mirror the plan:
//   0 = clean (all checks ok/info)
//   1 = warnings (one or more checks at "warn" severity)
//   2 = failures (one or more checks at "fail" severity)
//
// `--json` emits a single JSON object on stdout and suppresses the human
// summary, for piping into nightly CI.

import { Command } from "commander";
import { makeOctokit } from "../lib/octokit.mjs";
import { loadConfig, saveConfig } from "../lib/config.mjs";
import { runAudit } from "../../../lib/audit.mjs";

const HUB_OWNER_DEFAULT = "PXL-Digital-Application-Samples";
const HUB_REPO_DEFAULT = "pxl-classroom";

function resolveOrg(flag) {
  const org = flag || loadConfig().last_org;
  if (!org) {
    throw new Error(
      "no --org and no last-used org in config. Pass `--org <login>` (the value is remembered).",
    );
  }
  if (flag) saveConfig({ last_org: flag });
  return org;
}

// Adapt Octokit's request() to the shape lib/audit.mjs expects:
// { status, ok, data } with `ok` true on 2xx and false otherwise.
function makeRequest(octokit) {
  return async (method, path) => {
    try {
      const res = await octokit.request(`${method} ${path}`);
      return { status: res.status, ok: res.status >= 200 && res.status < 300, data: res.data };
    } catch (err) {
      const status = err.status ?? 0;
      return { status, ok: false, data: err.response?.data ?? null };
    }
  };
}

function severityGlyph(sev) {
  return { ok: "✓", info: "·", warn: "!", fail: "✗" }[sev] || "?";
}

function severityColor(sev) {
  // ANSI dimming/colors — kept minimal so output reads in plain pipes too.
  return { ok: "\x1b[32m", info: "\x1b[2m", warn: "\x1b[33m", fail: "\x1b[31m" }[sev] || "";
}

function printHuman(result) {
  const reset = "\x1b[0m";
  process.stdout.write(`\nAudit — ${result.org}${result.assignment_id ? ` / ${result.assignment_id}` : ""}\n`);
  process.stdout.write(`Overall: ${severityColor(result.overall)}${result.overall.toUpperCase()}${reset}\n\n`);
  for (const c of result.checks) {
    const glyph = `${severityColor(c.severity)}${severityGlyph(c.severity)}${reset}`;
    process.stdout.write(`  ${glyph}  ${c.label}\n`);
    process.stdout.write(`       ${c.message}\n`);
  }
  process.stdout.write("\n");
}

function exitCodeFor(overall) {
  if (overall === "fail") return 2;
  if (overall === "warn") return 1;
  return 0;
}

export function registerAuditCommand(program) {
  program
    .command("audit")
    .description("Run read-only health checks against an org's PXL Classroom install.")
    .option("--org <login>", "GitHub org login (defaults to last used)")
    .option("--assignment <id>", "Also run per-assignment deep checks")
    .option("--hub-owner <login>", `Hub repo owner (default ${HUB_OWNER_DEFAULT})`, HUB_OWNER_DEFAULT)
    .option("--hub-repo <name>", `Hub repo name (default ${HUB_REPO_DEFAULT})`, HUB_REPO_DEFAULT)
    .option("--json", "Emit JSON to stdout (suppresses human summary)", false)
    .action(async (opts) => {
      const org = resolveOrg(opts.org);
      const octokit = makeOctokit();
      const request = makeRequest(octokit);

      const result = await runAudit({
        request,
        org,
        assignmentId: opts.assignment ?? null,
        hubOwner: opts.hubOwner,
        hubRepo: opts.hubRepo,
      });

      if (opts.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      } else {
        printHuman(result);
      }
      process.exit(exitCodeFor(result.overall));
    });
}
