#!/usr/bin/env node
// PXL Classroom - the lint entry point. One command, run by CI and by hand.
//
// It exists because `npm run lint` and CI's lint job used to check different
// things. `npm run lint` was `eslint .`; CI's `test` job ran
// `npx eslint . --max-warnings 0` and CI's `lint` job ran actionlint plus
// scripts/workflow-lint.mjs, neither of which had a local equivalent. So a
// change could pass locally, four times over, while CI had been red since
// 48ed831 for a shellcheck finding nothing local would ever surface.
//
// Three checks, in cheapest-first order:
//
//   eslint         - no-undef above all. The Vue template compiler never sees a
//                    <script setup> body and the unit suite does not execute
//                    components, so an undeclared identifier ships silently.
//   workflow-lint  - bash -n over every `run:` block, plus this repo's own
//                    rules (scripts/workflow-lint.mjs).
//   actionlint     - workflow schema + expression checking, and shellcheck over
//                    every `run:` block, which is the half nothing else does.
//
// Both external tools are PINNED and resolved the same way in both places:
// actionlint is downloaded once into .tools/ (gitignored) at the version below,
// and shellcheck comes from the `shellcheck` devDependency rather than from
// whatever the runner image happens to ship - a different shellcheck reports
// different findings, which is the same drift in another coat.
//
// If a tool genuinely cannot be obtained, this fails rather than skipping. A
// check that quietly does not run is what caused this file to exist.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TOOLS = join(root, ".tools");

// Pinned. Bump deliberately, in one place, and both sides move together.
const ACTIONLINT_VERSION = "1.7.1";

const isWindows = process.platform === "win32";
const exe = (name) => (isWindows ? `${name}.exe` : name);

const results = [];
let failed = false;

// A hang is worse than a failure, because it looks exactly like work in
// progress. actionlint's shellcheck subprocess DEADLOCKS on Windows once a
// `run:` block's script exceeds the ~4 KB anonymous-pipe buffer: actionlint
// copies the script to shellcheck's stdin, the copy blocks on a full pipe, and
// Wait() never returns. Linux pipes hold 64 KB, so CI is unaffected - which is
// the worst shape for this, because the local command hangs for ever while
// everything remote stays green. It cost an hour once and shipped a workflow
// change with "local actionlint could not be run to completion" in its commit
// message instead of a lint result; the next one gets a named failure in two
// minutes. The whole suite runs in seconds, so this can never fire on
// slowness alone.
const STEP_TIMEOUT_MS = 120_000;

function run(label, command, args, opts = {}) {
  process.stdout.write(`\n── ${label}\n`);
  const res = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: false,
    timeout: STEP_TIMEOUT_MS,
    ...opts,
  });
  if (res.error) {
    const timedOut = res.error.code === "ETIMEDOUT" || res.signal !== null;
    console.error(`[FAIL] ${label}: ${timedOut ? `timed out after ${STEP_TIMEOUT_MS / 1000}s` : res.error.message}`);
    if (timedOut && label === "actionlint") {
      console.error(
        "       This is almost certainly a `run:` block whose script exceeds ~4 KB.\n" +
          "       Split the step - platform-neutral, and the blocks read better anyway.\n" +
          "       A Windows-only workaround would reintroduce the local-vs-CI drift\n" +
          "       this script exists to end. See CLAUDE.md, Linting."
      );
    }
    results.push({ label, ok: false });
    failed = true;
    return false;
  }
  const ok = res.status === 0;
  results.push({ label, ok });
  if (!ok) failed = true;
  return ok;
}

/** The pinned shellcheck, so local and CI report identically. */
function resolveShellcheck() {
  const vendored = join(root, "node_modules", "shellcheck", "bin", exe("shellcheck"));
  if (existsSync(vendored)) return vendored;
  // The wrapper downloads on first use; ask it to, rather than silently
  // falling through to whatever the machine has.
  const shim = join(root, "node_modules", ".bin", isWindows ? "shellcheck.cmd" : "shellcheck");
  if (existsSync(shim)) {
    spawnSync(shim, ["--version"], { cwd: root, stdio: "ignore", shell: isWindows });
    if (existsSync(vendored)) return vendored;
  }
  return null;
}

/** The pinned actionlint, downloaded into .tools/ once. */
function resolveActionlint() {
  const local = join(TOOLS, exe("actionlint"));
  if (existsSync(local)) return local;

  console.log(`   downloading actionlint ${ACTIONLINT_VERSION} into .tools/ ...`);
  mkdirSync(TOOLS, { recursive: true });
  const script =
    "curl -sSL https://raw.githubusercontent.com/rhysd/actionlint/main/scripts/download-actionlint.bash " +
    `| bash -s ${ACTIONLINT_VERSION}`;
  const res = spawnSync("bash", ["-c", script], { cwd: TOOLS, stdio: "inherit" });
  if (res.status !== 0 || !existsSync(local)) return null;
  return local;
}

// 1. eslint. --max-warnings 0 because a warning nobody fails on is a warning
//    nobody reads.
run("eslint", process.execPath, [
  join(root, "node_modules", "eslint", "bin", "eslint.js"),
  ".",
  "--max-warnings",
  "0",
]);

// 2. This repo's own workflow rules, plus bash -n.
run("workflow-lint", process.execPath, [join(root, "scripts", "workflow-lint.mjs")]);

// 3. actionlint + shellcheck.
const actionlint = resolveActionlint();
const shellcheck = resolveShellcheck();

if (!actionlint) {
  console.error(
    "\n[FAIL] actionlint could not be obtained.\n" +
      "       It needs `bash` and `curl` on PATH (Git Bash provides both on Windows).\n" +
      "       Skipping it is not an option: it is the only thing that runs shellcheck\n" +
      "       over workflow `run:` blocks, and CI will run it regardless."
  );
  results.push({ label: "actionlint", ok: false });
  failed = true;
} else if (!shellcheck) {
  console.error(
    "\n[FAIL] shellcheck could not be obtained.\n" +
      "       Run `npm ci` to fetch the pinned `shellcheck` devDependency.\n" +
      "       Running actionlint without it would silently skip every SC* check,\n" +
      "       which is exactly the local-vs-CI gap this script exists to close."
  );
  results.push({ label: "actionlint", ok: false });
  failed = true;
} else {
  run("actionlint", actionlint, ["-shellcheck", shellcheck]);
}

const width = Math.max(...results.map((r) => r.label.length));
process.stdout.write("\n");
for (const r of results) {
  process.stdout.write(`${r.ok ? "  ok  " : " FAIL "} ${r.label.padEnd(width)}\n`);
}
process.exit(failed ? 1 : 0);
