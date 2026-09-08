// The commit subject is an INPUT to the release, not decoration.
//
// `.releaserc.json` derives the version and the release notes from it, so a
// type nobody declared is a commit that moves no version and appears in no
// notes - and says so nowhere. `style:` was used four times in exactly that
// state before this guard existed.
//
// There is no pull request on this repository (CLAUDE.md: commit and push to
// `main`), so `.husky/commit-msg` is the only gate a bad subject can meet. This
// checks the gate agrees with the release configuration, in both directions,
// by DERIVING one from the other rather than holding a third copy of the list.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import config, { declaredTypes } from "../commitlint.config.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const releaserc = JSON.parse(read(".releaserc.json"));

test("the hook's type list is the release configuration's, not a copy of it", () => {
  // If commitlint.config.js ever stops reading `.releaserc.json` and grows its
  // own array, this still passes only while the two happen to agree - so the
  // source is checked as well as the value.
  assert.match(
    read("commitlint.config.js"),
    /readFileSync\([^)]*\.releaserc\.json/,
    "commitlint.config.js must read the release config rather than restate its types",
  );
  assert.deepEqual(config.rules["type-enum"][2], declaredTypes(releaserc));
});

test("every type the release config has an opinion about is one the hook accepts", () => {
  const allowed = new Set(config.rules["type-enum"][2]);
  const analyzer = releaserc.plugins.find((p) => p[0] === "@semantic-release/commit-analyzer")[1];
  const notes = releaserc.plugins.find((p) => p[0] === "@semantic-release/release-notes-generator")[1];

  for (const rule of analyzer.releaseRules) {
    assert.ok(allowed.has(rule.type), `releaseRules names "${rule.type}" and the hook would refuse it`);
  }
  for (const t of notes.presetConfig.types) {
    assert.ok(allowed.has(t.type), `the notes config names "${t.type}" and the hook would refuse it`);
  }
});

test("a type the hook accepts is one the release config decided about", () => {
  // The silent half. A type that releases nothing AND appears in no notes is a
  // commit that vanishes; that is fine when somebody chose it (`chore`,
  // `test`), and a defect when nobody did.
  const analyzer = releaserc.plugins.find((p) => p[0] === "@semantic-release/commit-analyzer")[1];
  const notes = releaserc.plugins.find((p) => p[0] === "@semantic-release/release-notes-generator")[1];
  const decided = new Set([
    "feat", "fix",                                   // the spec's own two
    ...analyzer.releaseRules.map((r) => r.type),
    ...notes.presetConfig.types.map((t) => t.type),
  ]);

  for (const type of config.rules["type-enum"][2]) {
    assert.ok(decided.has(type), `the hook accepts "${type}" and nothing in .releaserc.json mentions it`);
  }
});

test("every type in the recent history is one the hook would still accept", () => {
  // The convention was unenforced until this hook existed, so the history is
  // the evidence of what people actually type. A type in it that the hook now
  // refuses is a rule that would have rejected real work - worth knowing before
  // it rejects the next piece.
  const log = execFileSync("git", ["log", "--format=%s", "-300"], { cwd: root, encoding: "utf8" });
  const used = new Set();
  for (const subject of log.split("\n")) {
    const m = /^([a-z]+)(\([^)]*\))?!?:/.exec(subject.trim());
    if (m) used.add(m[1]);
  }
  assert.ok(used.size > 3, `expected several types in the history, found ${[...used]}`);

  const allowed = new Set(config.rules["type-enum"][2]);
  const refused = [...used].filter((t) => !allowed.has(t));
  assert.deepEqual(
    refused,
    [],
    `these types appear in the history and the hook would now refuse them: ${refused.join(", ")}`,
  );
});

test("the hook is wired to commitlint, and husky is installed by npm", () => {
  // A config nothing runs is a convention again. `prepare` is what installs the
  // hook on a fresh clone - without it the file sits there and git never calls
  // it, which looks exactly like enforcement.
  assert.match(read(".husky/commit-msg"), /commitlint --edit/);
  const pkg = JSON.parse(read("package.json"));
  assert.ok(pkg.devDependencies["@commitlint/cli"], "commitlint has to be installed to be run");
  assert.ok(pkg.devDependencies["@commitlint/config-conventional"]);
});

test("`prepare` survives the install every production workflow actually runs", () => {
  // THE ONE THAT NEARLY SHIPPED. `npm ci --omit=dev` skips devDependencies but
  // STILL RUNS `prepare`, so a bare `"prepare": "husky"` exits 1 - measured on
  // Windows and Linux alike: `cmd.exe /d /s /c husky` with husky not installed.
  //
  // Fourteen workflows run `npm ci --omit=dev` - acceptance-handler,
  // daily-activity, publish-assignment, deadline-sentinel, deploy-frontend and
  // the rest - so an unguarded prepare would have failed provisioning for every
  // student, the nightly for every org, and publishing, all at once. A developer
  // convenience is not worth one minute of that.
  //
  // `|| exit 0` rather than `|| true`: `true` is not a cmd.exe builtin, and npm
  // runs scripts through cmd on Windows.
  const pkg = JSON.parse(read("package.json"));
  assert.match(
    pkg.scripts.prepare,
    /\|\|\s*exit 0\s*$/,
    "prepare must tolerate husky being absent - `npm ci --omit=dev` runs it anyway",
  );

  const workflows = readdirSync(join(root, ".github/workflows"))
    .filter((f) => f.endsWith(".yml"))
    .filter((f) => /npm ci --omit=dev/.test(read(`.github/workflows/${f}`)));
  assert.ok(
    workflows.length > 5,
    `expected the production workflows to install without devDependencies, found ${workflows.length}`,
  );
});
