// PXL Classroom CLI — `download` command.
//
// Pulls preserved submissions out of <org>/pxl-classroom-archive into a local
// tree. Archive-backed so post-deadline rewrites of the live student repo
// cannot affect what's downloaded; we only read `preserved/<assignment>/<login>`
// refs that lockdown wrote on deadline night.
//
// Resumable: skips a student whose target dir already contains the expected
// SHA. Writes a manifest at <dir>/_manifest.json with {login, sha, branch,
// downloaded_at} rows so plagiarism tools / CI know what they're looking at.

import { Command } from "commander";
import { mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { makeOctokit } from "../lib/octokit.mjs";
import { loadConfig, saveConfig } from "../lib/config.mjs";
import { requireToken } from "../lib/auth.mjs";
import { resolveOrg } from "../lib/org.mjs";
import { getReport } from "../lib/control-repo.mjs";
import { withConcurrency } from "../lib/worker-pool.mjs";

const CONTROL_REPO = "pxl-classroom-control";
const ARCHIVE_REPO = "pxl-classroom-archive";



// Run a git subprocess with stdio captured. Throws on non-zero exit. Token
// is never put on the command line — only in the URL, which itself is only
// read by git, not logged here.
function runGit(args, opts = {}) {
  return new Promise((resolveFn, reject) => {
    const child = spawn("git", args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (b) => (stdout += b.toString()));
    child.stderr.on("data", (b) => (stderr += b.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolveFn({ stdout, stderr });
      else reject(new Error(`git ${args.join(" ")} exited ${code}: ${stderr.trim()}`));
    });
  });
}



function authedArchiveUrl(org, token) {
  return `https://x-access-token:${token}@github.com/${org}/${ARCHIVE_REPO}.git`;
}

// Single-student fetch: clone-or-update the archive into a per-student dir
// and checkout the preserved ref. Returns { login, sha, branch, status }.
async function fetchOne({ org, assignmentId, login, expectedSha, token, dir }) {
  const target = join(dir, login);
  const branch = `preserved/${assignmentId}/${login}`;
  const url = authedArchiveUrl(org, token);

  if (existsSync(join(target, ".git"))) {
    try {
      const cur = (await runGit(["rev-parse", "HEAD"], { cwd: target })).stdout.trim();
      if (cur === expectedSha) {
        return { login, sha: cur, branch, status: "cached" };
      }
    } catch { /* re-clone */ }
  }
  await mkdir(target, { recursive: true });
  if (!existsSync(join(target, ".git"))) {
    await runGit(["init", "--quiet"], { cwd: target });
  }
  // Best-effort: ensure remote is set to authed URL; we rewrite each call so
  // a rotated token always wins (and never gets stored long-term in config).
  try { await runGit(["remote", "remove", "origin"], { cwd: target }); } catch { /* ok */ }
  await runGit(["remote", "add", "origin", url], { cwd: target });
  await runGit(["fetch", "--depth=1", "origin", branch], { cwd: target });
  await runGit(["checkout", "-q", "-B", branch, "FETCH_HEAD"], { cwd: target });
  const sha = (await runGit(["rev-parse", "HEAD"], { cwd: target })).stdout.trim();
  return { login, sha, branch, status: "downloaded" };
}

export function registerDownloadCommand(program) {
  program
    .command("download")
    .description("Download all preserved submissions for an assignment from <org>/pxl-classroom-archive.")
    .option("--org <login>", "GitHub org login (defaults to last used)")
    .requiredOption("--assignment <id>", "Assignment ID")
    .option("--dir <path>", "Output directory", "./submissions")
    .option("--concurrency <n>", "Parallel git operations", (v) => Number(v), 4)
    .option("--login <login>", "Download for a single student only")
    .action(async (opts) => {
      const org = resolveOrg(opts.org);
      const octokit = makeOctokit();
      const token = requireToken().access_token;

      const report = await getReport(octokit, { org, assignmentId: opts.assignment });
      const eligible = (report.students || []).filter(
        (s) => s.preservation_status === "preserved" && s.preserved_sha && s.github_login,
      );
      const queue = opts.login ? eligible.filter((s) => s.github_login === opts.login) : eligible;
      if (queue.length === 0) {
        process.stdout.write(
          opts.login
            ? `No preserved submission for ${opts.login} on ${opts.assignment}.\n`
            : `No preserved submissions in reports/${opts.assignment}.json.\n`,
        );
        return;
      }

      const dir = resolve(opts.dir);
      await mkdir(dir, { recursive: true });
      process.stdout.write(`Downloading ${queue.length} submission(s) into ${dir} (concurrency=${opts.concurrency}).\n`);

      const results = await withConcurrency(queue, Math.max(1, opts.concurrency), async (s) => {
        return await fetchOne({
          org, assignmentId: opts.assignment,
          login: s.github_login, expectedSha: s.preserved_sha, token, dir,
        });
      });

      const rows = [];
      let okCount = 0, cachedCount = 0, failedCount = 0;
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const login = queue[i].github_login;
        if (r?.error) {
          failedCount++;
          process.stdout.write(`  ! ${login}: ${r.error.message}\n`);
          continue;
        }
        if (r.status === "cached") {
          cachedCount++;
          process.stdout.write(`  · ${login}: cached (${r.sha.slice(0, 12)})\n`);
        } else {
          okCount++;
          process.stdout.write(`  + ${login}: ${r.sha.slice(0, 12)}\n`);
        }
        rows.push({
          login, archive_sha: r.sha, archive_branch: r.branch,
          archive_branch_url: `https://github.com/${org}/${ARCHIVE_REPO}/tree/${encodeURIComponent(r.branch)}`,
          downloaded_at: new Date().toISOString(),
        });
      }

      const manifest = {
        schema_version: 1,
        org, assignment_id: opts.assignment,
        generated_at: new Date().toISOString(),
        students: rows,
      };
      await writeFile(join(dir, "_manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
      process.stdout.write(
        `\n${okCount} downloaded, ${cachedCount} cached, ${failedCount} failed. ` +
        `Manifest at ${join(dir, "_manifest.json")}\n`,
      );
      if (failedCount) process.exit(1);
    });
}
