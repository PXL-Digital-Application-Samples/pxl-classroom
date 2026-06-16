import { readFileSync } from "node:fs";

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

const report = JSON.parse(readFileSync(REPORT_PATH, "utf8"));
const overs = report.items.filter(i => i.over);

if (overs.length === 0) {
  console.log("Nothing over threshold — skipping notification.");
  process.exit(0);
}

async function gh(method, path, body) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${path}: ${text}`);
  }
  return res.json();
}

const q = encodeURIComponent(`repo:${ORG}/${CONTROL_REPO} is:issue is:open in:title "${ISSUE_TITLE}"`);
const search = await gh("GET", `/search/issues?q=${q}`);

let issueNumber;
if (search.total_count > 0) {
  issueNumber = search.items[0].number;
} else {
  const created = await gh("POST", `/repos/${ORG}/${CONTROL_REPO}/issues`, {
    title: ISSUE_TITLE,
    body: `Weekly usage report for \`${ORG}\`. The system appends a comment whenever a repo exceeds its configured limit.\n\nConfigure thresholds: \`limits.yml\` (global) · \`participating-orgs.yml\` (per-org) · \`limits-overrides.json\` (per-repo).`,
  });
  issueNumber = created.number;
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

await gh("POST", `/repos/${ORG}/${CONTROL_REPO}/issues/${issueNumber}/comments`, { body: lines.join("\n") });
console.log(`Posted overrun comment to issue #${issueNumber}.`);
