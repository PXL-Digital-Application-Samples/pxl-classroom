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

import { parseTeamPayload, sanitizeTeamName, teamHintMatches } from "../lib/team-payload.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const BROKER = join(root, "acceptance", "broker-workflow.yml");
const EXPRESSION = /\$\{\{[^}]*\}\}/g;

// `${{ }}` is substituted into the script TEXT before the shell or the JS parser
// sees it. So the question is not "who can reach this value", it is "is this
// value a literal I wrote". Anything else goes through `env:`.
//
// The old rule named only github.event.* and client_payload, which is how
// sixteen sites survived - including `gh api users/${{ inputs.github_login }}`
// in retry-acceptance.yml, a job that runs with the App key in scope, and
// setup-org.yml interpolating an installation token and a dispatch input into
// the same line. Neither is broker-reachable, but the rule is not about
// reachability; it is about not composing scripts out of values.
//
// The allowlist is deliberately short: run-scoped facts GitHub sets itself,
// which no caller can influence.
const CONSTANT = new RegExp(
  "^\\$\\{\\{\\s*(" +
    [
      "github\\.(server_url|repository|repository_owner|run_id|run_number|run_attempt|workspace|action_path|sha|ref|ref_name|event_name|job|api_url|graphql_url|token)\\b",
      "runner\\.(os|arch|temp|tool_cache)\\b",
      "job\\.status\\b",
      "env\\.[A-Za-z_][A-Za-z0-9_]*",
      "'[^']*'", // a literal
    ].join("|") +
    ")\\s*\\}\\}$"
);

// github.actor is a login GitHub validates, but it still reaches scripts via
// env: everywhere in this repo - keeping it out of the allowlist means a future
// `run:` cannot start composing with it.
function isConstant(expr) {
  return CONSTANT.test(expr);
}

function workflowFiles() {
  const dir = join(root, ".github", "workflows");
  return [
    ...readdirSync(dir)
      .filter((f) => f.endsWith(".yml"))
      .map((f) => join(dir, f)),
    BROKER,
    // Composite actions run the same scripts with the same values.
    ...["acceptance", "collect", "lockdown", "notify", "pages", "preserve", "provisioning", "registry", "report"].map(
      (a) => join(root, a, "action.yml")
    ),
  ];
}

// Every place a workflow embeds a shell script or a github-script body.
function scriptBlocks(file) {
  const doc = parse(readFileSync(file, "utf8"));
  const out = [];
  // A workflow has jobs; a composite action has runs.steps.
  const groups = doc?.jobs ? Object.entries(doc.jobs) : [["<composite>", doc?.runs ?? {}]];
  for (const [jobName, job] of groups) {
    for (const step of job?.steps || []) {
      const where = `${jobName}/${step.name || step.uses || "step"}`;
      if (typeof step.run === "string") out.push({ where, kind: "run", body: step.run });
      if (typeof step.with?.script === "string")
        out.push({ where, kind: "script", body: step.with.script });
    }
  }
  return out;
}

