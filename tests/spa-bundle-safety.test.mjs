// Nothing the SPA bundles may reach for a Node builtin.
//
// The modules under lib/ are isomorphic on purpose: the hub runs them in Node
// and the SPA imports the same files, which is what stops the wire formats and
// the business rules forking between the two. The cost is that a single
// `import { readFileSync } from "node:fs"` anywhere in that graph ends up in
// the browser bundle.
//
// It happened on 2026-08-27. lib/audit.mjs and lib/archive-repo.mjs were
// pointed at lib/deployment.mjs, which reads deployment.yml with node:fs and
// node:url. Every check that should have caught it passed:
//
//   - `npm run build` SUCCEEDS. Vite externalizes node builtins rather than
//     failing, so a broken bundle builds cleanly.
//   - the value under test (student.pxl.be) really was in the bundle, via the
//     SPA's own `?raw` reader, so grepping the output looked green.
//   - the landing page still rendered, because audit.mjs and archive-repo.mjs
//     only load in LAZY route chunks.
//
// What actually broke was the first navigation to a dashboard route:
// `TypeError: (0, sr.fileURLToPath) is not a function`, and a blank page. It
// reached production.
//
// So this test walks the real import graph instead of trusting the build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(root, "frontend", "src");

// Node builtins, with and without the `node:` prefix. The bare spellings matter
// because `import { join } from "path"` bundles just as badly.
const BUILTINS = new Set([
  "fs", "fs/promises", "path", "url", "os", "crypto", "child_process", "process",
  "util", "stream", "buffer", "http", "https", "net", "tls", "zlib", "worker_threads",
  "readline", "assert", "events", "module", "vm", "perf_hooks", "timers",
]);

function sourceFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(m?js|vue)$/.test(name)) out.push(full);
  }
  return out;
}

/**
 * STATIC imports only - `import x from "y"` and a bare `import "y"`.
 *
 * The static/dynamic split is the whole point, not pedantry. A static import of
 * a Node builtin is evaluated the moment the chunk loads, so it is fatal in the
 * browser: that is what lib/deployment.mjs did with `node:fs`, and the page went
 * blank. A dynamic `await import("node:fs/promises")` inside a function only
 * runs if something calls it - lib/yaml.mjs does exactly this, deliberately, so
 * that `parseYaml` is importable by the SPA while `loadYaml` stays Node-only.
 */
function staticSpecifiers(src) {
  const out = [];
  for (const m of src.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) out.push(m[1]);
  for (const m of src.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) out.push(m[1]);
  for (const m of src.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1]);
  return out;
}

/** Every import specifier, static or dynamic - used for walking the graph. */
function specifiers(src) {
  const out = staticSpecifiers(src);
  for (const m of src.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1]);
  return out;
}

