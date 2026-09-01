// A GitHub login is case-insensitive, and comparing one with `===` is not.
//
// CLAUDE.md states the rule - "A GitHub login is compared and indexed
// lowercased - lib/github-login.mjs, never a hand-written .toLowerCase()" -
// and nothing enforced it. Three raw `===` comparisons were live when this was
// written, each failing silently in a different way:
//
//   * scripts/get-budget-owner.mjs found no entry, printed an empty owner, and
//     weekly-usage-report.yml skips the notification on an empty one - so an
//     org over its budget was simply never told, on a green run.
//   * scripts/usage-fetch.mjs found no org entry, so `orgOverrides` stayed
//     empty and the org was measured against the GLOBAL limit instead of its
//     own. That file already carries a comment about exactly that consequence
//     arriving by another route.
//   * lib/dashboard-aggregate.mjs's caller in the SPA, fixed separately.
//
// THE LINE THIS DRAWS. A raw `===` on a login is unambiguously wrong: two real
// spellings of one account compare unequal. `a.toLowerCase() === b.toLowerCase()`
// is a different case - it is *nearly* right, differing from the shared helper
// only in that the helper also trims. acceptance/accept.mjs has nine of those
// and they were reviewed and deliberately left, so flagging them here would
// make this test something to switch off rather than something to fix. It
// catches the sharp shape only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const DIRS = ["scripts", "lib", "pages", "report", "lockdown", "acceptance", "cli/src"];

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (e.endsWith(".mjs") || e.endsWith(".js")) out.push(p);
  }
  return out;
}

test("no login is compared with a raw ===", () => {
  // `something.login === x` / `x === something.login`, and the `github_login`
  // spelling too. Anything already lowercased on both sides is out of scope,
  // and so is the helper that defines the rule.
  const patterns = [
    /\b\w+\.(github_)?login\s*===\s*(?!.*toLowerCase)/,
    /(?<!toLowerCase\(\))\s===\s*\w+\.(github_)?login\b/,
  ];

  const offenders = [];
  for (const dir of DIRS) {
    for (const file of walk(join(root, dir))) {
      const rel = relative(root, file).replace(/\\/g, "/");
      if (rel.endsWith("lib/github-login.mjs")) continue; // defines the rule
      readFileSync(file, "utf8").split("\n").forEach((line, i) => {
        if (/^\s*(\/\/|\*)/.test(line.trim())) return;
        if (/toLowerCase\(\)/.test(line)) return; // normalised, if not trimmed
        // `typeof x.github_login === "string"` is a type check, not a
        // comparison of two logins. The first draft reported one and it would
        // have been the reason somebody deleted this test.
        if (/typeof\s+[\w.?]*\.(github_)?login\s*===/.test(line)) return;
        if (patterns.some((re) => re.test(line))) {
          offenders.push(`${rel}:${i + 1} compares a login with === - use sameLogin from lib/github-login.mjs`);
        }
      });
    }
  }

  assert.deepEqual(
    offenders,
    [],
    "Two real spellings of one GitHub account compare unequal here, and every " +
      "failure it causes is silent - an org never told it is over budget, a " +
      "lecturer's raised limit that stops applying:\n  " + offenders.join("\n  "),
  );
});

test("the helper is what the fixed call sites actually use", () => {
  // A floor, so the sweep above cannot pass merely because somebody deleted the
  // comparisons rather than corrected them.
  for (const f of ["scripts/get-budget-owner.mjs", "scripts/usage-fetch.mjs"]) {
    const src = readFileSync(join(root, f), "utf8");
    assert.match(src, /sameLogin\(/, `${f} must compare through the shared helper`);
    assert.match(src, /github-login\.mjs/, `${f} must import it`);
  }
});
