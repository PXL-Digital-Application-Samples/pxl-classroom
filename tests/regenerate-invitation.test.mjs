// `regenerate_invite` retires every link already handed out. It was an input on
// publish-assignment.yml, documented in three places, and nothing in the SPA or
// the CLI ever sent it - so a lecturer whose link leaked had no in-app way to
// rotate it, only the raw Actions tab.
//
// And rotating from there made things worse: verifyLiveInfrastructure only
// re-read the token when the form had none, so the panel went on showing and
// copying the OLD link, which the broker now rejects as `superseded`. Silent,
// and worse than having no button.
//
// This file pins the wiring, the default (republish must NOT rotate), and the
// DESIGN.md constraints on the control itself.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const ADMIN = readFileSync(join(root, "frontend", "src", "views", "AdminView.vue"), "utf8");
const STYLE = readFileSync(join(root, "frontend", "src", "style.css"), "utf8");
// The dialog is its own component now. Its markup, its `regenerate` tick and
// the styles for both moved together - a scoped rule left behind in the parent
// cannot reach a child's DOM, so they had to.
const MODAL_FILE = join(root, "frontend", "src", "components", "RepublishBrokerModal.vue");
const MODAL_SRC = readFileSync(MODAL_FILE, "utf8");

/** The republish modal's markup, comments stripped. */
function modal() {
  const end = MODAL_SRC.indexOf("</template>");
  assert.ok(end > -1, "RepublishBrokerModal must still be a single-file component");
  // Comments explain the class choices, so counting classes without stripping
  // them counts the explanation as a usage.
  return MODAL_SRC.slice(0, end).replace(/<!--[\s\S]*?-->/g, "");
}

/** The modal's scoped style block. */
function modalStyle() {
  const at = MODAL_SRC.search(/<style\b/);
  assert.ok(at > -1, "RepublishBrokerModal must carry the styles that moved with it");
  return MODAL_SRC.slice(at);
}

// --- The wiring -------------------------------------------------------------

test("the workflow still accepts the input the UI now sends", () => {
  const doc = parse(readFileSync(join(root, ".github", "workflows", "publish-assignment.yml"), "utf8"));
  assert.ok(doc.on.workflow_dispatch.inputs.regenerate_invite, "publish-assignment.yml must take it");
});

test("publishExisting forwards the flag", () => {
  const fn = ADMIN.slice(ADMIN.indexOf("async function publishExisting"));
  const body = fn.slice(0, fn.indexOf("\n}") + 2);
  assert.match(body, /regenerate_invite:/, "the dispatch must carry regenerate_invite");
  // workflow_dispatch inputs cross the REST API as strings; sending a raw
  // boolean makes GitHub reject the dispatch with a validation error.
  assert.match(body, /regenerate \? 'true' : 'false'/, "and as a string, not a boolean");
});

test("the modal offers it, and the confirm passes what was chosen", () => {
  // The tick belongs to the dialog: it is a question that only exists while the
  // dialog is open, and it used to be a ref on the view that outlived every
  // cancel and had to be reset by hand in two places.
  assert.match(modal(), /v-model="regenerate"/, "the modal must offer the choice");
  assert.match(modal(), /emit\('confirm', regenerate\)/, "and hand it back on confirm");

  const fn = ADMIN.slice(ADMIN.indexOf("async function confirmRepublish"));
  const body = fn.slice(0, fn.indexOf("\n}") + 2);
  assert.match(body, /confirmRepublish\(regenerate\)/, "the view takes it from the event");
  assert.match(body, /publishExisting\(\{ regenerate \}\)/, "and forwards exactly that");
});

// --- The default: a repair must not break links -----------------------------

test("opening the modal always starts with regeneration off", () => {
  // Republish is a repair operation. It must not silently invalidate an
  // assignment's link the day before a deadline because a checkbox was sticky.
  const fn = ADMIN.slice(ADMIN.indexOf("function handlePublishClick"));
  const body = fn.slice(0, fn.indexOf("\n}") + 2);
  assert.match(body, /regenerateInvite\.value = false/, "the choice must be reset each time");

  const decl = ADMIN.match(/const regenerateInvite = ref\((\w+)\)/);
  assert.ok(decl, "regenerateInvite must exist");
  assert.equal(decl[1], "false", "and default to off");
});

test("a rotation clears the stale token so nothing can copy the dead link", () => {
  const fn = ADMIN.slice(ADMIN.indexOf("async function confirmRepublish"));
  const body = fn.slice(0, fn.indexOf("\n}") + 2);
  assert.match(body, /form\.value\.invite_token = ''/, "the old token must not stay copyable");
});

