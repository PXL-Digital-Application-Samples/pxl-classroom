// `lockdowns/<id>/lockdown-record.json` had no schema until 2026-09-08.
//
// It is the document a grade dispute is read from, the idempotency key
// find-finalizable.mjs re-queues on, and the thing lib/repo-unlock.mjs reads to
// choose an inverse - and nothing could reject a malformed one. That is the
// exemption ARCHITECTURE §5.3 describes: a generated document without a schema
// is a document no test can reject, and `reports/dashboard.json` sat in exactly
// that state with three writers.
//
// Two directions are checked here, because a schema written after the fact can
// be wrong in either. Against HISTORY: every lockdown record in the live
// organizations validates (run separately when this landed - 9 records, 0
// refused, and it caught two that predate the top-level `lock_method`, which is
// why that field is not required). Against the WRITER: the field list below is
// derived from lockdown.mjs itself, so a field the code learns to write and the
// schema does not declare fails here rather than being silently stored.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateAgainst } from "../lib/validate.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const SCHEMA = JSON.parse(read("schemas/lockdown-record.schema.json"));
const SRC = read("lockdown/lockdown.mjs");

/** A record shaped the way lockdown.mjs writes one. */
const record = (over = {}) => ({
  schema_version: 1,
  assignment_id: "lab-1",
  deadline_at: "2026-09-08T12:00:00.000Z",
  executed_at: "2026-09-08T12:05:00.000Z",
  finalize_attempts: 1,
  first_finalized_at: "2026-09-08T12:05:00.000Z",
  observer_run: "https://github.com/o/r/actions/runs/1",
  locked_at: "2026-09-08T12:00:00.000Z",
  lock_method: "ruleset",
  late_policy: "block",
  locked_count: 1,
  error_count: 0,
  no_submission_count: 0,
  deferred_count: 0,
  reopened_count: 0,
  unfreezable_count: 0,
  max_uncertainty_seconds: 12,
  results: [
    {
      github_login: "ada",
      repo_name: "org/lab-1-ada",
      repo_id: 123,
      snapshot_sha: "a".repeat(40),
      snapshot_ref: "refs/heads/main",
      pushed_at: "2026-09-08T11:59:00.000Z",
      lockdown_at: "2026-09-08T12:00:00.000Z",
      lock_method: "ruleset",
      permission_after: null,
      verified: true,
      uncertainty_seconds: 12,
    },
  ],
  ...over,
});

test("the record lockdown.mjs writes is one the schema accepts", () => {
  const res = validateAgainst("lockdown-record", record());
  assert.ok(res.valid, JSON.stringify(res.errors));
});

test("a deferred row is accepted, and it is not a failed one", () => {
  // snapshot_sha null WITH deferred_until is a deferral; null WITHOUT one is a
  // lockdown failure, and preserve.mjs tells them apart on exactly that.
  const res = validateAgainst("lockdown-record", record({
    deferred_count: 1,
    results: [{
      github_login: "bo",
      repo_name: "org/lab-1-bo",
      repo_id: 456,
      snapshot_sha: null,
      snapshot_ref: "refs/heads/main",
      lockdown_at: null,
      deferred_until: "2026-09-15T12:00:00.000Z",
      deferred_reason: "deadline_extension",
      permission_after: null,
      verified: false,
      uncertainty_seconds: null,
    }],
  }));
  assert.ok(res.valid, JSON.stringify(res.errors));
});

test("an organization owner who could not be frozen is a recordable state", () => {
  const res = validateAgainst("lockdown-record", record({
    unfreezable_count: 1,
    results: [{
      github_login: "lecturer",
      repo_name: "org/lab-1-lecturer",
      repo_id: 789,
      snapshot_sha: "b".repeat(40),
      lock_method: "demotion",
      permission_after: "admin",
      verified: false,
      unfreezable_reason: "org-owner",
      uncertainty_seconds: 3,
    }],
  }));
  assert.ok(res.valid, JSON.stringify(res.errors));
});

test("org-scoped lockdown is a method the record can carry", () => {
  const res = validateAgainst("lockdown-record", record({
    lock_method: "org-ruleset",
    org_ruleset_id: 22557726,
    results: [{ github_login: "ada", repo_id: 123, lock_method: "org-ruleset", verified: true }],
  }));
  assert.ok(res.valid, JSON.stringify(res.errors));
});

test("a field nobody declared is refused rather than stored", () => {
  assert.equal(validateAgainst("lockdown-record", record({ locked_cout: 1 })).valid, false);
  assert.equal(
    validateAgainst("lockdown-record", record({
      results: [{ github_login: "ada", lock_mehtod: "ruleset" }],
    })).valid,
    false,
    "a misspelled row field is the whole reason additionalProperties is false",
  );
});

test("every field lockdown.mjs writes into the record is one the schema declares", () => {
  // DERIVED FROM THE WRITER. A hand-kept list would agree with whatever it was
  // copied from, which is how the folded reporter env key survived two tests.
  const top = new Set(Object.keys(SCHEMA.properties));
  const row = new Set(Object.keys(SCHEMA.properties.results.items.properties));

  // The literal object at `const lockdownRecord = {` ... `};`
  const start = SRC.indexOf("const lockdownRecord = {");
  assert.ok(start > -1, "lockdown.mjs no longer builds the record as one literal - this guard needs rewriting");
  const body = SRC.slice(start, SRC.indexOf("\n  };", start));
  for (const [, key] of body.matchAll(/^\s{4}([a-z_]+):/gm)) {
    assert.ok(top.has(key), `lockdown.mjs writes top-level "${key}" and the schema does not declare it`);
  }

  // Every `lockdownResults.push({ ... })` - there are two, targets and deferrals.
  let found = 0;
  for (const m of SRC.matchAll(/lockdownResults\.push\(\{([\s\S]*?)\n\s{6}\}\);/g)) {
    found++;
    for (const [, key] of m[1].matchAll(/^\s{8}([a-z_]+):/gm)) {
      assert.ok(row.has(key), `lockdown.mjs writes row field "${key}" and the schema does not declare it`);
    }
  }
  assert.ok(found >= 2, `expected the target and deferral rows, found ${found} push site(s)`);
});

test("the fixture validates this path, so an e2e write of it cannot be exempt", () => {
  const fixtures = read("tests/fixtures/e2e-fixtures.mjs");
  assert.match(fixtures, /lockdown-record\\?\.json.*'lockdown-record'/);
  // And the more specific `unlocked/` pattern has to come first, or the record's
  // own pattern would swallow it.
  assert.ok(
    fixtures.indexOf("'unlock-record'") < fixtures.indexOf("'lockdown-record'"),
    "unlocked/<login>.json must be matched before lockdowns/<id>/lockdown-record.json",
  );
});
