// roster_mode: org_member - gating acceptance on ORGANIZATION MEMBERSHIP.
//
// The problem it solves: a lecturer has a list of student EMAIL ADDRESSES and
// not their GitHub usernames. An installation token can never read a user's
// email addresses, and anything the browser sends is a claim rather than a
// credential - so email cannot be matched directly. Instead the lecturer
// invites the addresses to the organization, GitHub performs the
// email-to-account binding itself, and this gate asks GitHub for the result.
//
// Verified against the live API on 2026-08-25, which is what fixed the design:
//
//   GET /orgs/{org}/memberships/{login}   invited-not-accepted -> state "pending"
//                                         never invited        -> 404
//   GET /orgs/{org}/members/{login}       BOTH of those        -> 404
//
// So `/members/` cannot tell "waiting on the student" from "not enrolled", and
// that difference is the entire student-facing message. Using it would be the
// waiting-screen bug of CLAUDE.md again: a page guessing why it is stuck.
//
// The rule these tests exist to hold: an API error is NOT an outcome. A missing
// `members: read` approval, a 5xx or an exhausted rate limit must exit 1 as a
// fail:* - never silently admit a cohort, and never silently reject one either.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const acceptScript = join(here, "..", "acceptance", "accept.mjs");

const ORG = "PXL-2TIN-NetAdv-26-27";

function assignmentYaml(over = {}) {
  const doc = {
    state: "published",
    roster_mode: "org_member",
    repository_name_pattern: "hw-{github_login}",
    ...over,
  };
  return Object.entries(doc)
    .map(([k, v]) => (typeof v === "object" ? `${k}:\n${Object.entries(v).map(([k2, v2]) => `  ${k2}: ${v2}`).join("\n")}` : `${k}: ${v}`))
    .join("\n") + "\ntemplate:\n  owner: TestOrg\n  repository: tpl\n";
}

/**
 * Run the REAL accept.mjs against a REAL local HTTP server standing in for
 * api.github.com, reached through GITHUB_API_URL. Stubbing fetch would skip
 * lib/gh.mjs's retry policy, which is part of what decides reject-vs-fail here.
 */
async function runAccept({
  env = {},
  yaml = assignmentYaml(),
  noRoster = true,
  roster = null,
  acceptances = null,
  respond,
} = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    const out = respond ? respond(req.url, requests.length) : { status: 200, body: { state: "active", role: "member" } };
    res.writeHead(out.status, { "content-type": "application/json", ...(out.headers || {}) });
    res.end(JSON.stringify(out.body ?? {}));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();

  const dir = mkdtempSync(join(tmpdir(), "pxl-orgmember-"));
  const outputEnv = join(dir, "output.env");

  mkdirSync(join(dir, "assignments"), { recursive: true });
  writeFileSync(join(dir, "assignments", "test-asgn.yml"), yaml);

  if (!noRoster) {
    mkdirSync(join(dir, "students"), { recursive: true });
    writeFileSync(
      join(dir, "students", "roster.yml"),
      roster ?? JSON.stringify({ schema_version: 2, students: [] }),
    );
  }
  if (acceptances) {
    mkdirSync(join(dir, "acceptances", "test-asgn"), { recursive: true });
    for (const [login, data] of Object.entries(acceptances)) {
      writeFileSync(join(dir, "acceptances", "test-asgn", `${login}.json`), JSON.stringify(data));
    }
  }

  // spawn, NOT spawnSync. The mock server lives in THIS process, so a
  // synchronous spawn blocks the event loop that would answer the child's
  // request: accept.mjs waits on a fetch that can never be served and the whole
  // suite hangs. tests/accept.test.mjs uses spawnSync safely only because
  // nothing it exercises makes an HTTP call.
  const res = await new Promise((resolve) => {
    const child = spawn(process.execPath, [acceptScript], {
      env: {
        ...process.env,
        DATA_DIR: dir,
        GITHUB_OUTPUT: outputEnv,
        GITHUB_STEP_SUMMARY: join(dir, "summary.md"),
        GITHUB_API_URL: `http://127.0.0.1:${port}`,
        GITHUB_TOKEN: "ghs_test",
        ORG,
        ASSIGNMENT_ID: "test-asgn",
        GITHUB_LOGIN: "student-one",
        GITHUB_ID: "4242",
        ...env,
      },
    });
    let stdout = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stdout += d; });
    child.on("close", (code) => resolve({ status: code, stdout }));
  });

  // closeAllConnections first: undici keeps the connection alive, and a bare
  // close() waits for it forever.
  server.closeAllConnections();
  await new Promise((r) => server.close(r));

  const outputs = {};
  try {
    for (const line of readFileSync(outputEnv, "utf8").split("\n")) {
      if (!line) continue;
      const [k, ...v] = line.split("=");
      outputs[k] = v.join("=");
    }
  } catch { /* no outputs written */ }

  return { status: res.status, stdout: res.stdout, outputs, requests };
}

