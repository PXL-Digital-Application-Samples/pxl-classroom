// A step output is spelled three times, by three files, and nothing made them
// agree.
//
//   provisioning/provision.mjs   setOutput("invited", …)
//   provisioning/action.yml      invited: value: ${{ steps.run.outputs.invited }}
//   acceptance-handler.yml       if: steps.prov.outputs.invited == 'true'
//
// Misspell any one of them and the expression evaluates to the empty string.
// `if: '' == 'true'` is false, the step is skipped, the run is GREEN, and the
// feature simply never happens. There is no error, no annotation and no failed
// job - the same failure mode as `[ok] could not comment on the broker issue`,
// one layer up.
//
// INPUTS were already guarded in both directions - "no dispatch sends an input
// the workflow does not declare", "every with: key on uses: ./<action> matches
// action.yml inputs". Outputs were not, and they are the worse half: a wrong
// input name is usually an error, a wrong output name is silence.
//
// This closes the chain end to end. It is one instance of the shape this repo
// keeps paying for - two places that must agree with no mechanism making them
// agree - and the only remedy that has ever worked is deriving one side from
// the other, which is what a test can do even where the runtime cannot.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const WF_DIR = join(root, ".github", "workflows");

const read = (p) => readFileSync(p, "utf8");
const workflows = readdirSync(WF_DIR).filter((f) => f.endsWith(".yml"));

/** Local composite actions, by the path a workflow would `uses:`. */
function localActions() {
  const out = new Map();
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(root, entry.name, "action.yml");
    if (existsSync(file)) out.set(`./${entry.name}`, { file, doc: parse(read(file)) });
  }
  return out;
}

/** Every step in a workflow that carries an `id`, flattened across jobs. */
function stepsById(doc) {
  const map = new Map();
  for (const job of Object.values(doc?.jobs || {})) {
    for (const step of job?.steps || []) {
      if (step?.id) map.set(step.id, step);
    }
  }
  return map;
}

const ACTIONS = localActions();

/**
 * Every script a `run:` block invokes, resolved to a real path.
 *
 * Composite actions call theirs as `node "$GITHUB_ACTION_PATH/accept.mjs"`, so
 * a repo-root join finds nothing - and a matcher that silently finds nothing is
 * a guard that passes vacuously, which is the failure this whole file is about.
 * `baseDir` is the action's own directory when there is one.
 */
function scriptsIn(run, baseDir) {
  return [...String(run || "").matchAll(/node\s+"?(?:\$GITHUB_ACTION_PATH\/|\$\{\{\s*github\.action_path\s*\}\}\/)?(\S+?\.mjs)"?/g)]
    .map(([, rel]) => join(baseDir, rel))
    .filter((f) => existsSync(f));
}

/**
 * Does this script write that output?
 *
 * TWO shapes, because the repo has two. Most emitters call a local
 * `setOutput(name, value)` helper with a literal name; `read-team-payload.mjs`
 * writes six at once from one template (`team_slug=${…}\nteam_name=${…}`).
 * Matching only the first called a working script broken.
 */
function emits(file, name) {
  const src = read(file);
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    new RegExp(`setOutput\\(\\s*["']${esc}["']`).test(src) ||
    new RegExp(`${esc}=\\$\\{`).test(src)
  );
}

