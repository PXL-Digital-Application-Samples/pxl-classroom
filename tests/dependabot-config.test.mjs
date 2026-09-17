// Dependabot version updates, and the three things they can silently get wrong.
//
// 1. A directory nobody listed is a directory nobody updates. Dependabot reads
//    `.github/workflows` for "/" and nothing else, so a composite action is
//    watched only if its directory is named, and a new one is missed without a
//    sound. Both lists are therefore DERIVED from the tracked files here, with
//    every exclusion carrying its reason, rather than trusted.
//
// 2. A merged update's subject feeds the release like any other commit's
//    (`.releaserc.json`), and it never meets `.husky/commit-msg`: Dependabot
//    writes it on GitHub. Left unset, the prefix is guessed from the history,
//    so every block must set one and it must be a type the hook accepts.
//
// 3. `acceptance/broker-workflow.yml` pins actions and is neither a hub
//    workflow nor an `action.yml`. It is copied onto every broker, a public
//    repository holding the broker App's key, so an update that moves the hub
//    and leaves it behind is exactly the drift that must not be quiet. This was
//    written expecting Dependabot never to read it; the first action update
//    (pull request #8) moved its pin anyway, because `/acceptance` is a listed
//    directory. So this is the guard that it keeps happening, not the
//    workaround for it not happening.
//
// And the trigger that makes pull requests checkable at all: ci.yml runs on
// `pull_request`, which cannot filter by author, so every job carries the same
// Dependabot gate or a stranger's pull request starts runners.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

import commitlint from "../commitlint.config.js";
import { trackedFiles } from "./repo-files.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const dependabot = parse(read(".github/dependabot.yml"));
const WORKFLOW_DIR = ".github/workflows";

/**
 * npm packages Dependabot deliberately does not watch, and why.
 *
 * An entry for a package that no longer exists fails, so this cannot outlive
 * what it excuses.
 */
const NPM_EXCLUDED = {
  "templates/template-autograding-docker":
    "starter code a cohort receives; a bump changes what students get, which is a lecturer's call",
  "templates/template-cloud-autograding/.github/aws-autograde":
    "starter code a cohort receives; a bump changes what students get, which is a lecturer's call",
};

/** Dependabot spells a directory from the root with a leading slash. */
const asDirectory = (file) => {
  const dir = posix.dirname(file);
  return dir === "." ? "/" : `/${dir}`;
};

function block(ecosystem) {
  const found = (dependabot.updates ?? []).filter((u) => u["package-ecosystem"] === ecosystem);
  assert.equal(found.length, 1, `expected one ${ecosystem} block in .github/dependabot.yml, found ${found.length}`);
  return found[0];
}

const sorted = (xs) => [...xs].sort();

test("every composite action is watched, and nothing that is not one", () => {
  const actions = trackedFiles("action.yml", "action.yaml", "**/action.yml", "**/action.yaml");
  assert.ok(actions.length > 3, `sanity: expected several composite actions, found ${actions.length}`);

  const expected = new Set(["/", ...actions.map(asDirectory)]);
  assert.deepEqual(
    sorted(block("github-actions").directories ?? []),
    sorted(expected),
    "github-actions `directories` must be \"/\" plus the directory of every tracked action.yml",
  );
});

test("every hub package is watched, and every package left out says why", () => {
  const packages = trackedFiles("package.json", "**/package.json").map(asDirectory);
  assert.ok(packages.includes("/"), "sanity: the root package.json must be tracked");

  const excluded = new Set(Object.keys(NPM_EXCLUDED).map((d) => `/${d}`));
  for (const dir of excluded) {
    assert.ok(packages.includes(dir), `NPM_EXCLUDED names ${dir}, which has no package.json any more`);
  }

  assert.deepEqual(
    sorted(block("npm").directories ?? []),
    sorted(packages.filter((d) => !excluded.has(d))),
    "npm `directories` must be every tracked package.json, less the ones NPM_EXCLUDED gives a reason for",
  );
});

