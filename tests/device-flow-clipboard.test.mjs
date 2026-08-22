import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// window.open() moves focus to the new tab, and a clipboard write on an
// unfocused document is rejected (Chrome: "Document is not focused"). Opening
// first therefore leaves the clipboard EMPTY while the button still reports
// success - which is exactly what happened in live testing.
//
// This is a source-order test on purpose. Headless Chromium with clipboard
// permissions granted does not enforce the focus rule, so an e2e passes with
// either order and cannot catch the regression. Verified: reintroducing the
// old order still passed the browser test.

const CARD = join(process.cwd(), "frontend", "src", "components", "DeviceFlowCard.vue");

test("device flow: the code is copied BEFORE the tab steals focus", async () => {
  const src = await readFile(CARD, "utf8");
  const fn = src.match(/function copyAndOpen\(\)[\s\S]*?\n\}/)?.[0];
  assert.ok(fn, "DeviceFlowCard must define copyAndOpen()");

  const copyAt = Math.min(
    ...[/copySync\(/, /clipboard\??\.?\s*\.?writeText\(/]
      .map((re) => { const m = fn.search(re); return m === -1 ? Infinity : m; }),
  );
  const openAt = fn.search(/window\.open\(/);

  assert.ok(copyAt !== Infinity, "copyAndOpen must copy the code");
  assert.ok(openAt !== -1, "copyAndOpen must open the verification page");
  assert.ok(
    copyAt < openAt,
    "The copy must be initiated BEFORE window.open. Opening first moves focus " +
      "to the new tab and the clipboard write is rejected, leaving the user " +
      "with an empty clipboard and a button claiming it worked.",
  );
});

test("device flow: copying does not depend solely on the async clipboard API", async () => {
  const src = await readFile(CARD, "utf8");
  assert.match(
    src,
    /document\.execCommand\(['"]copy['"]\)/,
    "Keep a synchronous copy path. navigator.clipboard.writeText resolves " +
      "asynchronously, so its permission check can land after focus has moved; " +
      "the synchronous fallback completes while the document is still focused.",
  );
});

test("device flow: the user is told when copying failed", async () => {
  const src = await readFile(CARD, "utf8");
  const fn = src.match(/function copyAndOpen\(\)[\s\S]*?\n\}/)?.[0];
  assert.match(
    fn,
    /else\s+toast\./,
    "A failed copy must say so. Reporting success while the clipboard is empty " +
      "is worse than not offering the button at all.",
  );
});
