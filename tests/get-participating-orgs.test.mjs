import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(here, "..", "scripts", "get-participating-orgs.mjs");

function runTest(yamlContent) {
  const dir = mkdtempSync(join(tmpdir(), "pxl-orgs-test-"));
  if (yamlContent !== null) {
    writeFileSync(join(dir, "participating-orgs.yml"), yamlContent);
  }
  
  const res = spawnSync("node", [scriptPath], {
    cwd: dir,
    encoding: "utf8",
  });
  
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

test("returns empty array if file is missing", () => {
  const res = runTest(null);
  assert.equal(res.status, 0);
  assert.equal(res.stdout, "[]");
});

test("returns empty array if file has no orgs key", () => {
  const res = runTest(`some_key: value`);
  assert.equal(res.status, 0);
  assert.equal(res.stdout, "[]");
});

test("extracts logins from yaml", () => {
  const yaml = `
orgs:
  - login: org1
    overrides: {}
  - login: org2
`;
  const res = runTest(yaml);
  assert.equal(res.status, 0);
  assert.equal(res.stdout, '["org1","org2"]');
});
