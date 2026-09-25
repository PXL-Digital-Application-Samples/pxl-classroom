// scripts/grade-at-deadline.mjs under a hand-in cap - the nightly half.
//
// Driven as a subprocess against a real control-repo directory, with the
// allowances written where the Admin Panel writes them
// (`overrides/<id>/<login>.json`), and a fake API answering the branch, the
// push run history and the check runs. The in-process cases are in
// tests/hand-in-cap.test.mjs; this proves the script reads `overrides/` at all,
// refuses when it cannot, and writes a summary that validates.
//
// NOT spawnSync, for the reason tests/grade-at-deadline.test.mjs gives: the
// in-process server could never answer the child.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateAgainst } from "../lib/validate.mjs";
import { readOverrides } from "../scripts/grade-at-deadline.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(root, "scripts", "grade-at-deadline.mjs");
const ID = "exam";
const REPO = "TestOrg/exam-ada";
const MSG = "einde examen";
const DEADLINE = "2026-10-01T12:00:00.000Z";

const sha = (n) => `${n}`.padEnd(40, "d");
const at = (min) => new Date(Date.parse("2026-10-01T09:00:00Z") + min * 60_000).toISOString();

function controlDir({ cap = 2, overrides = {}, badOverride = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pxl-cap-"));
  for (const d of ["assignments", "reports"]) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(
    join(dir, "assignments", `${ID}.yml`),
    [
      "schema_version: 1",
      `id: ${ID}`,
      "title: Exam",
      "organization: TestOrg",
      "template:",
      "  owner: TestOrg",
      "  repository: tpl",
      `repository_name_pattern: ${ID}-{github_login}`,
      "opens_at: 2026-09-01T08:00:00.000Z",
      `deadline_at: ${DEADLINE}`,
      "state: closed",
      "template_grades: true",
      "submission_marker:",
      "  type: commit_message",
      `  value: ${MSG}`,
      "  multiple: true",
      ...(cap ? [`  max_hand_ins: ${cap}`] : []),
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(dir, "reports", `${ID}.json`),
    JSON.stringify({
      schema_version: 1,
      assignment_id: ID,
      generated_at: "2026-10-02T00:30:00.000Z",
      students: [{ github_login: "ada", repo_name: REPO, preserved_sha: sha(9), effective_deadline_at: DEADLINE }],
    }),
  );
  const odir = join(dir, "overrides", ID);
  if (Object.keys(overrides).length || badOverride) mkdirSync(odir, { recursive: true });
  for (const [login, entries] of Object.entries(overrides)) {
    writeFileSync(
      join(odir, `${login}.json`),
      JSON.stringify({ schema_version: 1, assignment_id: ID, github_login: login, overrides: entries }),
    );
  }
  if (badOverride) writeFileSync(join(odir, "ada.json"), "{ not json");
  return dir;
}

const grant = (extra) => ({
  type: "hand_in_allowance",
  value: extra,
  reason: "lab crashed",
  overridden_by: "lecturer1",
  overridden_at: "2026-10-01T13:00:00Z",
});

/** Three hand-ins: 09:10, 09:20, 09:30. Hand-in n scores n/10. */
function fakeApi({ runsStatus = 200 } = {}) {
  const state = { calls: [] };
  const handIns = [1, 2, 3];
  const server = createServer((req, res) => {
    state.calls.push(req.url);
    const send = (code, data) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    };
    if (req.url.startsWith(`/repos/${REPO}/commits?`)) {
      const page = Number(new URL(`http://x${req.url}`).searchParams.get("page"));
      const rows = handIns.map((n) => ({ sha: sha(n), commit: { message: MSG, committer: { date: at(n * 10) } } })).reverse();
      return send(200, page === 1 ? rows : []);
    }
    if (req.url.startsWith(`/repos/${REPO}/actions/runs?`)) {
      if (runsStatus !== 200) return send(runsStatus, { message: "Resource not accessible by integration" });
      const runs = handIns
        .map((n) => ({ id: n, head_sha: sha(n), head_branch: "main", created_at: at(n * 10), head_commit: { message: MSG, timestamp: at(n * 10) } }))
        .reverse();
      return send(200, { total_count: runs.length, workflow_runs: runs });
    }
    const cr = req.url.match(/\/commits\/(\w+)\/check-runs$/);
    if (cr) {
      const n = handIns.find((x) => sha(x) === cr[1]);
      return send(200, {
        check_runs: n
          ? [{ id: n, name: "run-autograding-tests", conclusion: "success", html_url: `https://x/${n}`, output: { summary: null, annotations_count: 1 } }]
          : [],
      });
    }
    const an = req.url.match(/\/check-runs\/(\d+)\/annotations/);
    if (an) return send(200, [{ annotation_level: "notice", message: `{"totalPoints":${an[1]},"maxPoints":10}` }]);
    // 400, never 5xx: lib/gh.mjs retries a 5xx with backoff and the suite hangs.
    return send(400, { message: `unexpected ${req.url}` });
  });
  return { server, state };
}

const run = (dir, port) =>
  new Promise((resolve) => {
    const child = spawn("node", [SCRIPT], {
      env: { ...process.env, DATA_DIR: dir, ASSIGNMENT_ID: ID, GITHUB_TOKEN: "x", GITHUB_API_URL: `http://127.0.0.1:${port}` },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });

async function withApi(dir, opts, fn) {
  const { server, state } = fakeApi(opts);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    return await fn(await run(dir, server.address().port), state);
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

const summaryAt = (dir) => {
  const p = join(dir, "grading", ID, "summary.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
};

async function scenario(name, dirOpts, apiOpts, check) {
  test(name, async () => {
    const dir = controlDir(dirOpts);
    try {
      await withApi(dir, apiOpts, (res, state) => check(res, dir, state));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

scenario("over the cap: hand-in 2 is graded and hand-in 3 is named in the log", { cap: 2 }, {}, (res, dir) => {
  assert.equal(res.status, 0, res.stderr);
  const doc = summaryAt(dir);
  assert.ok(doc, res.stdout);
  const v = validateAgainst("grading-summary", doc);
  assert.equal(v.valid, true, JSON.stringify(v.errors));
  assert.equal(doc.students[0].earned_points, 2);
  assert.deepEqual(
    { used: doc.students[0].hand_ins.used, allowed: doc.students[0].hand_ins.allowed },
    { used: 3, allowed: 2 },
  );
  assert.match(res.stdout, /ada: hand-in 3 of 2 at .* ignored: over the limit/);
});

scenario("an allowance written to overrides/ is read: hand-in 3 counts", { cap: 2, overrides: { ada: [grant(1)] } }, {}, (res, dir) => {
  const doc = summaryAt(dir);
  assert.ok(doc, res.stdout);
  assert.equal(doc.students[0].earned_points, 3);
  assert.equal(doc.students[0].hand_ins.allowed, 3);
  assert.deepEqual(doc.students[0].hand_ins.ignored, []);
});

scenario("a revoked allowance is read: back to hand-in 2", { cap: 2, overrides: { ada: [grant(1), grant(0)] } }, {}, (res, dir) => {
  assert.equal(summaryAt(dir).students[0].earned_points, 2);
});

scenario("an override file that does not parse writes NOTHING", { cap: 2, badOverride: true }, {}, (res, dir) => {
  // It may be the one grant that matters. Grading as if it did not exist would
  // ignore exactly the hand-in a lecturer said should count.
  assert.equal(res.status, 0, "and it does not fail the finalize");
  assert.equal(summaryAt(dir), null);
  assert.match(res.stdout, /could not read the hand-in allowances/);
});

scenario("the run history refused (no Actions permission) names the student and writes nothing", { cap: 2 }, { runsStatus: 403 }, (res, dir) => {
  assert.equal(res.status, 0);
  assert.equal(summaryAt(dir), null, "one student, not graded: nothing-graded refuses the write");
  assert.match(res.stdout, /ada: could not read this repository's Actions run history \(HTTP 403\)/);
});

scenario("no cap: no run-history read and no overrides read", { cap: null }, {}, (res, dir, state) => {
  const doc = summaryAt(dir);
  assert.equal(doc.students[0].earned_points, 3);
  assert.equal("hand_ins" in doc.students[0], false);
  assert.equal(state.calls.some((c) => c.includes("/actions/runs")), false);
});

test("readOverrides: absent is none, unreadable is a failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pxl-ovr-"));
  try {
    assert.deepEqual(await readOverrides(join(dir, "nope")), { ok: true, docs: [] });
    writeFileSync(join(dir, "ada.json"), JSON.stringify({ github_login: "ada", overrides: [] }));
    writeFileSync(join(dir, "README.md"), "not an override");
    const good = await readOverrides(dir);
    assert.equal(good.ok, true);
    assert.equal(good.docs.length, 1);
    writeFileSync(join(dir, "bo.json"), "{");
    const bad = await readOverrides(dir);
    assert.equal(bad.ok, false);
    assert.match(bad.error, /bo\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
