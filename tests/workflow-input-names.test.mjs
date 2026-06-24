import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadYaml } from "../lib/yaml.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

test("every with: key on uses: ./<action> matches action.yml inputs", async () => {
  const workflowsDir = join(root, ".github", "workflows");
  const workflows = readdirSync(workflowsDir).filter(f => f.endsWith(".yml") || f.endsWith(".yaml"));
  
  for (const wf of workflows) {
    let yaml;
    try {
      yaml = await loadYaml(join(workflowsDir, wf));
    } catch (e) {
      console.error("Failed to parse", wf);
      throw e;
    }
    if (!yaml || !yaml.jobs) continue;
    
    for (const [jobName, job] of Object.entries(yaml.jobs)) {
      if (!job.steps) continue;
      
      for (let i = 0; i < job.steps.length; i++) {
        const step = job.steps[i];
        if (step.uses && step.uses.startsWith("./")) {
          // It's a local composite action
          const actionPath = step.uses.substring(2);
          const actionYamlPath = join(root, actionPath, "action.yml");
          
          let actionYaml;
          try {
            actionYaml = await loadYaml(actionYamlPath);
          } catch (e) {
            assert.fail(`Workflow ${wf} uses ${step.uses} but ${actionYamlPath} could not be loaded: ${e.message}`);
          }
          
          const expectedInputs = Object.keys(actionYaml.inputs || {});
          const actualInputs = Object.keys(step.with || {});
          
          for (const actual of actualInputs) {
            assert.ok(
              expectedInputs.includes(actual),
              `Workflow ${wf} job '${jobName}' step ${i} passes unknown input '${actual}' to ${step.uses}`
            );
          }
        }
      }
    }
  }
});

test("cli/src/lib/gittree.mjs <= 30 lines (adapter only)", () => {
  const content = readFileSync(join(root, "cli", "src", "lib", "gittree.mjs"), "utf8");
  const lines = content.split("\n").length;
  assert.ok(lines <= 30, `cli/src/lib/gittree.mjs should be <= 30 lines, but is ${lines}`);
});
