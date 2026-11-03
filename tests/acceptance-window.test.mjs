// lib/acceptance-window.mjs - the one judge of whether an assignment takes a
// new acceptance now, and the sweep that finds a reader spelling it by hand.
//
// `accepts_until` (2026-11-03) is the third date of the window: the invitation
// closes a week in, the work is due a week later. Before it the window was
// spelled by hand in ten places, and the way a third date goes wrong is one
// of them not learning it - a page that offers Accept where the hub refuses,
// which no save heals. So every reader asks the function below, and this
// file fails on one that compares the dates itself. The count was nine until
// a cold review found the tenth (the dashboard's own organization light): a
// hand-written list of readers is how one is missed, so the negative half is
// a sweep of every source file, and the list is only the positive half.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { ACCEPTANCE_PHASES, acceptanceClosesAt, acceptanceWindow, isAccepting, scheduledWindow } from "../lib/acceptance-window.mjs";
import { assignmentStatus } from "../frontend/src/lib/status-labels.js";
import { teamSwitchWindow } from "../frontend/src/lib/team-switch.js";
import { repoFiles } from "./repo-files.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

const NOW = Date.parse("2026-11-16T12:00:00Z");
const at = (h) => new Date(NOW + h * 3600_000).toISOString();
const published = (over = {}) => ({ state: "published", opens_at: at(-24 * 7), deadline_at: at(24 * 7), ...over });

test("the phases, in the order the dates come", () => {
  assert.deepEqual(acceptanceWindow(published(), NOW), { phase: "accepting", at: at(24 * 7) });
  assert.deepEqual(acceptanceWindow(published({ opens_at: at(1) }), NOW), { phase: "not-open", at: at(1) });
  assert.deepEqual(acceptanceWindow(published({ deadline_at: at(-1) }), NOW), { phase: "deadline-passed", at: at(-1) });
  // The acceptance deadline: passed, with the work still due.
  assert.deepEqual(acceptanceWindow(published({ accepts_until: at(-1) }), NOW), { phase: "acceptance-closed", at: at(-1) });
  // Ahead: accepting, and `at` says until when.
  assert.deepEqual(acceptanceWindow(published({ accepts_until: at(2) }), NOW), { phase: "accepting", at: at(2) });
  // Past both, the deadline is the answer: it is the one with a lock behind it.
  assert.deepEqual(acceptanceWindow(published({ accepts_until: at(-3), deadline_at: at(-1) }), NOW).phase, "deadline-passed");
  // Not open yet outranks everything: nothing has happened.
  assert.equal(acceptanceWindow(published({ opens_at: at(1), accepts_until: at(-1) }), NOW).phase, "not-open");
});

test("absent means the deadline, and every assignment from before the field keeps its one window", () => {
  const before = { state: "published", opens_at: at(-2), deadline_at: at(2) };
  assert.equal(acceptanceWindow(before, NOW).phase, "accepting");
  assert.equal(acceptanceWindow(before, NOW + 3 * 3600_000).phase, "deadline-passed");
  assert.equal(acceptanceClosesAt(before), before.deadline_at);
  assert.equal(acceptanceClosesAt({ state: "published" }), null);
  assert.deepEqual(acceptanceWindow({ state: "published" }, NOW), { phase: "accepting", at: null }, "no dates: accepting, nothing closes it");
});

test("the instant itself still accepts, as the hub always compared", () => {
  const a = published({ opens_at: at(0), accepts_until: at(0), deadline_at: at(0) });
  assert.equal(acceptanceWindow(a, NOW).phase, "accepting");
  assert.equal(acceptanceWindow(a, NOW + 1).phase, "deadline-passed");
  assert.equal(acceptanceWindow(a, NOW - 1).phase, "not-open");
  assert.equal(acceptanceWindow(published({ accepts_until: at(0) }), NOW + 1).phase, "acceptance-closed");
});

test("a Date is as good as a number, and an unreadable date is absent, never a refusal", () => {
  assert.equal(acceptanceWindow(published({ accepts_until: at(-1) }), new Date(NOW)).phase, "acceptance-closed");
  // The editor refuses to save one; a hand-edited YAML with `deadline_at: soon`
  // must not become an assignment nobody can accept with nothing saying why.
  assert.equal(acceptanceWindow(published({ accepts_until: "soon" }), NOW).phase, "accepting");
  assert.equal(acceptanceWindow(published({ accepts_until: "" }), NOW).phase, "accepting");
  assert.equal(acceptanceWindow(published({ accepts_until: 7 }), NOW).phase, "accepting");
  assert.equal(acceptanceClosesAt(published({ accepts_until: "soon" })), at(24 * 7));
});

