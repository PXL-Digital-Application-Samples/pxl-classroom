import { readFileSync } from "node:fs";
import { gh, ghAll } from "../lib/gh.mjs";

const {
  ORG,
  CONTROL_REPO,
  REPORT_PATH,
  BUDGET_OWNER_LOGIN,
  GITHUB_TOKEN,
} = process.env;

const required = { ORG, CONTROL_REPO, REPORT_PATH, BUDGET_OWNER_LOGIN, GITHUB_TOKEN };
for (const [k, v] of Object.entries(required)) {
  if (!v) {
    console.error(`Missing env var: ${k}`);
    process.exit(2);
  }
}

const ISSUE_TITLE = "PXL Classroom — Weekly Usage Report";
const ghOpts = { token: GITHUB_TOKEN, throwOnError: true };

const report = JSON.parse(readFileSync(REPORT_PATH, "utf8"));
const overs = report.items.filter(i => i.over);

if (overs.length === 0) {
  console.log("Nothing over threshold — skipping notification.");
  process.exit(0);
}

// List open issues directly instead of using Search (Search has lower rate
// limits and is eventually consistent, causing duplicate issues on close-spaced
// reruns and silent skips during rate-limit spikes).
const openIssues = await ghAll(
  `/repos/${ORG}/${CONTROL_REPO}/issues?state=open&per_page=100`,
  ghOpts,
);
const existing = openIssues.find(i => i.title === ISSUE_TITLE && !i.pull_request);

let issueNumber;
if (existing) {
  issueNumber = existing.number;
} else {
  const created = await gh(
    "POST",
    `/repos/${ORG}/${CONTROL_REPO}/issues`,
    {
      title: ISSUE_TITLE,
      body: `Weekly usage report for \`${ORG}\`. The system appends a comment whenever a repo exceeds its configured limit.\n\nConfigure thresholds: \`limits.yml\` (global) · \`participating-orgs.yml\` (per-org) · \`limits-overrides.json\` (per-repo).`,
    },
    ghOpts,
  );
  issueNumber = created.data.number;
}

const lines = [
  `@${BUDGET_OWNER_LOGIN} — **${overs.length}** repo/SKU pair(s) over threshold for week ${report.week_start} → ${report.week_end}.`,
  "",
  "| Repo | SKU | Used | Limit | Unit | Source |",
  "|------|-----|------|-------|------|--------|",
];
for (const r of overs) {
  lines.push(`| \`${r.repo}\` | ${r.sku} | **${r.used}** | ${r.limit} | ${r.unit} | ${r.limit_source} |`);
}

await gh(
  "POST",
  `/repos/${ORG}/${CONTROL_REPO}/issues/${issueNumber}/comments`,
  { body: lines.join("\n") },
  ghOpts,
);
console.log(`Posted overrun comment to issue #${issueNumber}.`);
