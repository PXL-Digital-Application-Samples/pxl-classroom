// The low-severity tail of the audit. None of these ruins a semester on its
// own; each is a wrong answer the system currently gives with a straight face,
// and every one of them was invisible to a green suite.
//
//   F12  is_first_member counted MEMBERS, and a seeded team has those before
//        anybody accepts
//   F13  a team switch rewrote accepted_at, moving a student's acceptance time
//        forward every time they changed team
//   F14  a DRAFT with a past deadline queued a finalize matrix leg, forever
//   F15  autograding YAML was built by string concatenation, so a quote in a
//        lecturer's command produced a workflow that does not parse - in every
//        student repository
//   F16  preserve.mjs printed a credentialed URL to a public run log
//   F17  the publish revert only handled .yml
//   F19  the Contents API returns 200 with no content above 1 MB, which read
//        as "file not found"
//   F20  one API call per invitation card per org on every frontend deploy

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { parse } from "yaml";

import { buildAutogradingWorkflow } from "../provisioning/provision.mjs";
import { validateAgainst } from "../lib/validate.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

// --- F15: autograding YAML --------------------------------------------------

const HOSTILE = [
  ["a double quote in the command", { id: "grep-test", type: "run", command: 'grep "needle" haystack.txt' }],
  ["a colon in the id", { id: "step-1: compile", type: "run", command: "make" }],
  ["a newline in the command", { id: "multi", type: "run", command: "make\nmake test" }],
  ["a backslash", { id: "esc", type: "run", command: 'printf "a\\tb"' }],
  ["a YAML comment marker", { id: "hash", type: "run", command: "echo '# not a comment'" }],
  ["a leading dash", { id: "dash", type: "run", command: "- not a list item" }],
  ["braces that look like an expression", { id: "expr", type: "run", command: "echo ${{ secrets.X }}" }],
  ["quotes in io fixtures", { id: "io", type: "io", command: "./a.out", stdin: 'say "hi"\n', expected_stdout: '"hi"\n' }],
  ["a very long command", { id: "long", type: "run", command: "x".repeat(500) }],
];

for (const [label, testCase] of HOSTILE) {
  test(`autograding YAML survives ${label}`, () => {
    const yaml = buildAutogradingWorkflow(
      { id: "lab", autograde: { enabled: true, visibility: "public", tests: [testCase] } },
      "PXLAutomation"
    );
    // It has to PARSE - the old builder emitted `command: "grep "needle" ..."`,
    // which does not, and lands in every student's repository.
    const doc = parse(yaml);
    assert.equal(doc.name, "Autograding");
    const step = doc.jobs.grade.steps.find((s) => s.with?.command !== undefined);
    assert.ok(step, "the test step must survive");
    // And round-trip the value unchanged, not merely parse.
    assert.equal(step.with.command, testCase.command);
    if (testCase.stdin !== undefined) assert.equal(step.with.input, testCase.stdin);
    if (testCase.expected_stdout !== undefined) {
      assert.equal(step.with["expected-output"], testCase.expected_stdout);
    }
  });
}

test("two test ids that differ only in punctuation keep separate results", () => {
  // `test-1` and `test_1` both uppercased to TEST_1_RESULTS, so one test's
  // results silently replaced the other's in the reporter.
  const yaml = buildAutogradingWorkflow(
    {
      id: "lab",
      autograde: {
        visibility: "public",
        tests: [
          { id: "test-1", type: "run", command: "a" },
          { id: "test_1", type: "run", command: "b" },
        ],
      },
    },
    "PXLAutomation"
  );
  const reporter = parse(yaml).jobs.grade.steps.at(-1);
  assert.equal(Object.keys(reporter.env).length, 2, "two tests, two env keys");
  const values = Object.values(reporter.env);
  assert.notEqual(values[0], values[1], "and they must point at different steps");
});

test("the concurrency expression is preserved, not mangled by the serialiser", () => {
  const yaml = buildAutogradingWorkflow({ id: "lab", autograde: { visibility: "private" } }, "PXLAutomation");
  assert.equal(parse(yaml).concurrency.group, "autograde-${{ github.ref }}");
});

