// Where documents live inside the control repo - decided once.
//
// `students/roster.yml` had an owner and a guard (ROSTER_PATH,
// tests/roster-path.test.mjs) because it had been re-spelled once. Its siblings
// had neither, and were built by hand across the CLI, the SPA and the hub:
// assignments/<id>.yml in five files, reports/<id>.json in four,
// overrides/<a>/<b>.json in four, teams/<id>/<slug>.json in six, and the two
// students/claim* paths in three each.
//
// A path spelled twice is a rename that half-lands. The writer moves, the
// reader does not, and the result is a 404 that reads as "nothing here yet" -
// an empty `acceptances/<id>` is indistinguishable from a cohort where nobody
// accepted.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CONTROL_SCAFFOLD_DIRS,
  assignmentPath,
  reportPath,
  DASHBOARD_PATH,
  acceptancesDir,
  acceptancePath,
  repositoriesDir,
  repositoryPath,
  teamsDir,
  teamPath,
  overridesDir,
  overridePath,
  lockdownRecordPath,
} from "../lib/control-layout.mjs";
import { ROSTER_PATH } from "../lib/roster-entries.mjs";
// Owned by the modules that own the documents, not by control-layout.
import { claimPath, claimAttemptsPath } from "../lib/claim.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("each builder produces the path the system actually uses", () => {
  assert.equal(assignmentPath("hw-1"), "assignments/hw-1.yml");
  assert.equal(reportPath("hw-1"), "reports/hw-1.json");
  assert.equal(DASHBOARD_PATH, "reports/dashboard.json");
  assert.equal(acceptancesDir("hw-1"), "acceptances/hw-1");
  assert.equal(acceptancePath("hw-1", "alice"), "acceptances/hw-1/alice.json");
  assert.equal(repositoriesDir("hw-1"), "repositories/hw-1");
  assert.equal(repositoryPath("hw-1", "alice"), "repositories/hw-1/alice.json");
  assert.equal(teamsDir("hw-1"), "teams/hw-1");
  assert.equal(teamPath("hw-1", "team-a"), "teams/hw-1/team-a.json");
  assert.equal(overridesDir("hw-1"), "overrides/hw-1");
  assert.equal(overridePath("hw-1", "alice"), "overrides/hw-1/alice.json");
  assert.equal(lockdownRecordPath("hw-1"), "lockdowns/hw-1/lockdown-record.json");
  assert.equal(claimPath("12345"), "students/claims/12345.json");
  assert.equal(claimAttemptsPath("12345"), "students/claim-attempts/12345.json");
});

test("every builder lives under a declared scaffold directory", () => {
  // The half that stops the two halves drifting. A builder rooted at a
  // directory the scaffold does not create writes into a control repo that has
  // no such folder - which succeeds, because git creates parents, and then
  // nothing that walks the scaffold ever finds it.
  const built = [
    assignmentPath("x"), reportPath("x"), DASHBOARD_PATH,
    acceptancesDir("x"), acceptancePath("x", "y"),
    repositoriesDir("x"), repositoryPath("x", "y"),
    teamsDir("x"), teamPath("x", "y"),
    overridesDir("x"), overridePath("x", "y"),
    lockdownRecordPath("x"), claimPath("1"), claimAttemptsPath("1"),
    ROSTER_PATH,
  ];
  const strays = built
    .map((p) => p.split("/")[0])
    .filter((seg) => !CONTROL_SCAFFOLD_DIRS.includes(seg));
  assert.deepEqual([...new Set(strays)], [], `not scaffold directories: ${strays.join(", ")}`);
});

test("ROSTER_PATH agrees with the students directory it lives in", () => {
  // ROSTER_PATH keeps its own home in lib/roster-entries.mjs - it predates
  // these, has its own guard and forty-odd references. This is what stops the
  // two owners disagreeing about the `students` segment.
  assert.equal(ROSTER_PATH.split("/")[0], claimPath("1").split("/")[0]);
});

// ------------------------------------------------- nobody spells them by hand

const SKIP = new Set([
  "node_modules", ".git", "dist", "test-results", "playwright-report",
  ".tools", "coverage",
  // Fixtures assert on the real-world path from outside; routing them through
  // the builders would make them agree by construction and assert nothing.
  "tests",
]);
const EXTS = new Set([".mjs", ".js", ".vue"]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (EXTS.has(extname(p))) out.push(p);
  }
  return out;
}

const STARTS_WITH_DIR = new RegExp("^(" + CONTROL_SCAFFOLD_DIRS.join("|") + ")/");

/**
 * Does this file BUILD a control-repo path, as opposed to mentioning one?
 *
 * The distinction is load-bearing and the first version of this guard got it
 * wrong, demanding that error messages be "fixed":
 *
 *   `assignments/${id}.yml`                     a path - flag it
 *   `assignments/${id}.yml not found in repo`   a sentence - leave it alone
 *
 * A path has no whitespace outside its interpolations. Interpolations may
 * contain spaces (`${a || b}`), so they are blanked before the check rather
 * than searched.
 */
function buildsAPath(src) {
  for (const m of src.matchAll(/`([^`\\]*)`/g)) {
    const raw = m[1];
    if (!STARTS_WITH_DIR.test(raw)) continue;
    if (!raw.includes("${")) continue;
    if (/\s/.test(raw.replace(/\$\{[^}]*\}/g, "{}"))) continue;
    return true;
  }
  return false;
}

/**
 * The modules that OWN a path, and may therefore spell it.
 *
 * Not an escape hatch - each of these is the single home for its own family,
 * which is the arrangement this guard defends. They are listed rather than
 * pattern-matched so that adding one is a deliberate act with a reason beside
 * it, instead of a directory that quietly stops being checked.
 */
const OWNERS = new Map([
  ["lib/control-layout.mjs", "assignments, reports, acceptances, repositories, teams, overrides, lockdowns"],
  ["lib/claim.mjs", "students/claims and students/claim-attempts - beside the code that reads them"],
  ["lib/invite-token-format.mjs", "public/i/<digest>.json - beside inviteFileName, which decides the digest half"],
  ["lib/roster-entries.mjs", "students/roster.yml, as ROSTER_PATH"],
]);

test("no file builds a control-repo path by hand", () => {
  const offenders = [];
  for (const file of walk(ROOT)) {
    const rel = relative(ROOT, file).replace(/\\/g, "/");
    if (OWNERS.has(rel)) continue;
    if (buildsAPath(readFileSync(file, "utf8"))) offenders.push(rel);
  }
  assert.deepEqual(
    offenders,
    [],
    `these build a control-repo path instead of using lib/control-layout.mjs:\n  ${offenders.join("\n  ")}`,
  );
});
