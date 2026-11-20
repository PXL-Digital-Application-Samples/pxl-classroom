// PXL Classroom - the students an assignment page shows before the report knows them.
//
// 2026-11-20, PXL-2TIN-DevOps-2627/pe-actions-reeks-2: fifty students accepted
// in three minutes, every rebuild of the report was cancelled by the next, and
// the page showed one student for eight minutes. The page now adds a row for
// every acceptance record the report does not list (lib/unreported-acceptances.mjs).
// The rows it adds are checked against what report.mjs itself writes for the
// same records, so the two cannot come to disagree.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { loginsToRead, withUnreportedAcceptances } from "../lib/unreported-acceptances.mjs";
import { validateAgainst } from "../lib/validate.mjs";
import { statusNotRead } from "../frontend/src/lib/last-commit.js";

const here = dirname(fileURLToPath(import.meta.url));
const ID = "test-asgn";

const acceptance = (login, extra = {}) => ({
  schema_version: 1, assignment_id: ID, github_login: login, github_id: 1000 + login.length,
  accepted_at: "2026-11-20T15:04:00.000Z", status: "provisioned", issue_number: 15, decided_by_run_id: "1", ...extra,
});
const repository = (login, extra = {}) => ({
  schema_version: 1, assignment_id: ID, github_login: login, repo_id: 5000 + login.length,
  repo_name: `TestOrg/test-asgn-${login}`, repo_url: `https://github.com/TestOrg/test-asgn-${login}`, ...extra,
});

const BASE_YAML = `schema_version: 1
id: ${ID}
title: Test Assignment
organization: TestOrg
template:
  owner: TestOrg
  repository: tpl
repository_name_pattern: test-asgn-{github_login}
opens_at: 2026-11-20T13:35:00Z
deadline_at: 2026-11-20T17:14:00Z
state: published
`;

/** report.mjs over acceptance and repository records, with nothing observed. */
function reportFor({ acceptances, repositories }) {
  const dir = mkdtempSync(join(tmpdir(), "pxl-unreported-"));
  mkdirSync(join(dir, "assignments"), { recursive: true });
  writeFileSync(join(dir, "assignments", `${ID}.yml`), BASE_YAML);
  mkdirSync(join(dir, "acceptances", ID), { recursive: true });
  for (const a of acceptances) writeFileSync(join(dir, "acceptances", ID, `${a.github_login}.json`), JSON.stringify(a));
  mkdirSync(join(dir, "repositories", ID), { recursive: true });
  for (const r of repositories) writeFileSync(join(dir, "repositories", ID, `${r.github_login}.json`), JSON.stringify(r));
  const res = spawnSync("node", [join(here, "..", "report", "report.mjs")], {
    encoding: "utf8",
    env: { ...process.env, ASSIGNMENT_ID: ID, DATA_DIR: dir, OUTPUT_FORMAT: "json" },
  });
  if (res.status !== 0) throw new Error(`report.mjs failed: ${res.stderr}\n${res.stdout}`);
  return JSON.parse(readFileSync(join(dir, "reports", `${ID}.json`), "utf8"));
}

test("loginsToRead - only the students the report is missing, so a current report costs no reads", () => {
  const rows = [
    { github_login: "d-ries", acceptance_state: "provisioned", repo_name: "TestOrg/test-asgn-d-ries" },
    { github_login: "rosterOnly", acceptance_state: "not-accepted", repo_name: null },
    { github_login: "noRepoYet", acceptance_state: "accepted", repo_name: null },
    { github_login: "stillProvisioning", acceptance_state: "accepted", repo_name: null },
  ];
  const listing = {
    acceptanceFiles: ["d-ries.json", "Faruk.json", "rosterOnly.json", "noRepoYet.json", "stillProvisioning.json", ".gitkeep"],
    repositoryFiles: ["d-ries.json", "Faruk.json", "rosterOnly.json", "noRepoYet.json"],
  };
  assert.deepEqual(loginsToRead(rows, listing), ["Faruk", "rosterOnly", "noRepoYet"]);
  assert.deepEqual(loginsToRead(rows.slice(0, 1), { acceptanceFiles: ["d-ries.json"], repositoryFiles: ["d-ries.json"] }), []);
});

