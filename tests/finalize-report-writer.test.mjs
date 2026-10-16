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
const scoresCommit = workflow("daily-activity.yml").jobs.finalize.steps.find((s) => s.name === "Commit + push the scores");

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
  // The assignment itself: the commit step asks the branch whether it still
  // exists before committing anything of it (R7-17).
  put(seed, "assignments/a1.yml", "state: published\n");
  git(["add", "-A"], seed);
  git(["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-m", "seed"], seed);
  git(["push", fileUrl(remote), "main"], seed);

  git(["clone", "-q", fileUrl(remote), "control"], dir);
  mkdirSync(join(dir, "scripts"));
  copyFileSync(join(root, "scripts/git-push-with-retry.sh"), join(dir, "scripts/git-push-with-retry.sh"));
  copyFileSync(join(root, "scripts/git-fetch-with-retry.sh"), join(dir, "scripts/git-fetch-with-retry.sh"));
  copyFileSync(join(root, "scripts/assignment-on-branch.sh"), join(dir, "scripts/assignment-on-branch.sh"));

  const regen = join(dir, "regen");
  git(["clone", "-q", fileUrl(remote), regen], dir);
  // What `steps.start` records: the commit the job checked out.
  const start = git(["rev-parse", "HEAD"], join(dir, "control"));
  return { dir, remote, control: join(dir, "control"), regen, start };
}

