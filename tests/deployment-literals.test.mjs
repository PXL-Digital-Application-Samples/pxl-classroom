// PXL Classroom - deployment.yml is the only place a deployment fact is spelled.
//
// deployment.yml's own header says it: "Forking this software? This is the file
// you edit - and apart from secrets, it should be the only one." That was not
// true. The 2026-09-01 review counted 49 occurrences of the literal
// `pxl-classroom-control` across 29 files - every CLI command, report.mjs,
// registry/reconcile.mjs, deadline-sentinel.mjs, fetch-pages-data.mjs, four SPA
// sites and fifteen workflows - while `CONTROL_REPO` was exported by both
// deployment readers and consumed by lib/audit.mjs alone. `hub_owner`,
// `hub_repo`, the App client id and `timezone` were spelled out the same way.
//
// The sharpest case was `timezone`: exported by BOTH readers, validated as
// REQUIRED by lib/deployment.mjs (which throws at import if it is absent), and
// read by NOTHING. The value actually in force was a literal in
// frontend/src/lib/config.js and three more in AdminView.vue, so editing
// deployment.yml changed neither what a lecturer saw nor what the Admin Panel
// wrote into every assignment. lib/group-config.mjs already has the name for
// this: "A constant nobody reads is not a source of truth, it is a decoy."
//
// JavaScript can import the reader, so it must. YAML cannot, so the workflows
// keep their literal - and this file is what stops that literal drifting from
// the configured value. A fork that edits deployment.yml gets a red run naming
// every file still holding the old name, instead of a silent half-migration.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { parse } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const deployment = parse(readFileSync(join(root, "deployment.yml"), "utf8"));

/** Every file under `dir` matching `exts`, recursively, skipping build output. */
function walk(dir, exts, out = []) {
  const SKIP = new Set(["node_modules", ".git", ".tools", "dist", "test-results", "playwright-report"]);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, exts, out);
    else if (exts.some((e) => entry.name.endsWith(e))) out.push(full);
  }
  return out;
}

const SOURCE_DIRS = [
  "acceptance", "cli/src", "collect", "frontend/src", "lib", "lockdown",
  "notify", "pages", "preserve", "provisioning", "registry", "report", "scripts",
];

const sourceFiles = SOURCE_DIRS.flatMap((d) => walk(join(root, d), [".mjs", ".js", ".vue"]));
const workflowFiles = walk(join(root, ".github", "workflows"), [".yml", ".yaml"]);

/**
 * Lines quoting a literal, ignoring comments - a comment naming the value is
 * documentation, and this test is about what the code DOES.
 */
function codeLinesQuoting(file, literal) {
  const isYaml = file.endsWith(".yml") || file.endsWith(".yaml");
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => line.includes(literal))
    .filter(({ line }) => {
      const trimmed = line.trim();
      if (isYaml) return !trimmed.startsWith("#");
      return !trimmed.startsWith("//") && !trimmed.startsWith("*") && !trimmed.startsWith("/*");
    })
    .map(({ n }) => `${relative(root, file)}:${n}`);
}

// --- JavaScript reads the value; it never spells it --------------------------

for (const [key, exportName] of [
  ["control_repo", "CONTROL_REPO"],
  ["hub_owner", "HUB_OWNER"],
  ["app_client_id", "APP_CLIENT_ID"],
  ["timezone", "TIMEZONE"],
]) {
  test(`no source file spells deployment.yml's ${key} as a literal`, () => {
    const literal = String(deployment[key]);
    const offenders = sourceFiles
      // The readers themselves do not count: reading the key IS their job.
      .filter((f) => !/deployment\.(mjs|js)$/.test(f))
      .flatMap((f) => codeLinesQuoting(f, literal));
    assert.deepEqual(
      offenders,
      [],
      `deployment.yml declares ${key}: ${literal} and exports it as ${exportName}. ` +
        `These spell it out instead, so a fork that changes it gets a half-migrated system:\n  ` +
        offenders.join("\n  "),
    );
  });
}

// `hub_repo` is "pxl-classroom", which is also this repository's own name and
// appears in package names, cache keys, user agents and scratch paths. Asserting
// on the bare word would be noise, so it is checked only where it names the
// repository: as one half of an owner/repo pair.
test("no source file spells the hub as owner/repo", () => {
  const slug = `${deployment.hub_owner}/${deployment.hub_repo}`;
  const offenders = sourceFiles
    .filter((f) => !/deployment\.(mjs|js)$/.test(f))
    .flatMap((f) => codeLinesQuoting(f, slug));
  assert.deepEqual(offenders, [], `HUB_REPO is exported for this:\n  ${offenders.join("\n  ")}`);
});

// --- Workflows cannot import, so they are checked instead --------------------

test("every workflow literal for the control repo matches deployment.yml", () => {
  const configured = String(deployment.control_repo);
  // Anything shaped like this project's control repo but spelled differently.
  const wrong = [];
  for (const file of workflowFiles) {
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
      if (line.trim().startsWith("#")) return;
      for (const m of line.matchAll(/[A-Za-z0-9][A-Za-z0-9._-]*-classroom-control\b/g)) {
        if (m[0] !== configured) wrong.push(`${relative(root, file)}:${i + 1}  ${m[0]}`);
      }
    });
  }
  assert.deepEqual(
    wrong,
    [],
    `deployment.yml says control_repo: ${configured}. A workflow cannot import it, ` +
      `so it carries the literal - and these do not match:\n  ${wrong.join("\n  ")}`,
  );
});

test("at least one workflow does carry the control-repo literal", () => {
  // Guards the test above against passing vacuously: if the workflows stop
  // naming the repository at all - because someone parameterised them - this
  // check is the thing that says the sweep above no longer covers anything.
  const configured = String(deployment.control_repo);
  const carriers = workflowFiles.filter((f) => codeLinesQuoting(f, configured).length > 0);
  assert.ok(
    carriers.length > 0,
    "no workflow names the control repo any more - the literal sweep above is now vacuous",
  );
});