test("an acceptance deadline after the deadline is never reached: the deadline closes first", () => {
  const a = published({ accepts_until: at(24 * 8) });
  assert.equal(acceptanceClosesAt(a), a.deadline_at);
  assert.deepEqual(acceptanceWindow(a, NOW), { phase: "accepting", at: a.deadline_at });
  assert.equal(acceptanceWindow(a, NOW + 24 * 7.5 * 3600_000).phase, "deadline-passed");
});

test("anything but published is not accepting, whatever the dates say - and the dates still answer for themselves", () => {
  for (const state of ["draft", "closed", "archived", undefined, null, "garbage"]) {
    assert.deepEqual(acceptanceWindow(published({ state }), NOW), { phase: "not-published", at: null }, String(state));
    assert.equal(isAccepting(published({ state }), NOW), false);
    // THE DEFECT THE FIRST VERSION HAD (e2e 119, 2026-11-03): the state button
    // of a CLOSED assignment asked the state-aware judge whether its
    // acceptance deadline had passed, was told "not published", and offered
    // Reopen over a date the hub would refuse. The schedule is its own question.
    assert.equal(scheduledWindow(published({ state, accepts_until: at(-1) }), NOW).phase, "acceptance-closed", `${state}: the dates still say`);
    assert.equal(scheduledWindow(published({ state, deadline_at: at(-1) }), NOW).phase, "deadline-passed");
    assert.equal(scheduledWindow(published({ state }), NOW).phase, "accepting");
  }
  assert.deepEqual(scheduledWindow(published(), NOW), acceptanceWindow(published(), NOW), "published: one answer");
  assert.equal(scheduledWindow(null, NOW).phase, "accepting", "no dates at all close nothing");
  assert.equal(acceptanceWindow(null, NOW).phase, "not-published");
  assert.equal(isAccepting(published(), NOW), true);
  assert.equal(isAccepting(published({ accepts_until: at(-1) }), NOW), false);
  assert.deepEqual([...ACCEPTANCE_PHASES].sort(), ["acceptance-closed", "accepting", "deadline-passed", "not-open", "not-published"]);
});

test("the label and the team switch follow the judge", () => {
  assert.deepEqual(assignmentStatus(published({ accepts_until: at(-1) }), NOW), { label: "Acceptance closed", accepting: false });
  assert.deepEqual(assignmentStatus(published({ accepts_until: at(1) }), NOW), { label: "Accepting", accepting: true });
  // A switch is an acceptance: closed by the acceptance deadline, until then named.
  assert.deepEqual(teamSwitchWindow({ canChooseAnother: true, assignment: published({ accepts_until: at(1) }), now: NOW }), { can: true, until: at(1) });
  assert.equal(teamSwitchWindow({ canChooseAnother: true, assignment: published({ accepts_until: at(-1) }), now: NOW }).can, false);
});

