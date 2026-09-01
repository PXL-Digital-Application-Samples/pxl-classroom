// Two entry points run with NO `npm ci`, and must stay dependency-free.
//
// Most workflows install the root dependencies before running a script. Two
// deliberately do not, for reasons that are not about speed:
//
//   - acceptance/broker-workflow.yml runs scripts/verify-invite-token.mjs on a
//     PUBLIC repository that holds PXL_APP_PRIVATE_KEY. Its own comment says a
//     credential-bearing public repo should not be running `npm ci`. This is
//     the signature check that decides whether an acceptance is authorized, so
//     if it cannot start, every student on every broker is refused.
//   - setup-org.yml runs scripts/scaffold-control-repo.mjs before any
//     dependency exists, which is why CLAUDE.md requires lib/control-layout.mjs
//     to stay dependency-free.
//
// A bare import anywhere in either graph is therefore not a slow start, it is
// ERR_MODULE_NOT_FOUND at the top of the script. Nothing else in the repo would
// notice: both files import cleanly under Node here, `npm test` passes, and the
// failure only appears on a broker in another organization.
//
// This is the same shape as the SPA outage on 2026-08-27 - a module that was
// fine in one runtime pulled a loader into another that could not have it - so
// it gets the same kind of guard, pointed the other way.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Workflow file -> the entry point it runs without installing anything. */
const ENTRY_POINTS = [
  ["acceptance/broker-workflow.yml", "scripts/verify-invite-token.mjs"],
  [".github/workflows/setup-org.yml", "scripts/scaffold-control-repo.mjs"],
  // Same workflow, same constraint. This one replaced ~40 lines of od/iconv/
  // sed/grep that had no dependencies because it was shell; moving it into
  // JavaScript is only safe for as long as its graph stays this small.
  [".github/workflows/setup-org.yml", "scripts/register-participating-org.mjs"],
];

function specifiersOf(file) {
  const src = readFileSync(file, "utf8");
  const out = [];
  for (const m of src.matchAll(/from\s+['"]([^'"]+)['"]/g)) out.push(m[1]);
  for (const m of src.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1]);
  for (const m of src.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1]);
  return out;
}

function resolveLocal(from, spec) {
  const base = resolve(dirname(from), spec);
  for (const cand of [base, `${base}.mjs`, `${base}.js`]) {
    try { readFileSync(cand); return cand; } catch { /* try next */ }
  }
  return null;
}

/** Walks the import graph, returning every file and every bare specifier. */
function graphOf(entry) {
  const files = new Set();
  const bare = new Map(); // specifier -> the file that imports it
  const queue = [resolve(root, entry)];
  while (queue.length) {
    const file = queue.shift();
    if (files.has(file)) continue;
    files.add(file);
    let specs;
    try { specs = specifiersOf(file); } catch { continue; }
    for (const spec of specs) {
      if (spec.startsWith(".")) {
        const target = resolveLocal(file, spec);
        if (target) queue.push(target);
        continue;
      }
      // `node:` builtins ship with the runtime. Everything else - including a
      // subpath import like `#deployment`, which resolves to a module that
      // imports `yaml` - needs node_modules.
      if (spec.startsWith("node:")) continue;
      bare.set(spec, relative(root, file).replace(/\\/g, "/"));
    }
  }
  return { files: [...files].map((f) => relative(root, f).replace(/\\/g, "/")), bare };
}

for (const [workflow, entry] of ENTRY_POINTS) {
  test(`${entry} runs without npm ci, so its graph must be dependency-free`, () => {
    const { bare, files } = graphOf(entry);
    const offenders = [...bare.entries()].map(([spec, from]) => `  ${from} imports "${spec}"`);
    assert.deepEqual(
      offenders,
      [],
      `${entry} is executed by ${workflow} with no dependencies installed; these would be ` +
        `ERR_MODULE_NOT_FOUND at startup:\n${offenders.join("\n")}`,
    );
    // The walk has to have actually walked, or an empty graph reads as clean.
    assert.ok(files.length >= 2, `expected ${entry} to import something, saw ${files.length} file(s)`);
  });

  test(`${workflow} still installs nothing, which is what makes that rule real`, () => {
    const src = readFileSync(join(root, workflow), "utf8");
    assert.ok(
      !/^\s*run:\s*npm (ci|install)/m.test(src) && !/\bnpm ci\b/.test(src.replace(/#.*$/gm, "")),
      `${workflow} appears to install dependencies now - if that is deliberate, this ` +
        `constraint can be relaxed, but do it on purpose rather than by leaving a stale test`,
    );
  });
}

test("the invitation verifier's graph is the security path, and is named here", () => {
  // Guard against the entry list quietly shrinking to nothing meaningful.
  const { files } = graphOf("scripts/verify-invite-token.mjs");
  for (const must of ["lib/invite-token.mjs", "lib/invite-token-format.mjs"]) {
    assert.ok(files.includes(must), `${must} must be part of the verifier graph`);
  }
});
