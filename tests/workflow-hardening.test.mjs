// Hub defence in depth.
//
// `workflow_dispatch` runs the workflow file from whatever ref you name, and
// the `participating-orgs` branch carries deliberately lighter protection
// (ARCHITECTURE §5.5) so that automation can commit the org registry to it.
// Together that is a path to running hub code at a ref an attacker controls,
// with the App private key in scope.
//
// A job that names an environment does not start at all when the run's ref is
// outside that environment's deployment branch policy - `provisioning` allows
// `main` only. That is what closes it, so every job holding a hub credential
// has to name it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const WORKFLOW_DIR = join(root, ".github", "workflows");

// Credentials that grant power beyond this repository: the App key mints
// installation tokens for every participating org, and the invite key mints
// invitations every broker will accept.
const HUB_CREDENTIALS = /PXL_APP_PRIVATE_KEY|PXL_INVITE_SIGNING_KEY/;
const ENVIRONMENT = "provisioning";

function workflows() {
  return readdirSync(WORKFLOW_DIR)
    .filter((f) => f.endsWith(".yml"))
    .map((f) => ({ file: f, doc: parse(readFileSync(join(WORKFLOW_DIR, f), "utf8")) }));
}

test("every job holding a hub credential is pinned to the provisioning environment", () => {
  const unguarded = [];
  let guarded = 0;
  for (const { file, doc } of workflows()) {
    for (const [name, job] of Object.entries(doc?.jobs || {})) {
      if (!HUB_CREDENTIALS.test(JSON.stringify(job))) continue;
      // `environment:` may be a string or an object with a `name`.
      const env = typeof job.environment === "object" ? job.environment?.name : job.environment;
      if (env === ENVIRONMENT) guarded++;
      else unguarded.push(`${file}:${name} (environment: ${JSON.stringify(job.environment)})`);
    }
  }
  assert.ok(guarded > 0, "expected to find jobs using hub credentials");
  assert.deepEqual(
    unguarded,
    [],
    `these jobs could run from a ref other than main with a hub credential in scope:\n  ${unguarded.join("\n  ")}`
  );
});

test("the admin workflows refuse an automated dispatch", () => {
  // A lecturer dispatches these as themselves. The other thing that can reach
  // workflow_dispatch is an App installation token - what a stolen broker
  // credential would be - and it arrives as `<slug>[bot]`. Guarding the
  // identity beats maintaining an allowlist of people.
  //
  // retry-acceptance can provision for an arbitrary login with the deadline
  // bypassed, and setup-org creates org-level state; neither should be
  // reachable by a credential rather than a person.
  for (const file of ["setup-org.yml", "retry-acceptance.yml", "publish-assignment.yml"]) {
    const doc = parse(readFileSync(join(WORKFLOW_DIR, file), "utf8"));
    const job = Object.values(doc.jobs)[0];
    const first = job.steps[0];
    assert.equal(
      first?.name,
      "Reject automated dispatch",
      `${file}: the guard must be the first step, before anything mints a token`
    );
    assert.match(first.if, /github\.event_name == 'workflow_dispatch'/);
    assert.match(first.if, /endsWith\(github\.actor, '\[bot\]'\)/);
    assert.match(first.run, /exit 1/, `${file}: the guard must fail the run, not just log`);
  }
});

test("no workflow reads a hub credential outside a step that needs it", () => {
  // Workflow-level `env:` would put the key in every step's environment,
  // including third-party actions that have no business seeing it.
  for (const { file, doc } of workflows()) {
    assert.ok(
      !HUB_CREDENTIALS.test(JSON.stringify(doc.env || {})),
      `${file}: hub credentials must not be exposed at workflow level`
    );
    for (const [name, job] of Object.entries(doc?.jobs || {})) {
      assert.ok(
        !HUB_CREDENTIALS.test(JSON.stringify(job.env || {})),
        `${file}:${name}: hub credentials must not be exposed at job level`
      );
    }
  }
});
