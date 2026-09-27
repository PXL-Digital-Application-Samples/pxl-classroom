// `pxl-classroom sync-starter`, run for real against a stubbed GitHub
// (tests/fixtures/cli-sync-stub.mjs), for what its record says.
//
// 2026-09-27: the CLI wrote its rows only at the end - a `running` record with
// `results: []` until then, so a closed terminal left no evidence of who it had
// changed; it recorded no issue number, url or assignees, so a lecturer could
// not see from the record who had been told; and it never closed a superseded
// sync pull request, so every CLI sync stacked another over the same files.
// The workflow did all three. Each is now one function in lib/ both call.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

import { CONTROL_REPO } from "../lib/deployment.mjs";
import { validateAgainst } from "../lib/validate.mjs";
import { syncMarker } from "../lib/starter-sync.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(root, "cli", "bin", "pxl-classroom.mjs");
const STUB = join(root, "tests", "fixtures", "cli-sync-stub.mjs");
const ORG = "PXL-Test-Org";
const HEAD = "a".repeat(40);
const PARENT = "b".repeat(40);
const OLDER_SYNC = "9".repeat(40);

const TEMPLATE = {
  commits: [
    { sha: HEAD, treeSha: "tree-head", date: "2026-09-27T10:00:00Z", message: "Lab 2", tree: { "README.md": "r2", gradlew: "g2@100755" } },
    { sha: PARENT, treeSha: "tree-parent", date: "2026-09-20T10:00:00Z", message: "Lab 1", tree: { "README.md": "r1", gradlew: "g1@100755" } },
  ],
};

function controlRepo(logins) {
  const out = {
    "assignments/labs.yml":
      "schema_version: 1\nid: labs\ntitle: Labs\nassignment_type: individual\nstate: published\n" +
      `repository_name_pattern: labs-{github_login}\ntemplate:\n  owner: ${ORG}\n  repository: starter\n`,
  };
  for (const login of logins) {
    out[`repositories/labs/${login}.json`] = JSON.stringify({
      schema_version: 1, assignment_id: "labs", github_login: login, repo_name: `${ORG}/labs-${login}`, repo_id: 1, repo_url: "https://example.invalid",
    });
  }
  return out;
}

function isolatedHome() {
  const dir = mkdtempSync(join(tmpdir(), "pxl-clisync-home-"));
  const cfg = join(dir, "pxl-classroom");
  mkdirSync(cfg, { recursive: true });
  writeFileSync(join(cfg, "token"), JSON.stringify({ access_token: "gho_test", scopes: [], user_login: "lecturer", obtained_at: new Date().toISOString() }));
  writeFileSync(join(cfg, "config.json"), JSON.stringify({ last_org: ORG }));
  return dir;
}

/** Runs the CLI; answers its output, every request, and every sync record it committed, in order. */
function runSync(students, argv = []) {
  const dir = mkdtempSync(join(tmpdir(), "pxl-clisync-"));
  const files = { fixture: join(dir, "fixture.json"), log: join(dir, "requests.log"), records: join(dir, "records.jsonl") };
  writeFileSync(files.fixture, JSON.stringify({
    org: ORG, controlRepo: CONTROL_REPO, branch: "main", template: TEMPLATE,
    control: controlRepo(Object.keys(students)),
    students: Object.fromEntries(Object.entries(students).map(([login, s]) => [`labs-${login}`, { rootTree: "tree-parent", ...s }])),
  }));
  writeFileSync(files.log, "");
  writeFileSync(files.records, "");
  const home = isolatedHome();
  // spawn, not a synchronous exec: nothing here needs the event loop, but a
  // long cohort's output would overflow a sync buffer before it overflowed this.
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", pathToFileURL(STUB).href, BIN, "sync-starter", "--assignment", "labs", "--org", ORG, ...argv], {
      env: { ...process.env, APPDATA: home, XDG_CONFIG_HOME: home, PXL_CLISYNC_FIXTURE: files.fixture, PXL_CLISYNC_LOG: files.log, PXL_CLISYNC_RECORDS: files.records },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (status) => {
      const log = readFileSync(files.log, "utf8").split("\n").filter(Boolean);
      const records = readFileSync(files.records, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
      resolve({ status, stdout, stderr, log, records });
    });
  });
}

const byLogin = (record) => Object.fromEntries(record.results.map((r) => [r.github_login, r]));

