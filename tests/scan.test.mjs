// PXL Classroom - scan.test.mjs
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
import { mkdtempSync, copyFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { scanTree } from "../pages/scan.mjs";

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

// A file the scanner cannot read is not a file it has cleared.
//
// `readFile(...).catch(() => "")` made an unreadable file contribute no
// findings, count toward filesScanned, and be reported as part of "clean - N
// file(s) scanned, no private data found; safe to publish". This gate is the
// one thing standing between the private control repo and a world-readable
// Pages site, so it is the one place in the system that must never fail open.
//
// Driven through scanTree() with an injected reader rather than through the
// CLI: making a file genuinely unreadable is not portable (chmod is a no-op on
// Windows and for root in CI), and a test-only env var inside the scanner would
// be a backdoor in exactly the wrong file.
test("an unreadable file is reported, never counted as clean", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pxl-scan-unreadable-"));
  copyFileSync(fix("public-clean.json"), join(dir, "assignments.json"));

  const result = await scanTree(dir, {
    read: async () => {
      const err = new Error("EACCES: permission denied");
      err.code = "EACCES";
      throw err;
    },
  });

  assert.equal(result.findings, 0, "nothing could be read, so nothing was found");
  assert.equal(result.unreadable.length, 1, "and that is the answer, not silence");
  assert.match(result.unreadable[0], /permission denied/);
});

test("the CLI exits non-zero when scanTree reports an unreadable file", () => {
  // The wiring, checked separately from the detection: a non-empty `unreadable`
  // has to reach an exit code and a message, or the guard above buys nothing.
  const src = readFileSync(scanner, "utf8");
  const at = src.indexOf("if (unreadable.length)");
  assert.ok(at > -1, "main() no longer checks whether anything was unreadable");
  const block = src.slice(at, at + 400);
  assert.match(block, /scan_result.*blocked/s, "an unreadable file must set scan_result=blocked");
  assert.match(block, /process\.exit\(1\)/, "and must exit non-zero");
});
