// Write a per-student repository record into a control-repo checkout, then
// validate against schemas/repository-record.schema.json before flushing to
// disk. Replaces an inline heredoc in acceptance-handler.yml / retry-acceptance.yml
// (CLAUDE.md: no `node -e` / large heredocs in workflow YAML).

import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { validateAgainst } from "../lib/validate.mjs";

const { values } = parseArgs({
  options: {
    "assignment-id": { type: "string" },
    "login":         { type: "string" },
    "org":           { type: "string" },
    "target-repo":   { type: "string" },
    "team-slug":     { type: "string" },
    "repo-id":       { type: "string" },
    "repo-url":      { type: "string" },
    "baseline-sha":  { type: "string" },
    "run-url":       { type: "string" },
    "data-dir":      { type: "string", default: "." },
  },
});

const required = ["assignment-id", "login", "org", "target-repo", "repo-url"];
const missing = required.filter((k) => !values[k]);
if (missing.length) {
  console.error(`::error::write-repository-record: missing required --${missing.join(", --")}`);
  process.exit(2);
}

const assignmentId = values["assignment-id"];
const login = values["login"];
const teamSlug = values["team-slug"];
const repoIdRaw = (values["repo-id"] || "").trim();
const baselineSha = (values["baseline-sha"] || "").trim();

const record = {
  schema_version: 1,
  assignment_id: assignmentId,
  github_login: login,
  repo_id: repoIdRaw ? Number(repoIdRaw) : null,
  repo_name: `${values["org"]}/${values["target-repo"]}`,
  repo_url: values["repo-url"],
  created_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  provisioned_by_run: values["run-url"] || undefined,
  student_permission: "admin",
  access_state: "invited",
  last_checked_at: null,
  feedback_pr_number: null,
  feedback_pr_url: null,
  feedback_pr_baseline_sha: baselineSha || null,
  ...(teamSlug ? { team_slug: teamSlug } : {}),
};

// repo_id is required by the schema; reject up-front rather than write garbage.
if (record.repo_id === null || Number.isNaN(record.repo_id)) {
  console.error("::error::write-repository-record: --repo-id is required and must be an integer");
  process.exit(2);
}

// Drop undefined-valued optional keys so additionalProperties:false stays happy.
for (const k of Object.keys(record)) {
  if (record[k] === undefined) delete record[k];
}

const { valid, errors } = validateAgainst("repository-record", record);
if (!valid) {
  console.error("::error::write-repository-record: schema validation failed");
  console.error(JSON.stringify(errors, null, 2));
  process.exit(1);
}

const outDir = join(values["data-dir"], "repositories", assignmentId);
const outPath = join(outDir, `${login}.json`);
mkdirSync(outDir, { recursive: true });
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(record, null, 2) + "\n");
console.log(`wrote ${outPath}`);

// If team-slug is provided, also update teams/<assignment-id>/<team-slug>.json with repo facts
if (teamSlug) {
  const teamPath = join(values["data-dir"], "teams", assignmentId, `${teamSlug}.json`);
  if (existsSync(teamPath)) {
    try {
      const team = JSON.parse(readFileSync(teamPath, "utf-8"));
      team.repo_name = record.repo_name;
      team.repo_id = record.repo_id;
      team.repo_url = record.repo_url;
      writeFileSync(teamPath, JSON.stringify(team, null, 2) + "\n");
      console.log(`updated team record ${teamPath}`);
    } catch (e) {
      console.error(`warning: could not update team record ${teamPath}: ${e.message}`);
    }
  }
}

