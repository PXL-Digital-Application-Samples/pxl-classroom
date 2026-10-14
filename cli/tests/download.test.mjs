// `pxl-classroom download`, run for real: the GitHub API mocked, the archive a
// real local repository that git is pointed at.
//
// Nothing ran this command before 2026-10-14, and it could not have worked: it
// read `reports/undefined.json` (getReport called with the wrong arguments)
// and handed git the stored token OBJECT as the credential. Found while adding
// the full history a git exercise is graded on (review 2026-10-14, S8).

import { test } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { registerDownloadCommand } from "../src/commands/download.mjs";
import { archiveRepoName } from "../../lib/archive-repo.mjs";

const ARCHIVE = archiveRepoName("a1");

const git = (args, cwd) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
};

test("download fetches each preserved submission; a full-history one with its whole history", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "pxl-download-"));
  const home = join(tmp, "home");
  mkdirSync(home);
  const archive = join(tmp, "archive");
  mkdirSync(archive);
  git(["init", "-q", "-b", "main"], archive);
  git(["config", "user.email", "t@example.test"], archive);
  git(["config", "user.name", "T"], archive);
  for (const n of [1, 2, 3]) {
    writeFileSync(join(archive, "f.txt"), `v${n}\n`);
    git(["add", "f.txt"], archive);
    git(["commit", "-q", "-m", `c${n}`], archive);
  }
  git(["branch", "preserved/a1/ann"], archive);
  git(["branch", "preserved/a1/bo"], archive);
  const sha = git(["rev-parse", "HEAD"], archive);

  // The plain URL is what the command asks git for; this points it here.
  writeFileSync(join(home, ".gitconfig"), `[url "file://${archive.replace(/\\/g, "/")}"]\n    insteadOf = https://github.com/TestOrg/${ARCHIVE}.git\n`);
  mkdirSync(join(home, "pxl-classroom"), { recursive: true });
  writeFileSync(join(home, "pxl-classroom", "token"), JSON.stringify({ access_token: "fake", obtained_at: new Date().toISOString() }));

  const report = {
    students: [
      { github_login: "ann", preservation_status: "preserved", preserved_sha: sha, archive_repo: `TestOrg/${ARCHIVE}`, archive_ref: "preserved/a1/ann" },
      { github_login: "bo", preservation_status: "preserved", preserved_sha: sha, archive_repo: `TestOrg/${ARCHIVE}`, archive_ref: "preserved/a1/bo", full_history: true },
    ],
  };
  const requested = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = url.toString();
    requested.push(u);
    if (u === "https://api.github.com/repos/TestOrg/pxl-classroom-control/contents/reports%2Fa1.json") {
      return new Response(JSON.stringify({ content: Buffer.from(JSON.stringify(report)).toString("base64") }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("Not Found", { status: 404 });
  };
  const env = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, APPDATA: process.env.APPDATA, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  let out = "";
  const write = process.stdout.write;
  try {
    Object.assign(process.env, { HOME: home, USERPROFILE: home, APPDATA: home, XDG_CONFIG_HOME: home, GIT_TERMINAL_PROMPT: "0" });
    process.stdout.write = (c) => { out += c; return true; };
    const program = new Command();
    program.exitOverride();
    registerDownloadCommand(program);
    const dir = join(tmp, "subs");
    await program.parseAsync(["node", "pxl", "download", "--org", "TestOrg", "--assignment", "a1", "--dir", dir, "--concurrency", "1"]);
    process.stdout.write = write;
    assert.ok(requested.some((u) => u.endsWith("reports%2Fa1.json")), `the report is read by its own path: ${requested.join(", ")}`);
    assert.match(out, /\+ ann: /);
    assert.match(out, /\+ bo: /);
    // One commit for an ordinary submission, the whole history for a git exercise.
    assert.equal(git(["rev-list", "--count", "HEAD"], join(dir, "ann")), "1");
    assert.equal(git(["rev-list", "--count", "HEAD"], join(dir, "bo")), "3");
    // And no credential in any working directory's config.
    for (const l of ["ann", "bo"]) assert.doesNotMatch(readFileSync(join(dir, l, ".git", "config"), "utf8"), /fake|AUTHORIZATION/i);
  } finally {
    process.stdout.write = write;
    globalThis.fetch = originalFetch;
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
