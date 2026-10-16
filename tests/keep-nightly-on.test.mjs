// scripts/keep-nightly-on.sh: work owed keeps the nightly on (review
// 2026-10-16, R7-13). Run for real, with the queue's own count and a `gh` that
// records what it was asked.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { GITHUB_API_VERSION } from "../lib/github-api-version.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "scripts", "keep-nightly-on.sh");

function run({ deadline, state = "published" }) {
  const dir = mkdtempSync(join(tmpdir(), "pxl-keep-on-"));
  const control = join(dir, "control");
  mkdirSync(join(control, "assignments"), { recursive: true });
  writeFileSync(join(control, "assignments", "exam.yml"), `state: ${state}\ndeadline_at: "${deadline}"\n`);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const asked = join(dir, "gh-calls.txt");
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env bash\necho "$*" >> "${asked.replace(/\\/g, "/")}"\n`);
  chmodSync(join(bin, "gh"), 0o755);
  const res = spawnSync("bash", [script.replace(/\\/g, "/"), "control", "O"], {
    cwd: dir, encoding: "utf8",
    env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, GITHUB_REPOSITORY: "hub/hub", GITHUB_API_VERSION },
  });
  return { res, calls: existsSync(asked) ? readFileSync(asked, "utf8") : "" };
}

test("an assignment still active switches the nightly on", () => {
  const { res, calls } = run({ deadline: new Date(Date.now() + 86400_000).toISOString() });
  assert.equal(res.status, 0, res.stderr);
  assert.match(calls, /--method PUT repos\/hub\/hub\/actions\/workflows\/daily-activity\.yml\/enable/);
  assert.ok(calls.includes(`X-GitHub-Api-Version: ${GITHUB_API_VERSION}`), "the pinned version is sent");
});

test("an assignment past its deadline with no lock is owed a finalize, so the nightly comes on too", () => {
  const { calls } = run({ deadline: "2026-10-15T10:00:00Z" });
  assert.match(calls, /daily-activity\.yml\/enable/);
});

test("nothing owed asks GitHub nothing", () => {
  // A draft that never went live: no students, no broker, nothing to lock.
  const { res, calls } = run({ deadline: "2026-10-15T10:00:00Z", state: "draft" });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(calls, "");
});

test("both callers run it under continue-on-error, on a token that may enable a workflow", () => {
  for (const [file, job] of [["regenerate-dashboard.yml", "generate"], ["deadline-sentinel.yml", "arm"]]) {
    const wf = parse(readFileSync(join(root, ".github", "workflows", file), "utf8"));
    const step = wf.jobs[job].steps.find((s) => String(s.run ?? "").includes("scripts/keep-nightly-on.sh"));
    assert.ok(step, `${file}: the step`);
    assert.equal(step["continue-on-error"], true, `${file}: never fails the job it rides in`);
    assert.equal(wf.jobs[job].permissions?.actions, "write", `${file}: actions: write`);
    assert.equal(wf.jobs[job].permissions?.contents, "read", `${file}: contents restated`);
  }
});
