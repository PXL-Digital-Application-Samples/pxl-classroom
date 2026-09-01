// The device-flow card is the one surface between a student and signing in.
//
// This file used to assert three things about copyAndOpen(), and all three were
// true while the button was broken:
//
//   1. the copy is initiated BEFORE window.open      - it was
//   2. a synchronous execCommand path exists          - it did
//   3. there is an `else toast.` branch for failure   - there was
//
// (3) is the lesson. The branch existed and could never run, because the line
// above it did `ok = true` unconditionally after starting an un-awaited
// clipboard write whose rejection went into `() => {}`. window.open then
// removed focus, the write was rejected, and the button reported "Copied" over
// an empty clipboard. A student with no code to paste cannot sign in.
//
// A test that greps source text cannot tell live code from dead code - the same
// lesson tests/invitation-link-surface.test.mjs opens with. The BEHAVIOUR now
// lives in frontend/src/lib/clipboard.js and is tested by running it
// (tests/clipboard.test.mjs). What is left here is the structural half that
// cannot be unit-tested: that this card does not reintroduce the race.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const CARD = join(process.cwd(), "frontend", "src", "components", "DeviceFlowCard.vue");
const card = () => readFile(CARD, "utf8");

test("nothing steals focus while the copy is in flight", async () => {
  // window.open moves focus to the new tab, and a clipboard write on an
  // unfocused document is rejected (Chrome: "Document is not focused" -
  // reproduced in the browser 2026-09-01). The two cannot share a click, so
  // GitHub is a plain <a> now: no popup blocker, and no focus change racing the
  // write. Any window.open here brings the bug straight back.
  const src = await card();
  assert.doesNotMatch(
    src,
    /window\.open\(/,
    "Opening GitHub must be an <a href target=_blank>, not window.open - " +
      "window.open unfocuses the document and the clipboard write is then rejected",
  );
  assert.match(src, /<a[^>]*:href="verificationUrl"[^>]*target="_blank"/, "and the link must exist");
  assert.match(src, /rel="noopener/, "with noopener, as an external link");
});

test("the button reports the copy's real answer", async () => {
  const src = await card();
  const fn = src.match(/async function copyCode\(\)[\s\S]*?\n\}/)?.[0];
  assert.ok(fn, "DeviceFlowCard must define copyCode()");

  assert.match(fn, /await copyText\(/, "it must await a real answer");
  assert.match(fn, /copied\.value = ok/, "and report exactly that");
  // The specific defect: a truthy literal assigned to the success flag.
  assert.doesNotMatch(
    fn,
    /\bok\s*=\s*true\b/,
    "the success flag may never be set to a literal - that is how the button " +
      "came to say 'Copied' over an empty clipboard",
  );
});

test("the copy logic is shared, not re-implemented here", async () => {
  // Ten copy implementations across eight files when this was written, two of
  // them reporting success on failure. LESSONS.md already records this shape
  // for the invitation link; only that one had been consolidated.
  const src = await card();
  assert.match(src, /from '\.\.\/lib\/clipboard\.js'/, "it must use the shared module");
  assert.doesNotMatch(src, /execCommand\(/, "and not keep a private copy of the fallback");
  assert.doesNotMatch(src, /clipboard\.writeText\(/, "nor of the async path");
});

test("a failed copy is visible in the page, not only in a toast", async () => {
  // A toast is gone in seconds and this is the step the student is stuck on.
  // The code is also selected for them, so the manual path is one keystroke.
  const src = await card();
  assert.match(src, /v-if="copyFailed"/, "the failure must render in the card");
  assert.match(src, /role="alert"/, "and be announced");
  const fn = src.match(/async function copyCode\(\)[\s\S]*?\n\}/)?.[0];
  assert.match(fn, /copyFailed\.value = !ok/, "set from the real answer");
  assert.match(fn, /selectCode\(\)/, "and the code selected so Ctrl+C works");
});

test("the code stays selectable however the copy went", async () => {
  const src = await card();
  assert.match(src, /user-select: all/, "the code block must be selectable");
  assert.match(src, /@click="selectCode"/, "and clicking it selects the whole thing");
});
