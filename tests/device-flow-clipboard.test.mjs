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
// THEN IT BROKE A SECOND TIME, in the opposite direction, and this file passed
// again. The fix for (3) was `const ok = await copyText(code)` before the open
// - which is honest, and which put an `await` between the click and everything
// after it. Engines stop attributing a clipboard call, and a window.open, to
// the handler once one has intervened (MDN; Firefox bug 1605928, "writeText()
// does not work in asynchronous environments"). Chrome is forgiving enough that
// it kept working there; Firefox is not, and the button stopped copying. The
// execCommand fallback inside copyText was by then unreachable too - after the
// await it is refused for the same reason the async write was.
//
// So the property this file now guards is the STRUCTURAL one that a unit test
// cannot see and that both regressions violated: copyAndOpen() must not yield
// before it copies and opens. The behaviour of the copy itself lives in
// frontend/src/lib/clipboard.js and is tested by running it
// (tests/clipboard.test.mjs).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const CARD = join(process.cwd(), "frontend", "src", "components", "DeviceFlowCard.vue");
const card = () => readFile(CARD, "utf8");

/** The body of a top-level function in the card's <script setup>. */
function body(src, name) {
  const m = src.match(new RegExp(`\\nfunction ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
  return m?.[0];
}

test("copyAndOpen does not yield before it copies and opens", async () => {
  // THE REGRESSION THIS FILE EXISTS FOR, second edition. An `await` anywhere on
  // this path spends the click's user activation: the clipboard call after it
  // is no longer attributed to the handler, and neither is window.open. That is
  // what stopped the button working in Firefox while it still worked in Chrome.
  const src = await card();
  const fn = body(src, "copyAndOpen");
  assert.ok(fn, "DeviceFlowCard must define a non-async copyAndOpen()");

  assert.doesNotMatch(
    src,
    /async function copyAndOpen\b/,
    "copyAndOpen must not be async - the fast path has to run to completion " +
      "inside the click's user activation",
  );
  assert.doesNotMatch(
    fn,
    /\bawait\b/,
    "no await in copyAndOpen. After one, the engine stops attributing the " +
      "clipboard write AND the window.open to the click, so the copy is " +
      "refused (Firefox) and the pop-up is blocked.",
  );
});

test("the synchronous copy leads, and its answer is known before the open", async () => {
  const src = await card();
  const fn = body(src, "copyAndOpen");

  const syncAt = fn.indexOf("copyWithExecCommand(");
  const openAt = fn.indexOf("openGitHub()");
  assert.ok(syncAt > -1, "the synchronous path must be tried first");
  assert.ok(openAt > -1, "and the same click must still open GitHub");
  assert.ok(syncAt < openAt, "the copy must be settled before anything moves focus");

  // The slow path is allowed to be async - it is the case where the sync path
  // was unavailable - but the window must stay shut until the write settles.
  // Opening it is exactly what makes an in-flight write reject.
  assert.match(
    fn,
    /copyTextAsync\(code\)\.then\(\(ok\) => \{[\s\S]*?openGitHub\(\)/,
    "on the async fallback, openGitHub must be inside .then - never before it",
  );
});

test("the button reports the copy's real answer", async () => {
  const src = await card();
  const fn = body(src, "reportCopy");
  assert.ok(fn, "DeviceFlowCard must define reportCopy()");

  assert.match(fn, /copied\.value = ok/, "it must report exactly what it was told");
  assert.match(fn, /copyFailed\.value = !ok/, "set from the real answer");
  // The original defect: a truthy literal assigned to the success flag.
  assert.doesNotMatch(
    src,
    /\bok\s*=\s*true\b/,
    "the success flag may never be set to a literal - that is how the button " +
      "came to say 'Copied' over an empty clipboard",
  );
  // And nothing may report success without having been handed an answer.
  assert.doesNotMatch(
    src,
    /reportCopy\(true\)(?![\s\S]{0,40}openGitHub)/,
    "reportCopy(true) is only legitimate immediately after a synchronous copy " +
      "returned true",
  );
});

test("a blocked pop-up is reported only when it was actually blocked", async () => {
  // `noopener` in the FEATURES string makes window.open return null even on
  // success, so `if (!win) toast('Allow pop-ups')` fired on every single click.
  // Nulling `opener` on the returned window keeps the security property and
  // leaves null meaning blocked.
  const src = await card();
  const fn = body(src, "openGitHub");
  assert.ok(fn, "DeviceFlowCard must define openGitHub()");
  assert.doesNotMatch(
    fn,
    /window\.open\([^)]*noopener/,
    "noopener in the features string makes the return value always null",
  );
  assert.match(fn, /win\.opener = null/, "so the opener is nulled on the window instead");
});

test("the copy logic is shared, not re-implemented here", async () => {
  // Ten copy implementations across eight files when this was written, two of
  // them reporting success on failure. LESSONS.md already records this shape
  // for the invitation link; only that one had been consolidated.
  //
  // Calling the shared `copyWithExecCommand` is the point - what may not appear
  // is a private copy of either mechanism, which is why these match on the
  // RECEIVER rather than on the bare method name.
  const src = await card();
  assert.match(src, /from '\.\.\/lib\/clipboard\.js'/, "it must use the shared module");
  assert.doesNotMatch(
    src,
    /(document|doc)\.execCommand\(/,
    "no private copy of the synchronous fallback",
  );
  assert.doesNotMatch(src, /clipboard\.writeText\(/, "nor of the async path");
});

test("a failed copy is visible in the page, not only in a toast", async () => {
  // A toast is gone in seconds and this is the step the student is stuck on.
  // The code is also selected for them, so the manual path is one keystroke.
  const src = await card();
  assert.match(src, /v-if="copyFailed"/, "the failure must render in the card");
  assert.match(src, /role="alert"/, "and be announced");
  const fn = body(src, "reportCopy");
  assert.match(fn, /selectCode\(\)/, "and the code selected so Ctrl+C works");
});

test("the code stays selectable however the copy went", async () => {
  const src = await card();
  assert.match(src, /user-select: all/, "the code block must be selectable");
  assert.match(src, /@click="selectCode"/, "and clicking it selects the whole thing");
});

test("the copy button is the card's primary action", async () => {
  // While the card is up the sign-in button is v-if'd out, so this is the only
  // call to action on the view - DESIGN.md §1.2's one primary, and §3's
  // "single decisive action" for the size. It is deliberately NOT btn-success:
  // green is reserved for the student's accepted state, and a button that is
  // green before it has done anything claims an outcome it has not reached.
  const src = await card();
  const button = src.match(/<button[^>]*@click="copyAndOpen"[^>]*>/)?.[0];
  assert.ok(button, "the card must have a copy button");
  assert.match(button, /\bbtn-primary\b/, "it is the view's one primary action");
  assert.match(button, /\bbtn-lg\b/, "at the decisive-action size");
  assert.doesNotMatch(button, /\bbtn-success\b/, "green is the accepted state, not this");
});