test("every update's commit subject is a type the commit hook accepts", () => {
  const allowed = new Set(commitlint.rules["type-enum"][2]);
  assert.ok(allowed.size > 3, "sanity: the hook's type list must be readable");

  for (const update of dependabot.updates ?? []) {
    const name = update["package-ecosystem"];
    const message = update["commit-message"] ?? {};
    // Absent is not a default here: Dependabot then guesses from the history.
    assert.ok(message.prefix, `${name}: commit-message.prefix must be set, or Dependabot guesses one`);
    for (const key of ["prefix", "prefix-development"]) {
      if (message[key] === undefined) continue;
      assert.ok(
        allowed.has(message[key]),
        `${name}: commit-message.${key} "${message[key]}" is not a type .releaserc.json declares`,
      );
    }
  }
});

test("@types/node is held to the Node the hub runs, and Dependabot does not move its major", () => {
  // The first run proposed @types/node 26 while `engines` and CI said 24: types
  // for APIs the runtime does not have. The three move together, by hand.
  const pkg = JSON.parse(read("package.json"));
  const major = (spec) => Number(/(\d+)/.exec(String(spec))?.[1]);

  const engine = major(pkg.engines?.node);
  assert.ok(Number.isInteger(engine), `sanity: engines.node must name a major, found ${pkg.engines?.node}`);
  assert.equal(major(pkg.devDependencies?.["@types/node"]), engine, "@types/node's major must be the engines floor");

  const ci = parse(read(`${WORKFLOW_DIR}/ci.yml`));
  const setupNode = Object.values(ci.jobs ?? {})
    .flatMap((job) => job.steps ?? [])
    .filter((s) => String(s.uses ?? "").startsWith("actions/setup-node@"));
  assert.ok(setupNode.length > 0, "sanity: ci.yml must set Node up");
  for (const step of setupNode) {
    assert.equal(major(step.with?.["node-version"]), engine, "CI must run the Node that engines names");
  }

  const held = (block("npm").ignore ?? []).some(
    (rule) =>
      rule["dependency-name"] === "@types/node" &&
      (rule["update-types"] ?? []).includes("version-update:semver-major"),
  );
  assert.ok(held, "Dependabot must ignore @types/node majors, or it proposes types for a Node the hub does not run");
});

test("the typecheck's compiler is held below 7, and jsconfig asks for the Node types by name", () => {
  // TypeScript 7 checks a .js file by TypeScript's rules: JSDoc `object` stops
  // meaning `any` and a `= {}` default types as `{}`. Measured 2026-09-17, that
  // is 168 errors of dialect on top of the 63 real findings, in a tool that is
  // read rather than gated (LESSONS.md, "JSDoc `object` meant `any`"). The
  // sweep that would fix it is 79 annotations and 22 destructurings in lib/.
  const pkg = JSON.parse(read("package.json"));
  const major = (spec) => Number(/(\d+)/.exec(String(spec))?.[1]);
  assert.ok(major(pkg.devDependencies?.typescript) < 7, "typescript stays below 7 until lib/'s JSDoc is swept");

  const held = (block("npm").ignore ?? []).some(
    (rule) =>
      rule["dependency-name"] === "typescript" &&
      (rule["update-types"] ?? []).includes("version-update:semver-major"),
  );
  assert.ok(held, "Dependabot must ignore typescript majors while that sweep is outstanding");

  // Both halves of what 6 changed, so removing either brings the noise back:
  // `types` no longer defaults to every @types package, and a `//` note inside
  // compilerOptions is an unknown option to 7.
  const jsconfig = JSON.parse(read("jsconfig.json"));
  assert.deepEqual(jsconfig.compilerOptions?.types, ["node"], "jsconfig must name the Node types");
  const unknown = Object.keys(jsconfig.compilerOptions ?? {}).filter((k) => k.startsWith("//"));
  assert.deepEqual(unknown, [], "a note inside compilerOptions is an unknown compiler option");
});

