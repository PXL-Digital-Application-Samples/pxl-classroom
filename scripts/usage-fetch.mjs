import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { parse as parseYaml } from "yaml";
import { gh, ghAllItems } from "../lib/gh.mjs";
import { readUtf8OrFail } from "./lib/encoding.mjs";

const {
  ORG,
  GITHUB_TOKEN,
  CONTROL_DIR,
  LIMITS_PATH,
  PORGS_PATH,
  WEEK_START,
  WEEK_END,
  GITHUB_OUTPUT,
} = process.env;

const required = { ORG, GITHUB_TOKEN, CONTROL_DIR, LIMITS_PATH, PORGS_PATH, WEEK_START, WEEK_END };
for (const [k, v] of Object.entries(required)) {
  if (!v) {
    console.error(`Missing env var: ${k}`);
    process.exit(2);
  }
}

const limits = parseYaml(readUtf8OrFail(LIMITS_PATH));
const globalLimits = new Map((limits.weekly_limits || []).map(l => [l.sku, l.limit]));

const porgs = parseYaml(readUtf8OrFail(PORGS_PATH));
const orgEntry = (porgs.orgs || []).find(o => o.login === ORG) || {};
const orgOverrides = orgEntry.overrides || {};

let repoOverrides = {};
try {
  const parsed = JSON.parse(readFileSync(`${CONTROL_DIR}/limits-overrides.json`, "utf8"));
  repoOverrides = parsed.repos || {};
} catch { /* none configured */ }

function resolveLimit(repo, sku) {
  if (repoOverrides[repo] && repoOverrides[repo][sku] !== undefined) {
    return { limit: repoOverrides[repo][sku], source: "repo" };
  }
  if (orgOverrides[sku] !== undefined) {
    return { limit: orgOverrides[sku], source: "org" };
  }
  if (globalLimits.has(sku)) {
    return { limit: globalLimits.get(sku), source: "global" };
  }
  return null;
}

const ghOpts = { token: GITHUB_TOKEN, throwOnError: true };

const orgInfoRes = await gh("GET", `/orgs/${ORG}`, null, ghOpts);
const orgId = orgInfoRes.data.id;

const monthsToFetch = new Set();
for (let d = new Date(WEEK_START + "T00:00:00Z"); d <= new Date(WEEK_END + "T23:59:59Z"); d.setUTCDate(d.getUTCDate() + 1)) {
  monthsToFetch.add(`${d.getUTCFullYear()}-${d.getUTCMonth() + 1}`);
}

const allItems = [];
for (const ym of monthsToFetch) {
  const [year, month] = ym.split("-");
  const items = await ghAllItems(
    `/organizations/${orgId}/settings/billing/usage?year=${year}&month=${month}`,
    "usageItems",
    ghOpts,
  );
  for (const item of items) {
    const day = (item.date || "").slice(0, 10);
    if (day >= WEEK_START && day <= WEEK_END) allItems.push(item);
  }
}

const groups = new Map();
for (const item of allItems) {
  const repo = item.repositoryName || "<org-level>";
  const key = `${repo} ${item.sku}`;
  if (!groups.has(key)) {
    groups.set(key, { repo, sku: item.sku, unit: item.unitType, used: 0 });
  }
  groups.get(key).used += item.quantity;
}

const items = [];
for (const g of groups.values()) {
  const limit = resolveLimit(g.repo, g.sku);
  const usedRounded = Math.round(g.used * 1000) / 1000;
  items.push({
    repo: g.repo,
    sku: g.sku,
    unit: g.unit,
    used: usedRounded,
    limit: limit ? limit.limit : null,
    limit_source: limit ? limit.source : "none",
    over: limit ? usedRounded > limit.limit : false,
  });
}

items.sort((a, b) => {
  if (a.over !== b.over) return a.over ? -1 : 1;
  return b.used - a.used;
});

const overCount = items.filter(i => i.over).length;

const report = {
  schema_version: 1,
  org: ORG,
  week_start: WEEK_START,
  week_end: WEEK_END,
  generated_at: new Date().toISOString(),
  over_count: overCount,
  items,
};

function isoWeek(dateStr) {
  const d = new Date(Date.UTC(...dateStr.split("-").map((s, i) => i === 1 ? Number(s) - 1 : Number(s))));
  const target = new Date(d);
  const dayNum = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  return { year: target.getUTCFullYear(), week: Math.ceil(((target - yearStart) / 86400000 + 1) / 7) };
}

const { year, week } = isoWeek(WEEK_END);
const datedPath = `${CONTROL_DIR}/reports/usage-${year}-W${String(week).padStart(2, "0")}.json`;
const latestPath = `${CONTROL_DIR}/reports/usage-latest.json`;

mkdirSync(dirname(datedPath), { recursive: true });
const json = JSON.stringify(report, null, 2) + "\n";
writeFileSync(datedPath, json);
writeFileSync(latestPath, json);

console.log(`Wrote ${datedPath}`);
console.log(`over_count=${overCount}`);

if (GITHUB_OUTPUT) {
  writeFileSync(GITHUB_OUTPUT, `over_count=${overCount}\n`, { flag: "a" });
}
