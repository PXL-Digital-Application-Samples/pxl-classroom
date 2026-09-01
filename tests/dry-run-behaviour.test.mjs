// Does `--dry-run` actually write nothing?
//
// `tests/dry-run-safety.test.mjs` answers a different question, and says so: it
// is a SHAPE check that every mutating call site sits after a dry-run guard.
// Its own comment names what it cannot do - "the CLI talks through Octokit, so
// proving 'no write was issued' means intercepting its request layer". This
// file does that, against the real `cli/bin/pxl-classroom.mjs`.
//
// The method is differential, because the failure mode of a behavioural test
// here is vacuity: a harness that never gets far enough to reach a write proves
// nothing while passing. So every command runs TWICE against the same canned
// API - once with --dry-run and once without - and BOTH halves are asserted:
//
//   wet run  -> issued at least one mutating request   (the harness got there)
//   dry run  -> issued none                            (the property)
//
// The first assertion is what stops the second from being free.
//
// Coverage is derived, not listed: the CLI is scanned for every `--dry-run`
// option, and each one must be exercised below or named in DEFERRED with a
// reason - so a new dry-run command fails this file rather than quietly going
// unchecked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const CMD_DIR = join(root, "cli", "src", "commands");
const BIN = join(root, "cli", "bin", "pxl-classroom.mjs");
const STUB = join(root, "tests", "fixtures", "dry-run-stub.mjs");

const ORG = "PXL-Test-Org";
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// ---------------------------------------------------------------------------
// A virtual control repo.
// ---------------------------------------------------------------------------

function team(assignmentId, slug, name, members, extra = {}) {
  return JSON.stringify({
    schema_version: 1,
    assignment_id: assignmentId,
    team_slug: slug,
    team_name: name,
    members,
    max_members: 4,
    created_at: "2026-01-01T00:00:00Z",
    created_by: "lecturer",
    ...extra,
  });
}

/**
 * The roster the app actually writes: schema_version 2, `student_number`
 * required. The first draft of this fixture was v1 without it and
 * `roster promote` refused to commit - the product's own validation catching a
 * fixture that was not the shape the app writes.
 */
function rosterYaml(students) {
  return (
    "schema_version: 2\nstudents:\n" +
    students
      .map(
        (s) =>
          `  - student_number: "${s.n}"\n    full_name: ${s.name}\n    email: ${s.email}\n` +
          (s.login ? `    github_login: ${s.login}\n` : ""),
      )
      .join("")
  );
}

const groupAssignment = (id, title) =>
  `schema_version: 1\nid: ${id}\ntitle: ${title}\nassignment_type: group\nstate: published\n` +
  `repository_name_pattern: ${id}-{team_slug}\ngroup_config:\n  max_team_size: 4\n  min_team_size: 1\n`;

function controlRepo() {
  return {
    "assignments/proj-source.yml": groupAssignment("proj-source", "Source"),
    "assignments/proj-target.yml": groupAssignment("proj-target", "Target"),
    "teams/proj-source/team-alpha.json": team("proj-source", "team-alpha", "Team Alpha", ["alice", "bob"]),
    "teams/proj-source/team-beta.json": team("proj-source", "team-beta", "Team Beta", ["carol"]),
    "students/roster.yml": rosterYaml([
      { n: "1", name: "Alice A", email: "alice@student.pxl.be", login: "alice" },
      { n: "2", name: "Bob B", email: "bob@student.pxl.be", login: "bob" },
      { n: "3", name: "Carol C", email: "carol@student.pxl.be", login: "carol" },
    ]),
    "students/claims/1001.json": JSON.stringify({
      schema_version: 1, github_id: 1001, github_login: "alice",
      email: "alice@student.pxl.be", claimed_at: "2026-01-02T00:00:00Z", claimed_via: "invitation",
    }),
  };
}

// ---------------------------------------------------------------------------
// Running the real binary with the request layer intercepted.
// ---------------------------------------------------------------------------

/** A token + config the CLI will accept, nowhere near the developer's own. */
function isolatedHome() {
  const dir = mkdtempSync(join(tmpdir(), "pxl-dry-"));
  const cfg = join(dir, "pxl-classroom");
  mkdirSync(cfg, { recursive: true });
  writeFileSync(
    join(cfg, "token"),
    JSON.stringify({ access_token: "gho_test", scopes: [], user_login: "lecturer", obtained_at: new Date().toISOString() }),
  );
  writeFileSync(join(cfg, "config.json"), JSON.stringify({ last_org: ORG }));
  return dir;
}

