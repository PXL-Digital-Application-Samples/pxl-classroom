import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import http from "node:http";
import { parse } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(here, "..", "scripts", "usage-fetch.mjs");

function runTest(env, apiResponses) {
  const dir = mkdtempSync(join(tmpdir(), "pxl-usage-test-"));
  
  // Schema-valid by default: usage-fetch.mjs validates limits.yml against
  // limits.schema.json before resolving anything, so a fixture missing
  // schema_version would test the validator rather than the resolution chain.
  writeFileSync(join(dir, "limits.yml"), env.limitsYaml || "schema_version: 1\nweekly_limits: []");
  writeFileSync(join(dir, "porgs.yml"), env.porgsYaml || "orgs: []");
  if (env.repoOverrides) {
    writeFileSync(join(dir, "limits-overrides.json"), JSON.stringify(env.repoOverrides));
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const key = url.pathname + url.search;
    
    if (apiResponses[key]) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(apiResponses[key]));
    } else {
      res.writeHead(404);
      res.end("Not Found: " + key);
    }
  });

  return new Promise((resolve) => {
    server.listen(0, () => {
      const port = server.address().port;
      
      const child = spawn("node", [scriptPath], {
        encoding: "utf8",
        env: {
          ...process.env,
          ORG: "TestOrg",
          GITHUB_TOKEN: "fake",
          CONTROL_DIR: dir,
          LIMITS_PATH: join(dir, "limits.yml"),
          PORGS_PATH: join(dir, "porgs.yml"),
          WEEK_START: env.WEEK_START || "2026-01-01",
          WEEK_END: env.WEEK_END || "2026-01-07",
          GITHUB_API_URL: `http://localhost:${port}`
        }
      });
      
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", d => stdout += d);
      child.stderr.on("data", d => stderr += d);
      child.on("close", (code) => {
        server.close();
        resolve({ status: code, stdout, stderr, dir });
      });
    });
  });
}

test("repo -> org -> global threshold override resolution chain", async () => {
  // limits.schema.json requires schema_version and a unit on every entry.
  const limitsYaml = `schema_version: 1\nweekly_limits:\n  - sku: "ubuntu-min"\n    unit: Minutes\n    limit: 10\n  - sku: "windows-min"\n    unit: Minutes\n    limit: 100\n`;
  const porgsYaml = `orgs:\n  - login: TestOrg\n    overrides:\n      ubuntu-min: 20\n`;
  // limits-overrides.schema.json requires schema_version alongside repos, and a
  // present-but-invalid overrides file is now a configuration error rather than
  // being swallowed as "none configured".
  const repoOverrides = { schema_version: 1, repos: { "repo-override": { "ubuntu-min": 30 }, "repo-ok-override": { "ubuntu-min": 30 } } };
  
  const apiResponses = {
    "/orgs/TestOrg": { id: 123 },
    "/organizations/123/settings/billing/usage?year=2026&month=1": {
      usageItems: [
        { date: "2026-01-05T12:00:00Z", repositoryName: "repo-global", sku: "windows-min", unitType: "minute", quantity: 150 },
        { date: "2026-01-05T12:00:00Z", repositoryName: "repo-org", sku: "ubuntu-min", unitType: "minute", quantity: 25 },
        { date: "2026-01-05T12:00:00Z", repositoryName: "repo-override", sku: "ubuntu-min", unitType: "minute", quantity: 35 },
        { date: "2026-01-05T12:00:00Z", repositoryName: "repo-ok-global", sku: "windows-min", unitType: "minute", quantity: 50 },
        { date: "2026-01-05T12:00:00Z", repositoryName: "repo-ok-org", sku: "ubuntu-min", unitType: "minute", quantity: 15 },
        { date: "2026-01-05T12:00:00Z", repositoryName: "repo-ok-override", sku: "ubuntu-min", unitType: "minute", quantity: 25 },
      ]
    }
  };
  
  const env = { limitsYaml, porgsYaml, repoOverrides, WEEK_START: "2026-01-05", WEEK_END: "2026-01-11" };
  const res = await runTest(env, apiResponses);
  assert.equal(res.status, 0, res.stderr);
  
  const latestJson = JSON.parse(readFileSync(join(res.dir, "reports", "usage-latest.json"), "utf8"));
  
  const getRepo = (name) => latestJson.items.find(i => i.repo === name);
  
  const rGlobal = getRepo("repo-global");
  assert.equal(rGlobal.limit, 100);
  assert.equal(rGlobal.limit_source, "global");
  assert.equal(rGlobal.over, true);
  
  const rOrg = getRepo("repo-org");
  assert.equal(rOrg.limit, 20);
  assert.equal(rOrg.limit_source, "org");
  assert.equal(rOrg.over, true);
  
  const rOverride = getRepo("repo-override");
  assert.equal(rOverride.limit, 30);
  assert.equal(rOverride.limit_source, "repo");
  assert.equal(rOverride.over, true);

  const rOkGlobal = getRepo("repo-ok-global");
  assert.equal(rOkGlobal.limit, 100);
  assert.equal(rOkGlobal.limit_source, "global");
  assert.equal(rOkGlobal.over, false);
  
  const rOkOrg = getRepo("repo-ok-org");
  assert.equal(rOkOrg.limit, 20);
  assert.equal(rOkOrg.limit_source, "org");
  assert.equal(rOkOrg.over, false);
  
  const rOkOverride = getRepo("repo-ok-override");
  assert.equal(rOkOverride.limit, 30);
  assert.equal(rOkOverride.limit_source, "repo");
  assert.equal(rOkOverride.over, false);
  
  assert.equal(latestJson.over_count, 3);
});

