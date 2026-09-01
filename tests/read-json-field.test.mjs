// `read-json-field.mjs` decides what publish-assignment.yml records as an
// assignment's prior state, and that value is what the revert restores when a
// publish fails. The shape it replaced swallowed every error into an empty
// string, so a file that could not be read looked exactly like a file with no
// state - and the revert then had nothing to put back.
//
// Run as a subprocess, because that is how the workflow runs it: importing it
// would execute the CLI against the test runner's own argv.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(root, "scripts", "read-json-field.mjs");

const dir = mkdtempSync(join(tmpdir(), "rjf-"));
const fixture = (name, body) => {
  const p = join(dir, name);
  writeFileSync(p, body);
  return p;
};

/** @returns {{status: number, stdout: string, stderr: string}} */
function run(...args) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { status: 0, stdout, stderr: "" };
  } catch (e) {
    return { status: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

test("a present field is printed with no trailing newline to trip up $( )", () => {
  const f = fixture("a.json", JSON.stringify({ state: "published" }));
  const r = run(f, "state");
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "published");
});

test("a non-string scalar still reads, because JSON has more than strings", () => {
  const f = fixture("n.json", JSON.stringify({ count: 3, on: false }));
  assert.equal(run(f, "count").stdout, "3");
  assert.equal(run(f, "on").stdout, "false");
});

test("an ABSENT field is an answer: empty, exit 0", () => {
  // A JSON assignment that genuinely records no state is the ordinary case the
  // workflow's `elif` exists for.
  const f = fixture("b.json", JSON.stringify({ other: 1 }));
  const r = run(f, "state");
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});

test("an UNREADABLE file is not an answer: it fails rather than reading as empty", () => {
  // The whole point. `2>/dev/null || true` made these two cases identical, and
  // the publish carried on with no prior state to revert to.
  const bad = fixture("c.json", "not json");
  const r = run(bad, "state");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Could not read/);

  const missing = run(join(dir, "nope.json"), "state");
  assert.equal(missing.status, 1);
});

test("a field holding an object fails instead of printing [object Object]", () => {
  const f = fixture("o.json", JSON.stringify({ state: { nested: true } }));
  const r = run(f, "state");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not a scalar/);
});

test("missing arguments are a usage error, not an empty read", () => {
  assert.equal(run().status, 2);
  assert.equal(run(fixture("d.json", "{}")).status, 2);
});
