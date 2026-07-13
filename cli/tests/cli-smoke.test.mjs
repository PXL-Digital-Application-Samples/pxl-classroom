// CLI smoke test — guards against parse/import errors shipping unnoticed.
//
// The bin imports every command module eagerly, so a single SyntaxError in
// any of them kills ALL commands (this happened: a stray brace in
// download.mjs broke the whole CLI for three weeks because no test imported
// the file). Two layers here:
//   1. dynamic-import every module under src/ — catches syntax + import errors
//   2. spawn `pxl-classroom --help` — proves the bin actually starts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const cliRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function mjsFilesUnder(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...mjsFilesUnder(full));
    else if (entry.name.endsWith(".mjs")) out.push(full);
  }
  return out;
}

test("every src module imports cleanly", async () => {
  const files = mjsFilesUnder(join(cliRoot, "src"));
  assert.ok(files.length > 0, "expected src/ modules");
  for (const file of files) {
    await assert.doesNotReject(
      () => import(pathToFileURL(file).href),
      `module failed to import: ${file}`,
    );
  }
});

test("bin starts and prints help", async () => {
  const { code, stdout } = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(cliRoot, "bin", "pxl-classroom.mjs"), "--help"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (b) => (out += b.toString()));
    child.on("error", reject);
    child.on("close", (c) => resolve({ code: c, stdout: out }));
  });
  assert.equal(code, 0, "pxl-classroom --help should exit 0");
  assert.match(stdout, /pxl-classroom/, "help output should name the binary");
});
