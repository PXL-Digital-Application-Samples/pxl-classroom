// PXL Classroom - finalize-report-writer.test.mjs
//
// reports/ has ONE git writer, regenerate-dashboard.yml, and the finalize
// commit carries only the sources a report is derived from.
//
// Measured on a live drill, 2026-09-27: the sentinel fired twice, the second
// finalize ran (serialised behind the first) while regenerate-dashboard.yml
// committed six times, and its push rebased into
//   CONFLICT (content): Merge conflict in reports/drill-20260927-0120.json
// Lock, archive and report were all correct afterwards; the deadline went red.
// report.mjs stamps `generated_at`, so two runs over identical sources still
// write different bytes - any overlap between two writers is a conflict.
//
// These tests run the finalize job's real `Commit + push` step against real git
// repositories, replaying that race, rather than grepping the step for a word.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const workflow = (name) => parse(readFileSync(join(root, ".github/workflows", name), "utf8"));

const finalizeCommit = workflow("daily-activity.yml").jobs.finalize.steps.find((s) => s.name === "Commit + push");

const git = (args, cwd) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
const fileUrl = (p) => `file:///${p.replace(/\\/g, "/").replace(/^\//, "")}`;
const put = (base, rel, body) => {
  mkdirSync(dirname(join(base, rel)), { recursive: true });
  writeFileSync(join(base, rel), body);
};
const report = (stamp) => JSON.stringify({ assignment_id: "a1", generated_at: stamp, students: [] }, null, 2) + "\n";

/**
 * A remote control repository, the finalize job's checkout of it (`control`,
 * beside a copy of scripts/git-push-with-retry.sh, as on the runner), and a
 * second clone standing in for regenerate-dashboard.yml.
 */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "pxl-finalize-"));
  const remote = join(dir, "remote.git");
  mkdirSync(remote);
  git(["init", "--bare", "--initial-branch=main", "."], remote);

  const seed = join(dir, "seed");
  mkdirSync(seed);
  git(["init", "--initial-branch=main", "."], seed);
  put(seed, "reports/a1.json", report("2026-09-27T01:30:00Z"));
  put(seed, "reports/dashboard.json", "{}\n");
  put(seed, "observations/a1/ann/2026-09-27T01-00-00Z.json", "{}\n");
  put(seed, "lockdowns/a1/.gitkeep", "");
  git(["add", "-A"], seed);
  git(["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-m", "seed"], seed);
  git(["push", fileUrl(remote), "main"], seed);

  git(["clone", "-q", fileUrl(remote), "control"], dir);
  mkdirSync(join(dir, "scripts"));
  copyFileSync(join(root, "scripts/git-push-with-retry.sh"), join(dir, "scripts/git-push-with-retry.sh"));

  const regen = join(dir, "regen");
  git(["clone", "-q", fileUrl(remote), regen], dir);
  return { dir, remote, control: join(dir, "control"), regen };
}

/** regenerate-dashboard.yml landing a commit while finalize is still running. */
function regenerateCommits({ regen }, stamp) {
  put(regen, "reports/a1.json", report(stamp));
  put(regen, "reports/a1.csv", `login\n# ${stamp}\n`);
  put(regen, "reports/dashboard.json", `{"generated_at":"${stamp}"}\n`);
  git(["add", "reports/"], regen);
  git(["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", `Regenerate ${stamp}`], regen);
  git(["push", "-q", "origin", "main"], regen);
}

/** Everything finalize steps 1-6 leave in the checkout before its commit. */
function finalizeWrites({ control }) {
  put(control, "observations/a1/ann/2026-09-27T01-38-00Z.json", '{"final":true}\n');
  put(control, "observations/a1/ann/preservation.json", '{"verified":true}\n');
  put(control, "lockdowns/a1/lockdown-record.json", '{"outcome":"locked"}\n');
  put(control, "grading/a1/summary.json", "{}\n");
  put(control, "reports/a1.json", report("2026-09-27T01:38:30Z"));
  put(control, "reports/a1.csv", "login\n# finalize\n");
  put(control, "reports/dashboard.json", '{"generated_at":"2026-09-27T01:38:30Z"}\n');
}

function runCommitStep({ dir }) {
  const script = join(dir, "step.sh");
  writeFileSync(script, finalizeCommit.run);
  return spawnSync("sh", [script], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, ASSIGNMENT_ID: "a1", MAX_RETRIES: "2" },
  });
}

