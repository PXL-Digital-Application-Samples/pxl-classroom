#!/usr/bin/env node
// Retry: can the hub show it admitted this account to this assignment before?
//
// lib/earlier-admission.mjs says why this exists and what counts. This makes
// the reads and hands the verdict to the acceptance step as `admitted_at`,
// which is empty unless every part was read and matches. Nothing here writes,
// and nothing here fails the Retry: a read that does not answer is "no", and
// the acceptance then asks for the confirmed address as it always did.
//
// Env: DATA_DIR, ORG, ASSIGNMENT_ID, GITHUB_LOGIN, GITHUB_ID, GITHUB_TOKEN,
//      GITHUB_OUTPUT
// Outputs: admitted_at (ISO time or empty)

import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { gh, ghAll } from "../lib/gh.mjs";
import { loadYaml } from "../lib/yaml.mjs";
import { APP_SLUG } from "../lib/deployment.mjs";
import { INVITED_LABEL } from "../lib/acceptance-labels.mjs";
import { brokerRepoName } from "../lib/broker-repo.mjs";
import { repositoryNameFor } from "../lib/repo-name.mjs";
import { judgeEarlierAdmission } from "../lib/earlier-admission.mjs";

const dataDir = process.env.DATA_DIR || "control";
const org = process.env.ORG || "";
const assignmentId = process.env.ASSIGNMENT_ID || "";
const login = process.env.GITHUB_LOGIN || "";
const githubId = Number(process.env.GITHUB_ID);

function give(at, note) {
  console.log(`[${at ? "ok" : "no"}] earlier admission - ${note}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `admitted_at=${at || ""}\n`);
  process.exit(0);
}

let assignment;
try {
  assignment = await loadYaml(join(dataDir, "assignments", `${assignmentId}.yml`));
} catch (err) {
  give(null, `the assignment could not be read (${err.message})`);
}
if (!assignment || typeof assignment !== "object") give(null, "the assignment could not be read");
if (assignment.assignment_type === "team") give(null, "a team assignment: not asked");

const broker = brokerRepoName({ assignment, assignmentId });
const target = repositoryNameFor(assignment.repository_name_pattern, { login });
if (!broker || !target) give(null, "no broker or no repository name to ask about");

// This account's requests the broker shows as invited. `creator` is a login,
// and a login can have changed hands, so the verdict compares the id.
let issues;
try {
  issues = await ghAll(
    `/repos/${org}/${broker}/issues?state=all&creator=${encodeURIComponent(login)}&labels=${encodeURIComponent(INVITED_LABEL)}&per_page=100`,
  );
} catch (err) {
  give(null, `the acceptance requests could not be read (${err.message})`);
}
const requests = [];
for (const issue of (Array.isArray(issues) ? issues : []).filter((i) => !i.pull_request)) {
  let events = null;
  try {
    events = await ghAll(`/repos/${org}/${broker}/issues/${issue.number}/events?per_page=100`);
  } catch {
    events = null; // Unread is not evidence.
  }
  requests.push({ issue, events: Array.isArray(events) ? events : null });
}

const repoRes = await gh("GET", `/repos/${org}/${target}`);
const permRes = repoRes.ok
  ? await gh("GET", `/repos/${org}/${target}/collaborators/${encodeURIComponent(login)}/permission`)
  : null;

const verdict = judgeEarlierAdmission({
  assignmentType: assignment.assignment_type,
  githubId,
  requests,
  appBotLogin: `${APP_SLUG}[bot]`,
  repo: repoRes.ok ? repoRes.data : null,
  templateId: Number.isInteger(assignment.template?.repository_id) ? assignment.template.repository_id : null,
  templateFullName: assignment.template?.owner && assignment.template?.repository
    ? `${assignment.template.owner}/${assignment.template.repository}`
    : null,
  // The collaborator's own id, so a login that changed hands is not this account.
  permission: permRes?.ok && permRes.data?.user?.id === githubId ? permRes.data.permission : null,
});

give(
  verdict.admitted ? verdict.at : null,
  verdict.admitted
    ? `the hub admitted @${login} on ${verdict.at} (request ${org}/${broker} issue ${verdict.issue}) and created ${target} for them`
    : verdict.why,
);
