// Where an assignment's acceptance broker lives - decided once.
//
// The name was rebuilt by hand at NINE call sites across the hub library, the
// composables and three views, and one of them had already drifted:
// AdminView.vue rendered `broker-${form.id}` with no `|| broker_repo`, so the
// Republish dialog showed the wrong repository for any assignment carrying a
// custom broker name.
//
// Same fork guard tests/archive-repo.test.mjs puts on the archive, and for the
// same reason: the fallback is not decoration. `broker_repo` is what the
// document says its broker IS; `broker-<id>` is only where a new one GOES.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative, extname } from "node:path";
import { fileURLToPath } from "node:url";

import { brokerRepoName } from "../lib/broker-repo.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("the recorded broker_repo wins over the default naming", () => {
  assert.equal(
    brokerRepoName({ assignment: { id: "hw-1", broker_repo: "broker-custom" } }),
    "broker-custom",
  );
});

test("without one, the name is derived from the id", () => {
  assert.equal(brokerRepoName({ assignment: { id: "hw-1" } }), "broker-hw-1");
  assert.equal(brokerRepoName({ assignmentId: "hw-1" }), "broker-hw-1");
});

test("an explicit id does not override what the document recorded", () => {
  // Callers pass both. The document is the authority on where its broker IS.
  assert.equal(
    brokerRepoName({ assignment: { broker_repo: "broker-custom" }, assignmentId: "hw-1" }),
    "broker-custom",
  );
});

test("nothing to build from yields null, not `broker-undefined`", () => {
  // A caller with no id has no business rendering a link to broker-undefined -
  // that is a 404 the user discovers by clicking.
  assert.equal(brokerRepoName({}), null);
  assert.equal(brokerRepoName(), null);
  assert.equal(brokerRepoName({ assignment: {} }), null);
  assert.equal(brokerRepoName({ assignmentId: "  " }), null);
});

test("a blank broker_repo falls back rather than returning empty", () => {
  // An empty string is not a name. Returning it would build `<org>/`.
  assert.equal(brokerRepoName({ assignment: { id: "hw-1", broker_repo: "   " } }), "broker-hw-1");
});

// ------------------------------------------------------- nobody builds it again

// `tests` is skipped deliberately, and only here. A fixture that spells
// `broker-hw1` is asserting on the real-world name from the outside, which is
// exactly how a rename gets caught; routing fixtures through the helper would
// make them agree with the code by construction and assert nothing. Everything
// that SHIPS is in scope - including pages/, which the first version of this
// guard missed.
const SKIP = new Set(["node_modules", ".git", "dist", "test-results", "playwright-report", ".tools", "coverage", "tests"]);
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

test("no file builds a broker repo name by hand", () => {
  // The guard those copies earned. `broker-${...}` anywhere outside the module
  // that owns it is the next one waiting to drift.
  //
  // Scanned from the REPOSITORY ROOT, not from a list of directories. The first
  // version of this guard listed lib, scripts, acceptance and frontend/src, and
  // reported clean while `pages/generate.mjs` was still composing the name -
  // and that one mattered most, because it writes the PUBLIC assignment data a
  // student's invitation page reads. An allow-list of directories is a guard
  // that only checks where you already looked.
  const offenders = [];
  for (const file of walk(ROOT)) {
    const rel = relative(ROOT, file).replace(/\\/g, "/");
    if (rel === "lib/broker-repo.mjs") continue;
    const src = readFileSync(file, "utf8");
    if (/`broker-\$\{/.test(src) || /\bbroker_repo\s*\|\|/.test(src)) offenders.push(rel);
  }
  assert.deepEqual(
    offenders,
    [],
    `these compose a broker repo name instead of using brokerRepoName():\n  ${offenders.join("\n  ")}`,
  );
});
