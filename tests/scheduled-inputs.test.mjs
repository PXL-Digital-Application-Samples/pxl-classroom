// A workflow that runs on a schedule has no inputs there, and GitHub compares
// a missing input (null) and `false` as the same number. So `inputs.x != false`
// is false on the schedule and `inputs.x == false` is true: a default-on
// switch is off exactly when nobody is there to turn it on. The watchdog's
// `AUTO_CANCEL: ${{ inputs.auto_cancel != false }}` meant the scheduled run
// never cancelled a stuck run (measured in TV-8, read as fine; found by the
// documentation audit, 2026-10-15).
//
// Every boolean dispatch input of a scheduled workflow is checked: compared
// with `false` anywhere in the file is refused. Compare with `true`, or name
// the schedule (`github.event_name == 'schedule' || inputs.x`).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

import { trackedFiles } from "./repo-files.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const workflows = trackedFiles().filter((f) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f));

test("no scheduled workflow compares a boolean dispatch input with false", () => {
  const offenders = [];
  let checked = 0;
  for (const file of workflows) {
    const text = readFileSync(join(root, file), "utf8");
    const doc = parse(text);
    const on = doc?.on ?? doc?.true;
    if (!on || typeof on !== "object" || !("schedule" in on)) continue;
    const inputs = on.workflow_dispatch?.inputs ?? {};
    for (const [name, spec] of Object.entries(inputs)) {
      if (spec?.type !== "boolean") continue;
      checked++;
      const compared = new RegExp(`inputs\\.${name}\\s*[!=]=\\s*false|false\\s*[!=]=\\s*inputs\\.${name}`);
      if (compared.test(text)) offenders.push(`${file}: inputs.${name} compared with false`);
    }
  }
  assert.ok(checked > 0, "the watchdog's auto_cancel is a scheduled workflow's boolean input; finding none means this checks nothing");
  assert.deepEqual(offenders, []);
});

test("the watchdog cancels on its schedule", () => {
  const doc = parse(readFileSync(join(root, ".github/workflows/pipeline-watchdog.yml"), "utf8"));
  const step = doc.jobs.watchdog.steps.find((s) => s.env?.AUTO_CANCEL !== undefined);
  assert.match(String(step.env.AUTO_CANCEL), /github\.event_name == 'schedule' \|\| inputs\.auto_cancel/);
});
