#!/usr/bin/env node
// A git merge driver for `lockdowns/<id>/broker-reopened.json`: two publishes
// that both switched the broker on agree that it is on, so the merge is the
// mark with the LATER `reopened_at`.
//
// Every publish writes the mark (scripts/mark-broker-reopened.mjs). A lecturer
// who saved an assignment twice, fourteen seconds apart, on one whose deadline
// had passed started two publishes at once; both wrote the mark with their own
// time, and the second one's rebase stopped on it: "another writer changed the
// same file, and this commit was NOT pushed" - a red run over a publish that
// had done everything else (PXL-2TIN-CloudEssentials-2627, 2026-11-15).
//
// The later time is the answer that cannot skip a close: only `reopened_at` is
// read (scripts/find-finalizable.mjs `closeOnlyReason`,
// scripts/close-acceptance.mjs), as "on since", and a close is owed unless a
// close record is newer than it. Anything that does not parse is NOT merged:
// the driver exits 1 and git leaves the conflict, which fails the push as
// before rather than guessing.
//
// publish-assignment.yml registers it for its control checkout only, through
// `.git/info/attributes` and the checkout's own config - nothing is committed
// to the control repository.
//
//   node scripts/merge-broker-reopened.mjs <base> <current> <other>
//
// git's `%O %A %B`: the result is written to <current>.

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * The mark that stands, of two: the one with the later `reopened_at`, or null
 * when either is not a mark with a time.
 *
 * @param {string} current
 * @param {string} other
 * @returns {string|null} the winning file's text, unchanged
 */
export function laterMark(current, other) {
  const at = (text) => {
    try {
      const doc = JSON.parse(text);
      const t = Date.parse(doc?.reopened_at ?? "");
      return doc && typeof doc === "object" && Number.isFinite(t) ? t : null;
    } catch {
      return null;
    }
  };
  const a = at(current);
  const b = at(other);
  if (a === null || b === null) return null;
  return b > a ? other : current;
}

export function main(argv = process.argv.slice(2)) {
  const [, currentPath, otherPath] = argv;
  if (!currentPath || !otherPath) {
    console.error("usage: merge-broker-reopened.mjs <base> <current> <other>");
    return 1;
  }
  const winner = laterMark(readFileSync(currentPath, "utf8"), readFileSync(otherPath, "utf8"));
  if (winner === null) {
    console.error("merge-broker-reopened: a side is not a mark with a reopened_at - left as a conflict");
    return 1;
  }
  writeFileSync(currentPath, winner);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
