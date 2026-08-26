// PXL Classroom CLI - `download` command.
//
// Pulls preserved submissions out of the assignment's archive repository into a
// local tree. Archive-backed so post-deadline rewrites of the live student repo
// cannot affect what's downloaded; we only read the `preserved/...` refs that
// lockdown wrote on deadline night.
//
// The archive repo and ref come off each report row (`archive_repo` /
// `archive_ref`), not from the assignment id. Archives are per assignment now,
// but a cohort preserved before that change is in the org's old shared
// `pxl-classroom-archive` - and a targeted retry after the change can leave one
// report with rows in both. Per row, that resolves itself.
//
// Resumable: skips a student whose target dir already contains the expected
// SHA. Writes a manifest at <dir>/_manifest.json with {login, sha, branch,
// downloaded_at} rows so plagiarism tools / CI know what they're looking at.

import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { makeOctokit } from "../lib/octokit.mjs";
import { saveConfig } from "../lib/config.mjs";
import { requireToken } from "../lib/auth.mjs";
import { resolveOrg } from "../lib/org.mjs";
import { getReport } from "../lib/control-repo.mjs";
import { withConcurrency } from "../lib/worker-pool.mjs";
import { archiveBranchName, archiveBranchUrl, resolveArchiveRepo } from "../../../lib/archive-repo.mjs";



// Run a git subprocess with stdio captured. Throws on non-zero exit. Token
// is never put on the command line - only in the URL, which itself is only
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



function authedArchiveUrl(archiveRepo, token) {
  return `https://x-access-token:${token}@github.com/${archiveRepo}.git`;
}

// Single-student fetch: clone-or-update the archive into a per-student dir
// and checkout the preserved ref. Returns { login, sha, branch, status }.
async function fetchOne({ org, assignmentId, login, teamSlug, archiveRepo, archiveRef, expectedSha, token, dir }) {
  const target = join(dir, login);
  const branch = archiveBranchName({ assignmentId, login, teamSlug, recordedRef: archiveRef });
  const repo = resolveArchiveRepo({ org, recorded: archiveRepo });
  const url = authedArchiveUrl(repo, token);

  if (existsSync(join(target, ".git"))) {
    try {
      const cur = (await runGit(["rev-parse", "HEAD"], { cwd: target })).stdout.trim();
      if (cur === expectedSha) {
        return { login, sha: cur, branch, repo, status: "cached" };
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
  try {
    await runGit(["fetch", "--depth=1", "origin", branch], { cwd: target });
    await runGit(["checkout", "-q", "-B", branch, "FETCH_HEAD"], { cwd: target });
    const sha = (await runGit(["rev-parse", "HEAD"], { cwd: target })).stdout.trim();
    return { login, sha, branch, repo, status: "downloaded" };
  } finally {
    try {
      await runGit(["remote", "set-url", "origin", `https://github.com/${repo}.git`], { cwd: target });
    } catch { /* ignore clean url errors */ }
  }
}

function parseConcurrency(val) {
  const parsed = parseInt(val, 10);
  if (isNaN(parsed) || parsed <= 0 || String(parsed) !== String(val)) {
    throw new Error("Concurrency must be a positive integer.");
  }
  return parsed;
}

export function registerDownloadCommand(program) {
  program
    .command("download")
    .description("Download all preserved submissions for an assignment from its archive repository.")
    .option("--org <login>", "GitHub org login (defaults to last used)")
    .requiredOption("--assignment <id>", "Assignment ID")
    .option("--dir <path>", "Destination directory", "submissions")
    .option("--concurrency <n>", "Parallel git workers", parseConcurrency, 4)
    .option("--login <username>", "Download a single student's submission only")
    .action(async (opts) => {
      const org = await resolveOrg(opts.org);
      const token = requireToken();
      const octokit = makeOctokit(token);

      saveConfig({ defaultOrg: org });

      const report = await getReport(octokit, org, opts.assignment);
      if (!report) {
        throw new Error(`Report not found for ${opts.assignment}. Has the deadline finalized?`);
      }

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
          login: s.github_login, teamSlug: s.team_slug,
          archiveRepo: s.archive_repo, archiveRef: s.archive_ref,
          expectedSha: s.preserved_sha, token, dir,
        });
      });

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
      }

      const manifestPath = join(dir, "_manifest.json");
      let studentsList = results
        .filter((r) => r && !r.error)
        .map((r) => ({
          login: r.login,
          archive_sha: r.sha,
          archive_branch: r.branch,
          archive_branch_url: archiveBranchUrl({ org, recorded: r.repo, recordedRef: r.branch }),
          downloaded_at: new Date().toISOString(),
        }));

      try {
        if (existsSync(manifestPath)) {
          const content = await readFile(manifestPath, "utf8");
          const existing = JSON.parse(content);
          if (existing && Array.isArray(existing.students)) {
            const list = existing.students.map((s) => ({
              login: s.login,
              archive_sha: s.archive_sha || s.sha,
              archive_branch: s.archive_branch || s.branch,
              archive_branch_url: s.archive_branch_url || archiveBranchUrl({ org, recordedRef: s.archive_branch || s.branch }),
              downloaded_at: s.downloaded_at || null,
            }));
            for (const r of studentsList) {
              const idx = list.findIndex((s) => s.login === r.login);
              if (idx !== -1) {
                list[idx] = r;
              } else {
                list.push(r);
              }
            }
            studentsList = list;
          }
        }
      } catch (err) {
        process.stderr.write(`[warning] Failed to read existing manifest: ${err.message}. Overwriting.\n`);
      }

      const manifest = {
        schema_version: 1,
        org, assignment_id: opts.assignment,
        generated_at: new Date().toISOString(),
        students: studentsList,
      };
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
      process.stdout.write(
        `\n${okCount} downloaded, ${cachedCount} cached, ${failedCount} failed. ` +
        `Manifest at ${manifestPath}\n`,
      );
      if (failedCount) process.exit(1);
    });
}
