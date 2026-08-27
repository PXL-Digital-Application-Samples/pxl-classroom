// `--dry-run` must have ZERO side effects: no API writes, no PRs, no commits.
//
// CLAUDE.md records this as sacred, and it records why: `feedback open
// --dry-run` once created real pull requests. That was a P0, fixed in e967035
// - and until now NOTHING pinned it. Swept 2026-08-27: not one test in the
// suite mentioned dry-run at all, so the exact bug could have walked back in
// on any refactor of any of the five commands that take the flag.
//
// This is a SHAPE check, not a behavioural one, and it says so: the CLI talks
// through Octokit, so proving "no write was issued" would mean intercepting
// its request layer. What this proves instead is the property the P0 violated -
// that every mutating call site in a dry-run-capable command has a dry-run
// guard EARLIER in the file, so the flag is consulted before the write rather
// than after it. A necessary condition, cheaply enforced, on the exact class.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const CMD_DIR = join(root, "cli", "src", "commands");

/** Anything that changes state on GitHub or in a control repository. */
const MUTATING = /octokit\.(rest\.[a-zA-Z.]+\.(create|update|delete|add|remove|merge)[A-Za-z]*|request\(\s*["'](POST|PUT|PATCH|DELETE)\b)|commitWithRebase\s*\(/;

/** A line that consults the flag - either shape reads as a guard. */
const GUARD = /\bopts\.dryRun\b|\bdryRun\b/;

function commandsWithDryRun() {
  return readdirSync(CMD_DIR)
    .filter((f) => f.endsWith(".mjs"))
    .map((f) => ({ file: f, src: readFileSync(join(CMD_DIR, f), "utf8") }))
    .filter(({ src }) => /dry-run|dryRun/.test(src));
}

test("every mutating call in a dry-run command is preceded by a dry-run guard", () => {
  const commands = commandsWithDryRun();
  assert.ok(commands.length >= 5, `expected several dry-run commands, found ${commands.length}`);

  const offenders = [];
  for (const { file, src } of commands) {
    // Comments quote the P0 by name in places; a mention inside one is not a
    // guard, and a mutating call inside one is not a call.
    const lines = src
      .split("\n")
      .map((l) => (/^\s*(\/\/|\*)/.test(l) ? "" : l));

    let firstGuard = Infinity;
    lines.forEach((l, i) => {
      if (firstGuard === Infinity && GUARD.test(l)) firstGuard = i;
    });

    // Where each named helper function begins. A mutating call inside one is
    // not unguarded just because the helper is DEFINED above the command body -
    // feedback.mjs declares openDraftPr at the top and calls it after an
    // `if (opts.dryRun) continue`, which is correct and which the first version
    // of this test called a violation. What matters is whether the helper is
    // INVOKED after a guard.
    const helpers = [];
    lines.forEach((l, i) => {
      const m = l.match(/^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/);
      if (m) helpers.push({ name: m[1], at: i });
    });
    const enclosingHelper = (line) => {
      let best = null;
      for (const h of helpers) if (h.at <= line && (!best || h.at > best.at)) best = h;
      return best;
    };

    lines.forEach((l, i) => {
      if (!MUTATING.test(l)) return;
      if (i >= firstGuard) return;

      const h = enclosingHelper(i);
      if (h) {
        // Called anywhere after the flag is first consulted?
        const invoked = lines.some(
          (line, j) => j > firstGuard && new RegExp(`\\b${h.name}\\s*\\(`).test(line),
        );
        if (invoked) return;
        offenders.push(`${file}:${i + 1} in ${h.name}(), which is never called after a dry-run guard`);
        return;
      }
      offenders.push(`${file}:${i + 1} writes before the flag is ever consulted`);
    });
  }
  assert.deepEqual(
    offenders,
    [],
    "--dry-run must be checked before anything is written:\n" +
      offenders.map((o) => `  ${o}`).join("\n"),
  );
});

test("the scan actually found the calls it is meant to police", () => {
  // A matcher that silently stops matching looks exactly like a clean repo -
  // the trap tests/fixture-options.test.mjs names. These are the real call
  // sites as of 2026-08-27.
  const seen = [];
  for (const { file, src } of commandsWithDryRun()) {
    src.split("\n").forEach((l, i) => {
      if (MUTATING.test(l) && !/^\s*(\/\/|\*)/.test(l)) seen.push(`${file}:${i + 1}`);
    });
  }
  assert.ok(seen.length >= 12, `expected to find the mutating call sites, found ${seen.length}`);

  const files = new Set(seen.map((s) => s.split(":")[0]));
  for (const expected of ["feedback.mjs", "sync-starter.mjs", "roster.mjs", "teams.mjs", "grade.mjs"]) {
    assert.ok(files.has(expected), `${expected} should contain a mutating call`);
  }
  // The one the P0 was actually about.
  assert.ok(
    seen.some((s) => s.startsWith("feedback.mjs")),
    "feedback.mjs opens PRs - the command that created real ones under --dry-run",
  );
});
