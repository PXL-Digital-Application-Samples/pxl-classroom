// PXL Classroom — scan.test.mjs
//
// The privacy scanner blocks publication of any Pages output containing
// roster fields, tokens, emails, or keys. Verify:
//   - the clean fixture exits 0
//   - the leaky fixture exits non-zero
//
// We run the actual scanner as a child process so we exercise the same
// entry point the workflow does.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const scanner = join(here, "..", "pages", "scan.mjs");
const fix = (n) => join(here, "fixtures", n);

function runScannerOn(fixtureName) {
  const dir = mkdtempSync(join(tmpdir(), "pxl-scan-test-"));
  copyFileSync(fix(fixtureName), join(dir, "assignments.json"));
  const res = spawnSync("node", [scanner, dir], { encoding: "utf8" });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

test("scanner passes a clean fixture", () => {
  const { code, stdout } = runScannerOn("public-clean.json");
  assert.equal(code, 0, `expected 0, got ${code}. stdout: ${stdout}`);
});

test("scanner blocks a leaky fixture (token + email + roster fields)", () => {
  const { code, stdout, stderr } = runScannerOn("public-leaky.json");
  assert.notEqual(code, 0, "scanner should reject the leaky fixture");
  // Per-finding "LEAK …" lines go to stdout; the blocking summary to stderr.
  // Verify both: stdout names triggered rules, stderr says BLOCKED.
  assert.match(
    stdout,
    /(github-token|email-address|roster-field|institutional-id-field)/i,
    `stdout did not name a triggered rule: ${stdout}`
  );
  assert.match(stderr, /BLOCKED/i, `stderr did not announce BLOCKED: ${stderr}`);
});
