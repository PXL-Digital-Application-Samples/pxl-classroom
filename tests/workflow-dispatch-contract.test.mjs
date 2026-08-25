// The SPA dispatches hub workflows by name, with an inputs object. Nothing
// checks that object against what the workflow declares, and GitHub rejects an
// undeclared input with a 422 - at run time, in front of a lecturer, with a
// toast that says the dispatch failed.
//
// This shipped once already. CLAUDE.md: setup-org.yml declares `target_org`
// and `budget_owner_login`, both required, and the System Health fix sent
// `org` - so the one-click repair "could never have worked". It was found by
// someone trying it, not by anything here.
//
// The check is mechanical: parse each workflow's workflow_dispatch inputs,
// parse every triggerWorkflow(...) call in the SPA, and compare.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Declared workflow_dispatch inputs, by workflow file name. */
function declaredInputs() {
  const dir = join(root, ".github", "workflows");
  const out = new Map();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".yml")) continue;
    let doc;
    try {
      doc = parseYaml(readFileSync(join(dir, file), "utf8"));
    } catch {
      continue;
    }
    // `on:` parses as the boolean true in YAML 1.1, which is why this reads
    // both keys rather than trusting one.
    const on = doc?.on ?? doc?.[true];
    const inputs = on?.workflow_dispatch?.inputs;
    if (!inputs) continue;
    out.set(file, {
      names: new Set(Object.keys(inputs)),
      required: new Set(
        Object.entries(inputs)
          .filter(([, spec]) => spec?.required === true)
          .map(([name]) => name),
      ),
    });
  }
  return out;
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    // `.claude` holds git worktrees - a full second checkout of this repo.
    if (entry === "node_modules" || entry === "dist" || entry === ".claude") continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(vue|js)$/.test(entry)) out.push(p);
  }
  return out;
}

/**
 * Every `triggerWorkflow(..., '<file>.yml', { ... })` in the SPA.
 *
 * The object literal is read by balancing braces from the opening one, so a
 * nested value cannot end the scan early; the keys taken are the top-level
 * ones only. A call whose inputs are a variable rather than a literal is
 * reported as `dynamic` instead of being silently skipped - unchecked is not
 * the same as checked and fine.
 */
function dispatchCalls() {
  const calls = [];
  for (const file of walk(join(root, "frontend", "src"))) {
    const src = readFileSync(file, "utf8");
    const re = /triggerWorkflow\s*\([^,]+,[^,]+,[^,]+,\s*'([^']+\.yml)'\s*,\s*/g;
    let m;
    while ((m = re.exec(src))) {
      const rel = relative(root, file).split("\\").join("/");
      const after = src.slice(re.lastIndex);
      if (!after.startsWith("{")) {
        calls.push({ file: rel, workflow: m[1], dynamic: true, keys: [] });
        continue;
      }
      let depth = 0, end = -1;
      for (let i = 0; i < after.length; i++) {
        if (after[i] === "{") depth++;
        else if (after[i] === "}") {
          depth--;
          if (depth === 0) { end = i; break; }
        }
      }
      if (end === -1) continue;
      const body = after.slice(1, end);
      // Top-level keys only: skip anything nested inside a deeper brace.
      const keys = [];
      let d = 0;
      for (const line of body.split("\n")) {
        const trimmed = line.trim();
        const key = d === 0 && trimmed.match(/^([A-Za-z_][\w]*)\s*:/);
        if (key) keys.push(key[1]);
        d += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
      }
      calls.push({ file: rel, workflow: m[1], dynamic: false, keys });
    }
  }
  return calls;
}

test("the parser actually finds the dispatches, so an empty pass cannot look green", () => {
  const calls = dispatchCalls();
  assert.ok(calls.length >= 8, `expected the SPA's dispatch calls, found ${calls.length}`);
  assert.ok(
    calls.some((c) => c.workflow === "setup-org.yml"),
    "setup-org.yml is the one this check exists for - it must be among them",
  );
  assert.ok(declaredInputs().size >= 5, "workflow inputs must parse");
});

test("no dispatch sends an input the workflow does not declare", () => {
  // GitHub answers 422 for an undeclared input. Not a warning, not a partial
  // run - the dispatch simply does not happen, and the SPA can only report
  // that it failed.
  const declared = declaredInputs();
  const offenders = [];

  for (const call of dispatchCalls()) {
    if (call.dynamic) continue;
    const spec = declared.get(call.workflow);
    if (!spec) {
      // Sending `{}` to a workflow that declares no inputs is correct, not an
      // offence - deploy-frontend.yml is dispatched exactly that way.
      if (call.keys.length) {
        offenders.push(
          `${call.file}: sends [${call.keys.join(", ")}] to ${call.workflow}, ` +
            "which declares no workflow_dispatch inputs at all",
        );
      }
      continue;
    }
    for (const key of call.keys) {
      if (!spec.names.has(key)) {
        offenders.push(
          `${call.file}: sends "${key}" to ${call.workflow}, which declares only ` +
            `[${[...spec.names].join(", ")}]`,
        );
      }
    }
  }

  assert.deepEqual(offenders, [], `GitHub rejects these dispatches with 422:\n  ${offenders.join("\n  ")}`);
});

test("no dispatch omits an input the workflow marks required", () => {
  const declared = declaredInputs();
  const offenders = [];

  for (const call of dispatchCalls()) {
    if (call.dynamic) continue;
    const spec = declared.get(call.workflow);
    if (!spec) continue;
    for (const need of spec.required) {
      if (!call.keys.includes(need)) {
        offenders.push(`${call.file}: dispatches ${call.workflow} without required input "${need}"`);
      }
    }
  }

  assert.deepEqual(offenders, [], `GitHub rejects these dispatches with 422:\n  ${offenders.join("\n  ")}`);
});

test("a dispatch built from a variable is named, so it is known to be unchecked", () => {
  // Not a failure - StarterSyncModal composes its inputs - but it must not
  // pass silently as though it had been verified.
  const declared = declaredInputs();
  for (const c of dispatchCalls().filter((x) => x.dynamic)) {
    assert.ok(
      declared.has(c.workflow),
      `${c.file} dispatches ${c.workflow} with computed inputs, and that workflow ` +
        "does not even declare workflow_dispatch inputs",
    );
  }
});
