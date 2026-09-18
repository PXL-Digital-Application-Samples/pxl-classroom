// Write a per-student repository record into a control-repo checkout, then
// validate against schemas/repository-record.schema.json before flushing to
// disk. Replaces an inline heredoc in acceptance-handler.yml / retry-acceptance.yml
// (CLAUDE.md: no `node -e` / large heredocs in workflow YAML).
//
// `--team-only` stamps the team manifest and writes NO per-student record. It is
// for provisioning that failed AFTER the team's repository existed: the student
// was never granted access, so a repository record would claim what did not
// happen - but the repository is this assignment's, and a team manifest that
// does not say so makes accept.mjs refuse every teammate as `rejected:repo-exists`
// over their own team's repository.

import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { validateAgainst } from "../lib/validate.mjs";
import { buildRepositoryRecord } from "../lib/team-member-records.mjs";

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
    "student-permission": { type: "string" },
    "data-dir":      { type: "string", default: "." },
    "team-only":     { type: "boolean", default: false },
  },
});

const teamOnly = values["team-only"];
const required = teamOnly
  ? ["assignment-id", "org", "target-repo", "team-slug", "repo-url"]
  : ["assignment-id", "login", "org", "target-repo", "repo-url"];
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
const repoId = repoIdRaw ? Number(repoIdRaw) : null;
const repoName = `${values["org"]}/${values["target-repo"]}`;

// repo_id is required by the schema; reject up-front rather than write garbage.
if (repoId === null || Number.isNaN(repoId)) {
  console.error("::error::write-repository-record: --repo-id is required and must be an integer");
  process.exit(2);
}

if (!teamOnly) {
  // One builder, shared with the Teams tab (lib/team-member-records.mjs).
  const record = buildRepositoryRecord({
    assignmentId,
    login,
    repo: { repo_id: repoId, repo_name: repoName, repo_url: values["repo-url"] },
    teamSlug,
    // What provisioning actually granted. This was the literal "admin" whatever
    // the assignment said, which was true only because provisioning ignored
    // the setting too.
    studentPermission: values["student-permission"] || "admin",
    runUrl: values["run-url"],
    baselineSha,
  });

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
}

// If team-slug is provided, also update teams/<assignment-id>/<team-slug>.json with repo facts.
// `repo_name` is `owner/name`, the same string as the repository record's;
// accept.mjs reads it through lib/existing-repo.mjs `teamManifestNamesRepo`.
if (teamSlug) {
  const teamPath = join(values["data-dir"], "teams", assignmentId, `${teamSlug}.json`);
  if (existsSync(teamPath)) {
    try {
      const team = JSON.parse(readFileSync(teamPath, "utf-8"));
      team.repo_name = repoName;
      team.repo_id = repoId;
      team.repo_url = values["repo-url"];
      writeFileSync(teamPath, JSON.stringify(team, null, 2) + "\n");
      console.log(`updated team record ${teamPath}`);
    } catch (e) {
      console.error(`warning: could not update team record ${teamPath}: ${e.message}`);
    }
  }
}