function runCli(argv, { repo, caseId }) {
  const dir = mkdtempSync(join(tmpdir(), "pxl-run-"));
  const fixtureFile = join(dir, "fixture.json");
  const logFile = join(dir, "requests.log");
  writeFileSync(fixtureFile, JSON.stringify({ caseId, org: ORG, repo }));
  writeFileSync(logFile, "");

  let stdout = "";
  let stderr = "";
  let status = 0;
  try {
    stdout = execFileSync(process.execPath, ["--import", pathToFileURL(STUB).href, BIN, ...argv], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        APPDATA: isolatedHome(),
        XDG_CONFIG_HOME: isolatedHome(),
        PXL_DRYRUN_FIXTURE: fixtureFile,
        PXL_DRYRUN_LOG: logFile,
      },
    });
  } catch (e) {
    status = e.status ?? 1;
    stdout = e.stdout ?? "";
    stderr = e.stderr ?? "";
  }

  const log = readFileSync(logFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [method, ...rest] = line.split(" ");
      return { method, path: rest.join(" ") };
    });
  return { log, mutations: log.filter((r) => MUTATING.has(r.method)), stdout, stderr, status };
}

// ---------------------------------------------------------------------------
// The table. Every entry runs twice; both halves are asserted.
// ---------------------------------------------------------------------------

/** A CSV on disk for `roster import`, which takes a file argument. */
function rosterCsv() {
  const dir = mkdtempSync(join(tmpdir(), "pxl-csv-"));
  const file = join(dir, "roster.csv");
  writeFileSync(
    file,
    "student_number,full_name,email,class_group,github_login\n" +
      "1,Alice A,alice@student.pxl.be,1TIN,alice\n" +
      "2,Bob B,bob@student.pxl.be,1TIN,bob\n" +
      "3,Carol C,carol@student.pxl.be,1TIN,carol\n" +
      "4,Erin E,erin@student.pxl.be,1TIN,erin\n",
  );
  return file;
}

const CASES = [
  {
    name: "teams seed",
    id: "teams.mjs:seed",
    argv: ["teams", "seed", "--to", "proj-target", "--from", "proj-source", "--org", ORG, "--yes", "--no-publish"],
  },
  {
    name: "teams unseed",
    id: "teams.mjs:unseed",
    // planUnseed only removes teams that were CARRIED OVER (`seeded_from`) and
    // that nobody has claimed - no repo, no accepted member.
    repo: () => ({
      ...controlRepo(),
      "teams/proj-target/team-alpha.json": team("proj-target", "team-alpha", "Team Alpha", ["alice", "bob"], { seeded_from: "proj-source" }),
      "teams/proj-target/team-beta.json": team("proj-target", "team-beta", "Team Beta", ["carol"], { seeded_from: "proj-source" }),
    }),
    argv: ["teams", "unseed", "--assignment", "proj-target", "--org", ORG, "--yes", "--no-publish"],
  },
  {
    name: "roster unlink",
    id: "roster.mjs:unlink",
    argv: ["roster", "unlink", "--login", "alice", "--org", ORG, "--force"],
  },
  {
    name: "roster import",
    id: "roster.mjs:import",
    // The CSV carries a student the stored roster does not have, so there is a
    // diff to commit.
    argv: ["roster", "import", rosterCsv(), "--org", ORG, "--force"],
  },
  {
    name: "roster promote",
    id: "roster.mjs:promote",
    // A roster entry with an email and NO github_login, plus a claim binding
    // that address - which is exactly what promote folds in.
    repo: () => ({
      ...controlRepo(),
      "students/roster.yml": rosterYaml([
        { n: "1", name: "Alice A", email: "alice@student.pxl.be", login: "alice" },
        { n: "4", name: "Dave D", email: "dave@student.pxl.be" },
      ]),
      "students/claims/1002.json": JSON.stringify({
        schema_version: 1, github_id: 1002, github_login: "dave",
        email: "dave@student.pxl.be", claimed_at: "2026-01-03T00:00:00Z", claimed_via: "invitation",
      }),
    }),
    argv: ["roster", "promote", "--claims", "--org", ORG],
  },
  {
    name: "feedback open",
    id: "feedback.mjs:open",
    caseId: "feedback",
    repo: () => ({
      ...controlRepo(),
      "assignments/proj-fb.yml":
        "schema_version: 1\nid: proj-fb\ntitle: Feedback\nassignment_type: individual\nstate: published\n" +
        "repository_name_pattern: proj-fb-{github_login}\nfeedback_pr: true\n",
      "repositories/proj-fb/alice.json": JSON.stringify({
        schema_version: 1, assignment_id: "proj-fb", github_login: "alice",
        repo_name: `${ORG}/proj-fb-alice`, repo_id: 1, repo_url: "https://example.invalid",
      }),
    }),
    argv: ["feedback", "open", "--assignment", "proj-fb", "--org", ORG],
  },
  {
    name: "sync-starter",
    id: "sync-starter.mjs:sync-starter",
    caseId: "sync-starter",
    repo: () => ({
      ...controlRepo(),
      "assignments/proj-tpl.yml":
        "schema_version: 1\nid: proj-tpl\ntitle: Template\nassignment_type: individual\nstate: published\n" +
        `repository_name_pattern: proj-tpl-{github_login}\ntemplate:\n  owner: ${ORG}\n  repository: starter\n`,
      "repositories/proj-tpl/alice.json": JSON.stringify({
        schema_version: 1, assignment_id: "proj-tpl", github_login: "alice",
        repo_name: `${ORG}/proj-tpl-alice`, repo_id: 1, repo_url: "https://example.invalid",
      }),
    }),
    argv: ["sync-starter", "--assignment", "proj-tpl", "--org", ORG, "--no-issue"],
  },
];

