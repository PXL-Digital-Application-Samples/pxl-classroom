// A refused retry changes nothing.
//
// retry-acceptance.yml removes the student's acceptance record so accept.mjs
// runs every gate again rather than leaving through `already-accepted`. It
// used to COMMIT AND PUSH that removal before the gates ran. Measured on the
// testbed, drill-20260927-0146: after the deadline the drill's Retry for a
// locked, preserved, on-time student pushed "Reset acceptance state ...
// (manual retry)", then accept.mjs refused the student because the repository
// is frozen (correct, exit 0) - and the next regeneration reported the student
// as `no-submission`. A rejection is an outcome; it may not also be a write.
//
// Two halves, each tested against the real thing:
//   * the workflow: nothing reaches the control repository's remote unless
//     accept.mjs admitted the student, and the step that removes the record
//     never commits it;
//   * the report: a missing acceptance record does not erase a repository
//     record, observations and a preservation that say the student submitted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const steps = parse(readFileSync(join(root, ".github", "workflows", "retry-acceptance.yml"), "utf8")).jobs.retry.steps;

// Anything that can put a commit on the control repository's remote. The record
// script commits and pushes, so running it counts.
const WRITES_REMOTE = /git-push-with-retry|record-acceptance\.sh|git\s+(-C\s+\S+\s+)?push\b|git\s+(-C\s+\S+\s+)?commit\b/;
const ADMITTED = /steps\.accept\.outputs\.outcome\s*==\s*'accepted'/;

test("the record is removed only inside the decision, and never committed on a refusal", async () => {
  // No step touches the record before the decision: a copy or a removal made
  // once, up front, goes stale the moment the student's own attempt saves and
  // the decision has to be made again from the remote (acceptance/reserve.mjs).
  const touchers = steps.filter((s) => typeof s.run === "string" && /ACCEPT_FILE|acceptances\//.test(s.run));
  assert.deepEqual(touchers.map((s) => s.name), [], "a step handles the record outside the decision");

  // The decision copies it OUTSIDE the checkout and removes it, before EVERY
  // attempt, and a refused Retry commits nothing at all.
  const accept = steps.find((s) => s.id === "accept");
  assert.equal(accept.with["prior-acceptance-file"], "${{ runner.temp }}/prior-acceptance.json");
  assert.equal(String(accept.with["set-aside"]), "true");
  assert.equal(String(accept.with["persist-refusals"]), "false");
  const { pathsToCommit } = await import("../lib/acceptance-reservation.mjs");
  assert.deepEqual([...pathsToCommit("rejected:repo-frozen", { persistRefusals: false })], []);
  assert.ok(!pathsToCommit("rejected:repo-frozen").includes("acceptances"), "a refusal never commits the record, whoever runs it");
});

test("every step that writes the control repository runs only after an admitted acceptance", () => {
  const acceptAt = steps.findIndex((s) => s.id === "accept");
  assert.ok(acceptAt > 0, "the acceptance step is id: accept");
  const writers = steps
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => typeof s.run === "string" && WRITES_REMOTE.test(s.run));
  assert.ok(writers.length > 0, "the record step still commits and pushes - a vacuous pass otherwise");
  for (const { s, i } of writers) {
    assert.ok(i > acceptAt, `"${s.name}" writes the control repository before the gates have run`);
    assert.match(String(s.if ?? ""), ADMITTED, `"${s.name}" writes the control repository on a refusal`);
  }
});

test("a repository record, observations and a preservation outlive a missing acceptance record", () => {
  const dir = mkdtempSync(join(tmpdir(), "pxl-retry-refusal-"));
  const id = "test-asgn";
  const login = "lecturer2";
  const sha = "f".repeat(40);
  mkdirSync(join(dir, "assignments"), { recursive: true });
  writeFileSync(
    join(dir, "assignments", `${id}.yml`),
    [
      "schema_version: 1",
      `id: ${id}`,
      "title: Test Assignment",
      "organization: TestOrg",
      "template:",
      "  owner: TestOrg",
      "  repository: tpl",
      `repository_name_pattern: ${id}-{github_login}`,
      "opens_at: 2026-09-01T00:00:00Z",
      "deadline_at: 2026-09-10T23:59:59Z",
      "state: closed",
      "late_policy: block",
      "",
    ].join("\n"),
  );
  // No acceptances/ at all: what the pushed wipe left behind.
  mkdirSync(join(dir, "repositories", id), { recursive: true });
  writeFileSync(
    join(dir, "repositories", id, `${login}.json`),
    JSON.stringify({ github_login: login, repo_name: `TestOrg/${id}-${login}`, repo_id: 7 }),
  );
  const obsDir = join(dir, "observations", id, login);
  mkdirSync(obsDir, { recursive: true });
  writeFileSync(
    join(obsDir, "2026-09-10T12-00-00Z.json"),
    JSON.stringify({ observed_at: "2026-09-10T12:00:00Z", sha, commit_date: "2026-09-10T11:50:00Z", commit_count: 3 }),
  );
  writeFileSync(
    join(obsDir, "preservation.json"),
    JSON.stringify({
      schema_version: 1,
      verified: true,
      source_sha: sha,
      archive_repo: "TestOrg/arch",
      archive_ref: `refs/heads/preserved/${id}/${login}`,
    }),
  );

  const res = spawnSync("node", [join(root, "report", "report.mjs")], {
    encoding: "utf8",
    env: { ...process.env, ASSIGNMENT_ID: id, DATA_DIR: dir, OUTPUT_FORMAT: "json" },
  });
  assert.equal(res.status, 0, res.stderr);
  const row = JSON.parse(readFileSync(join(dir, "reports", `${id}.json`), "utf8")).students.find(
    (s) => s.github_login === login,
  );
  assert.equal(row.submission_status, "on-time", "the observed, preserved submission is still the answer");
  assert.equal(row.preserved_sha, sha);
  // The other direction - a roster student with nothing at all is still
  // no-submission - is "roster student who didn't accept" in report.test.mjs.
});