const atRemote = ({ remote }, path) => git(["show", `main:${path}`], remote);

test("the finalize commit step is found, and is a run: block", () => {
  // Every test below runs this step; a renamed step must fail here, loudly,
  // rather than make them run `undefined`.
  assert.ok(finalizeCommit, "daily-activity.yml finalize must have a `Commit + push` step");
  assert.equal(typeof finalizeCommit.run, "string");
});

test("finalize pushes its sources over a report regenerate-dashboard rewrote meanwhile (2026-09-27)", () => {
  const fx = fixture();
  try {
    finalizeWrites(fx);
    regenerateCommits(fx, "2026-09-27T01:38:21Z");
    const res = runCommitStep(fx);
    assert.equal(res.status, 0, `the step must succeed:\n${res.stdout}\n${res.stderr}`);
    assert.doesNotMatch(res.stderr, /conflicted/);

    // What only finalize knows reached the remote.
    assert.equal(atRemote(fx, "lockdowns/a1/lockdown-record.json"), '{"outcome":"locked"}');
    assert.equal(atRemote(fx, "observations/a1/ann/preservation.json"), '{"verified":true}');
    assert.equal(atRemote(fx, "observations/a1/ann/2026-09-27T01-38-00Z.json"), '{"final":true}');
    assert.equal(atRemote(fx, "grading/a1/summary.json"), "{}");
    assert.match(git(["log", "-1", "--format=%s", "main"], fx.remote), /^Finalize deadline for a1$/);

    // And nothing under reports/ came from finalize: the regeneration's copy
    // stands until the one trigger-dashboard dispatches rebuilds it.
    // reports/a1.csv is the untracked case: the seed has none, both sides add
    // one, and a leftover would stop `git pull --rebase` with "untracked
    // working tree files would be overwritten" - no unmerged path, no dirty
    // tracked file, so five identical refused pulls.
    assert.match(atRemote(fx, "reports/a1.json"), /01:38:21Z/);
    assert.match(atRemote(fx, "reports/a1.csv"), /01:38:21Z/);
    assert.match(atRemote(fx, "reports/dashboard.json"), /01:38:21Z/);
    assert.deepEqual(
      git(["show", "--name-only", "--format=", "main"], fx.remote).split("\n").filter((p) => p.startsWith("reports/")),
      [],
      "the finalize commit touches no path under reports/",
    );
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("with no concurrent writer, finalize still commits no report", () => {
  // Not "only when it would conflict": a second writer is a race waiting for
  // its overlap, and the overlap is exactly a deadline.
  const fx = fixture();
  try {
    finalizeWrites(fx);
    const res = runCommitStep(fx);
    assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
    assert.match(atRemote(fx, "reports/a1.json"), /01:30:00Z/);
    assert.equal(atRemote(fx, "lockdowns/a1/lockdown-record.json"), '{"outcome":"locked"}');
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("regenerate-dashboard.yml is the git writer of reports/, and it runs after every finalize", () => {
  // Discarding the report is right only because this holds: the owner rebuilds
  // it from the sources finalize pushed. Break either half and the report is
  // stale after a deadline with nothing red.
  const regen = workflow("regenerate-dashboard.yml").jobs.generate;
  const commit = regen.steps.find((s) => s.name === "Commit public data and reports");
  assert.match(commit.run, /git -C control add[^\n]*\breports\//);
  assert.equal(regen.concurrency.group, "dashboard-${{ matrix.org }}");

  const daily = workflow("daily-activity.yml").jobs;
  assert.deepEqual(daily["trigger-dashboard"].needs.includes("finalize"), true);
  assert.equal(daily["trigger-dashboard"].if, "always()");
  assert.match(daily["trigger-dashboard"].steps.at(-1).with.script, /workflow_id: 'regenerate-dashboard\.yml'/);

  // No other job in the nightly stages reports/.
  for (const [name, job] of Object.entries(daily)) {
    for (const step of job.steps || []) {
      if (typeof step.run !== "string") continue;
      for (const line of step.run.split("\n").filter((l) => /\bgit\b.*\badd\b/.test(l))) {
        assert.doesNotMatch(line, /reports|-A\b|\s\.\s*$/, `${name} / ${step.name} stages reports/: ${line.trim()}`);
      }
    }
  }
});