test("no workflow composes a script out of a value", () => {
  const offenders = [];
  for (const file of workflowFiles()) {
    for (const { where, kind, body } of scriptBlocks(file)) {
      for (const expr of body.match(EXPRESSION) || []) {
        if (!isConstant(expr)) {
          offenders.push(`${file.slice(root.length + 1)} [${where}] ${kind}: ${expr}`);
        }
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `Values must reach scripts through env:, never by substitution into the script text:\n  ${offenders.join("\n  ")}`
  );
});

test("the guard rejects the shapes that actually shipped", () => {
  // A regression on the rule itself. The previous version named only
  // github.event.* and client_payload, so every one of these passed it -
  // including `gh api users/${{ inputs.github_login }}` in a job holding the
  // App key, and an installation token interpolated one character from a
  // dispatch input in setup-org.yml.
  const shouldFail = [
    "${{ inputs.github_login }}",
    "${{ inputs.target_org }}",
    "${{ steps.generate_token.outputs.token }}",
    "${{ steps.prov.outputs.repo-url }}",
    "${{ matrix.org }}",
    "${{ matrix.assignment.assignment_id }}",
    "${{ github.event.issue.body }}",
    "${{ github.event.client_payload.org }}",
    "${{ secrets.PXL_APP_PRIVATE_KEY }}",
    "${{ needs.find-orgs.outputs.orgs }}",
    "${{ github.actor }}",
  ];
  for (const expr of shouldFail) {
    assert.equal(isConstant(expr), false, `${expr} must not count as a constant`);
  }

  for (const expr of [
    "${{ github.repository }}",
    "${{ github.run_id }}",
    "${{ github.workspace }}",
    "${{ runner.temp }}",
    "${{ env.SOME_VAR }}",
  ]) {
    assert.equal(isConstant(expr), true, `${expr} is a run-scoped constant`);
  }
});

test("retry-acceptance validates its inputs before anything uses them", () => {
  // This job provisions for an arbitrary login with the deadline bypassed, and
  // it holds the App key. Its inputs get checked first, not eventually.
  const doc = parse(readFileSync(join(root, ".github", "workflows", "retry-acceptance.yml"), "utf8"));
  const names = doc.jobs.retry.steps.map((s) => s.name);
  const validate = names.indexOf("Validate dispatch inputs");
  const use = names.indexOf("Look up student GitHub numeric ID");
  assert.ok(validate > -1, "there must be a validation step");
  assert.ok(validate < use, "and it must come before the first use");
});

test("setup-org validates the org before it builds a remote, and keeps the token out of the URL", () => {
  // It validated target_org in the step AFTER the one that used it, which is
  // not validation - and that step had an installation token substituted into
  // the same line, so a value that broke out of the URL had the credential.
  const doc = parse(readFileSync(join(root, ".github", "workflows", "setup-org.yml"), "utf8"));
  const step = Object.values(doc.jobs)
    .flatMap((j) => j.steps || [])
    .find((s) => s.name === "Initialize control repo structure");
  assert.ok(step, "the scaffold step must exist");

  const check = step.run.indexOf("grep -Eq");
  const remote = step.run.indexOf("git remote add");
  assert.ok(check > -1 && remote > -1 && check < remote, "validate, then use");

  const remoteLine = step.run.split("\n").find((l) => l.includes("git remote add"));
  assert.ok(!/x-access-token|:\$\{?GH_TOKEN/.test(remoteLine), `credential in the remote URL: ${remoteLine}`);
  assert.match(step.run, /http\.https:\/\/github\.com\/\.extraheader/, "the token goes in a header instead");
});

test("the broker never reads the issue body", () => {
  const content = readFileSync(BROKER, "utf8");
  assert.ok(
    !content.includes("github.event.issue.body"),
    "broker-workflow.yml must not reference the issue body anywhere - the hub reads and validates it"
  );
});

test("the broker reads the issue title only through env, against one strict pattern", () => {
  // The title carries the invitation token and the concurrency hint, so the
  // broker must read it - but through env:, where it is never substituted into
  // the script text. Test 1 proves that; this pins what may be extracted.
  const doc = parse(readFileSync(BROKER, "utf8"));
  const steps = Object.values(doc.jobs).flatMap((job) => job.steps || []);
  const titleSteps = steps.filter((step) =>
    JSON.stringify(step.env || {}).includes("github.event.issue.title")
  );
  assert.equal(titleSteps.length, 1, "exactly one step may take the issue title, and only via env:");
  assert.match(
    titleSteps[0].run,
    /RE='\^pxl-accept:\(\[A-Za-z0-9_-\]\{35\}\\\.\[A-Za-z0-9_-\]\{86\}\)\( team:\(\[a-z0-9\]\[a-z0-9-\]\{0,63\}\)\)\?\$'/,
    "the title may only be matched against the exact token+slug pattern"
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

// --- The team hint is a lock, not a label -----------------------------------
//
// The hub keys its concurrency group on the slug from the issue TITLE
// (client_payload.team_hint), because that is all it has before the body can be
// read. Per-team serialization is the only thing guarding max_team_size - there
// is no distributed lock (ARCHITECTURE §5.8) - so a body naming a different team
// than the title serializes against one team and writes to another.

test("a body naming a different team than the title is refused", () => {
  assert.equal(teamHintMatches("popular-team", "decoy"), false);
  assert.equal(teamHintMatches("popular-team", ""), false, "no hint, but a body slug");
  assert.equal(teamHintMatches("", "decoy"), false, "a hint, but no body slug");
});

test("agreement in any casing or padding is agreement", () => {
  // The title regex only accepts lowercase slugs, but the body is free text and
  // parseTeamPayload has already normalised it - being strict about whitespace
  // here would reject real students to no purpose.
  for (const [slug, hint] of [
    ["alpha-1", "alpha-1"],
    ["alpha-1", "ALPHA-1"],
    ["alpha-1", " alpha-1 "],
    ["", ""],
    ["", "   "],
  ]) {
    assert.equal(teamHintMatches(slug, hint), true, `${JSON.stringify([slug, hint])} must match`);
  }
});

test("individual acceptance carries neither, and matches", () => {
  assert.equal(teamHintMatches(undefined, undefined), true);
  assert.equal(teamHintMatches(null, null), true);
});

test("non-strings never match a real slug", () => {
  for (const junk of [null, undefined, 0, {}, [], true]) {
    assert.equal(teamHintMatches("alpha-1", junk), false, `${JSON.stringify(junk)}`);
    assert.equal(teamHintMatches(junk, "alpha-1"), false, `${JSON.stringify(junk)}`);
  }
});

test("the reader compares the two before it emits a slug", () => {
  const src = readFileSync(join(root, "scripts", "read-team-payload.mjs"), "utf8");
  const compare = src.indexOf("teamHintMatches");
  const emit = src.lastIndexOf("await setOutputs({ ...parsed");
  assert.ok(compare > -1, "read-team-payload.mjs must compare the hint");
  assert.ok(emit > -1 && compare < emit, "and must do it before emitting the payload");

  const handler = readFileSync(join(root, ".github", "workflows", "acceptance-handler.yml"), "utf8");
  assert.match(handler, /TEAM_HINT: \$\{\{ github\.event\.client_payload\.team_hint \}\}/,
    "the handler must pass the hint the concurrency group was built from");
});