// --- F16: no credential in a git command line -------------------------------

test("preserve.mjs never builds a credential into a URL", () => {
  const src = readFileSync(join(root, "preserve", "preserve.mjs"), "utf8");
  // The URL shape specifically. Building `x-access-token:<token>` for a basic
  // auth HEADER is the fix, not the bug - what must not exist is a credential
  // followed by `@host`, which is what lands in the logged command string.
  assert.ok(
    !/x-access-token:\S*@/.test(src.replace(/^\s*\/\/.*$/gm, "")),
    "no token in a git URL"
  );
  assert.ok(!/authedUrl/.test(src), "the helper that built one is gone");
  assert.match(src, /extraheader/, "the token goes in a header instead");
  // The command string is logged, so anything in it is in a public run log.
  assert.match(src, /GIT_CONFIG_KEY_0/, "and through the environment, not an argument");
});

test("no workflow builds a credential into a git remote", () => {
  const dir = join(root, ".github", "workflows");
  for (const file of ["publish-assignment.yml", "setup-org.yml"]) {
    const src = readFileSync(join(dir, file), "utf8");
    const remotes = src.split("\n").filter((l) => /git remote add|git clone|git push http/.test(l));
    for (const line of remotes) {
      assert.ok(
        !/x-access-token|@github\.com/.test(line),
        `${file}: credential in a remote URL - it lands in .git/config and in git's error output: ${line.trim()}`
      );
    }
  }
});

// --- F14: a draft is not finalizable ----------------------------------------

function runFindFinalizable(assignments) {
  const dir = mkdtempSync(join(tmpdir(), "pxl-fin-"));
  mkdirSync(join(dir, "assignments"), { recursive: true });
  for (const [id, doc] of Object.entries(assignments)) {
    writeFileSync(
      join(dir, "assignments", `${id}.yml`),
      Object.entries({ schema_version: 1, id, ...doc })
        .map(([k, v]) => `${k}: ${v}`)
        .join("\n") + "\n"
    );
  }
  const out = execFileSync(
    process.execPath,
    [join(root, "scripts", "find-finalizable.mjs"), dir, "PXLAutomation"],
    { encoding: "utf8", cwd: dir, stdio: ["pipe", "pipe", "pipe"] }
  );
  return JSON.parse(out.trim().split("\n").at(-1));
}

const PAST = new Date(Date.now() - 86400000).toISOString();
const FUTURE = new Date(Date.now() + 86400000).toISOString();

test("a published assignment past its deadline is queued", () => {
  const queued = runFindFinalizable({ live: { state: "published", deadline_at: PAST } });
  assert.deepEqual(queued.map((q) => q.assignment_id), ["live"]);
});

test("a closed assignment past its deadline is still queued", () => {
  // Closing stops acceptance; it does not mean the submissions are archived.
  const queued = runFindFinalizable({ done: { state: "closed", deadline_at: PAST } });
  assert.deepEqual(queued.map((q) => q.assignment_id), ["done"]);
});

test("a draft past its deadline is never queued", () => {
  // It has no repositories and no lockdown record, so it looked "not-finalized"
  // forever - a four-step matrix leg every night, on a system whose whole point
  // is billing zero minutes when idle.
  for (const state of ["draft", "archived"]) {
    const queued = runFindFinalizable({ stale: { state, deadline_at: PAST } });
    assert.deepEqual(queued, [], `${state} must not be finalizable`);
  }
});

test("a future deadline is never queued, whatever the state", () => {
  for (const state of ["published", "closed", "draft"]) {
    assert.deepEqual(runFindFinalizable({ soon: { state, deadline_at: FUTURE } }), []);
  }
});

test("an assignment with no deadline is never queued", () => {
  assert.deepEqual(runFindFinalizable({ open: { state: "published" } }), []);
});

// --- F17: the publish revert handles both file shapes -----------------------

