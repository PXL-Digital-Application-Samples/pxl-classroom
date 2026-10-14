// Every `steps.<id>` a workflow reads names a step that exists, earlier, in
// the same job.
//
// GitHub evaluates `steps.typo.outcome` to '' rather than failing, so
// `if: always() && steps.contorl.outcome == 'success'` is false for ever and
// the step it guards never runs, green - a lock, a commit or a close that
// silently stops happening (CLAUDE.md, "A step output is spelled three
// times"). Conditions that gate on a checkout having happened were added on
// 2026-10-14 (TL-13 follow-up); this is what makes a misspelling one of them
// an error instead of a missing deadline.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const WF_DIR = join(root, ".github", "workflows");

/** Every string anywhere under a step (its if, env, with, run). */
function strings(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => strings(v, out));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => strings(v, out));
  return out;
}

/** Each `steps.<id>` a step reads that no earlier step of its job carries, and how many were read. */
function unknownStepRefs(jobs) {
  const problems = [];
  let checked = 0;
  for (const [jobName, job] of Object.entries(jobs || {})) {
    const seen = new Set();
    for (const step of job.steps || []) {
      for (const text of strings(step)) {
        for (const m of text.matchAll(/\bsteps\.([A-Za-z_][A-Za-z0-9_-]*)\./g)) {
          checked++;
          if (!seen.has(m[1])) problems.push(`${jobName} / ${step.name || step.uses || step.id}: reads steps.${m[1]}`);
        }
      }
      if (step.id) seen.add(step.id);
    }
  }
  return { problems, checked };
}

test("a step reads only steps that exist before it in its own job", () => {
  const all = [];
  let checked = 0;
  for (const file of readdirSync(WF_DIR).filter((f) => f.endsWith(".yml"))) {
    const res = unknownStepRefs(parse(readFileSync(join(WF_DIR, file), "utf8"))?.jobs);
    checked += res.checked;
    all.push(...res.problems.map((p) => `${file} / ${p}`));
  }
  assert.ok(checked > 50, `sanity: found only ${checked} step references`);
  assert.deepEqual(all, []);
});

test("the guard catches a misspelt id, and a step read before it runs", () => {
  const { problems } = unknownStepRefs({
    commit: { steps: [
      { name: "Early", if: "steps.control.outcome == 'success'" },
      { id: "control", uses: "actions/checkout" },
      { name: "Commit", if: "always() && steps.contorl.outcome == 'success'" },
    ] },
  });
  assert.deepEqual(problems, ["commit / Early: reads steps.control", "commit / Commit: reads steps.contorl"]);
});
