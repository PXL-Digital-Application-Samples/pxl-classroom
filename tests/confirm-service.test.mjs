// frontend/src/lib/confirm.js: every confirmation is asked in the page, and
// the states a page question can reach that a browser box could not are each
// decided. tests/e2e/97-confirm-dialogs.spec.mjs drives them in a browser.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { repoFiles } from "./repo-files.mjs";
// The pure rules, over a plain holder: `npm test` installs the hub's packages
// and not the SPA's, so frontend/src/lib/confirm.js (which imports Vue) cannot
// be imported here - it passed locally and failed CI. confirm.js is checked
// below to be nothing but these rules over a ref.
import { createConfirmService } from "../frontend/src/lib/confirm-state.js";

const pendingConfirm = { value: null };
const { askConfirm, answerConfirm, dismissConfirm, askDiscard, askText } = createConfirmService(pendingConfirm);

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tick = () => new Promise((r) => setImmediate(r));

test("yes and no come back as true and false, and the question is gone", async () => {
  const p = askConfirm({ title: "Remove Ann?", confirmLabel: "Remove", destructive: true });
  assert.equal(pendingConfirm.value.title, "Remove Ann?");
  assert.equal(pendingConfirm.value.destructive, true);
  answerConfirm(true);
  assert.equal(await p, true);
  assert.equal(pendingConfirm.value, null);

  const q = askConfirm({ title: "Again?", confirmLabel: "Go" });
  answerConfirm(false);
  assert.equal(await q, false);
});

test("a second question answers the open one no, and is the one on screen", async () => {
  const first = askConfirm({ title: "First?", confirmLabel: "One" });
  const second = askConfirm({ title: "Second?", confirmLabel: "Two" });
  assert.equal(await first, false, "the abandoned question is told no, not left hanging");
  assert.equal(pendingConfirm.value.title, "Second?");
  answerConfirm(true);
  assert.equal(await second, true);
});

test("a completed navigation answers an open question no", async () => {
  const p = askConfirm({ title: "Delete?", confirmLabel: "Delete", destructive: true });
  dismissConfirm();
  assert.equal(await p, false);
  assert.equal(pendingConfirm.value, null);
});

test("answering twice, or with nothing open, does nothing", async () => {
  answerConfirm(true);
  dismissConfirm();
  const p = askConfirm({ title: "Once?", confirmLabel: "Once" });
  answerConfirm(true);
  answerConfirm(false);
  assert.equal(await p, true, "the second answer did not reach a promise already settled");
  await tick();
  assert.equal(pendingConfirm.value, null);
});

test("only `true` is yes, and a question with missing parts still asks something", async () => {
  const p = askConfirm({});
  assert.equal(pendingConfirm.value.title, "Are you sure?");
  assert.equal(pendingConfirm.value.confirmLabel, "Continue");
  assert.equal(pendingConfirm.value.destructive, false);
  assert.deepEqual(pendingConfirm.value.paragraphs, []);
  answerConfirm("yes");
  assert.equal(await p, false);

  const q = askConfirm({ title: "T", confirmLabel: "C", paragraphs: ["a", "", 3, "b"], list: "x", after: null });
  assert.deepEqual(pendingConfirm.value.paragraphs, ["a", "b"]);
  assert.deepEqual(pendingConfirm.value.list, []);
  assert.deepEqual(pendingConfirm.value.after, []);
  dismissConfirm();
  await q;
});

test("discarding unsaved work is one question with one button", async () => {
  const p = askDiscard("Your changes to this assignment are not saved.");
  assert.equal(pendingConfirm.value.title, "Discard unsaved changes?");
  assert.equal(pendingConfirm.value.confirmLabel, "Discard changes");
  assert.equal(pendingConfirm.value.destructive, true);
  assert.deepEqual(pendingConfirm.value.paragraphs, ["Your changes to this assignment are not saved."]);
  dismissConfirm();
  assert.equal(await p, false);
});

test("askText resolves what was typed, trimmed; Cancel and an empty answer are both null", async () => {
  const p = askText({ title: "Clear?", inputLabel: "Username", value: "  alice-gh ", confirmLabel: "Clear" });
  assert.equal(pendingConfirm.value.input.label, "Username");
  assert.equal(pendingConfirm.value.input.value, "  alice-gh ");
  answerConfirm(true);
  assert.equal(await p, "alice-gh");

  const typed = askText({ title: "Clear?", inputLabel: "Username", value: "" });
  pendingConfirm.value.input.value = "bob";
  answerConfirm(true);
  assert.equal(await typed, "bob", "the answer is read when it is given, not when it was asked");

  const cancelled = askText({ title: "Clear?", inputLabel: "Username", value: "carol" });
  answerConfirm(false);
  assert.equal(await cancelled, null);

  const blank = askText({ title: "Clear?", inputLabel: "Username", value: "   " });
  answerConfirm(true);
  assert.equal(await blank, null);

  const replaced = askText({ title: "One?", inputLabel: "U", value: "x" });
  const next = askConfirm({ title: "Two?", confirmLabel: "Two" });
  assert.equal(await replaced, null, "a newer question cancels a text question too");
  dismissConfirm();
  await next;
});

test("the SPA asks nothing through window.confirm, prompt or alert any more", () => {
  const offenders = [];
  for (const file of repoFiles({ under: "frontend/src", exts: [".vue", ".js", ".mjs"] })) {
    const rel = relative(root, file).replace(/\\/g, "/");
    if (!rel.startsWith("frontend/src/") || !/\.(vue|js|mjs)$/.test(rel)) continue;
    const code = readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/<!--[\s\S]*?-->/g, "");
    if (/\b(?:window\.)?(?:confirm|prompt|alert)\s*\(/.test(code.replace(/askConfirm|answerConfirm|dismissConfirm|emit\('confirm'\)/g, ""))) {
      offenders.push(rel);
    }
  }
  assert.deepEqual(offenders, [], "ask through lib/confirm.js askConfirm, which says what the button does");
});

test("confirm.js is these rules over a ref, and nothing else", () => {
  // The tests above run lib/confirm-state.js; the app imports confirm.js. If
  // confirm.js grew its own logic, the tests would be testing something the
  // app does not run.
  const src = readFileSync(join(root, "frontend", "src", "lib", "confirm.js"), "utf8")
    .replace(/^\s*\/\/.*$/gm, "")
    .trim();
  assert.match(src, /createConfirmService\(pendingConfirm\)/);
  assert.doesNotMatch(src, /\bfunction\b|=>/, "no logic of its own");
});
