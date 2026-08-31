import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { parse as parseYaml } from "yaml";
import { gh, ghAllItems } from "../lib/gh.mjs";
import { readUtf8OrFail } from "./lib/encoding.mjs";
import { validateAgainst } from "../lib/validate.mjs";

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
{
  // A limit the schema rejects is a limit nobody can rely on: the numbers here
  // decide when an org is warned it is about to overspend, and a typo in a sku
  // or a limit silently drops that warning.
  const { valid, errors } = validateAgainst("limits", limits);
  if (!valid) {
    console.error(
      `${LIMITS_PATH} does not match limits.schema.json: ` +
        errors.slice(0, 4).map((e) => `${e.instancePath || "/"} ${e.message}`).join("; ")
    );
    process.exit(2);
  }
}
const globalLimits = new Map((limits.weekly_limits || []).map(l => [l.sku, l.limit]));

const porgs = parseYaml(readUtf8OrFail(PORGS_PATH));
const orgEntry = (porgs.orgs || []).find(o => o.login === ORG) || {};
const orgOverrides = orgEntry.overrides || {};

// ABSENT and MALFORMED are different answers. The old `catch {}` swallowed
// both, so a limits-overrides.json with a typo in it read as "no overrides
// configured" - the lecturer's raised limit silently stopped applying and the
// org was warned against the global number instead, with nothing said anywhere.
// A file that is not there is a legitimate "none"; a file that is there and
// unreadable is a configuration error and has to be one.
let repoOverrides = {};
{
  const overridesPath = `${CONTROL_DIR}/limits-overrides.json`;
  let raw = null;
  try {
    raw = readFileSync(overridesPath, "utf8");
  } catch {
    raw = null; // none configured, which is the common case
  }
  if (raw !== null) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      console.error(`${overridesPath} is present but is not valid JSON: ${e.message}`);
      process.exit(2);
    }
    const { valid, errors } = validateAgainst("limits-overrides", parsed);
    if (!valid) {
      console.error(
        `${overridesPath} does not match limits-overrides.schema.json: ` +
          errors.slice(0, 4).map((e) => `${e.instancePath || "/"} ${e.message}`).join("; ")
      );
      process.exit(2);
    }
    repoOverrides = parsed.repos || {};
  }
}

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
// Enhanced Billing requires `organization_administration: read`. An existing
// installation may not have accepted that permission update yet, or the org
// may not have Enhanced Billing. Skip that org rather than failing unrelated
// matrix legs; System Health probes this endpoint and reports the exact gap.
for (const ym of monthsToFetch) {
  const [year, month] = ym.split("-");
  let items;
  try {
    items = await ghAllItems(
      `/organizations/${orgId}/settings/billing/usage?year=${year}&month=${month}`,
      "usageItems",
      ghOpts,
    );
  } catch (err) {
    if (/\b(403|404)\b/.test(err.message)) {
      console.error(
        `[skip] ${ORG}: billing usage unavailable (${err.message.slice(0, 120)}).\n` +
        `       Grant the App "Organization Administration: read", have an org owner ` +
        `approve the update, and verify Enhanced Billing access - ADMIN.md §10.6. Skipping the usage report.`,
      );
      process.exit(0);
    }
    throw err;
  }
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