test("every steps.<id>.outputs.<name> a workflow reads is one the step can produce", () => {
  let checked = 0;
  const skipped = [];

  for (const wf of workflows) {
    const raw = read(join(WF_DIR, wf));
    const steps = stepsById(parse(raw));

    for (const m of raw.matchAll(/steps\.([A-Za-z0-9_-]+)\.outputs\.([A-Za-z0-9_-]+)/g)) {
      const [, id, name] = m;
      const step = steps.get(id);
      // A reference to a step this workflow does not declare is its own bug,
      // and always empty.
      assert.ok(step, `${wf}: reads steps.${id}.outputs.${name} but has no step with id "${id}"`);

      const uses = typeof step.uses === "string" ? step.uses : "";
      if (uses.startsWith("./")) {
        const action = ACTIONS.get(uses.replace(/\/$/, ""));
        assert.ok(action, `${wf}: step "${id}" uses ${uses}, which has no action.yml`);
        const declared = Object.keys(action.doc?.outputs || {});
        assert.ok(
          declared.includes(name),
          `${wf}: reads steps.${id}.outputs.${name}, but ${uses}/action.yml declares only [${declared.join(", ")}]. ` +
            `The expression is the empty string, so an \`if:\` on it is false forever and the step never runs.`,
        );
        checked++;
      } else if (typeof step.run === "string") {
        // A `run:` step writes its own outputs. Accept either the name being
        // written in the block, or a repo script it invokes emitting it.
        const inBlock = new RegExp(`${name}\\s*(=|<<)`).test(step.run);
        const viaScript = scriptsIn(step.run, root).some((f) => emits(f, name));
        assert.ok(
          inBlock || viaScript,
          `${wf}: reads steps.${id}.outputs.${name}, but that step never writes it`,
        );
        checked++;
      } else {
        // A pinned third-party action - its outputs are not in this repo.
        skipped.push(`${wf}:${id}.${name}`);
      }
    }
  }

  // A floor, so a regex that stopped matching cannot pass as a clean repo.
  assert.ok(checked >= 15, `only ${checked} output references verified - the parse has broken, not the workflows`);
});

test("every output a local action declares is one its own script emits", () => {
  // The middle link, and the one with no runtime signal at all: action.yml can
  // name `steps.run.outputs.baseline_sha` while the script writes
  // `baselineSha`, and every consumer downstream just sees "".
  let checked = 0;

  for (const [uses, { file, doc }] of ACTIONS) {
    const innerSteps = new Map((doc?.runs?.steps || []).filter((s) => s?.id).map((s) => [s.id, s]));

    for (const [publicName, spec] of Object.entries(doc?.outputs || {})) {
      const value = typeof spec?.value === "string" ? spec.value : "";
      const ref = /steps\.([A-Za-z0-9_-]+)\.outputs\.([A-Za-z0-9_-]+)/.exec(value);
      if (!ref) continue; // a literal or an input passthrough - nothing to join
      const [, innerId, innerName] = ref;

      const step = innerSteps.get(innerId);
      assert.ok(step, `${uses}: output "${publicName}" reads steps.${innerId}, which is not a step in this action`);

      const scripts = scriptsIn(step.run, dirname(file));
      if (scripts.length === 0) continue; // not a node step - out of reach here

      assert.ok(
        scripts.some((f) => emits(f, innerName)),
        `${uses}: output "${publicName}" is wired to steps.${innerId}.outputs.${innerName}, ` +
          `but ${scripts.join(" / ")} never writes "${innerName}". It resolves to "" for every consumer.`,
      );
      checked++;
    }
  }

  assert.ok(checked >= 10, `only ${checked} action outputs traced to a script - the parse has broken`);
});

test("the invitation announcement is wired all three ways", () => {
  // The specific chain this test file was written for, pinned by name so that
  // a rename has to come here and be thought about rather than going quiet.
  const script = read(join(root, "provisioning", "provision.mjs"));
  const action = parse(read(join(root, "provisioning", "action.yml")));
  const handler = read(join(WF_DIR, "acceptance-handler.yml"));

  assert.match(script, /setOutput\("invited",/, "provision.mjs must emit it");
  assert.equal(
    action.outputs?.invited?.value,
    "${{ steps.run.outputs.invited }}",
    "action.yml must forward it",
  );
  assert.match(
    handler,
    /if:\s*steps\.prov\.outputs\.invited == 'true'/,
    "the handler must gate the student comment on it",
  );

  // And it must be set from the grant's status code, not from the outcome -
  // 201 is "an invitation was created", which is the only thing that makes the
  // announcement true.
  assert.match(
    script,
    /grantInvited = add\.status === 201/,
    "the flag is the 201, not a proxy for it",
  );
});