test("every reader asks the judge", () => {
  // The positive half: each surface that says whether a student can accept
  // asks the function, with the clock it has. The lecturer's surfaces ask the
  // DATES whatever the state (a closed assignment's menu, the Retry dialog,
  // the student's actions dialog): `scheduledWindow`.
  const readers = {
    "acceptance/accept.mjs": /const gate = acceptanceWindow\(assignment, now\)/,
    "frontend/src/lib/status-labels.js": /acceptanceWindow\(assignment, now\)/,
    "frontend/src/lib/team-switch.js": /acceptanceWindow\(assignment, now\)\.phase === 'accepting'/,
    "frontend/src/lib/org-session.js": /isAccepting\(a, now\)/,
    "frontend/src/views/DashboardView.vue": /isAccepting\(a, now\)/,
    "frontend/src/views/AssignmentView.vue": /acceptanceWindow\(assignment\.value, now\.value\)\.phase/,
    "frontend/src/components/GroupAcceptanceCard.vue": /acceptanceWindow\(props\.assignment, nowTick\.value\)\.phase/,
    "frontend/src/components/InvitationShare.vue": /acceptanceWindow\(a, now\)/,
    "frontend/src/components/StudentDiagnosticsModal.vue": /acceptanceWindow\(props\.assignment\)\.phase/,
    "frontend/src/components/AssignmentHeader.vue": /scheduledWindow\(props\.assignment, nowMs\.value\)\.phase === 'acceptance-closed'/,
    "frontend/src/views/AssignmentDetailView.vue": /scheduledWindow\(assignment\.value/,
  };
  for (const [file, call] of Object.entries(readers)) {
    assert.match(read(file), call, `${file} no longer asks lib/acceptance-window.mjs`);
  }
  const hub = read("acceptance/accept.mjs");
  assert.match(hub, /"rejected:acceptance-closed"/, "the hub no longer refuses after the acceptance deadline");
  assert.match(hub, /acceptanceClosesAt\(assignment\)/, "the hub's grace no longer runs from the date that closed acceptance");
});

test("no source spells the window by hand (a sweep, not a list)", () => {
  // The negative half, over every source file git tracks (tests/repo-files.mjs),
  // because the list above is how a reader gets missed.
  //
  // Two rules. `opens_at` and `accepts_until` have NO question but the window,
  // so any parse or comparison of either outside the judge is a fork - except
  // a display (formatDate(a.opens_at) is no parse) and the editor's boxes,
  // which hold `_local` copies the `\b` below does not match. `deadline_at`
  // answers other questions too (the lock, grading, a student's own deadline,
  // the confirm link's lifetime), so for it only a clock compared with the
  // field inline is matched; a comparison through a variable is not seen,
  // which is stated here rather than pretended otherwise.
  //
  // Exhaustive, not comparative: the matches must EQUAL the allow-list, so a
  // legitimate match needs its reason here and a stale reason fails too.
  // `(?<!=)` keeps an arrow function's `=> a.accepts_until` out of it.
  const windowOnly = /(?:new Date|Date\.parse)\(\s*[\w.?$]*\.(?:opens_at|accepts_until)\b|[\w.?$]*\.(?:opens_at|accepts_until)\b\s*[<>]=?|(?<!=)[<>]=?\s*[\w.?$]*\.(?:opens_at|accepts_until)\b/;
  const clock = String.raw`(?:\bnow\b|\bnow\.value\b|Date\.now\(\)|new Date\(\)|\bnowMs(?:\.value)?\b|\bnowTick(?:\.value)?\b|\bt\b)`;
  const deadlineInline = new RegExp(
    `${clock}\\s*[<>]=?\\s*(?:new Date\\(|Date\\.parse\\()?\\s*[\\w.?$]*\\.deadline_at\\b|[\\w.?$]*\\.deadline_at\\b\\)?(?:\\.getTime\\(\\))?\\s*[<>]=?\\s*${clock}`,
  );
  const ALLOWED = {
    "frontend/src/views/AdminView.vue": "the editor's cross-field validation compares the three dates with each other, never with a clock",
  };
  const judge = join(root, "lib", "acceptance-window.mjs");
  const files = repoFiles({ under: ["frontend/src", "lib", "scripts", "acceptance", "pages", "cli"], exts: [".mjs", ".js", ".vue"] })
    .filter((f) => f !== judge && !f.includes(`${join("cli", "tests")}${"\\"}`) && !f.includes(`${join("cli", "tests")}/`));
  assert.ok(files.length > 100, `the sweep saw only ${files.length} files`);
  const found = {};
  for (const abs of files) {
    const src = readFileSync(abs, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/<!--[\s\S]*?-->/g, "");
    const hits = [];
    for (const line of src.split("\n")) {
      if (windowOnly.test(line) || deadlineInline.test(line)) hits.push(line.trim());
    }
    if (hits.length) found[relative(root, abs).replace(/\\/g, "/")] = hits;
  }
  assert.deepEqual(
    Object.keys(found).sort(),
    Object.keys(ALLOWED).sort(),
    "these files compare a clock with a date of the window, or read opens_at/accepts_until, outside lib/acceptance-window.mjs:\n" +
      Object.entries(found).map(([f, hits]) => `  ${f}\n${hits.map((h) => `      ${h}`).join("\n")}`).join("\n"),
  );
  // The editor's matches are what the reason says: dates against dates.
  for (const hit of found["frontend/src/views/AdminView.vue"] || []) {
    assert.match(hit, /new Date\(doc\.\w+\) [<>]=? new Date\(doc\.\w+\)/, `AdminView: not a cross-field check: ${hit}`);
  }
});