function resolveRelative(fromFile, spec) {
  const base = resolve(dirname(fromFile), spec.split("?")[0]);
  for (const cand of [base, `${base}.mjs`, `${base}.js`, join(base, "index.mjs"), join(base, "index.js")]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  return null;
}

/**
 * Everything the SPA pulls in from outside frontend/, followed transitively.
 * Returns a Map of repo-relative path -> the chain that reached it.
 */
function bundledOutsideModules() {
  const reached = new Map();
  const queue = [];

  for (const file of sourceFiles(SRC)) {
    for (const spec of specifiers(readFileSync(file, "utf8"))) {
      if (!spec.startsWith(".")) continue;
      const target = resolveRelative(file, spec);
      if (!target) continue;
      const rel = relative(root, target).replace(/\\/g, "/");
      if (rel.startsWith("frontend/")) continue;
      if (!reached.has(rel)) {
        reached.set(rel, [relative(root, file).replace(/\\/g, "/")]);
        queue.push(target);
      }
    }
  }

  while (queue.length) {
    const file = queue.shift();
    const fromRel = relative(root, file).replace(/\\/g, "/");
    for (const spec of specifiers(readFileSync(file, "utf8"))) {
      if (!spec.startsWith(".")) continue;
      const target = resolveRelative(file, spec);
      if (!target) continue;
      const rel = relative(root, target).replace(/\\/g, "/");
      if (rel.startsWith("frontend/")) continue;
      if (!reached.has(rel)) {
        reached.set(rel, [...(reached.get(fromRel) ?? []), fromRel]);
        queue.push(target);
      }
    }
  }
  return reached;
}

test("no module the SPA bundles STATICALLY imports a Node builtin", () => {
  const offenders = [];
  for (const [rel, chain] of bundledOutsideModules()) {
    const src = readFileSync(join(root, rel), "utf8");
    for (const spec of staticSpecifiers(src)) {
      if (spec.startsWith("node:") || BUILTINS.has(spec)) {
        offenders.push(`  ${rel} imports "${spec}"\n    reached via: ${[...chain, rel].join(" -> ")}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "these are bundled into the browser and will throw at runtime, not at build time:\n" + offenders.join("\n"),
  );
});

test("the #deployment specifier resolves in BOTH runtimes", () => {
  // The escape hatch that made the fix possible. If either half goes missing
  // the failure is silent in exactly the way the original bug was: Node keeps
  // working and the browser breaks on a lazy route, or vice versa.
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(
    pkg.imports?.["#deployment"],
    "./lib/deployment.mjs",
    'root package.json must map "#deployment" for Node',
  );

  const vite = readFileSync(join(root, "frontend", "vite.config.js"), "utf8");
  assert.match(vite, /['"]#deployment['"]\s*:/, "vite.config.js must alias #deployment for the browser");
  assert.match(vite, /src\/lib\/deployment\.js/, "and it must point at the browser reader");
});

test("both deployment readers export the same names", () => {
  // Two loaders for one deployment.yml is fine; two loaders that disagree about
  // what they provide is a fork that only shows up in one runtime.
  const names = (rel) =>
    [...readFileSync(join(root, rel), "utf8").matchAll(/^export const (\w+)/gm)]
      .map((m) => m[1])
      .sort();

  assert.deepEqual(
    names("frontend/src/lib/deployment.js"),
    names("lib/deployment.mjs"),
    "the Node and browser readers must expose an identical surface",
  );
});

test("a builtin behind a dynamic import is deferred, and lib/yaml.mjs relies on that", () => {
  // Not a loophole - a property worth pinning. lib/diagnostics.mjs (bundled by
  // SystemHealthModal) imports `parseYaml`, which is pure; `loadYaml` reaches
  // for node:fs/promises only when called, and the SPA never calls it. If that
  // import is ever hoisted to the top of the file, the health modal starts
  // failing the way the dashboard routes did.
  const src = readFileSync(join(root, "lib", "yaml.mjs"), "utf8");
  assert.ok(
    !staticSpecifiers(src).some((s) => s.startsWith("node:")),
    "lib/yaml.mjs must keep its Node builtin behind a dynamic import",
  );
  assert.match(src, /await import\(\s*["']node:fs\/promises["']\s*\)/);
});

test("the walk actually reached the modules it is meant to police", () => {
  // A graph walk that silently stops matching looks exactly like a clean repo.
  const reached = bundledOutsideModules();
  assert.ok(reached.size >= 10, `expected the SPA to pull in many lib/ modules, found ${reached.size}`);
  for (const must of ["lib/audit.mjs", "lib/archive-repo.mjs", "lib/claim.mjs"]) {
    assert.ok(reached.has(must), `${must} must be seen by this walk - it is bundled`);
  }
  // And the walk must be TRANSITIVE: archive-repo is reached through the SPA's
  // re-export, not directly from a .vue file.
  assert.ok(
    reached.get("lib/archive-repo.mjs").length >= 1,
    "archive-repo must be reached through a chain",
  );
});
