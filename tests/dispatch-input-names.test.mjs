import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadYaml } from "../lib/yaml.mjs";

// workflow_dispatch is validated by GitHub, not by us: an undeclared input or a
// missing required one is a 422 at dispatch time, surfacing as a toast the
// lecturer can do nothing about. Nothing in the build or the type system
// connects a triggerWorkflow() call to the YAML it targets, so this does.
//
// tests/workflow-input-names.test.mjs covers workflow -> composite action.
// This covers SPA -> workflow_dispatch, which is where the lecturer-facing
// buttons live.

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const SRC = join(root, "frontend", "src");

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (name.endsWith(".vue") || name.endsWith(".js")) out.push(p);
  }
  return out;
}

/** Balanced-brace slice starting at the `{` index. */
function objectAt(src, start) {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

/** Top-level keys of an object literal, ignoring nested objects. */
function topLevelKeys(objectSrc) {
  const inner = objectSrc.slice(1, -1);
  const keys = [];
  let depth = 0;
  let atKeyPosition = true;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === "{" || c === "[" || c === "(") depth++;
    else if (c === "}" || c === "]" || c === ")") depth--;
    else if (c === "," && depth === 0) atKeyPosition = true;
    else if (depth === 0 && atKeyPosition && /[A-Za-z_'"]/.test(c)) {
      const m = inner.slice(i).match(/^['"]?([A-Za-z_][\w-]*)['"]?\s*:/);
      if (m) keys.push(m[1]);
      atKeyPosition = false;
    }
  }
  return keys;
}

test("every SPA workflow_dispatch matches the target workflow's declared inputs", async () => {
  const problems = [];

  for (const file of walk(SRC)) {
    const src = readFileSync(file, "utf8");
    const rel = file.slice(root.length + 1).replace(/\\/g, "/");

    for (const m of src.matchAll(/triggerWorkflow\(\s*[^,]+,\s*[^,]+,\s*[^,]+,\s*['"]([\w.-]+\.yml)['"]\s*,/g)) {
      const workflow = m[1];
      const line = src.slice(0, m.index).split("\n").length;
      const where = `${rel}:${line} -> ${workflow}`;

      // The argument after the workflow id is either an inline object literal
      // or an identifier holding one. Anything else (a ref string, nothing) is
      // not an inputs payload and is skipped rather than guessed at.
      const after = src.slice(m.index + m[0].length);
      const lead = after.match(/^\s*/)[0].length;
      let objSrc = null;

      if (after[lead] === "{") {
        objSrc = objectAt(src, m.index + m[0].length + lead);
      } else {
        const ident = after.slice(lead).match(/^([A-Za-z_$][\w$]*)\s*[,)]/);
        if (ident) {
          const decl = src.search(
            new RegExp(`(?:const|let|var)\\s+${ident[1]}\\s*=\\s*\\{`),
          );
          if (decl !== -1) objSrc = objectAt(src, src.indexOf("{", decl));
        }
      }
      if (!objSrc) continue;
      const sent = topLevelKeys(objSrc);

      let yaml;
      try {
        yaml = await loadYaml(join(root, ".github", "workflows", workflow));
      } catch {
        problems.push(`${where}: workflow file not found`);
        continue;
      }

      const declared = yaml?.on?.workflow_dispatch?.inputs ?? {};
      const declaredNames = Object.keys(declared);
      const required = declaredNames.filter((n) => declared[n]?.required === true);

      const undeclared = sent.filter((k) => !declaredNames.includes(k));
      const missing = required.filter((r) => !sent.includes(r));

      if (undeclared.length) {
        problems.push(
          `${where}: sends undeclared input(s) [${undeclared}] - GitHub 422s. Declared: [${declaredNames}]`,
        );
      }
      if (missing.length) {
        problems.push(`${where}: omits required input(s) [${missing}] - GitHub 422s`);
      }
    }
  }

  assert.deepEqual(
    problems,
    [],
    "These dispatches cannot succeed. GitHub validates workflow_dispatch inputs " +
      "server-side and rejects the call before the workflow starts.",
  );
});