const ok = (body) => () => ({ status: 200, body });
const status = (s, body = {}) => () => ({ status: s, body });

// ======================================================= the three real states

test("an ACTIVE member is accepted", async () => {
  const r = await runAccept({ respond: ok({ state: "active", role: "member" }) });
  assert.equal(r.status, 0);
  assert.equal(r.outputs.outcome, "accepted");
  assert.equal(r.outputs.target_repo, "hw-student-one");
});

test("an org OWNER is active too - a lecturer testing their own link is not an outsider", async () => {
  const r = await runAccept({ respond: ok({ state: "active", role: "admin" }) });
  assert.equal(r.outputs.outcome, "accepted");
});

test("a PENDING invitation is rejected, and told to go and accept it", async () => {
  // Exit 0: the student has something to do, the system did not fail.
  const r = await runAccept({ respond: ok({ state: "pending", role: "member" }) });
  assert.equal(r.status, 0);
  assert.equal(r.outputs.outcome, "rejected:membership-pending");
  assert.match(r.outputs.reject_reason, /has not accepted yet/);
  assert.match(r.outputs.reject_reason, new RegExp(`orgs/${ORG}/invitation`));
});

test("a 404 is rejected, and names BOTH causes rather than guessing one", async () => {
  // An invitation to an address no GitHub account has verified leaves no
  // membership record at all - identical to never having been invited. Blaming
  // only the first would send a student who WAS invited to their lecturer with
  // the wrong question.
  const r = await runAccept({ respond: status(404, { message: "Not Found" }) });
  assert.equal(r.status, 0);
  assert.equal(r.outputs.outcome, "rejected:not-org-member");
  assert.match(r.outputs.reject_reason, /not a member/);
  assert.match(r.outputs.reject_reason, /has not verified/);
  assert.match(r.outputs.reject_reason, /Settings -> Emails/);
});

// ======================================================= errors are not outcomes

test("a permission 403 FAILS - it is not a statement about the student", async () => {
  // The realistic one: members: read never approved on that org. Admitting or
  // rejecting a whole cohort on this would be a silent, wrong answer.
  const r = await runAccept({
    respond: status(403, { message: "Resource not accessible by integration" }),
  });
  assert.equal(r.status, 1);
  assert.equal(r.outputs.outcome, "fail:membership-check");
  assert.match(r.stdout, /Members permission is not approved/);
  assert.match(r.stdout, /10\.6/);
});

test("a 401 FAILS rather than reading as 'not a member'", async () => {
  const r = await runAccept({ respond: status(401, { message: "Bad credentials" }) });
  assert.equal(r.status, 1);
  assert.equal(r.outputs.outcome, "fail:membership-check");
});

test("a 500 FAILS after the shared retry policy gives up", async () => {
  const r = await runAccept({ respond: status(500, { message: "Server Error" }) });
  assert.equal(r.status, 1);
  assert.equal(r.outputs.outcome, "fail:membership-check");
  assert.ok(r.requests.length > 1, "a 5xx must be retried, not failed on the first attempt");
});

test("a transient 500 that then succeeds is accepted", async () => {
  const r = await runAccept({
    respond: (_url, n) => (n === 1 ? { status: 500, body: { message: "Server Error" } } : { status: 200, body: { state: "active" } }),
  });
  assert.equal(r.outputs.outcome, "accepted");
});

// ======================================================= failing closed

test("an unrecognised membership state rejects rather than admitting", async () => {
  for (const state of ["invited", "", null, undefined, "ACTIVE"]) {
    const r = await runAccept({ respond: ok({ state }) });
    assert.equal(r.outputs.outcome, "rejected:not-org-member", `state ${JSON.stringify(state)}`);
    assert.equal(r.status, 0);
  }
});

test("a 200 with no body at all rejects rather than admitting", async () => {
  const r = await runAccept({ respond: () => ({ status: 200, body: null }) });
  assert.equal(r.outputs.outcome, "rejected:not-org-member");
});

test("an unrecognised roster_mode falls back to ENFORCED, not to org_member", async () => {
  // The fail-closed rule, which the new mode must not have widened. With no
  // roster present, enforced rejects - and crucially never calls the API.
  const r = await runAccept({ yaml: assignmentYaml({ roster_mode: "org_members" }) });
  assert.equal(r.outputs.outcome, "rejected:no-roster");
  assert.equal(r.requests.length, 0, "the membership endpoint must not be consulted");
});

// ======================================================= what it asks for