test("loginsToRead - a login is the same account in any spelling", () => {
  const rows = [{ github_login: "FarukKazankayaPXL", acceptance_state: "provisioned", repo_name: "TestOrg/x" }];
  assert.deepEqual(loginsToRead(rows, { acceptanceFiles: ["farukkazankayapxl.json"], repositoryFiles: [] }), []);
});

test("the row added for a student the report does not list is the row report.mjs writes for them", () => {
  const records = [
    { acceptance: acceptance("FarukKazankayaPXL"), repository: repository("FarukKazankayaPXL", { starter_sha: "a".repeat(40), starter_commit_count: 1 }) },
    { acceptance: acceptance("nielsvds1", { status: "accepted" }), repository: null },
  ];
  const rows = withUnreportedAcceptances([], records);
  const fromReport = reportFor({
    acceptances: records.map((r) => r.acceptance),
    repositories: records.map((r) => r.repository).filter(Boolean),
  }).students;
  const fields = ["github_login", "acceptance_state", "team_slug", "team_name", "repo_id", "repo_name", "repo_url", "submission_status", "starter_sha", "starter_commit_count", "full_history"];
  for (const row of rows) {
    const theirs = fromReport.find((s) => s.github_login === row.github_login);
    assert.ok(theirs, row.github_login);
    for (const f of fields) assert.deepEqual(row[f], theirs[f], `${row.github_login}.${f}`);
  }
});

test("a row added from the records stores as it is, and shows as not read yet", async () => {
  const rows = withUnreportedAcceptances([], [{ acceptance: acceptance("Faruk"), repository: repository("Faruk") }], {
    rosterEntry: (login) => (login === "Faruk" ? { student_number: "12504343", full_name: "Faruk K", email: "faruk.k@student.pxl.be", class_group: "2TINA" } : null),
  });
  const { valid, errors } = await validateAgainst("report", { schema_version: 1, assignment_id: ID, students: rows });
  assert.ok(valid, JSON.stringify(errors));
  assert.equal(rows[0].full_name, "Faruk K");
  assert.equal(rows[0].student_number, "12504343");
  assert.equal(statusNotRead(rows[0]), true, "the page says Not read yet, never No submission");
});

test("a roster row the report lists as not accepted takes the acceptance and the repository", () => {
  const prev = { github_login: "rosterOnly", full_name: "Roster Student", acceptance_state: "not-accepted", repo_name: null, submission_status: "no-submission" };
  const [row] = withUnreportedAcceptances([prev], [{ acceptance: acceptance("rosterOnly"), repository: repository("rosterOnly") }]);
  assert.equal(row.full_name, "Roster Student", "what the report had is kept");
  assert.equal(row.acceptance_state, "provisioned");
  assert.equal(row.repo_name, "TestOrg/test-asgn-rosterOnly");
});

test("a record that could not be read changes nothing, and a repository record of another login is not theirs", () => {
  const rows = [{ github_login: "d-ries", acceptance_state: "provisioned", repo_name: "TestOrg/x" }];
  assert.deepEqual(withUnreportedAcceptances(rows, [{ acceptance: null, repository: repository("Faruk") }]), rows);
  const [, added] = withUnreportedAcceptances(rows, [{ acceptance: acceptance("Faruk"), repository: repository("Someone") }]);
  assert.equal(added.repo_name, null);
});

test("2026-11-20: the report of one student and fifty acceptances shows fifty-one students", () => {
  const report = [{ github_login: "d-ries", acceptance_state: "provisioned", repo_name: "TestOrg/test-asgn-d-ries" }];
  const logins = Array.from({ length: 50 }, (_, i) => `student${i}`);
  const listing = { acceptanceFiles: ["d-ries.json", ...logins.map((l) => `${l}.json`)], repositoryFiles: ["d-ries.json", ...logins.map((l) => `${l}.json`)] };
  const toRead = loginsToRead(report, listing);
  assert.equal(toRead.length, 50);
  const rows = withUnreportedAcceptances(report, toRead.map((l) => ({ acceptance: acceptance(l), repository: repository(l) })));
  assert.equal(rows.length, 51);
  assert.equal(rows[0], report[0], "the report's own row is the same object");
});
