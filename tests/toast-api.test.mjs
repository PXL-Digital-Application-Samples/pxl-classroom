import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";

// `toast` is a plain object literal, so `toast.warning(...)` on a module that
// only exports success/error/info is a TypeError at the moment the user needed
// the message most - and always inside a rare branch, which is why it survived:
//
//   AdminView          "link copied, but the broker is missing"
//   AdminView          "link copied, but Pages is still deploying"
//   AssignmentDetailView  "3 of 40 feedback PRs failed"
//   SandboxView        the toast demo
//
// All four called toast.warning/toast.warn, none of which existed. The severity
// now exists; this test stops any other name from being invented in a branch
// nobody exercises.

const FRONTEND_SRC = join(process.cwd(), "frontend", "src");
const TOAST_MODULE = join(FRONTEND_SRC, "lib", "toast.js");

async function getSourceFiles(dir = FRONTEND_SRC) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await getSourceFiles(full)));
    else if (/\.(vue|js)$/.test(entry.name)) files.push(full);
  }
  return files;
}

/** Method names on the exported `toast` object literal. */
function toastMethods(src) {
  // Not indexOf("export const toast"): that is a prefix of `export const
  // toasts = ref([])` two lines earlier, which walks the brace scan into
  // DURATION_MS and reports an empty method set.
  const decl = /export const toast\s*=\s*\{/.exec(src);
  assert.ok(decl, "toast.js no longer exports a `toast` object");
  const open = src.indexOf("{", decl.index);
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  assert.notEqual(end, -1, "could not find the end of the toast object");
  return new Set([...src.slice(open, end).matchAll(/^\s{2}(\w+)\s*\(/gm)].map((m) => m[1]));
}

test("Toasts: every toast.<method>() call exists on the toast object", async () => {
  const methods = toastMethods(await readFile(TOAST_MODULE, "utf8"));

  const offenders = [];
  for (const file of await getSourceFiles()) {
    if (basename(file) === "toast.js") continue;
    const src = await readFile(file, "utf8");
    for (const m of src.matchAll(/\btoast\.(\w+)\s*\(/g)) {
      if (!methods.has(m[1])) {
        offenders.push(`${relative(process.cwd(), file)} calls toast.${m[1]}()`);
      }
    }
  }

  assert.deepEqual(
    [...new Set(offenders)].sort(),
    [],
    `toast only exposes: ${[...methods].sort().join(", ")}. ` +
      "A call to anything else throws a TypeError at the moment the message was needed.",
  );
});

test("Toasts: every severity the module can emit is styled and given a role", async () => {
  const methods = toastMethods(await readFile(TOAST_MODULE, "utf8"));
  const moduleSrc = await readFile(TOAST_MODULE, "utf8");
  const component = await readFile(join(FRONTEND_SRC, "components", "Toast.vue"), "utf8");

  // The type string each method actually pushes - warn() emits "warning".
  const emitted = new Set(
    [...moduleSrc.matchAll(/addToast\([^,]+,\s*'([a-z]+)'/g)].map((m) => m[1]),
  );
  assert.ok(emitted.size > 0, "no addToast calls found");

  for (const type of emitted) {
    assert.match(
      component,
      new RegExp(`\\.toast-${type}\\s*\\{`),
      `Toast.vue has no .toast-${type} rule, so a ${type} toast renders unstyled`,
    );
    assert.match(
      moduleSrc,
      new RegExp(`\\b${type}:\\s*\\d+`),
      `DURATION_MS has no entry for "${type}", so it silently falls back to 5s`,
    );
  }

  // warn() is an alias, not a second severity.
  if (methods.has("warn")) {
    assert.match(moduleSrc, /warn\(message, options\) \{\s*\n\s*addToast\(message, 'warning'/);
  }
});
