// The broker is a PUBLIC repository that carries the Provisioner App's private
// key as a repo secret, and any GitHub account can open an issue on it. Group
// acceptance introduced `BODY="${{ github.event.issue.body }}"` into a `run:`
// block there, which is arbitrary code execution against that key - an issue
// body of `"; <command>; echo "` breaks straight out of the assignment.
//
// Two invariants keep it shut:
//   1. No untrusted event data is interpolated into ANY script in ANY workflow.
//      Values reach scripts through `env:`, where they are never substituted
//      into the script text.
//   2. The broker never sees the issue body at all. It forwards the issue
//      NUMBER and the hub reads the body where it can validate it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

import { parseTeamPayload, sanitizeTeamName } from "../lib/team-payload.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const BROKER = join(root, "acceptance", "broker-workflow.yml");
const EXPRESSION = /\$\{\{[^}]*\}\}/g;
// github.event.* and client_payload.* are attacker-reachable: anyone can star a
// broker or open an issue on it, and client_payload is whatever the dispatcher sent.
const UNTRUSTED = /(github\.event\b|client_payload)/;

function workflowFiles() {
  const dir = join(root, ".github", "workflows");
  return [
    ...readdirSync(dir)
      .filter((f) => f.endsWith(".yml"))
      .map((f) => join(dir, f)),
    BROKER,
  ];
}

// Every place a workflow embeds a shell script or a github-script body.
function scriptBlocks(file) {
  const doc = parse(readFileSync(file, "utf8"));
  const out = [];
  for (const [jobName, job] of Object.entries(doc?.jobs || {})) {
    for (const step of job?.steps || []) {
      const where = `${jobName}/${step.name || step.uses || "step"}`;
      if (typeof step.run === "string") out.push({ where, kind: "run", body: step.run });
      if (typeof step.with?.script === "string")
        out.push({ where, kind: "script", body: step.with.script });
    }
  }
  return out;
}

