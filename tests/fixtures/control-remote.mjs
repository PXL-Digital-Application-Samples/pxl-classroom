// A control repository in a bare git "remote", and hub runs against it.
//
// Used by tests/acceptance-race.test.mjs to run the real acceptance pipeline -
// acceptance/reserve.mjs (around the real accept.mjs) and
// scripts/record-acceptance.sh - as many concurrent processes, the way
// GitHub runs them once nothing serialises acceptances. Provisioning is the one
// stand-in: it needs GitHub, and its outcome is all the record step reads.
//
// GitHub misbehaving is modelled at the git layer, where the pipeline meets it:
//   flaky(remote)       - the server refuses pushes (a pre-receive hook)
//   lostAnswer(dir)     - a push lands but the client is told it failed (a
//                         pre-push hook that pushes, then fails)

import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function configure(dir) {
  git(dir, "config", "user.name", "test");
  git(dir, "config", "user.email", "test@users.noreply.github.com");
  git(dir, "config", "commit.gpgsign", "false");
}

function writeFiles(dir, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), typeof content === "string" ? content : JSON.stringify(content, null, 2) + "\n");
  }
}

/** A bare remote holding these files on `main`. */
export function remoteWith(files) {
  const remote = mkdtempSync(join(tmpdir(), "pxl-remote-"));
  git(remote, "init", "-q", "--bare", "-b", "main");
  const seed = mkdtempSync(join(tmpdir(), "pxl-seed-"));
  git(seed, "clone", "-q", remote, ".");
  configure(seed);
  git(seed, "checkout", "-q", "-b", "main");
  writeFiles(seed, files);
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "seed");
  git(seed, "push", "-q", "origin", "main");
  return remote;
}

/**
 * A runner's checkout. SHALLOW, as actions/checkout makes it (fetch-depth 1),
 * because the pipeline's fetch, diff and rebase must work on one.
 */
export function checkout(remote) {
  const dir = mkdtempSync(join(tmpdir(), "pxl-checkout-"));
  git(dir, "clone", "-q", "--depth", "1", `file://${remote.replace(/\\/g, "/")}`, ".");
  configure(dir);
  return dir;
}

/** The server refuses every `every`-th push - GitHub failing some of the time. */
export function flaky(remote, { every = 2 } = {}) {
  const hook = join(remote, "hooks", "pre-receive");
  const counter = join(remote, "push-count");
  writeFileSync(counter, "0");
  writeFileSync(
    hook,
    [
      "#!/bin/sh",
      `n=$(cat "${counter.replace(/\\/g, "/")}" 2>/dev/null || echo 0)`,
      "n=$((n + 1))",
      `echo "$n" > "${counter.replace(/\\/g, "/")}"`,
      `if [ $((n % ${every})) -eq 0 ]; then echo "simulated GitHub error" >&2; exit 1; fi`,
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(hook, 0o755);
}

/**
 * The next push from this checkout LANDS, and the client is told it failed -
 * a connection lost after GitHub updated the branch. Once only.
 */
export function lostAnswer(dir) {
  const hooks = join(dir, ".git", "hooks");
  mkdirSync(hooks, { recursive: true });
  const marker = join(dir, ".git", "lost-answer-done").replace(/\\/g, "/");
  const hook = join(hooks, "pre-push");
  writeFileSync(
    hook,
    [
      "#!/bin/sh",
      `[ -f "${marker}" ] && exit 0`,
      `touch "${marker}"`,
      // The real push, past this very hook, then a failure for the outer one.
      'git push --no-verify -q "$1" HEAD:refs/heads/main || exit 0',
      'echo "simulated: connection lost after the push" >&2',
      "exit 1",
      "",
    ].join("\n"),
  );
  chmodSync(hook, 0o755);
}

export function remoteJson(remote, path) {
  const r = spawnSync("git", ["--git-dir", remote, "show", `main:${path}`], { encoding: "utf8" });
  return r.status === 0 ? JSON.parse(r.stdout) : null;
}

/** Every JSON document under a directory on the remote's main, by file name. */
export function remoteDir(remote, dir) {
  const r = spawnSync("git", ["--git-dir", remote, "ls-tree", "--name-only", `main:${dir}`], { encoding: "utf8" });
  if (r.status !== 0) return {};
  const out = {};
  for (const name of r.stdout.split("\n").filter((n) => n.endsWith(".json"))) out[name.slice(0, -5)] = remoteJson(remote, `${dir}/${name}`);
  return out;
}

function run(cmd, args, { cwd, env }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env });
    let log = "";
    child.stdout.on("data", (d) => (log += d));
    child.stderr.on("data", (d) => (log += d));
    child.on("close", (status) => resolve({ status, log }));
  });
}

