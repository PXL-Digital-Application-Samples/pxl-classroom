// Every GitHub App token step asks for exactly its row in lib/app-token-scopes.mjs.
//
// A token with only `owner:` gets every repository and every permission the
// installation holds. The table is where each step's scope is decided; this
// holds the YAML to it in both directions, and holds the table to what each App
// actually declares. It says nothing about whether a list is ENOUGH - a 403 at
// the moment of use is found by running the job, never here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

import { APP_TOKEN_SCOPES } from "../lib/app-token-scopes.mjs";
import { MANIFEST_APP_PERMISSIONS } from "../lib/audit.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const LEVEL = { read: 1, write: 2 };

/** Every file that can mint a token: hub workflows, composite actions, the broker template. */
function tokenFiles() {
  const workflows = readdirSync(join(root, ".github", "workflows"))
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => ({ path: `.github/workflows/${f}`, composite: false }));
  const composites = readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(root, e.name, "action.yml")))
    .map((e) => ({ path: `${e.name}/action.yml`, composite: true }));
  return [...workflows, ...composites, { path: "acceptance/broker-workflow.yml", composite: false }];
}

/** `[{ key, step }]` for every create-github-app-token step. */
function tokenSteps() {
  const out = [];
  for (const { path, composite } of tokenFiles()) {
    const doc = parse(read(path));
    const groups = composite
      ? [[null, doc?.runs?.steps ?? []]]
      : Object.entries(doc?.jobs ?? {}).map(([id, job]) => [id, job?.steps ?? []]);
    for (const [jobId, steps] of groups) {
      for (const step of steps) {
        if (!String(step?.uses ?? "").startsWith("actions/create-github-app-token@")) continue;
        assert.ok(step.id, `${path}${jobId ? `:${jobId}` : ""}: a token step needs an id, which is its key in the table`);
        out.push({ key: jobId ? `${path}#${jobId}.${step.id}` : `${path}#${step.id}`, step });
      }
    }
  }
  return out;
}

const steps = tokenSteps();

/** What the step asks for, in the table's terms. */
function asked(step) {
  const w = step.with ?? {};
  const repositories =
    w.repositories === undefined
      ? "all"
      : String(w.repositories).split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
  const permissionInputs = Object.keys(w).filter((k) => k.startsWith("permission-"));
  const permissions = permissionInputs.length
    ? Object.fromEntries(permissionInputs.map((k) => [k.slice("permission-".length).replaceAll("-", "_"), String(w[k])]))
    : "all";
  return { repositories, permissions, clientId: String(w["client-id"] ?? "") };
}

/** The broker App's permissions, read from the script that creates it. */
function brokerDeclared() {
  const src = read("scripts/create-broker-app.mjs");
  const m = /const REQUIRED_PERMISSIONS = Object\.freeze\((\{[^}]*\})\)/.exec(src);
  assert.ok(m, "sanity: scripts/create-broker-app.mjs must still declare REQUIRED_PERMISSIONS");
  return JSON.parse(m[1].replace(/(\w+)\s*:/g, '"$1":'));
}

const DECLARED = { provisioning: MANIFEST_APP_PERMISSIONS, broker: brokerDeclared() };

test("every token step has exactly one row, and every row has a step", () => {
  assert.ok(steps.length > 20, `sanity: expected the hub's token steps, found ${steps.length}`);
  const keys = steps.map((s) => s.key);
  assert.deepEqual(
    keys.filter((k, i) => keys.indexOf(k) !== i),
    [],
    "two token steps share a key; give them distinct ids",
  );
  assert.deepEqual(
    keys.filter((k) => !(k in APP_TOKEN_SCOPES)),
    [],
    "these token steps have no row in lib/app-token-scopes.mjs: decide their scope there",
  );
  assert.deepEqual(
    Object.keys(APP_TOKEN_SCOPES).filter((k) => !keys.includes(k)),
    [],
    "these rows name a token step that no longer exists",
  );
});

