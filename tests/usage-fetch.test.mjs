import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import http from "node:http";

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(here, "..", "scripts", "usage-fetch.mjs");

function runTest(env, apiResponses) {
  const dir = mkdtempSync(join(tmpdir(), "pxl-usage-test-"));
  
  writeFileSync(join(dir, "limits.yml"), env.limitsYaml || "weekly_limits: []");
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
  const limitsYaml = `weekly_limits:\n  - sku: "ubuntu-min"\n    limit: 10\n  - sku: "windows-min"\n    limit: 100\n`;
  const porgsYaml = `orgs:\n  - login: TestOrg\n    overrides:\n      ubuntu-min: 20\n`;
  const repoOverrides = { repos: { "repo-override": { "ubuntu-min": 30 }, "repo-ok-override": { "ubuntu-min": 30 } } };
  
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