function outputsOf(file) {
  const outputs = {};
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return outputs;
  }
  for (const line of text.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) outputs[line.slice(0, i)] = line.slice(i + 1);
  }
  return outputs;
}

let runSeq = 1000;

// A HUB RUN HAS NO GIT IDENTITY, so neither does one here. The scripts under
// test name theirs on every command that writes a commit; one that does not
// fails on a runner with "Committer identity unknown" and passed here, in CI
// too, because `configure()` above gives every checkout one - which the
// workflow's checkout never has. acceptance/reserve.mjs
// replayed its decision with a bare `git rebase`, which failed on every runner,
// so every refused push was decided again and a lab's burst cut one student's
// acceptance off after fifteen minutes (2026-11-13).
//
// Only the identity is taken away, through environment config, which outranks
// every config file (the checkout's own included) and is outranked by a
// command's own `-c`: an empty name is refused, and `useConfigOnly` stops git
// guessing an address from the host name. The rest of the config stays -
// dropping ~/.gitconfig whole also dropped Windows' `core.autocrlf`, and every
// run then read the roster as changed by every other.
//
// Built per run from the environment as it is then: a test points the scripts
// at its GitHub stub through process.env after this module has loaded.
const withoutIdentity = () => {
  const env = { ...process.env };
  for (const k of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "EMAIL"]) delete env[k];
  return {
    ...env,
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_0: "user.name",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "user.email",
    GIT_CONFIG_VALUE_1: "",
    GIT_CONFIG_KEY_2: "user.useConfigOnly",
    GIT_CONFIG_VALUE_2: "true",
  };
};

/**
 * One hub run, as acceptance-handler.yml makes it: decide and save, then -
 * when admitted - a provisioning stand-in, then the record script.
 *
 * `onProvisioned(repo)` is called when the stand-in "creates" the repository,
 * BEFORE the record step - so a GitHub stub can start answering that it exists
 * while no record names it yet. That window is real (a minute, measured live)
 * and the stub without it hid a defect: two students creating one team at the
 * same moment, the second refused over the first's new repository.
 *
 * @returns {Promise<{login, issue, runId, outcome, recorded, log}>}
 */
export async function hubRun({ remote, org, assignmentId, login, githubId, issue, team, action = "join", env = {}, prepare, onProvisioned }) {
  const dir = checkout(remote);
  if (prepare) prepare(dir);
  const runId = String(++runSeq);
  const scratch = mkdtempSync(join(tmpdir(), "pxl-run-"));
  const out = join(scratch, "out.env");
  writeFileSync(out, "");
  const base = { ...withoutIdentity(), GITHUB_RUN_ID: runId, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: join(scratch, "summary") };

  const decided = await run("node", [join(root, "acceptance", "reserve.mjs")], {
    cwd: root,
    env: {
      ...base,
      ORG: org,
      DATA_DIR: dir,
      ASSIGNMENT_ID: assignmentId,
      GITHUB_LOGIN: login,
      GITHUB_ID: String(githubId),
      ...(issue ? { ISSUE_NUMBER: String(issue) } : {}),
      ...(team ? { TEAM_SLUG: team, TEAM_NAME: team, TEAM_ACTION: action } : {}),
      ...env,
    },
  });
  const outputs = outputsOf(out);
  const result = { login, issue, runId, outcome: outputs.outcome, recorded: false, log: decided.log, status: decided.status };
  if (outputs.outcome !== "accepted" && outputs.outcome !== "already-accepted") return result;

  // Provisioning stand-in: the team's repository, which is what the record
  // step writes - deterministic per repository name, as a real id is.
  const repo = outputs.target_repo;
  const repoId = [...repo].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 1_000_000_007, 7);
  if (onProvisioned) await onProvisioned(repo);
  // Provisioning takes seconds on GitHub; the window between the repository
  // existing and its record landing is what a teammate's run can fall into.
  await new Promise((r) => setTimeout(r, 1500));
  const recorded = await run("bash", [join(root, "scripts", "record-acceptance.sh")], {
    cwd: root,
    env: {
      ...base,
      DATA_DIR: dir,
      ASSIGNMENT_ID: assignmentId,
      LOGIN: login,
      TEAM_SLUG: outputs.team_slug || "",
      OUTCOME: "reused",
      ORG: org,
      TARGET_REPO: repo,
      REPO_ID: String(repoId),
      REPO_URL: `https://github.com/${org}/${repo}`,
      BASELINE_SHA: "",
      STUDENT_PERMISSION: "push",
      RUN_URL: `https://github.com/hub/actions/runs/${runId}`,
      COMMIT_LABEL: "Provision",
    },
  });
  return { ...result, recorded: recorded.status === 0, log: result.log + recorded.log, recordStatus: recorded.status };
}
