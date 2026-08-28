// Four schemas described real documents that nothing validated against.
//
// observation, limits, limits-overrides and sync-record all governed documents
// the system genuinely writes or reads, and no code ever checked one. That is
// the gap the e2e write-validation found two live bugs in, one layer up - so
// this closes it at the source, and pins the one real bug it exposed.
//
// THE BUG: lockdown.mjs wrote `team_slug` onto its observation. The snapshot
// variant of observation.schema.json is `additionalProperties: false` and has
// no such field, so every GROUP assignment produced an observation that failed
// its own schema, from the day group assignments shipped. Nothing read it
// either: report.mjs resolves a student's team from the team manifests, falling
// back to the acceptance record, and the lockdown record already carries
// team_slug per student - which is the copy preserve.mjs reads.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import { validateAgainst } from "../lib/validate.mjs";
import { summarize } from "../lib/starter-sync.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

// --- the bug -----------------------------------------------------------------

test("lockdown's observation carries no team_slug, because the schema forbids it", () => {
  const withTeam = {
    schema_version: 1,
    assignment_id: "exam",
    github_login: "alice",
    team_slug: "alpha",
    repo_id: 1,
    observed_at: "2026-08-30T20:00:00.000Z",
    ref: "refs/heads/main",
    sha: "a".repeat(40),
    observer_run: "https://github.com/o/r/actions/runs/1",
    collection_type: "lockdown",
  };
  const bad = validateAgainst("observation", withTeam);
  assert.ok(!bad.valid, "if this passes, the schema learned team_slug and this file needs rereading");

  const { team_slug, ...withoutTeam } = withTeam;
  assert.equal(team_slug, "alpha");
  const good = validateAgainst("observation", withoutTeam);
  assert.ok(good.valid, JSON.stringify(good.errors));
});

test("lockdown.mjs no longer builds an observation with team_slug", () => {
  const src = read("lockdown/lockdown.mjs");
  const at = src.indexOf("const observation = {");
  assert.ok(at > 0, "lockdown must still build an observation");
  const body = src.slice(at, src.indexOf("};", at));
  assert.ok(
    !/team_slug/.test(body),
    "team_slug on the observation fails observation.schema.json for every group assignment",
  );
});

// --- the writers now validate ------------------------------------------------

test("both observation writers validate before writing", () => {
  for (const rel of ["collect/collect.mjs", "lockdown/lockdown.mjs"]) {
    const src = read(rel);
    const validateAt = src.indexOf('validateAgainst("observation"');
    const writeAt = src.indexOf("writeFile(", validateAt < 0 ? 0 : validateAt);
    assert.ok(validateAt > 0, `${rel} must validate the observation it writes`);
    assert.ok(writeAt > validateAt, `${rel} must validate BEFORE writing`);
  }
});

test("an invalid observation fails the student, not the cohort", () => {
  // Both writes sit inside a per-student / per-target try whose catch records
  // that one failure and carries on to the next. A malformed document must
  // never stop the rest of a cohort being collected, frozen and preserved -
  // least of all on exam night. Asserted through each file's own recovery
  // handler rather than by matching braces, which nesting defeats.
  const recoveries = [
    ["collect/collect.mjs", /\} catch \(e\) \{[\s\S]{0,200}?log\(`snapshot \$\{login\}`, \{ ok: false/],
    ["lockdown/lockdown.mjs", /\} catch \(e\) \{[\s\S]{0,200}?byRepo\.set\(t, \{ ok: false/],
  ];
  for (const [rel, recovery] of recoveries) {
    const src = read(rel);
    const at = src.indexOf('validateAgainst("observation"');
    assert.ok(at > 0, `${rel} must validate the observation`);
    const after = src.slice(at);

    assert.match(after.slice(0, 900), /throw new Error/, `${rel} should throw rather than write`);
    assert.match(after, recovery, `${rel}: the throw must land in a per-item catch that records and continues`);

    // And it must not take the whole run down.
    const throwToCatch = after.slice(0, after.search(recovery));
    assert.ok(
      !/await fail\(|process\.exit\(/.test(throwToCatch),
      `${rel}: an invalid observation must not fail the run for every other student`,
    );
  }
});

test("usage-fetch validates limits and limits-overrides", () => {
  const src = read("scripts/usage-fetch.mjs");
  assert.match(src, /validateAgainst\("limits",/, "limits.yml must be validated");
  assert.match(src, /validateAgainst\("limits-overrides",/, "the overrides file must be validated");

  // ABSENT and MALFORMED must stay different answers: a missing overrides file
  // is a legitimate "none", a present but unreadable one is a config error that
  // silently dropped a lecturer's raised limit.
  assert.ok(
    !/}\s*catch\s*{\s*\/\* none configured \*\/\s*}/.test(src),
    "the old catch-all swallowed a malformed overrides file as 'none configured'",
  );
  assert.match(src, /is present but is not valid JSON/, "a malformed overrides file must say so");
});

test("sync-starter validates the record before writing it", () => {
  const src = read("scripts/sync-starter.mjs");
  const validateAt = src.indexOf('validateAgainst("sync-record"');
  const writeAt = src.indexOf('writeFile(join(syncDir', validateAt < 0 ? 0 : validateAt);
  assert.ok(validateAt > 0, "the sync record must be validated");
  assert.ok(writeAt > validateAt, "and validated before it is written");
});

// --- the real documents pass ---------------------------------------------------

test("the repository's own limits.yml is valid", () => {
  const { valid, errors } = validateAgainst("limits", parseYaml(read("limits.yml")));
  assert.ok(valid, JSON.stringify(errors));
});

test("the sync record sync-starter builds is valid", () => {
  const results = [
    { github_login: "alice", repo_name: "org/exam-alice", outcome: "auto-merged" },
    { github_login: "bob", repo_name: "org/exam-bob", outcome: "pr-opened", pr_number: 3 },
    { github_login: "dan", team_slug: "alpha", repo_name: "unknown", outcome: "skipped-no-repo" },
  ];
  const record = {
    schema_version: 1,
    sync_id: "sync-20260828T000000Z-a1b2c3",
    assignment_id: "exam",
    synced_at: "2026-08-28T00:00:00.000Z",
    synced_by: "tomcoolpxl",
    template_repo: "org/tpl",
    template_sha: "b".repeat(40),
    template_base_sha: "c".repeat(40),
    selected_files: ["README.md"],
    pr_title: "Starter code update",
    pr_body: "body",
    created_issues: false,
    summary: summarize(results),
    results,
  };
  const { valid, errors } = validateAgainst("sync-record", record);
  assert.ok(valid, JSON.stringify(errors));
});

// --- errors/ is gone -----------------------------------------------------------

test("errors/ is no longer part of the data model", () => {
  // It was scaffolded into every control repo and documented in ARCHITECTURE
  // §5.1, and nothing ever wrote one - failures go to the org's instructor
  // tracking issue via notify.mjs, which is what a lecturer reads.
  const layout = read("lib/control-layout.mjs");
  assert.ok(!/"errors"/.test(layout), "errors must not be a scaffold directory");

  for (const doc of ["ARCHITECTURE.md", "RUNBOOK.md"]) {
    assert.ok(
      !/error-record\.schema\.json|errors\/<id>\.json/.test(read(doc)),
      `${doc} must not document an error-record mechanism the system does not have`,
    );
  }
});
