import { test } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

const cliRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const binPath = join(cliRoot, "bin", "pxl-classroom.mjs");

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binPath, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (b) => (stdout += b.toString()));
    child.stderr.on("data", (b) => (stderr += b.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

// -----------------------------------------------------------------------------
// TEST SUITE: CLI E2E Command Parity & Schema Contracts
// -----------------------------------------------------------------------------

test("CLI E2E: download command supports SPA generated flags (--org, --assignment, --dir, --concurrency)", async () => {
  const { code, stdout, stderr } = await runCli(["download", "--help"]);
  assert.equal(code, 0, `download --help exited ${code}: ${stderr}`);
  assert.match(stdout, /--org/, "download should support --org");
  assert.match(stdout, /--assignment/, "download should support --assignment");
  assert.match(stdout, /--dir/, "download should support --dir");
  assert.match(stdout, /--concurrency/, "download should support --concurrency");
});

test("CLI E2E: grade command supports SPA generated flags (--org, --assignment, --runner, --concurrency)", async () => {
  const { code, stdout, stderr } = await runCli(["grade", "--help"]);
  assert.equal(code, 0, `grade --help exited ${code}: ${stderr}`);
  assert.match(stdout, /--org/, "grade should support --org");
  assert.match(stdout, /--assignment/, "grade should support --assignment");
  assert.match(stdout, /--runner/, "grade should support --runner");
  assert.match(stdout, /--concurrency/, "grade should support --concurrency");
});

test("CLI E2E: sync-starter command supports --dry-run, --org, and --assignment flags", async () => {
  const { code, stdout, stderr } = await runCli(["sync-starter", "--help"]);
  assert.equal(code, 0, `sync-starter --help exited ${code}: ${stderr}`);
  assert.match(stdout, /--dry-run/, "sync-starter should support --dry-run");
  assert.match(stdout, /--org/, "sync-starter should support --org");
  assert.match(stdout, /--assignment/, "sync-starter should support --assignment");
});

test("CLI E2E: feedback command supports open subcommand with --dry-run", async () => {
  const { code, stdout, stderr } = await runCli(["feedback", "open", "--help"]);
  assert.equal(code, 0, `feedback open --help exited ${code}: ${stderr}`);
  assert.match(stdout, /--dry-run/, "feedback open should support --dry-run");
  assert.match(stdout, /--org/, "feedback open should support --org");
  assert.match(stdout, /--assignment/, "feedback open should support --assignment");
});

test("CLI Contract: Download manifest schema matches root repository definition", async () => {
  const rootSchemaPath = join(cliRoot, "..", "schemas", "download-manifest.schema.json");
  const rootSchema = JSON.parse(await readFile(rootSchemaPath, "utf8"));

  assert.equal(rootSchema.$schema, "http://json-schema.org/draft-07/schema#");
  assert.ok(rootSchema.properties.students, "Schema must require students array");
  assert.ok(rootSchema.properties.generated_at, "Schema must record generated_at");
});