test("no workflow interpolates untrusted event data into a script", () => {
  const offenders = [];
  for (const file of workflowFiles()) {
    for (const { where, kind, body } of scriptBlocks(file)) {
      for (const expr of body.match(EXPRESSION) || []) {
        if (UNTRUSTED.test(expr)) {
          offenders.push(`${file.slice(root.length + 1)} [${where}] ${kind}: ${expr}`);
        }
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `Untrusted event data must reach scripts via env:, never \${{ }}:\n  ${offenders.join("\n  ")}`
  );
});

test("the broker never reads the issue body", () => {
  const content = readFileSync(BROKER, "utf8");
  assert.ok(
    !content.includes("github.event.issue.body"),
    "broker-workflow.yml must not reference the issue body anywhere - the hub reads and validates it"
  );
});

test("the broker reads the issue title only through env, for the concurrency hint", () => {
  // The hub's concurrency group is evaluated at dispatch time, before the body
  // can be read, so the broker has to supply the team slug for it. Taking the
  // title through env: and matching it with a bash regex is safe - the value is
  // never substituted into the script text. Test 1 proves that; this pins what
  // the step is allowed to extract.
  const doc = parse(readFileSync(BROKER, "utf8"));
  const steps = Object.values(doc.jobs).flatMap((job) => job.steps || []);
  const titleSteps = steps.filter((step) =>
    JSON.stringify(step.env || {}).includes("github.event.issue.title")
  );
  assert.equal(titleSteps.length, 1, "exactly one step may take the issue title, and only via env:");
  assert.match(
    titleSteps[0].run,
    /\[\[ "\$ISSUE_TITLE" =~ \^team:\(\[a-z0-9\]\[a-z0-9-\]\{0,63\}\)\$ \]\]/,
    "the title may only be matched against a strict slug regex"
  );
});

test("the broker forwards the issue number and its own repo instead", () => {
  const content = readFileSync(BROKER, "utf8");
  assert.ok(
    content.includes("client_payload[issue_number]"),
    "broker must forward the issue number so the hub can read the payload"
  );
  assert.ok(
    content.includes("client_payload[broker_repo]"),
    "broker must forward its own repository so the hub knows which issue to read"
  );
  assert.ok(
    !/client_payload\[team_(slug|name|action)\]/.test(content),
    "broker must not forward team fields it would have had to parse from the body"
  );
  assert.ok(
    content.includes("client_payload[team_hint]"),
    "broker must forward the title-derived concurrency hint (ARCHITECTURE §5.8)"
  );
});

test("the acceptance handler reads the team payload before accepting", () => {
  const content = readFileSync(join(root, ".github", "workflows", "acceptance-handler.yml"), "utf8");
  const readAt = content.indexOf("scripts/read-team-payload.mjs");
  const acceptAt = content.indexOf("uses: ./acceptance");
  assert.ok(readAt > -1, "acceptance-handler must run scripts/read-team-payload.mjs");
  assert.ok(acceptAt > -1, "acceptance-handler must run the ./acceptance action");
  assert.ok(readAt < acceptAt, "the team payload must be resolved before ./acceptance runs");
  for (const input of ["team-slug:", "team-name:", "team-action:"]) {
    assert.ok(
      content.includes(`${input} \${{ steps.team.outputs.`),
      `./acceptance must take ${input} from the validated payload step, not client_payload`
    );
  }
});

test("parseTeamPayload accepts a well-formed payload", () => {
  assert.deepEqual(
    parseTeamPayload({
      body: JSON.stringify({ team_slug: "alpha-1", team_name: "Team Alpha", team_action: "join" }),
    }),
    { team_slug: "alpha-1", team_name: "Team Alpha", team_action: "join" }
  );
});

test("parseTeamPayload falls back to the title form", () => {
  assert.equal(parseTeamPayload({ title: "team:beta-2" }).team_slug, "beta-2");
});

test("parseTeamPayload rejects hostile slugs", () => {
  const hostile = [
    { body: '"; echo pwned; echo "' },
    { body: JSON.stringify({ team_slug: "../../etc/passwd" }) },
    { body: JSON.stringify({ team_slug: "Alpha" }) },
    { body: JSON.stringify({ team_slug: "a".repeat(65) }) },
    { body: JSON.stringify({ team_slug: "-leading-hyphen" }) },
    { body: JSON.stringify(["team_slug"]) },
    { body: "not json at all" },
    { title: "team:../../evil" },
    { title: "team:has spaces" },
    {},
  ];
  for (const input of hostile) {
    assert.equal(
      parseTeamPayload(input).team_slug,
      "",
      `expected no slug from ${JSON.stringify(input).slice(0, 60)}`
    );
  }
});

test("parseTeamPayload only honours known team actions", () => {
  const ok = JSON.stringify({ team_slug: "a1", team_action: "switch" });
  assert.equal(parseTeamPayload({ body: ok }).team_action, "switch");
  const bad = JSON.stringify({ team_slug: "a1", team_action: "rm -rf /" });
  assert.equal(parseTeamPayload({ body: bad }).team_action, "");
});

test("sanitizeTeamName strips control characters that would forge outputs", () => {
  // GITHUB_OUTPUT is `name=value` lines, so a newline in a team name would let
  // a student append outputs of their own choosing.
  const nl = String.fromCharCode(10);
  const name = `Alpha${nl}assignment_id=evil${nl}outcome=accepted`;
  const cleaned = sanitizeTeamName(name);
  assert.ok(!cleaned.includes(nl), "newlines must not survive");
  assert.equal(cleaned, "Alpha assignment_id=evil outcome=accepted");

  assert.equal(sanitizeTeamName(String.fromCharCode(0, 7, 27, 127)), "");
  assert.equal(sanitizeTeamName("x".repeat(200)).length, 100);
  assert.equal(sanitizeTeamName(undefined), "");
  assert.equal(sanitizeTeamName({ toString: () => "nope" }), "");
});
