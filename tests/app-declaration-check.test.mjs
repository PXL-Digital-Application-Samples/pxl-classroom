import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MANIFEST_APP_PERMISSIONS, missingManifestPermissions } from "../lib/audit.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(root, "scripts", "check-app-declaration.mjs");

// Run the real script against a stubbed global fetch, so the comparison, the
// annotation text and the exit code are all exercised end to end.
function runScript({ ok = true, status = 200, permissions = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pxl-app-decl-"));
  const stub = join(dir, "stub-fetch.mjs");
  writeFileSync(
    stub,
    [
      "globalThis.fetch = async () => ({",
      `  ok: ${ok},`,
      `  status: ${status},`,
      `  json: async () => (${JSON.stringify({ permissions })}),`,
      "});",
      "",
    ].join("\n"),
  );
  try {
    const stdout = execFileSync(process.execPath, ["--import", pathToFileURL(stub).href, SCRIPT], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_TOKEN: "" },
    });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status, stdout: String(err.stdout || "") };
  }
}

test("missingManifestPermissions - a complete App has no gaps", () => {
  assert.deepEqual(missingManifestPermissions({ ...MANIFEST_APP_PERMISSIONS }), []);
});

test("missingManifestPermissions - a downgraded level counts as missing", () => {
  const weak = { ...MANIFEST_APP_PERMISSIONS, contents: "read" };
  const gaps = missingManifestPermissions(weak);
  assert.equal(gaps.length, 1);
  assert.deepEqual(gaps[0], { permission: "contents", expected: "write", actual: "read" });
});

test("missingManifestPermissions - a stronger level satisfies the manifest", () => {
  assert.deepEqual(missingManifestPermissions({ ...MANIFEST_APP_PERMISSIONS, metadata: "write" }), []);
});

test("missingManifestPermissions - no declaration at all reports every permission", () => {
  assert.equal(missingManifestPermissions(null).length, Object.keys(MANIFEST_APP_PERMISSIONS).length);
});

test("check-app-declaration - a complete App passes", () => {
  const { code, stdout } = runScript({ permissions: { ...MANIFEST_APP_PERMISSIONS } });
  assert.equal(code, 0);
  assert.match(stdout, /declares every permission in the manifest/);
});

// The 2026-08-21 drift: the manifest gained organization_administration, the
// live App never did, and nothing noticed until an onboarding failed.
test("check-app-declaration - drift fails the run with the remediation", () => {
  const declared = { ...MANIFEST_APP_PERMISSIONS };
  delete declared.organization_administration;
  const { code, stdout } = runScript({ permissions: declared });

  assert.equal(code, 1);
  assert.match(stdout, /^::error::/m);
  assert.match(stdout, /organization_administration=missing \(want read\)/);
  assert.match(stdout, /RUNBOOK\.md section 6\.7/);
});

test("check-app-declaration - an unreachable API warns, never fails", () => {
  const { code, stdout } = runScript({ ok: false, status: 503 });
  assert.equal(code, 0);
  assert.match(stdout, /^::warning::/m);
  assert.equal(/::error::/.test(stdout), false);
});