test("THE CLI RECORD: issue fields as the workflow keeps them, per-student applied files, a superseded PR closed", async () => {
  const res = await runSync({
    // Untouched, but gradlew written by an old sync as a plain file.
    alice: { tree: { "README.md": "r1", gradlew: "g1" } },
    // Edited README; an older sync's PR (#7) offers only README - superseded;
    // another (#8) also offers a file this sync does not - still an offer.
    bob: {
      tree: { "README.md": "bob-edit", gradlew: "g1@100755" },
      pulls: [
        { number: 7, body: `old\n\n${syncMarker(OLDER_SYNC)}` },
        { number: 8, body: `older\n\n${syncMarker(OLDER_SYNC)}` },
        { number: 9, body: "the student's own pull request" },
      ],
      pullFiles: { 7: ["README.md"], 8: ["README.md", "Lab0/notes.md"], 9: ["README.md"] },
      assignFails: true,
    },
    carol: { tree: { "README.md": "r2", gradlew: "g2@100755" } },
    dave: { tree: { "README.md": "r2", gradlew: "g1@100755" } },
  });
  assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
  const end = res.records.at(-1);
  for (const doc of res.records) {
    const { valid, errors } = validateAgainst("sync-record", doc);
    assert.equal(valid, true, JSON.stringify(errors));
  }
  assert.equal(end.status, "completed");
  assert.equal(end.via, "cli");
  const rows = byLogin(end);

  // The mode-only drift is repaired in place, not a pull request.
  assert.equal(rows.alice.outcome, "auto-merged");
  assert.equal(rows.alice.files_conflicted, 0);
  assert.equal(rows.bob.outcome, "merged-and-pr");

  // ISSUE FIELDS, as the workflow writes them: who GitHub actually assigned.
  assert.match(rows.alice.issue_url, /\/labs-alice\/issues\/\d+$/);
  assert.equal(typeof rows.alice.issue_number, "number");
  assert.deepEqual(rows.alice.issue_assignees, ["alice"]);
  // The assign call failed: recorded as nobody, never as the list asked for.
  assert.ok(rows.bob.issue_number);
  assert.deepEqual(rows.bob.issue_assignees, []);
  assert.match(res.stdout, /bob: issue not assigned/);
  assert.equal("issue_number" in rows.carol, false, "up to date: no issue");

  // PER-STUDENT APPLIED FILES. The union is both paths; alice and bob were sent
  // exactly it (left out as equal), carol nothing, dave only gradlew.
  assert.deepEqual(end.selected_files, ["README.md", "gradlew"]);
  assert.equal("applied_files" in rows.alice, false);
  assert.equal("applied_files" in rows.bob, false);
  assert.deepEqual(rows.carol.applied_files, []);
  assert.deepEqual(rows.dave.applied_files, ["gradlew"]);

  // SUPERSEDED: #7 is commented on and closed; #8 still offers a file, and #9
  // is not a sync's at all.
  assert.ok(res.log.includes(`PATCH /repos/${ORG}/labs-bob/pulls/7`), res.log.join("\n"));
  assert.ok(res.log.includes(`POST /repos/${ORG}/labs-bob/issues/7/comments`));
  assert.equal(res.log.some((l) => /labs-bob\/pulls\/(8|9)$/.test(l) && l.startsWith("PATCH")), false);
  assert.match(res.stdout, /closed the superseded #7/);
});

test("THE CLI FLUSHES AS IT GOES: a run that dies after 20 students has already said who they were", async () => {
  const logins = Array.from({ length: 22 }, (_, i) => `s${String(i).padStart(2, "0")}`);
  const up = { tree: { "README.md": "r2", gradlew: "g2@100755" } };
  const res = await runSync(Object.fromEntries(logins.map((l) => [l, up])), ["--no-issue"]);
  assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
  const [start, ...rest] = res.records;
  assert.equal(start.status, "running");
  assert.deepEqual(start.results, []);
  const progress = rest.filter((d) => d.status === "running");
  assert.equal(progress.length, 1, "one progress write, at 20 finished students");
  assert.equal(progress[0].results.length, 20);
  assert.equal(res.records.at(-1).status, "completed");
  assert.equal(res.records.at(-1).results.length, 22);
  // The start is committed before any student repository is read.
  const firstStudent = res.log.findIndex((l) => l.includes("/labs-s"));
  const firstRecord = res.log.findIndex((l) => l.includes(`${CONTROL_REPO}/git/blobs`));
  assert.ok(firstRecord >= 0 && firstRecord < firstStudent);
});

test("a dry run still writes no record, progress or otherwise", async () => {
  const res = await runSync({ alice: { tree: { "README.md": "r1", gradlew: "g1@100755" } } }, ["--dry-run"]);
  assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
  assert.deepEqual(res.records, []);
  assert.equal(res.log.some((l) => /^(POST|PATCH|PUT|DELETE) /.test(l)), false, res.log.join("\n"));
});
