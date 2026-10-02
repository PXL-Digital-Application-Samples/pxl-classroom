// "Grade" starts a grading run on GitHub; "read" reads results that exist.
//
// The cohort action said "Re-grade all 23" and started no run at all: it read
// the results of runs that had already happened and applied the rules again. A
// lecturer reads "re-grade" as "run the tests again", and in a setup where no
// run can be started that is a promise the button cannot keep (DESIGN.md
// §1.5). Renamed on 2026-10-02 - "Read all scores again", "Choose the commit
// that counts", and "Start a grading run on this commit" / "Re-run its grading
// on GitHub" for the two actions that really do start one. This holds the
// distinction: no text a lecturer can see says "re-grade".
//
// Code identifiers (`regradePanel`, `@regrade`) and comments are not text a
// lecturer sees, so the sweep looks for the capitalised word, with comments
// removed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { repoFiles } from "./repo-files.mjs";

const ROOT = new URL("..", import.meta.url);

function withoutComments(src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

test("no visible text says re-grade - a read is called a read", () => {
  const files = repoFiles({ under: ["frontend/src", "lib", "scripts"], exts: [".vue", ".js", ".mjs"] });
  assert.ok(files.length > 100, `expected the sources, found ${files.length}`);
  const offenders = [];
  for (const file of files) {
    withoutComments(readFileSync(file, "utf8")).split("\n").forEach((line, i) => {
      if (/\bRe-grade\b|\bRegrad(e|ing)\b/.test(line)) {
        offenders.push(`${relative(ROOT.pathname.replace(/^\/([A-Za-z]:)/, "$1"), file)}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(offenders, []);
});
