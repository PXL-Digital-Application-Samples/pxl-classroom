// The preserved SHA the whole archive surface hangs on.
//
// report.mjs read `preservation.preserved_sha`. preserve.mjs has never written
// that field - it writes `source_sha`. So `preserved_sha` was null on EVERY
// report ever generated, which was confirmed against the only real preservation
// in production: its preservation.json carries
//
//   source_sha: a7655427953d…, verified: true
//
// and the report beside it says `preservation_status: "preserved"` with
// `preserved_sha: null`.
//
// Everything gated on that field being truthy was therefore dead:
//
//   - the archive link in the student table (`v-if="… && s.preserved_sha"`)
//   - `pxl-classroom download`, which filters on it before fetching anything
//   - `pxl-classroom grade`, same filter
//   - the export manifest's `archive_sha`
//
// The name was right and the source was wrong: preserve pushes exactly this
// commit to the archive and verifies the remote SHA equals it, so the preserved
// SHA and the source SHA are the same object by construction.
//
// Same class as the `earned_points` bug already in CLAUDE.md - a report field
// every consumer reads and nothing writes - and it survived for the same reason:
// the fixtures supplied it, so the tests described a document no backend emits.
// Hence the second test here, which checks the producer and the consumer agree
// rather than checking a fixture against itself.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const reportScript = join(root, "report", "report.mjs");

const ID = "test-asgn";
const PRESERVED_SHA = "a7655427953d" + "0".repeat(28);

const BASE_YAML = `schema_version: 1
id: ${ID}
title: Test Assignment
organization: TestOrg
template:
  owner: TestOrg
  repository: tpl
repository_name_pattern: ${ID}-{github_login}
opens_at: 2026-09-01T00:00:00Z
deadline_at: 2026-09-10T23:59:59Z
state: published
`;

/** Exactly what preserve.mjs writes, field for field. */
function preservationDoc(login) {
  return {
    schema_version: 1,
    assignment_id: ID,
    github_login: login,
    source_repo: `TestOrg/${ID}-${login}`,
    source_repo_id: 42,
    source_sha: PRESERVED_SHA,
    archive_repo: "TestOrg/pxl-classroom-archive",
    preserved_ref: `refs/heads/preserved/${ID}/${login}`,
    verified: true,
    preserved_at: "2026-09-11T00:05:00Z",
    observer_run: "https://example.test/run/1",
  };
}

function runReport({ preservation, lockdownRecord, lockdownObservedAt }) {
  const dir = mkdtempSync(join(tmpdir(), "pxl-report-pres-"));
  mkdirSync(join(dir, "assignments"), { recursive: true });
  writeFileSync(join(dir, "assignments", `${ID}.yml`), BASE_YAML);

  if (lockdownRecord) {
    mkdirSync(join(dir, "lockdowns", ID), { recursive: true });
    writeFileSync(
      join(dir, "lockdowns", ID, "lockdown-record.json"),
      JSON.stringify(lockdownRecord),
    );
  }

  mkdirSync(join(dir, "acceptances", ID), { recursive: true });
  writeFileSync(
    join(dir, "acceptances", ID, "alice.json"),
    JSON.stringify({ github_login: "alice", status: "accepted" }),
  );

  mkdirSync(join(dir, "observations", ID, "alice"), { recursive: true });
  writeFileSync(
    join(dir, "observations", ID, "alice", "2026-09-09T20-00-00Z.json"),
    JSON.stringify({ observed_at: "2026-09-09T20:00:00Z", sha: PRESERVED_SHA, commit_count: 3 }),
  );
  if (preservation) {
    writeFileSync(
      join(dir, "observations", ID, "alice", "preservation.json"),
      JSON.stringify(preservation),
    );
  }
  if (lockdownObservedAt) {
    // What lockdown.mjs's phase 2 writes: an observation stamped with when the
    // nightly LOOKED, which is not when the student was stopped.
    writeFileSync(
      join(dir, "observations", ID, "alice", "2026-09-11T00-00-00Z.json"),
      JSON.stringify({
        observed_at: lockdownObservedAt,
        sha: PRESERVED_SHA,
        collection_type: "lockdown",
      }),
    );
  }

  const res = spawnSync("node", [reportScript], {
    encoding: "utf8",
    env: { ...process.env, ASSIGNMENT_ID: ID, DATA_DIR: dir, OUTPUT_FORMAT: "json" },
  });
  assert.equal(res.status, 0, `report.mjs failed:\n${res.stderr}\n${res.stdout}`);
  return JSON.parse(readFileSync(join(dir, "reports", `${ID}.json`), "utf8"));
}