test("the publish revert restores a JSON assignment too", () => {
  const doc = parse(readFileSync(join(root, ".github", "workflows", "publish-assignment.yml"), "utf8"));
  const steps = doc.jobs.publish.steps;

  const revert = steps.find((s) => s.name === "Revert to prior state on failure");
  assert.match(revert.run, /\.json/, "a JSON assignment must be revertible");
  assert.match(revert.run, /update-json-field\.mjs/, "and through the schema-checked writer");

  // The prior state has to be readable from both shapes, or the revert has
  // nothing to restore a JSON assignment to.
  const prior = steps.find((s) => s.name === "Record prior state");
  assert.match(prior.run, /\.json/, "the prior state must be read from both shapes");
});

// --- F19: files over the Contents API limit ---------------------------------

test("getRepoContent does not read a 1 MB+ file as missing", () => {
  // The API answers 200 with `content: ""` and `encoding: "none"`, which the
  // old code returned as null - indistinguishable from a 404 to every caller.
  const src = readFileSync(join(root, "frontend", "src", "lib", "api.js"), "utf8");
  // To the next top-level declaration, not the first `\n}` - that one closes an
  // inner block, and slicing there cut the check off before the code it checks.
  const rest = src.slice(src.indexOf("export async function getRepoContent") + 1);
  const next = rest.search(/\n(export |\/\*\*)/);
  const body = next > -1 ? rest.slice(0, next) : rest;
  assert.match(body, /encoding === 'none'/, "the oversized case must be recognised");
  assert.match(body, /application\/vnd\.github\.raw/, "and re-read through the raw media type");
  assert.match(body, /throw e/, "a failure there must be an error, not a silent null");
});

// --- F20: one call per card, per org, per deploy -----------------------------

