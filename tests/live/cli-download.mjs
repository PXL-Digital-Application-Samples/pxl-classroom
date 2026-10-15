#!/usr/bin/env node
// PXL Classroom - LIVE: `pxl-classroom download` of a full-history drill, run
// twice into the same directory as the lecturer (review TV-4).
//
//   node tests/live/cli-download.mjs <full-history drill id>
//
// Each submission arrives with its whole history (a full-history assignment is
// graded on it, S8), the second run brings a copy up to date rather than
// failing on it, and no credential is left in any `.git/config` - the CLI
// authenticates git with a header it never writes (lib/git-auth.mjs, A10).
// Writes nothing on GitHub; the directory is temporary.

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { accounts, api, decode, die, loadEnv, reporter } from "./live-kit.mjs";
import { CONTROL_REPO } from "../../lib/deployment.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ORG = process.env.DRILL_ORG || "pxl-classroom-testbed";
const { LECTURER } = accounts(loadEnv());
const id = process.argv[2];
if (!id) die("usage: node tests/live/cli-download.mjs <full-history drill id>");
const r = reporter();

const report = JSON.parse(decode((await api(`/repos/${ORG}/${CONTROL_REPO}/contents/reports/${id}.json`, { token: LECTURER.token })).data.content));
const rows = report.students.filter((s) => s.preservation_status === "preserved");
if (!rows.length) die(`${id} has no preserved submissions`);

const work = mkdtempSync(join(tmpdir(), "pxl-cli-download-"));
const cfg = join(work, "config");
mkdirSync(join(cfg, "pxl-classroom"), { recursive: true });
writeFileSync(join(cfg, "pxl-classroom", "token"), JSON.stringify({ access_token: LECTURER.token, obtained_at: new Date().toISOString() }));
const dest = join(work, "submissions");
const cli = (...args) => spawnSync(process.execPath, [join(root, "cli", "bin", "pxl-classroom.mjs"), ...args], {
  encoding: "utf8", env: { ...process.env, APPDATA: cfg, XDG_CONFIG_HOME: cfg }, timeout: 10 * 60_000,
});
const git = (cwd, ...args) => spawnSync("git", args, { cwd, encoding: "utf8" }).stdout.trim();

try {
  for (const pass of [1, 2]) {
    const run = cli("download", "--org", ORG, "--assignment", id, "--dir", dest);
    if (run.status === 0) r.ok(`pass ${pass}: download exited 0`);
    else r.bad(`pass ${pass}: download exited ${run.status}\n${run.stdout}${run.stderr}`);
  }
  const dirs = readdirSync(dest, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  for (const row of rows) {
    const dir = dirs.find((d) => d.toLowerCase().includes(row.github_login.toLowerCase()));
    if (!dir) { r.bad(`${row.github_login}: no directory in ${dest} (${dirs.join(", ")})`); continue; }
    const at = join(dest, dir);
    const head = git(at, "rev-parse", "HEAD");
    if (head === row.preserved_sha) r.ok(`${row.github_login}: at the preserved ${head.slice(0, 7)}`);
    else r.bad(`${row.github_login}: at ${head}, preserved ${row.preserved_sha}`);
    const shallow = git(at, "rev-parse", "--is-shallow-repository");
    const count = Number(git(at, "rev-list", "--count", "HEAD"));
    if (shallow === "false" && count > 1) r.ok(`${row.github_login}: the whole history, ${count} commits`);
    else r.bad(`${row.github_login}: shallow ${shallow}, ${count} commit(s)`);
    const config = readFileSync(join(at, ".git", "config"), "utf8");
    if (config.includes(LECTURER.token) || /extraheader|authorization|x-access-token/i.test(config)) r.bad(`${row.github_login}: a credential is in .git/config`);
    else r.ok(`${row.github_login}: no credential in .git/config`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log(`\n${r.failures() === 0 ? "All checks passed." : `${r.failures()} check(s) failed.`}\n`);
process.exit(r.failures() === 0 ? 0 : 1);