test("the non-regenerating path is still reachable and unchanged", () => {
  // Every other caller of publishExisting - first publish, the incomplete-setup
  // recovery button - must keep reusing the invitation.
  const calls = [...ADMIN.matchAll(/(?<!function )publishExisting\(([^)]*)\)/g)].map((m) => m[1].trim());
  assert.ok(calls.length >= 3, `expected several call sites, got ${calls.length}`);
  const regenerating = calls.filter((a) => a.includes("regenerate"));
  assert.equal(regenerating.length, 1, `exactly one call site may ask to rotate: ${JSON.stringify(calls)}`);
});

// --- DESIGN.md conformity ---------------------------------------------------

test("DESIGN.md §1.2 - the modal has exactly one solid button", () => {
  // "A modal counts as its own view." Cancel is neutral; the confirm is the one
  // solid action, and it spells itself .btn-danger only when it is destructive.
  const m = modal();
  const primaries = (m.match(/btn-primary/g) || []).length;
  const dangers = (m.match(/btn-danger\b/g) || []).length;
  assert.equal(primaries, 1, "one .btn-primary");
  assert.equal(dangers, 1, "and one .btn-danger, on the same button");
  assert.match(
    m,
    /regenerate \? 'btn-danger' : 'btn-primary'/,
    "they must be the two states of one button, not two buttons"
  );
});

test("DESIGN.md §3 - only the four declared variants are used", () => {
  // btn-warning was used seven times across two components and declared
  // nowhere: not in style.css, not in any scoped block. It rendered as a plain
  // .btn, and a test that read the template rather than the CSS passed anyway.
  const used = new Set([...ADMIN.matchAll(/\bbtn-([a-z-]+)\b/g)].map((m) => `btn-${m[1]}`));
  const sizeAndShape = new Set(["btn-sm", "btn-xs", "btn-lg", "btn-icon", "btn-with-icon", "btn-link"]);
  for (const cls of used) {
    if (sizeAndShape.has(cls)) continue;
    const declaredGlobally = new RegExp(`^\\.${cls}\\b`, "m").test(STYLE);
    const declaredLocally = new RegExp(`^\\.${cls}\\b`, "m").test(ADMIN.slice(ADMIN.search(/<style\b/)));
    assert.ok(
      declaredGlobally || declaredLocally,
      `.${cls} is used but declared nowhere - it renders as a plain .btn`
    );
  }
  assert.ok(!used.has("btn-warning"), "btn-warning is not a §3 variant");
});

test("DESIGN.md §1.1 - the new control is a tonal step, not a third box", () => {
  // The modal outlines itself, and its alerts are bordered. A bordered control
  // inside one of those is the box prison §1.1 names. --bg-inset is the
  // recessed step that differs in BOTH themes.
  const style = modalStyle();
  const rule = style.slice(style.indexOf(".regen-choice {"), style.indexOf("}", style.indexOf(".regen-choice {")));
  assert.ok(rule, ".regen-choice must be styled");
  assert.match(rule, /background: var\(--bg-inset\)/, "a tonal step");
  assert.ok(!/border:/.test(rule), "and no border - that would be the third box");
});

test("DESIGN.md §2/§5 - the control introduces no colour literal and no dead fallback", () => {
  const style = modalStyle();
  const added = style.slice(style.indexOf(".alert-danger {"));
  assert.ok(!/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(added), "no colour literal outside :root");
  assert.ok(!/var\(--[\w-]+,\s*[^)]+\)/.test(added), "no var() fallbacks - they pin one theme");
});

test("every token the new styles reference actually resolves", () => {
  // Undefined custom properties fail SILENTLY: border-color falls back to
  // currentColor, background to transparent, box-shadow to none.
  const style = modalStyle();
  const added = style.slice(style.indexOf(".alert-danger {"));
  for (const m of added.matchAll(/var\((--[\w-]+)\)/g)) {
    assert.ok(STYLE.includes(`${m[1]}:`), `${m[1]} is used but not defined in style.css`);
  }
});

// --- The consequence is stated, not implied ---------------------------------

test("ticking the box says what it will do", () => {
  const m = modal();
  assert.match(m, /Every link already handed out stops working/i, "the consequence must be explicit");
  assert.match(m, /v-if="regenerate"/, "and shown only when it applies");
  assert.match(m, /Republish and retire the old link/, "the button must say it too");
});
