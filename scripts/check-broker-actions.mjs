#!/usr/bin/env node
// Can GitHub Actions run on the broker(s)? (lib/audit.mjs `actionsAllowedFinding`,
// the one judge.)
//
//   node scripts/check-broker-actions.mjs <control-dir> --assignment <id>
//       publish-assignment.yml, after the broker exists: a fail REFUSES the
//       publish (exit 1), so no student gets a link whose broker never runs.
//   node scripts/check-broker-actions.mjs <control-dir> --published
//       the weekly check: every published assignment's broker; exit 1 on any
//       fail, so the run goes red over an organization where acceptance cannot
//       work.
//
// A setting that could not be read is said and never refuses: a token that
// cannot read Actions settings is not evidence that they are off.
//
// Env: GITHUB_TOKEN (an installation token: Administration read on the broker,
//      Organization administration read), ORG.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { gh } from "../lib/gh.mjs";
import { parseYaml } from "../lib/yaml.mjs";
import { ASSIGNMENTS_DIR, assignmentIdFromFile, assignmentPathsRead } from "../lib/control-layout.mjs";
import { brokerRepoName } from "../lib/broker-repo.mjs";
import { actionsAllowedFinding, readActionsSettings } from "../lib/audit.mjs";

const LOGIN = /^[A-Za-z0-9](?:-?[A-Za-z0-9]){0,38}$/;

async function readDoc(dir, path) {
  const text = await readFile(join(dir, path), "utf8");
  return path.endsWith(".json") ? JSON.parse(text) : parseYaml(text);
}

/** The brokers to check: one assignment's, or every published one's. */
export async function brokersToCheck(dir, { assignmentId = null, published = false } = {}) {
  if (assignmentId) {
    for (const path of assignmentPathsRead(assignmentId)) {
      try {
        return [brokerRepoName({ assignment: await readDoc(dir, path), assignmentId })];
      } catch { /* the next spelling */ }
    }
    return [brokerRepoName({ assignmentId })];
  }
  if (!published) return [];
  const out = [];
  for (const file of await readdir(join(dir, ASSIGNMENTS_DIR)).catch(() => [])) {
    const id = assignmentIdFromFile(file);
    if (!id) continue;
    try {
      const doc = await readDoc(dir, join(ASSIGNMENTS_DIR, file));
      if (doc?.state === "published") out.push(brokerRepoName({ assignment: doc, assignmentId: id }));
    } catch { /* an assignment that does not parse has no broker to check */ }
  }
  return [...new Set(out.filter(Boolean))];
}

export async function main(argv = process.argv.slice(2), { request = (m, p) => gh(m, p), env = process.env } = {}) {
  const [dir, flag, value] = argv;
  const org = env.ORG || "";
  if (!dir || !LOGIN.test(org) || !["--assignment", "--published"].includes(flag)) {
    console.log("usage: check-broker-actions.mjs <control-dir> --assignment <id> | --published   (env ORG)");
    return 1;
  }
  const brokers = await brokersToCheck(dir, flag === "--assignment" ? { assignmentId: value } : { published: true });
  if (!brokers.length) {
    console.log(`[ok] ${org}: no published assignment, no broker to check`);
    return 0;
  }
  let failed = 0;
  for (const broker of brokers) {
    const finding = actionsAllowedFinding({ org, broker, ...(await readActionsSettings(request, { org, broker })) });
    if (finding.severity === "fail") {
      failed++;
      console.log(`::error::${finding.message}`);
    } else if (finding.severity === "warn") {
      console.log(`::warning::${finding.message}`);
    } else {
      console.log(`[${finding.severity}] ${broker}: ${finding.message}`);
    }
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; });
}