function triggersOf(doc) {
  const on = doc?.on;
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return on;
  return Object.keys(on ?? {});
}

test("ci.yml is the only workflow a pull request can start, and never with pull_request_target", () => {
  const prTriggered = readdirSync(join(root, WORKFLOW_DIR))
    .filter((f) => /\.ya?ml$/.test(f))
    .filter((f) => {
      const triggers = triggersOf(parse(read(`${WORKFLOW_DIR}/${f}`)));
      return triggers.includes("pull_request") || triggers.includes("pull_request_target");
    });
  assert.deepEqual(prTriggered, ["ci.yml"]);

  // pull_request_target runs with this repository's secrets against the pull
  // request's code. Dependabot's runs get no secrets on `pull_request`, and
  // ci.yml needs none; that is the answer, not a reason to switch.
  assert.ok(!triggersOf(parse(read(`${WORKFLOW_DIR}/ci.yml`))).includes("pull_request_target"));
});

test("every ci.yml job runs on a push or on Dependabot's pull request, and on no other", () => {
  const ci = parse(read(`${WORKFLOW_DIR}/ci.yml`));
  assert.ok(triggersOf(ci).includes("pull_request"), "sanity: ci.yml must run on Dependabot's pull requests");

  const jobs = Object.entries(ci.jobs ?? {});
  assert.ok(jobs.length >= 3, "sanity: expected the unit, e2e and lint jobs");
  const ungated = jobs
    .filter(([, job]) => {
      const cond = String(job.if ?? "");
      return !(
        cond.includes("github.event_name == 'push'") &&
        cond.includes("github.event.pull_request.user.login == 'dependabot[bot]'")
      );
    })
    .map(([name]) => name);
  assert.deepEqual(ungated, [], "these jobs would run on anybody's pull request");
});

/** Every `uses:` in a workflow's jobs or a composite action's steps. */
function usesIn(doc) {
  const steps = [
    ...Object.values(doc?.jobs ?? {}).flatMap((job) => job?.steps ?? []),
    ...(doc?.runs?.steps ?? []),
  ];
  return steps.map((s) => s?.uses).filter((u) => typeof u === "string" && u.includes("@"));
}

test("the broker template pins every action where the hub does", () => {
  const hubFiles = [
    ...readdirSync(join(root, WORKFLOW_DIR)).filter((f) => /\.ya?ml$/.test(f)).map((f) => `${WORKFLOW_DIR}/${f}`),
    ...trackedFiles("**/action.yml", "**/action.yaml"),
  ];
  const hubRefs = new Map();
  for (const file of hubFiles) {
    for (const uses of usesIn(parse(read(file)))) {
      const [action, ref] = uses.split("@");
      if (!hubRefs.has(action)) hubRefs.set(action, new Set());
      hubRefs.get(action).add(ref);
    }
  }

  const brokerPath = "acceptance/broker-workflow.yml";
  assert.ok(existsSync(join(root, brokerPath)), `sanity: ${brokerPath} must exist`);
  const brokerUses = usesIn(parse(read(brokerPath)));
  assert.ok(brokerUses.length > 0, "sanity: the broker template must pin at least one action");

  const drift = [];
  for (const uses of brokerUses) {
    const [action, ref] = uses.split("@");
    const hub = hubRefs.get(action);
    if (!hub) {
      drift.push(`${action}: used by the broker and nowhere in the hub, so nothing keeps the two in step`);
    } else if (hub.size !== 1 || !hub.has(ref)) {
      drift.push(`${action}: broker pins ${ref}, hub pins ${[...hub].join(", ")}`);
    }
  }
  assert.deepEqual(
    drift,
    [],
    `${brokerPath} disagrees with the hub. Dependabot updates it through the /acceptance directory; ` +
      "where it did not, copy the hub's pin (SHA and version comment) into it on the update's own branch.",
  );
});