test("it queries /memberships/{login}, not /members/{login}", async () => {
  // /members/ answers 204/404 and cannot distinguish pending from unknown.
  const r = await runAccept({ respond: ok({ state: "active" }) });
  assert.equal(r.requests.length, 1);
  assert.equal(r.requests[0], `/orgs/${ORG}/memberships/student-one`);
  assert.doesNotMatch(r.requests[0], /\/members\//);
});

test("the login is sent as GitHub gave it, not lower-cased", async () => {
  const r = await runAccept({ env: { GITHUB_LOGIN: "Student-One" }, respond: ok({ state: "active" }) });
  assert.equal(r.requests[0], `/orgs/${ORG}/memberships/Student-One`);
});

// ======================================================= the roster is not the gate

test("NO roster file is fine - membership decides, not the roster", async () => {
  const r = await runAccept({ noRoster: true, respond: ok({ state: "active" }) });
  assert.equal(r.outputs.outcome, "accepted");
});

test("an empty roster is fine too", async () => {
  const r = await runAccept({ noRoster: false, respond: ok({ state: "active" }) });
  assert.equal(r.outputs.outcome, "accepted");
});

test("an UNPARSEABLE roster does not refuse the cohort", async () => {
  // Under `enforced` this is fail:exception, because the roster IS the gate.
  // Here it only costs team pre-assignment columns, which is a degraded group
  // resolution rather than grounds to turn every student away.
  const r = await runAccept({
    noRoster: false,
    roster: "students: [ unclosed",
    respond: ok({ state: "active" }),
  });
  assert.equal(r.outputs.outcome, "accepted");
});

test("a member who is NOT on the roster is still accepted", async () => {
  const r = await runAccept({
    noRoster: false,
    roster: JSON.stringify({ schema_version: 2, students: [{ student_number: "1", full_name: "Someone Else", github_login: "other" }] }),
    respond: ok({ state: "active" }),
  });
  assert.equal(r.outputs.outcome, "accepted");
});

// ======================================================= the other guardrails still apply

test("no max_acceptances is allowed - unlike open, membership is itself a limit", async () => {
  const r = await runAccept({ yaml: assignmentYaml(), respond: ok({ state: "active" }) });
  assert.equal(r.outputs.outcome, "accepted");
});

test("the cap is still enforced when one is set", async () => {
  const r = await runAccept({
    yaml: assignmentYaml({ max_acceptances: 1 }),
    acceptances: { alice: { accepted_at: "2026-01-01" } },
    respond: ok({ state: "active" }),
  });
  assert.equal(r.outputs.outcome, "rejected:cap-reached");
});

test("a draft is still refused before any membership call is made", async () => {
  const r = await runAccept({ yaml: assignmentYaml({ state: "draft" }), respond: ok({ state: "active" }) });
  assert.equal(r.outputs.outcome, "rejected:not-published");
  assert.equal(r.requests.length, 0);
});

test("a past deadline is still refused", async () => {
  const r = await runAccept({
    yaml: assignmentYaml({ deadline_at: "2020-01-01T00:00:00.000Z" }),
    respond: ok({ state: "active" }),
  });
  assert.equal(r.outputs.outcome, "rejected:past-deadline");
});

// ======================================================= the student-facing copy
//
// Checked at source level, as tests/student-wait-copy.test.mjs checks the
// waiting screen's. Reaching the timeout state in a browser means accepting and
// letting the poll give up; two e2e `not.toContainText` assertions written
// against a page that never got that far passed while the bug they were meant
// to catch was live. Comments are stripped first - they quote the copy.

const viewSource = (rel) =>
  readFileSync(join(here, "..", "frontend", "src", rel), "utf8")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

test("the student page blames the roster only where the roster is the gate", () => {
  const src = viewSource("views/AssignmentView.vue");
  const line = src.split("\n").find((l) => l.includes("not on the lecturer's roster"));
  assert.ok(line, "the enforced cause must still be offered");
  assert.match(
    line,
    /rosterMode === 'enforced'/,
    "it must be gated on `enforced`, not on `!== 'open'` - org_member does not gate on the roster, " +
      "so blaming it sends an enrolled student to their lecturer with the wrong question",
  );
});

test("the student page offers the membership cause, and names both halves of it", () => {
  const src = viewSource("views/AssignmentView.vue");
  assert.match(src, /rosterMode === 'org_member'/);
  assert.match(src, /not verified on your GitHub account/);
});

test("the student diagnostics modal does not run a roster check under org_member", () => {
  const src = viewSource("components/StudentDiagnosticsModal.vue");
  assert.match(src, /normalizeRosterMode\(assignment\?\.roster_mode\) === 'enforced'/);
});

test("no student-facing view decides the mode with its own ternary", () => {
  for (const rel of ["views/AssignmentView.vue", "components/StudentDiagnosticsModal.vue", "views/AdminView.vue"]) {
    assert.doesNotMatch(
      viewSource(rel),
      /roster_mode === 'open' \? 'open' : 'enforced'/,
      `${rel} must use normalizeRosterMode - the ternary silently rewrites any mode it predates`,
    );
  }
});

test("an already-accepted student is idempotent, as in every other mode", async () => {
  const r = await runAccept({
    acceptances: { "student-one": { github_login: "student-one", accepted_at: "2026-01-01", status: "provisioned" } },
    respond: ok({ state: "active" }),
  });
  assert.equal(r.status, 0);
  assert.match(r.outputs.outcome, /already-accepted|accepted/);
});