test("the Pages fetch walks the git tree instead of the contents API", () => {
  const src = readFileSync(join(root, "scripts", "fetch-pages-data.mjs"), "utf8");
  assert.match(src, /git\/trees\/HEAD\?recursive=1/, "one call for the listing");
  assert.match(src, /git\/blobs\//, "and one blob per file, with no directory walk");
  assert.ok(
    !/contents\/public\/i/.test(src),
    "the contents listing caps at 1000 entries and cost a request per file"
  );
  assert.match(src, /truncated/, "a truncated tree must be reported, not silently short");
});

// --- The generated workflow still validates ---------------------------------

test("a generated autograding workflow is a workflow GitHub would accept", () => {
  const yaml = buildAutogradingWorkflow(
    {
      id: "lab",
      autograde: {
        visibility: "public",
        tests: [
          { id: "compile", type: "run", command: 'gcc -o a "main file.c"', points: 5 },
          { id: "io", type: "io", command: "./a", stdin: "1 2\n", expected_stdout: "3\n" },
          { id: "py", type: "python", script: 'print("hello: world")\n' },
        ],
      },
    },
    "PXLAutomation"
  );
  const doc = parse(yaml);
  assert.deepEqual(doc.on.push.branches, ["main"]);
  assert.equal(doc.jobs.grade["runs-on"], "ubuntu-latest");
  assert.equal(doc.jobs.grade.steps.length, 6, "checkout + 3 tests + reporter, + the python write step");
  for (const step of doc.jobs.grade.steps) {
    assert.ok(step.uses || step.run, "every step must do something");
  }
  const reporter = doc.jobs.grade.steps.at(-1);
  assert.equal(reporter.with.runners, "compile,io,py");
});

// --- A python test means the same thing on every runner ---------------------
//
// `provision.mjs` emitted `t.command || "pytest"` for type=python and never
// looked at `script`, while both CLI runners write `script` to t.py and run it
// and ignore `command`. The Admin Panel only ever writes `script`, so a
// lecturer's python test ran their code locally and the student repo's own
// pytest suite on Actions - the same definition, two meanings, no error.

test("a python test's script reaches the generated workflow, through env and not the run text", () => {
  const script = 'import sys\nprint("a: b", file=sys.stderr)  # quotes and colons\n';
  const doc = parse(
    buildAutogradingWorkflow(
      { id: "lab", autograde: { visibility: "public", tests: [{ id: "py", type: "python", script, points: 3 }] } },
      "PXLAutomation"
    )
  );
  const [, write, grade] = doc.jobs.grade.steps;

  assert.equal(write.env.PXL_SCRIPT, script, "the script survives verbatim");
  assert.equal(write.env.PXL_SCRIPT_PATH, ".pxl-autograde/py.py");
  assert.ok(
    !write.run.includes("import sys") && !write.run.includes('"a: b"'),
    "the script must reach the file through env:, never composed into the shell text"
  );
  assert.match(write.run, /"\$PXL_SCRIPT"/, "and the run text reads it from the environment");

  assert.equal(grade.uses, "classroom-resources/autograding-python-grader@v1");
  assert.equal(grade.with.command, "python3 .pxl-autograde/py.py", "it runs the script, not pytest");
  assert.ok(
    !JSON.stringify(grade.with).includes("pytest"),
    "`pytest` was the fallback that silently replaced the lecturer's script"
  );
});

test("the CLI runners and the Actions generator agree that `script` is the authoritative field", () => {
  const generator = readFileSync(join(root, "provisioning", "provision.mjs"), "utf8");
  // Bounded at the next `} else {` - the branch after this one is the command
  // grader, whose `command: t.command` would satisfy the assertion below and
  // make this test pass against nothing.
  const pythonStart = generator.indexOf('t.type === "python"');
  const pythonBranch = generator.slice(pythonStart, generator.indexOf("} else {", pythonStart));
  assert.ok(pythonStart > 0 && pythonBranch.length > 0, "the python branch must still be findable");
  assert.ok(pythonBranch.includes("t.script"), "the generator reads script");
  assert.ok(
    !/command:\s*t\.command/.test(pythonBranch),
    "and must not fall back to command - that is the fork this test exists to stop"
  );
  assert.ok(!/t\.setup_command/.test(pythonBranch), "setup_command is not a schema field");

  for (const runner of ["runner-host.mjs", "runner-docker.mjs"]) {
    const src = readFileSync(join(root, "cli", "src", "lib", runner), "utf8");
    // `if (` matters: runner-docker's imageFor() tests the same expression 60
    // lines earlier, and a slice from there covers the run/io branches too.
    const start = src.indexOf('if (test.type === "python")');
    assert.ok(start > 0, `${runner} must still have a python branch`);
    const branch = src.slice(start);
    assert.ok(branch.includes("test.script"), `${runner} reads script`);
    assert.ok(!branch.includes("test.command"), `${runner} must not read command for a python test`);
  }
});

test("the schema refuses a python test with no script", () => {
  const assignment = parse(readFileSync(join(root, "tests", "fixtures", "valid-assignment.yml"), "utf8"));
  const withAutograde = (t) => ({ ...assignment, autograde: { enabled: true, tests: [t] } });

  const ok = validateAgainst("assignment", withAutograde({ id: "py", type: "python", script: "print(1)", points: 1 }));
  assert.equal(ok.valid, true, JSON.stringify(ok.errors));

  const bad = validateAgainst("assignment", withAutograde({ id: "py", type: "python", command: "pytest", points: 1 }));
  assert.equal(bad.valid, false, "a python test carrying only `command` runs an empty script on every runner");
  assert.ok(bad.errors.some((e) => e.params?.missingProperty === "script"), JSON.stringify(bad.errors));
});

test("no tests, and no autograde block at all, both still produce valid YAML", () => {
  for (const autograde of [{ visibility: "public", tests: [] }, { visibility: "public" }, undefined]) {
    const doc = parse(buildAutogradingWorkflow({ id: "lab", autograde }, "PXLAutomation"));
    assert.equal(doc.name, "Autograding");
    assert.ok(doc.jobs.grade, "there must always be a grade job");
  }
});

// --- F12/F13 are exercised against the real script --------------------------

function runAccept(dir, envOverrides) {
  const outFile = join(dir, "out.txt");
  writeFileSync(outFile, "");
  execFileSync(process.execPath, [join(root, "acceptance", "accept.mjs")], {
    env: {
      ...process.env,
      DATA_DIR: dir,
      ORG: "PXLAutomation",
      CONTROL_REPO: "pxl-classroom-control",
      GITHUB_OUTPUT: outFile,
      ...envOverrides,
    },
    stdio: "pipe",
  });
  return Object.fromEntries(
    readFileSync(outFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
  );
}

function groupFixture({ teams = {}, acceptances = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pxl-accept-"));
  mkdirSync(join(dir, "assignments"), { recursive: true });
  mkdirSync(join(dir, "students"), { recursive: true });
  writeFileSync(
    join(dir, "assignments", "lab.yml"),
    [
      "schema_version: 1",
      "id: lab",
      "title: Lab",
      "state: published",
      "assignment_type: group",
      "roster_mode: open",
      "max_acceptances: 50",
      "repository_name_pattern: lab-{team_slug}",
      "template:",
      "  owner: PXLAutomation",
      "  repository: lab-template",
      "group_config:",
      "  max_team_size: 4",
    ].join("\n") + "\n"
  );
  for (const [slug, members] of Object.entries(teams)) {
    mkdirSync(join(dir, "teams", "lab"), { recursive: true });
    writeFileSync(
      join(dir, "teams", "lab", `${slug}.json`),
      JSON.stringify({ schema_version: 1, assignment_id: "lab", team_slug: slug, team_name: slug, members, max_members: 4 })
    );
  }
  for (const [login, record] of Object.entries(acceptances)) {
    mkdirSync(join(dir, "acceptances", "lab"), { recursive: true });
    writeFileSync(join(dir, "acceptances", "lab", `${login}.json`), JSON.stringify(record));
  }
  return dir;
}

test("the first student into a SEEDED team is the first member", () => {
  // A lecturer-seeded team lists all its members before anybody accepts, so
  // `members.length === 1` was false for the very first acceptance - and true
  // twice for a seeded team of one that somebody else then joined.
  const dir = groupFixture({ teams: { alpha: ["alice", "bob", "carol"] } });
  const out = runAccept(dir, {
    ASSIGNMENT_ID: "lab",
    GITHUB_LOGIN: "alice",
    GITHUB_ID: "1",
    TEAM_SLUG: "alpha",
  });
  assert.equal(out.outcome, "accepted");
  assert.equal(out.is_first_member, "true");
});

test("a later student into the same seeded team is not", () => {
  const dir = groupFixture({
    teams: { alpha: ["alice", "bob", "carol"] },
    acceptances: { alice: { schema_version: 1, github_login: "alice", accepted_at: "2026-01-01T00:00:00.000Z" } },
  });
  const out = runAccept(dir, {
    ASSIGNMENT_ID: "lab",
    GITHUB_LOGIN: "bob",
    GITHUB_ID: "2",
    TEAM_SLUG: "alpha",
  });
  assert.equal(out.is_first_member, "false");
});

test("a switch keeps the original accepted_at", () => {
  // It falls through the idempotency check because it has work to do, and then
  // rewrote the record with `now` - moving the timestamp that decides whether a
  // student accepted before the deadline.
  const ORIGINAL = "2026-01-01T09:00:00.000Z";
  const dir = groupFixture({
    teams: { alpha: ["dave"], beta: [] },
    acceptances: {
      dave: { schema_version: 1, assignment_id: "lab", github_login: "dave", github_id: 4, accepted_at: ORIGINAL, status: "accepted", team_slug: "alpha" },
    },
  });
  const out = runAccept(dir, {
    ASSIGNMENT_ID: "lab",
    GITHUB_LOGIN: "dave",
    GITHUB_ID: "4",
    TEAM_SLUG: "beta",
  });
  assert.equal(out.outcome, "accepted", "a switch is a fresh write, not already-accepted");
  assert.equal(out.team_slug, "beta");

  const record = JSON.parse(readFileSync(join(dir, "acceptances", "lab", "dave.json"), "utf8"));
  assert.equal(record.accepted_at, ORIGINAL, "the original acceptance time must survive the switch");
  assert.ok(existsSync(join(dir, "teams", "lab", "beta.json")));
});
