// Everything the SPA bundle READS must be a path that redeploys it.
//
// deploy-frontend.yml is path-filtered, which is right - a docs commit should
// not rebuild Pages. The failure mode is silent and total: a file the bundle
// imports at build time, but which is not in the filter, changes on main and
// the live site keeps serving the old bytes. Nothing goes red, because nothing
// ran.
//
// Measured 2026-08-27: minting the hub's claim keypair touched only
// `acceptance/claim-keys.json`. The SPA imports that file
// (frontend/src/lib/claim.js) to know which public key to seal an address to,
// the path was not in the filter, no deploy fired - and the live page kept
// telling students "claiming is not set up for this course yet" on a course
// where the key existed and the hub could decrypt. A rotation would fail the
// same way.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const SRC = join(root, "frontend", "src");

function sourceFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(m?js|vue)$/.test(name)) out.push(full);
  }
  return out;
}

/** Every path outside frontend/ that the SPA imports, repo-relative, POSIX. */
function outsideImports() {
  const found = new Set();
  for (const file of sourceFiles(SRC)) {
    const src = readFileSync(file, "utf8");
    // `import x from '../../../lib/foo.mjs'` and the `export ... from` form.
    for (const m of src.matchAll(/from\s+['"](\.\.[^'"]+)['"]/g)) {
      // Vite query suffixes are part of the import specifier, not the path:
      // `../../../deployment.yml?raw` is still a build-time read of
      // deployment.yml, and the deploy filter can only name the file.
      const specifier = m[1].split("?")[0];
      const resolved = join(dirname(file), specifier);
      const rel = relative(root, resolved).replace(/\\/g, "/");
      if (!rel.startsWith("frontend/")) found.add(rel);
    }
  }
  return [...found].sort();
}

test("every path the bundle imports from outside frontend/ triggers a deploy", () => {
  const doc = parse(readFileSync(join(root, ".github", "workflows", "deploy-frontend.yml"), "utf8"));
  const paths = doc?.on?.push?.paths ?? [];
  assert.ok(paths.length, "deploy-frontend.yml must declare push paths");

  const covered = (rel) =>
    paths.some((p) => {
      if (p === rel) return true;
      // `lib/**` covers `lib/anything/deep.mjs`
      if (p.endsWith("/**")) return rel.startsWith(p.slice(0, -2));
      return false;
    });

  const uncovered = outsideImports().filter((rel) => !covered(rel));
  assert.deepEqual(
    uncovered,
    [],
    "the SPA imports these at build time, but changing them deploys nothing:\n" +
      uncovered.map((u) => `  ${u}`).join("\n"),
  );
});

test("the scan actually found the imports it is meant to police", () => {
  // A walk that silently stops matching looks exactly like a clean repo. Two
  // floors: the well-known isomorphic modules, and the claim key list that this
  // test exists because of.
  const found = outsideImports();
  assert.ok(found.length >= 5, `expected several outside imports, found ${found.length}`);
  assert.ok(
    found.includes("acceptance/claim-keys.json"),
    "the claim key list is the instance this test was written for",
  );
  assert.ok(
    found.some((f) => f.startsWith("lib/")),
    "expected the SPA to import isomorphic modules from lib/",
  );
});
