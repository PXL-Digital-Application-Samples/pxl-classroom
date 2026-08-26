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

function runReport({ preservation }) {
  const dir = mkdtempSync(join(tmpdir(), "pxl-report-pres-"));
  mkdirSync(join(dir, "assignments"), { recursive: true });
  writeFileSync(join(dir, "assignments", `${ID}.yml`), BASE_YAML);

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