test("a preserved submission reports the SHA it was preserved at", () => {
  const report = runReport({ preservation: preservationDoc("alice") });
  const alice = report.students.find((s) => s.github_login === "alice");

  assert.equal(alice.preservation_status, "preserved");
  assert.equal(
    alice.preserved_sha,
    PRESERVED_SHA,
    "null here kills the archive link, the bulk download and the CLI grader",
  );
});

test("no preservation document still means not-required and a null sha", () => {
  // The other half: the field must stay null when nothing was preserved, or
  // every consumer's truthiness gate opens on a submission that is not archived.
  const report = runReport({ preservation: null });
  const alice = report.students.find((s) => s.github_login === "alice");
  assert.equal(alice.preservation_status, "not-required");
  assert.equal(alice.preserved_sha, null);
});

// --- When writes actually stopped --------------------------------------------
//
// Two instants get confused here, and they can be hours apart:
//
//   lockdown-record.json  results[].lockdown_at  - when the student stopped
//                                                  being able to push
//   the lockdown OBSERVATION observed_at         - when the nightly looked
//
// The report took the second. With a deadline sentinel the first is the deadline
// instant and the second is the nightly hours later, so `lock_down_at` said the
// cohort was frozen at 00:00 for a 20:00 deadline. And the preservation banner's
// "delay between deadline and lockdown execution" was reading
// `uncertainty_interval_seconds`, which is the OTHER side of the deadline
// entirely - the gap between the last observation and the deadline.

const DEADLINE = "2026-09-10T23:59:59Z";

test("lock_down_at comes from the record, not from when the nightly looked", () => {
  const report = runReport({
    lockdownObservedAt: "2026-09-11T04:00:00Z",
    lockdownRecord: {
      schema_version: 1,
      assignment_id: ID,
      results: [
        { github_login: "alice", lockdown_at: DEADLINE, uncertainty_seconds: 0, snapshot_sha: PRESERVED_SHA },
      ],
    },
  });
  const alice = report.students.find((s) => s.github_login === "alice");
  assert.equal(alice.lock_down_at, DEADLINE, "the sentinel stopped her at the deadline");
  assert.equal(alice.lockdown_delay_seconds, 0, "and the delay was none");
});

test("the freeze delay is carried, and is not the evidence gap", () => {
  // A nightly-only freeze: stopped four hours after the deadline. The two
  // numbers must not be the same value, or the banner is showing the wrong one
  // again without anybody noticing.
  const report = runReport({
    lockdownRecord: {
      schema_version: 1,
      assignment_id: ID,
      results: [
        { github_login: "alice", lockdown_at: "2026-09-11T04:00:00Z", uncertainty_seconds: 14401, snapshot_sha: PRESERVED_SHA },
      ],
    },
  });
  const alice = report.students.find((s) => s.github_login === "alice");
  assert.equal(alice.lockdown_delay_seconds, 14401);
  assert.notEqual(
    alice.lockdown_delay_seconds,
    alice.uncertainty_interval_seconds,
    "these measure opposite sides of the deadline and must stay distinct",
  );
});

test("no lockdown record leaves both fields null rather than inventing them", () => {
  const report = runReport({});
  const alice = report.students.find((s) => s.github_login === "alice");
  assert.equal(alice.lock_down_at, null);
  assert.equal(alice.lockdown_delay_seconds, null);
});

