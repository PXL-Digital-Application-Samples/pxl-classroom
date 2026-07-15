// The control repo scaffold has three consumers that historically drifted
// apart: setup-org.yml hand-rolled `mkdir -p` (missing students/, overrides/,
// errors/), control-repo-template/ was missing lockdowns/, and audit.mjs
// checked its own third list. Result: every org onboarded by setup-org.yml
// failed its own scaffold audit. These tests pin all of them to
// lib/control-layout.mjs and to ARCHITECTURE.md §5.1.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile, mkdtemp, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { CONTROL_SCAFFOLD_DIRS } from "../lib/control-layout.mjs";
import { CONTROL_SCAFFOLD_DIRS as REEXPORTED } from "../lib/audit.mjs";

const run = promisify(execFile);
const REPO_ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const exists = (p) => access(p).then(() => true, () => false);

test("audit.mjs re-exports the same layout list", () => {
  assert.deepEqual([...REEXPORTED], [...CONTROL_SCAFFOLD_DIRS]);
});

test("control-repo-template/ contains exactly the canonical dirs", async () => {
  const entries = await readdir(join(REPO_ROOT, "control-repo-template"), {
    withFileTypes: true,
  });
  const dirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();
  assert.deepEqual(dirs, [...CONTROL_SCAFFOLD_DIRS].sort());
});

test("ARCHITECTURE.md §5.1 documents every canonical dir", async () => {
  const md = await readFile(join(REPO_ROOT, "ARCHITECTURE.md"), "utf8");
  const layout = md.split("### 5.1 Control repository layout")[1].split("```")[1];
  for (const dir of CONTROL_SCAFFOLD_DIRS) {
    assert.ok(
      layout.includes(`${dir}/`),
      `ARCHITECTURE.md §5.1 does not document ${dir}/`
    );
  }
});

test("setup-org.yml scaffolds via the script, not a hand-rolled mkdir", async () => {
  const yml = await readFile(
    join(REPO_ROOT, ".github/workflows/setup-org.yml"),
    "utf8"
  );
  assert.ok(
    yml.includes("scripts/scaffold-control-repo.mjs"),
    "setup-org.yml must call the scaffold script"
  );
  assert.ok(
    !/mkdir -p assignments/.test(yml),
    "setup-org.yml must not hand-roll the scaffold dirs"
  );
});

test("scaffold script creates the full layout and is idempotent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pxl-scaffold-"));
  const script = join(REPO_ROOT, "scripts/scaffold-control-repo.mjs");

  const first = await run(process.execPath, [script, dir]);
  assert.match(first.stdout, /created/);

  for (const d of CONTROL_SCAFFOLD_DIRS) {
    assert.ok(await exists(join(dir, d, ".gitkeep")), `${d}/.gitkeep missing`);
  }
  assert.ok(await exists(join(dir, "README.md")));
  assert.ok(await exists(join(dir, "students", "roster.yml")));

  // Re-running must not clobber live data.
  const second = await run(process.execPath, [script, dir]);
  assert.match(second.stdout, /already intact/);
});

test("scaffold script never overwrites an existing roster", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pxl-scaffold-"));
  const script = join(REPO_ROOT, "scripts/scaffold-control-repo.mjs");

  await run(process.execPath, [script, dir]);
  const rosterPath = join(dir, "students", "roster.yml");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(rosterPath, "schema_version: 2\nstudents:\n  - real: data\n");

  await run(process.execPath, [script, dir]);
  assert.match(await readFile(rosterPath, "utf8"), /real: data/);
});