/**
 * Dry-run commands this file does NOT drive, each with the reason. A reason is
 * required: "not covered", unexplained, is how a gap becomes permanent.
 */
const DEFERRED = [
  {
    id: "grade.mjs:grade",
    why: "the write is downstream of actually running student code in a container; " +
      "tests/dry-run-safety.test.mjs still covers its call sites lexically",
  },
];

for (const c of CASES) {
  test(`${c.name} --dry-run issues no mutating request, and the harness proves it could have`, () => {
    const opts = { repo: c.repo ? c.repo() : controlRepo(), caseId: c.caseId ?? c.name };

    const wet = runCli(c.argv, opts);
    assert.ok(
      wet.mutations.length > 0,
      `the WET run issued no mutating request, so the dry-run assertion below would pass ` +
        `for free. Fix the fixtures until it writes something.\nexit=${wet.status}\nrequests:\n` +
        wet.log.map((r) => `  ${r.method} ${r.path}`).join("\n") +
        `\nstdout:\n${wet.stdout}\nstderr:\n${wet.stderr}`,
    );

    const dry = runCli([...c.argv, "--dry-run"], opts);
    assert.deepEqual(
      dry.mutations.map((r) => `${r.method} ${r.path}`),
      [],
      `--dry-run wrote:\n` +
        dry.mutations.map((r) => `  ${r.method} ${r.path}`).join("\n") +
        `\nstdout:\n${dry.stdout}\nstderr:\n${dry.stderr}`,
    );
    // A dry run that crashed before doing anything would also issue no writes.
    assert.ok(
      dry.log.length > 0,
      `the DRY run made no requests at all, which is not evidence of anything:\n${dry.stderr}`,
    );
  });
}

test("every --dry-run in the CLI is accounted for here", () => {
  const declared = [];
  for (const file of readdirSync(CMD_DIR).filter((f) => f.endsWith(".mjs"))) {
    const lines = readFileSync(join(CMD_DIR, file), "utf8").split("\n");
    lines.forEach((line, i) => {
      if (!/\.option\(\s*"--dry-run"/.test(line)) return;
      let cmd = "?";
      for (let j = i; j >= 0; j--) {
        const m = lines[j].match(/\.command\(\s*"([^"\s<]+)/);
        if (m) { cmd = m[1]; break; }
      }
      declared.push(`${file}:${cmd}`);
    });
  }
  // A floor, because a scan that silently stops matching looks exactly like
  // full coverage.
  assert.ok(declared.length >= 8, `expected the scan to find the dry-run commands, found ${declared.length}`);

  const covered = new Set(CASES.map((c) => c.id));
  const documented = new Set(DEFERRED.map((d) => d.id));
  const unaccounted = declared.filter((d) => !covered.has(d) && !documented.has(d));
  assert.deepEqual(
    unaccounted,
    [],
    `these --dry-run commands are neither exercised above nor listed in DEFERRED with a reason:\n  ` +
      unaccounted.join("\n  "),
  );
});

test("the interceptor and the binary it wraps both exist", () => {
  // The whole file is worthless if the child silently runs an unstubbed CLI.
  assert.ok(existsSync(BIN), "the CLI entry point must be where this test spawns it");
  assert.ok(existsSync(STUB), "the fetch interceptor must exist or every run would hit the network");
  const probe = runCli(["teams", "list", "--assignment", "proj-source", "--org", ORG], {
    repo: controlRepo(),
    caseId: "probe",
  });
  assert.ok(
    probe.log.length > 0,
    "a read-only command logged no requests - the interceptor is not loaded, and every " +
      "'no mutating request' result above would be meaningless",
  );
});
