// The local docker runner's image override, and why it needed a schema.
//
// `runner-docker.mjs` has read `test.image` since it was written - the comment
// beside it says the override is deliberate, "most courses settle on one image
// per assignment". The schema never declared it, and every test item is
// `additionalProperties: false`, so NO saveable assignment could set it: a
// reader with no possible writer.
//
// That is not cosmetic, because the defaults are narrow. `run` and `io` checks
// run in `debian:stable-slim`, which has no python3, no node, no make and no
// compiler, and the runner enforces `--network=none` so a check cannot install
// one. Measured 2026-09-08 against the drill on pxl-classroom-testbed: three
// checks that scored 10/10 on GitHub Actions scored 0 locally, every one of
// them `sh: 1: python3: not found`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateAgainst } from "../lib/validate.mjs";
import { cleanChecks } from "../frontend/src/lib/autograde.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

const assignment = (tests) => ({
  schema_version: 1,
  id: "img",
  title: "Image",
  organization: "org",
  template: { owner: "org", repository: "tpl" },
  repository_name_pattern: "img-{github_login}",
  opens_at: "2026-09-08T06:00:00.000Z",
  deadline_at: "2026-12-31T22:00:00.000Z",
  state: "draft",
  roster_mode: "open",
  max_acceptances: 5,
  autograde: { enabled: true, execution_environment: "lecturer_local", tests },
});

test("an assignment can name the image its checks need", () => {
  const res = validateAgainst("assignment", assignment([
    { id: "t", type: "run", command: "python3 solve.py", points: 1, image: "python:3.12-slim" },
  ]));
  assert.ok(res.valid, JSON.stringify(res.errors));
});

test("the field the runner reads is the field the schema declares", () => {
  // Derived: whatever `imageFor` reads off the test is what has to be storable.
  // Spelling "image" in this test and in the runner would be the same two-lists
  // problem one level down.
  const runner = read("cli/src/lib/runner-docker.mjs");
  const m = /if \(test\.(\w+)\) return test\.\1;/.exec(runner);
  assert.ok(m, "runner-docker must read an override off the test for this to check anything");
  const field = m[1];

  const schema = JSON.parse(read("schemas/assignment.schema.json"));
  const props = schema.properties.autograde.properties.tests.items.properties;
  assert.ok(
    Object.hasOwn(props, field),
    `runner-docker reads test.${field} and the schema does not declare it, so no assignment can set it`,
  );
});

test("saving an assignment does not delete it", () => {
  // buildDoc rebuilds `autograde` from the form, and the form has no control
  // for this. A field the form does not show is exactly what `cleanChecks` used
  // to drop - the same failure invitation tokens had.
  const [cleaned] = cleanChecks([
    { id: "t", type: "run", command: "python3 solve.py", points: 1, image: "python:3.12-slim" },
  ]);
  assert.equal(cleaned.image, "python:3.12-slim");

  // And a check that names none stays clean rather than gaining an empty one.
  const [plain] = cleanChecks([{ id: "t", type: "run", command: "true", points: 1 }]);
  assert.ok(!("image" in plain), "absent means the runner's default, not an empty string");
});

test("the default images are what the runner actually uses", () => {
  // The schema's description tells a lecturer which image they get by default,
  // and that sentence is only useful while it is true.
  const runner = read("cli/src/lib/runner-docker.mjs");
  const schema = JSON.parse(read("schemas/assignment.schema.json"));
  const described = schema.properties.autograde.properties.tests.items.properties.image.description;

  for (const image of ["python:3.12-slim", "debian:stable-slim"]) {
    assert.ok(runner.includes(image), `runner-docker no longer defaults to ${image}`);
    assert.ok(described.includes(image), `the schema description does not mention ${image}`);
  }
});