/** The assignment deleted on the branch while finalize runs (R7-17). */
function deleteAssignment({ regen }) {
  git(["pull", "-q", "--rebase"], regen);
  git(["rm", "-q", "-r", "assignments/a1.yml", "lockdowns/a1", "observations/a1"], regen);
  git(["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "Delete a1"], regen);
  git(["push", "-q", "origin", "main"], regen);
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

/** The runner's own files, shared by every step of the job. */
function runnerEnv({ dir }) {
  const temp = join(dir, "runner-temp");
  mkdirSync(temp, { recursive: true });
  return { RUNNER_TEMP: temp, GITHUB_OUTPUT: join(dir, "github-output") };
}

function runStep(fx, step, name, extra = {}) {
  const script = join(fx.dir, name);
  writeFileSync(script, step.run);
  return spawnSync("sh", [script], {
    cwd: fx.dir,
    encoding: "utf8",
    env: { ...process.env, ...runnerEnv(fx), ASSIGNMENT_ID: "a1", MAX_RETRIES: "2", ...extra },
  });
}

const runCommitStep = (fx) => runStep(fx, finalizeCommit, "step.sh");

/** The scores step, given the commit the job checked out (`steps.start`). */
function runScoresStep(fx) {
  return runStep(fx, scoresCommit, "scores.sh", { START: fx.start });
}

/** Someone else's commit landing on the remote meanwhile (a lecturer's save). */
function otherCommits({ regen }, path, body) {
  git(["pull", "-q", "--rebase"], regen);
  put(regen, path, body);
  git(["add", path], regen);
  git(["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", `Save ${path}`], regen);
  git(["push", "-q", "origin", "main"], regen);
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
    assert.match(git(["log", "-1", "--format=%s", "main"], fx.remote), /^Finalize deadline for a1$/);
    assert.deepEqual(
      git(["show", "--name-only", "--format=", "main"], fx.remote).split("\n").filter((p) => p.startsWith("grading/")),
      [],
      "the scores are not in the finalize commit (R6-8)",
    );

    // ...and the scores follow, in a commit of their own.
    const scores = runScoresStep(fx);
    assert.equal(scores.status, 0, `${scores.stdout}\n${scores.stderr}`);
    assert.equal(atRemote(fx, "grading/a1/summary.json"), "{}");
    assert.match(git(["log", "-1", "--format=%s", "main"], fx.remote), /^Scores at the deadline for a1$/);

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

test("R6-8: a lecturer's score save at the deadline no longer fails the lock record's push, and it is kept", () => {
  // The case: Read all scores again pressed at the deadline wrote
  // grading/a1/summary.json while finalize ran. One commit carried both, the
  // rebase conflicted, and nothing finalize knew reached the remote.
  const fx = fixture();
  try {
    finalizeWrites(fx);
    otherCommits(fx, "grading/a1/summary.json", '{"by":"lecturer"}\n');
    const res = runCommitStep(fx);
    assert.equal(res.status, 0, `the deadline is not red:\n${res.stdout}\n${res.stderr}`);
    assert.equal(atRemote(fx, "lockdowns/a1/lockdown-record.json"), '{"outcome":"locked"}');
    assert.equal(atRemote(fx, "observations/a1/ann/preservation.json"), '{"verified":true}');

    const scores = runScoresStep(fx);
    assert.equal(scores.status, 0, `${scores.stdout}\n${scores.stderr}`);
    assert.match(scores.stdout, /::notice::The scores or a grading decision for a1 were saved while this ran/);
    assert.equal(atRemote(fx, "grading/a1/summary.json"), '{"by":"lecturer"}', "the lecturer's read stands");
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("R6-8: a grading decision saved while finalize ran keeps this reading from being written over it", () => {
  // The reading used the checkout's overrides/, minutes old: a score by hand
  // set meanwhile would be replaced by the rules' score.
  const fx = fixture();
  try {
    finalizeWrites(fx);
    const res = runCommitStep(fx);
    assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
    otherCommits(fx, "overrides/a1/ann.json", '{"decision":"manual"}\n');
    const scores = runScoresStep(fx);
    assert.equal(scores.status, 0, `${scores.stdout}\n${scores.stderr}`);
    assert.match(scores.stdout, /::notice::/);
    assert.throws(() => atRemote(fx, "grading/a1/summary.json"), "nothing written");
    // Another assignment's decision is not this one's.
    const fy = fixture();
    try {
      finalizeWrites(fy);
      assert.equal(runCommitStep(fy).status, 0);
      otherCommits(fy, "overrides/a10/ann.json", "{}\n");
      assert.equal(runScoresStep(fy).status, 0);
      assert.equal(atRemote(fy, "grading/a1/summary.json"), "{}");
    } finally {
      rmSync(fy.dir, { recursive: true, force: true });
    }
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("R7-17: an assignment deleted while finalize ran is not put back by its commit", () => {
  const fx = fixture();
  try {
    finalizeWrites(fx);
    deleteAssignment(fx);
    const head = git(["rev-parse", "main"], fx.remote);
    const res = runCommitStep(fx);
    assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
    assert.match(res.stdout, /a1 was deleted while this ran, so nothing of it is committed/);
    assert.equal(git(["rev-parse", "main"], fx.remote), head, "nothing pushed");
    assert.throws(() => git(["cat-file", "-e", "main:lockdowns/a1/lockdown-record.json"], fx.remote), "the directory stays deleted");
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

// R7-26: the fetch that asks whether it was deleted is retried, and one that
// never answers commits as before rather than failing the lock record's push.
// The fetch URL points nowhere; the push URL is the remote.
function fetchNowhere(fx) {
  git(["remote", "set-url", "origin", fileUrl(join(fx.dir, "nowhere.git"))], fx.control);
  git(["remote", "set-url", "--push", "origin", fileUrl(fx.remote)], fx.control);
}

test("R7-26: a fetch that never answers commits the finalize as before, and says so", () => {
  const fx = fixture();
  try {
    finalizeWrites(fx);
    fetchNowhere(fx);
    const res = runStep(fx, finalizeCommit, "step.sh", { FETCH_TRIES: "1" });
    assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
    assert.match(res.stdout, /fetch gave up after 1 tries/);
    assert.match(res.stdout, /::warning::Could not ask GitHub whether a1 still exists, so it is committed as before/);
    assert.equal(atRemote(fx, "lockdowns/a1/lockdown-record.json"), '{"outcome":"locked"}');
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

// R7-31 (step-back review): the lock record is committed the moment lockdown
// writes it, so the publish's release - which asks GitHub - finds it.
const lockRecordStep = workflow("daily-activity.yml").jobs.finalize.steps.find((s) => s.name === "2b. Commit the lock record");

test("R7-31: step 2b pushes the lock record alone, over collect's observations still in the checkout", () => {
  const fx = fixture();
  try {
    // A reopen on the branch, which this lock ends (R7-29).
    otherCommits(fx, "lockdowns/a1/unlocked/ann.json", '{"unlocked_at":"2026-10-16T10:00:00Z"}\n');
    git(["pull", "-q", "--rebase"], fx.control);
    rmSync(join(fx.control, "lockdowns/a1/unlocked/ann.json"));
    // What collect and lockdown leave: a new observation, a changed tracked
    // one, the lock record and the reopen it ended, kept.
    put(fx.control, "observations/a1/ann/2026-10-16T17-00-00Z.json", '{"collect":true}\n');
    put(fx.control, "observations/a1/ann/2026-09-27T01-00-00Z.json", '{"rewritten":true}\n');
    put(fx.control, "lockdowns/a1/lockdown-record.json", '{"outcome":"locked"}\n');
    put(fx.control, "lockdowns/a1/relocked/ann/2026-10-16T17-00-00Z.json", '{"relocked_by":"pxl-classroom[bot]"}\n');
    otherCommits(fx, "students/roster.yml", "students: []\n");
    const res = runStep(fx, lockRecordStep, "lock.sh");
    assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
    assert.equal(atRemote(fx, "lockdowns/a1/lockdown-record.json"), '{"outcome":"locked"}');
    assert.match(git(["log", "-1", "--format=%s", "main"], fx.remote), /^Lock record for a1$/);
    assert.deepEqual(git(["show", "--name-only", "--format=", "main"], fx.remote).split("\n").filter(Boolean).sort(),
      ["lockdowns/a1/lockdown-record.json", "lockdowns/a1/relocked/ann/2026-10-16T17-00-00Z.json", "lockdowns/a1/unlocked/ann.json"], "the lock record and nothing of collect's");
    assert.throws(() => atRemote(fx, "lockdowns/a1/unlocked/ann.json"), "the ended reopen is removed on the branch");
    // Line endings aside: the autostash re-applies it through git's own checkout.
    assert.equal(readFileSync(join(fx.control, "observations/a1/ann/2026-09-27T01-00-00Z.json"), "utf8").replace(/\r\n/g, "\n"), '{"rewritten":true}\n', "collect's change survives the rebase");
    // ...and the commit after preserve carries the rest, over it.
    const rest = runCommitStep(fx);
    assert.equal(rest.status, 0, `${rest.stdout}\n${rest.stderr}`);
    assert.equal(atRemote(fx, "observations/a1/ann/2026-10-16T17-00-00Z.json"), '{"collect":true}');
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("R7-31: step 2b commits nothing for an assignment deleted meanwhile, nor where lockdown wrote no record", () => {
  const gone = fixture();
  try {
    put(gone.control, "lockdowns/a1/lockdown-record.json", '{"outcome":"locked"}\n');
    deleteAssignment(gone);
    const head = git(["rev-parse", "main"], gone.remote);
    assert.equal(runStep(gone, lockRecordStep, "lock.sh").status, 0);
    assert.equal(git(["rev-parse", "main"], gone.remote), head);
  } finally {
    rmSync(gone.dir, { recursive: true, force: true });
  }
  const none = fixture();
  try {
    const head = git(["rev-parse", "main"], none.remote);
    assert.equal(runStep(none, lockRecordStep, "lock.sh").status, 0);
    assert.equal(git(["rev-parse", "main"], none.remote), head);
  } finally {
    rmSync(none.dir, { recursive: true, force: true });
  }
});

// R7-39: deleted, the checkout is left clean and the scores step told so.
test("R7-39: lockdown's deleted commits nothing even when the branch cannot be asked, and leaves the checkout clean", () => {
  const fx = fixture();
  try {
    finalizeWrites(fx);
    fetchNowhere(fx);
    const head = git(["rev-parse", "main"], fx.remote);
    const res = runStep(fx, finalizeCommit, "step.sh", { LOCKDOWN_OUTCOME: "deleted", FETCH_TRIES: "1" });
    assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
    assert.equal(git(["rev-parse", "main"], fx.remote), head, "nothing pushed");
    assert.equal(git(["status", "--porcelain"], fx.control), "", "nothing left for a later pull to trip over");
    assert.match(readFileSync(runnerEnv(fx).GITHUB_OUTPUT, "utf8"), /^deleted=true$/m);
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("R7-31/R7-26/R7-39: the step layout - 2b after lockdown, no second lockdown, steps 3 to 6 skip deleted, the scores skip a deleted exit", () => {
  const steps = workflow("daily-activity.yml").jobs.finalize.steps;
  const names = steps.map((s) => s.name);
  assert.equal(names.indexOf("2b. Commit the lock record"), names.indexOf("2. Lockdown") + 1);
  assert.equal(steps.filter((s) => s.uses === "./lockdown").length, 1, "one lockdown: it asks again itself before it writes");
  assert.equal(steps.find((s) => s.name === "2. Lockdown").id, "lockdown");
  for (const name of ["3. Preserve", "4. Report", "5. Close acceptance on the broker", "6a. Token for reading scores", "6. Read autograding scores", "2b. Commit the lock record"]) {
    assert.match(String(steps.find((s) => s.name === name)?.if), /steps\.lockdown\.outputs\.outcome != 'deleted'/, name);
  }
  assert.match(String(scoresCommit.if), /steps\.commit\.outputs\.deleted != 'true'/);
  assert.equal(scoresCommit.env.START, "${{ steps.start.outputs.sha }}", "a save is judged against the checkout, not the lock record's commit");
});

test("R6-8: no reading, no scores commit", () => {
  const fx = fixture();
  try {
    put(fx.control, "lockdowns/a1/lockdown-record.json", '{"outcome":"locked"}\n');
    assert.equal(runCommitStep(fx).status, 0);
    const head = git(["rev-parse", "main"], fx.remote);
    const scores = runScoresStep(fx);
    assert.equal(scores.status, 0, `${scores.stdout}\n${scores.stderr}`);
    assert.equal(git(["rev-parse", "main"], fx.remote), head);
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
