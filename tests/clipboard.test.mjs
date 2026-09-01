// Copying, and whether the answer is true.
//
// THE BUG THIS FILE EXISTS FOR STOPPED PEOPLE SIGNING IN, and the guard that
// was supposed to catch it passed the whole time.
//
// DeviceFlowCard's button did:
//
//     let ok = copySync(code)
//     if (!ok && navigator.clipboard?.writeText) {
//       navigator.clipboard.writeText(code).then(() => {...}, () => {})
//       ok = true
//     }
//     copied.value = ok
//     window.open(verificationUrl, ...)
//
// `writeText` rejects on an unfocused document, `window.open` unfocuses it
// microseconds later, and the rejection went into `() => {}`. The button
// reported "Copied" over an empty clipboard, so a student had no code to paste
// into GitHub and could not sign in.
//
// tests/device-flow-clipboard.test.mjs asserted three things and all three were
// true: the copy is initiated before window.open, a synchronous path exists,
// and there is an `else toast.` branch for failure. That last assertion is the
// lesson - the branch existed and was UNREACHABLE, because `ok` had just been
// forced to true. A test that greps source text cannot tell live code from dead
// code; this file runs the thing instead.
//
// The e2e cannot cover it either, and that is documented rather than assumed:
// headless Chromium with clipboard permissions granted does not enforce the
// focus rule, so the browser test passes with the bug present.

import { test } from "node:test";
import assert from "node:assert/strict";

import { copyText, copyTextAsync, copyWithExecCommand } from "../frontend/src/lib/clipboard.js";

/** A navigator whose clipboard write resolves. */
const writes = (sink) => ({
  clipboard: { writeText: async (t) => { sink.push(t); } },
});

/** A navigator whose clipboard write rejects, as it does on an unfocused page. */
const rejects = (name = "NotAllowedError") => ({
  clipboard: {
    writeText: async () => {
      const err = new Error("Document is not focused.");
      err.name = name;
      throw err;
    },
  },
});

/** A minimal document stub for the execCommand fallback. */
function fakeDocument({ execCommandReturns = true, throwOnSelect = false } = {}) {
  const appended = [];
  const node = {
    style: {},
    value: "",
    setAttribute() {},
    select() { if (throwOnSelect) throw new Error("cannot select"); },
    setSelectionRange() {},
    remove() { node.removed = true; },
    removed: false,
  };
  return {
    node,
    appended,
    body: { appendChild: (n) => appended.push(n) },
    createElement: () => node,
    execCommand: () => execCommandReturns,
    activeElement: { focus() { node.refocused = true; } },
  };
}

// --- the property that was violated -----------------------------------------

test("a rejected clipboard write with no fallback resolves FALSE, never true", async () => {
  // The exact production failure: the async API is present, it rejects because
  // focus moved, and execCommand is unavailable. The old code returned true
  // here and the button said "Copied".
  const ok = await copyText("914F-59D8", { navigator: rejects(), document: null });
  assert.equal(ok, false, "an unverified copy must never report success");
});

test("when both paths fail the answer is false", async () => {
  const failing = fakeDocument({ execCommandReturns: false });
  assert.equal(
    await copyText("914F-59D8", { navigator: rejects(), document: failing }),
    false,
    "both paths failed, so the answer is false",
  );

  const working = fakeDocument({ execCommandReturns: true });
  assert.equal(
    await copyText("914F-59D8", { navigator: rejects(), document: working }),
    true,
    "one path worked, so the answer is true",
  );
});

test("the SYNCHRONOUS path is used first, and the async API is not spent", async () => {
  // INVERTED DELIBERATELY - this test used to assert the opposite, and the
  // opposite is what broke the button in Firefox.
  //
  // With the async API first, `execCommand` only ever ran AFTER an await, and a
  // clipboard call that follows an await is no longer attributed to the click
  // handler - so the fallback was refused in exactly the case it existed for
  // (MDN; Firefox bug 1605928). Sync-first is the only order in which the
  // fallback is reachable, and the only one in which a caller can still open a
  // window on the same gesture.
  const sink = [];
  const doc = fakeDocument({ execCommandReturns: true });
  assert.equal(await copyText("914F-59D8", { navigator: writes(sink), document: doc }), true);
  assert.equal(doc.appended.length, 1, "the synchronous path ran");
  assert.deepEqual(sink, [], "and the async API was never needed");
});

test("the async API is the fallback, and it is awaited", async () => {
  const sink = [];
  const doc = fakeDocument({ execCommandReturns: false });
  assert.equal(await copyText("914F-59D8", { navigator: writes(sink), document: doc }), true);
  assert.deepEqual(sink, ["914F-59D8"], "the text must reach the clipboard API");
});

test("copyTextAsync is the async half on its own, and never guesses", async () => {
  // Exported separately so a caller that also has to open a window can choose
  // its path with its eyes open, rather than discovering mid-await that the
  // gesture is gone.
  const sink = [];
  assert.equal(await copyTextAsync("914F-59D8", { navigator: writes(sink) }), true);
  assert.deepEqual(sink, ["914F-59D8"]);

  assert.equal(await copyTextAsync("914F-59D8", { navigator: rejects() }), false,
    "a rejected write is false, never an assumed true");
  assert.equal(await copyTextAsync("914F-59D8", { navigator: {} }), false,
    "no clipboard API is false, not a TypeError");
  assert.equal(await copyTextAsync("", { navigator: writes([]) }), false);
});

test("no clipboard API at all still copies through execCommand", async () => {
  const doc = fakeDocument({ execCommandReturns: true });
  assert.equal(await copyText("914F-59D8", { navigator: {}, document: doc }), true);
  assert.equal(doc.appended.length, 1, "the textarea was used");
  assert.equal(doc.node.removed, true, "and cleaned up");
});

test("nothing to copy is false, not a crash", async () => {
  for (const bad of ["", null, undefined, 42, {}]) {
    assert.equal(await copyText(bad, { navigator: {}, document: fakeDocument() }), false);
  }
});

// --- the fallback's own edges ------------------------------------------------

test("execCommand throwing is false, and the textarea is still removed", () => {
  const doc = fakeDocument({ throwOnSelect: true });
  assert.equal(copyWithExecCommand("x", doc), false);
  assert.equal(doc.node.removed, true, "a throw must not leave the node in the document");
});

test("a document without execCommand is false rather than a TypeError", () => {
  assert.equal(copyWithExecCommand("x", { body: {}, createElement: () => ({}) }), false);
  assert.equal(copyWithExecCommand("x", null), false);
});

test("focus is handed back to whatever had it", () => {
  // Otherwise the button the user just pressed loses its ring and a keyboard
  // user is dropped at the top of the document.
  const doc = fakeDocument();
  copyWithExecCommand("x", doc);
  assert.equal(doc.node.refocused, true);
});

test("the fallback element is laid out, not hidden off-canvas", () => {
  // `position:fixed;top:-1000px;opacity:0` was the old recipe. An element
  // outside the layout cannot reliably be selected, and a failed selection
  // makes the copy return false for a reason nobody can see.
  const doc = fakeDocument();
  copyWithExecCommand("x", doc);
  assert.match(doc.node.style.cssText, /position:fixed/);
  assert.doesNotMatch(doc.node.style.cssText, /top:-\d/, "it must not be moved off-screen");
  assert.match(doc.node.style.cssText, /background:transparent/, "it is hidden by being transparent");
});