test("every token step asks for exactly its row", () => {
  const mismatches = [];
  for (const { key, step } of steps) {
    const row = APP_TOKEN_SCOPES[key];
    if (!row) continue;
    const got = asked(step);
    try {
      assert.deepEqual(got.repositories, row.repositories);
    } catch {
      mismatches.push(`${key}: repositories ${JSON.stringify(got.repositories)}, table ${JSON.stringify(row.repositories)}`);
    }
    try {
      assert.deepEqual(got.permissions, row.permissions);
    } catch {
      mismatches.push(`${key}: permissions ${JSON.stringify(got.permissions)}, table ${JSON.stringify(row.permissions)}`);
    }
  }
  assert.deepEqual(mismatches, [], mismatches.join("\n"));
});

test("each step mints with the App its row names", () => {
  // A composite action is handed the client id by its caller, so what it mints
  // with is decided at every `uses: ./action` site; those are checked below.
  const wrong = [];
  for (const { key, step } of steps) {
    const row = APP_TOKEN_SCOPES[key];
    if (!row) continue;
    const { clientId } = asked(step);
    const ok =
      row.app === "broker"
        ? clientId.includes("secrets.PXL_BROKER_CLIENT_ID")
        : clientId.includes("secrets.PXL_APP_CLIENT_ID") || clientId.includes("inputs.client-id");
    if (!ok) wrong.push(`${key}: row says ${row.app}, client-id is ${clientId}`);
  }
  assert.deepEqual(wrong, [], wrong.join("\n"));

  const callers = [];
  for (const { path, composite } of tokenFiles()) {
    if (composite) continue;
    for (const [jobId, job] of Object.entries(parse(read(path))?.jobs ?? {})) {
      for (const s of job?.steps ?? []) {
        if (!String(s?.uses ?? "").startsWith("./") || s.with?.["client-id"] === undefined) continue;
        if (!String(s.with["client-id"]).includes("secrets.PXL_APP_CLIENT_ID")) {
          callers.push(`${path}:${jobId} passes ${s.with["client-id"]} to ${s.uses}`);
        }
      }
    }
  }
  assert.deepEqual(callers, [], "composite actions mint with the provisioning App; these callers hand them another client id");
});

test("no row asks for more than its App declares", () => {
  const over = [];
  for (const [key, row] of Object.entries(APP_TOKEN_SCOPES)) {
    const declared = DECLARED[row.app];
    assert.ok(declared, `${key}: unknown app "${row.app}"`);
    if (row.permissions === "all") continue;
    for (const [name, level] of Object.entries(row.permissions)) {
      if (!(level in LEVEL)) over.push(`${key}: ${name}: "${level}" is not read or write`);
      else if (!(name in declared)) over.push(`${key}: ${name} is not a permission the ${row.app} App declares`);
      else if (LEVEL[level] > LEVEL[declared[name]]) over.push(`${key}: ${name}: ${level} exceeds the declared ${declared[name]}`);
    }
  }
  assert.deepEqual(over, [], over.join("\n"));
});

// `pending` was how a row stayed broad while the narrowing was staged. All three
// stages landed on 2026-09-17, so a broad row now needs a decision, not a plan.
test("a row left broad says why, and a scoped row does not", () => {
  const bad = [];
  for (const [key, row] of Object.entries(APP_TOKEN_SCOPES)) {
    const broad = row.repositories === "all" || row.permissions === "all";
    if (row.pending !== undefined) bad.push(`${key}: "pending" is retired - decide the scope, or give a reason`);
    if (row.permissions === "all") bad.push(`${key}: every permission the installation holds - name the ones it uses`);
    if (broad) {
      if (row.reason === undefined) bad.push(`${key}: a broad row carries a reason`);
      else if (String(row.reason).length < 40) bad.push(`${key}: a reason says why`);
    } else if (row.reason !== undefined) {
      bad.push(`${key}: fully scoped, so its reason is stale`);
    }
    if (row.repositories !== "all" && (!Array.isArray(row.repositories) || row.repositories.length === 0)) {
      bad.push(`${key}: repositories is "all" or a non-empty list`);
    }
  }
  assert.deepEqual(bad, [], bad.join("\n"));
});