// --- The evidence gap, and the alarm that always fired -----------------------
//
// `uncertainty_interval_seconds` is `deadline - lastOnTimeObservation`: how
// stale our final pre-deadline evidence was. Before the deadline that same
// subtraction is the time REMAINING, which is a different quantity wearing the
// name - measured live 2026-08-26, an assignment due in four days reported
// "116h" for every student, and alarmed on it at a one-hour threshold.

test("no uncertainty is reported before the deadline has passed", () => {
  // BASE_YAML's deadline is 2026-09-10, comfortably in the future here.
  const report = runReport({});
  const alice = report.students.find((s) => s.github_login === "alice");
  assert.equal(
    alice.uncertainty_interval_seconds,
    null,
    "before the deadline this number is the time remaining, not an uncertainty",
  );
});

test("once the deadline has passed the gap is measured", () => {
  const dir = mkdtempSync(join(tmpdir(), "pxl-report-gap-"));
  mkdirSync(join(dir, "assignments"), { recursive: true });
  writeFileSync(
    join(dir, "assignments", `${ID}.yml`),
    BASE_YAML.replace("2026-09-10T23:59:59Z", "2020-01-02T00:00:00Z"),
  );
  mkdirSync(join(dir, "acceptances", ID), { recursive: true });
  writeFileSync(
    join(dir, "acceptances", ID, "alice.json"),
    JSON.stringify({ github_login: "alice", status: "accepted" }),
  );
  mkdirSync(join(dir, "observations", ID, "alice"), { recursive: true });
  writeFileSync(
    join(dir, "observations", ID, "alice", "2020-01-01T00-00-00Z.json"),
    JSON.stringify({ observed_at: "2020-01-01T00:00:00Z", sha: PRESERVED_SHA, commit_count: 3 }),
  );

  const res = spawnSync("node", [reportScript], {
    encoding: "utf8",
    env: { ...process.env, ASSIGNMENT_ID: ID, DATA_DIR: dir, OUTPUT_FORMAT: "json" },
  });
  assert.equal(res.status, 0, res.stderr);
  const report = JSON.parse(readFileSync(join(dir, "reports", `${ID}.json`), "utf8"));
  const alice = report.students.find((s) => s.github_login === "alice");
  assert.equal(alice.uncertainty_interval_seconds, 86400, "24h between the observation and the deadline");
});

test("report.mjs only reads preservation fields preserve.mjs actually writes", () => {
  // The class, not the instance. Two files, one document, no schema between
  // them - so the agreement is asserted directly rather than trusted.
  const preserveSrc = readFileSync(join(root, "preserve", "preserve.mjs"), "utf8");
  const reportSrc = readFileSync(join(root, "report", "report.mjs"), "utf8");

  const start = preserveSrc.indexOf("const preservation = {");
  assert.ok(start > -1, "could not find the preservation document literal");
  const block = preserveSrc.slice(start, preserveSrc.indexOf("};", start));
  // `[,:]`, because `verified` is written as a SHORTHAND property. Matching only
  // `name:` reported it as never written, which is the scanner lying rather than
  // the code being wrong - the failure mode this whole test exists to catch.
  const written = new Set([...block.matchAll(/^\s*([a-z_]+)\s*[,:]/gm)].map((m) => m[1]));
  assert.ok(written.has("source_sha"), `sanity: parsed ${[...written].join(", ")}`);
  assert.ok(written.has("verified"), "sanity: shorthand properties must be parsed too");

  // Comments quote the old field name deliberately, and the document's own
  // FILENAME is "preservation.json" - both look like field reads to a regex.
  // Strip comments and string literals, or this reports `json` as a field and
  // passes by reading its own explanation.
  const code = reportSrc
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
  const read = [...code.matchAll(/\bpreservation\??\.([a-z_]+)/g)].map((m) => m[1]);
  assert.ok(read.length > 0, "sanity: report.mjs must read the preservation document");

  const unknown = [...new Set(read)].filter((f) => !written.has(f));
  assert.deepEqual(
    unknown,
    [],
    `report.mjs reads preservation field(s) preserve.mjs never writes: ${unknown.join(", ")}`,
  );
});