// Measured on PXL-Digital-Application-Samples and PXL-Systems-Advanced,
// 2026-10-25: the hub's 5,479 minutes and docker-labs' 25 GB-hours were both "over"
// with a net charge of zero, and the report had been red for four weeks.
const LIMITS = `schema_version: 1\nweekly_limits:\n  - sku: "Actions Linux"\n    unit: Minutes\n    limit: 800\n  - sku: "Actions storage"\n    unit: GigabyteHours\n    limit: 168\n`;
const USAGE = "/organizations/123/settings/billing/usage?year=2026&month=1";
const PUBLIC_REPOS = "/orgs/TestOrg/repos?type=public&per_page=100";
const item = (repositoryName, sku, quantity) => ({ date: "2026-01-05T12:00:00Z", repositoryName, sku, unitType: "x", quantity });

async function usageReport(items, { publicRepos, porgsYaml, repoOverrides } = {}) {
  const apiResponses = { "/orgs/TestOrg": { id: 123 }, [USAGE]: { usageItems: items } };
  if (publicRepos) apiResponses[PUBLIC_REPOS] = publicRepos.map((name) => ({ name }));
  const res = await runTest({ limitsYaml: LIMITS, porgsYaml, repoOverrides, WEEK_START: "2026-01-05", WEEK_END: "2026-01-11" }, apiResponses);
  assert.equal(res.status, 0, res.stderr);
  const report = JSON.parse(readFileSync(join(res.dir, "reports", "usage-latest.json"), "utf8"));
  return { report, stderr: res.stderr, row: (repo, sku) => report.items.find((i) => i.repo === repo && i.sku === sku) };
}

test("a public repository's minutes are free: no limit, never over, and it says why", async () => {
  const { report, row } = await usageReport([item("pxl-classroom", "Actions Linux", 5479)], { publicRepos: ["pxl-classroom"] });
  const hub = row("pxl-classroom", "Actions Linux");
  assert.equal(hub.over, false, "a null limit must not compare as zero");
  assert.equal(hub.limit, null);
  assert.equal(hub.limit_source, "public");
  assert.equal(report.over_count, 0);
});

test("a private repository's minutes still count, whatever the public ones do", async () => {
  const { report, row } = await usageReport(
    [item("pxl-classroom", "Actions Linux", 5479), item("exam-repo", "Actions Linux", 801)],
    { publicRepos: ["pxl-classroom"] },
  );
  assert.equal(row("exam-repo", "Actions Linux").over, true);
  assert.equal(row("exam-repo", "Actions Linux").limit_source, "global");
  assert.equal(report.over_count, 1);
});

test("only minutes are exempt: storage on a public repository is still measured", async () => {
  const { row } = await usageReport([item("pxl-classroom", "Actions storage", 200)], { publicRepos: ["pxl-classroom"] });
  assert.equal(row("pxl-classroom", "Actions storage").over, true);
  assert.equal(row("pxl-classroom", "Actions storage").limit_source, "global");
});

test("a listing that failed exempts nothing, and says so", async () => {
  const { row, stderr } = await usageReport([item("pxl-classroom", "Actions Linux", 5479)]);
  assert.equal(row("pxl-classroom", "Actions Linux").over, true, "a false warning, never a silent overrun");
  assert.match(stderr, /could not list public repositories/);
});

test("a limit a person set on one repository outranks the exemption; an org's does not", async () => {
  const overrides = { schema_version: 1, repos: { "pxl-classroom": { "Actions Linux": 1000 } } };
  const asked = await usageReport([item("pxl-classroom", "Actions Linux", 5479)], { publicRepos: ["pxl-classroom"], repoOverrides: overrides });
  assert.equal(asked.row("pxl-classroom", "Actions Linux").over, true);
  assert.equal(asked.row("pxl-classroom", "Actions Linux").limit_source, "repo");

  const porgsYaml = `orgs:\n  - login: TestOrg\n    overrides:\n      Actions Linux: 20\n`;
  const org = await usageReport([item("pxl-classroom", "Actions Linux", 5479)], { publicRepos: ["pxl-classroom"], porgsYaml });
  assert.equal(org.row("pxl-classroom", "Actions Linux").limit_source, "public");
});

test("limits.yml: a GB-hours limit is at least one GB held all week, and storage does not fire at the amounts that are normal here", () => {
  const limits = parse(readFileSync(join(here, "..", "limits.yml"), "utf8"));
  const gbHours = limits.weekly_limits.filter((l) => l.unit === "GigabyteHours");
  assert.ok(gbHours.length > 0, "sanity: limits.yml has GB-hours limits");
  for (const l of gbHours) assert.ok(l.limit >= 168, `${l.sku}: ${l.limit} GB-hours is less than 1 GB for a week`);
  const storage = limits.weekly_limits.find((l) => l.sku === "Actions storage").limit;
  assert.ok(storage > 25, "docker-labs' measured 25 GB-hours, about 0.15 GB held");
});

test("ISO week computation", async () => {
  const env = { WEEK_START: "2025-12-29", WEEK_END: "2026-01-04" };
  const apiResponses = {
    "/orgs/TestOrg": { id: 123 },
    "/organizations/123/settings/billing/usage?year=2025&month=12": { usageItems: [] },
    "/organizations/123/settings/billing/usage?year=2026&month=1": { usageItems: [] }
  };
  const res = await runTest(env, apiResponses);
  assert.equal(res.status, 0, res.stderr);
  
  const fileExists = existsSync(join(res.dir, "reports", "usage-2026-W01.json"));
  assert.equal(fileExists, true);
});
