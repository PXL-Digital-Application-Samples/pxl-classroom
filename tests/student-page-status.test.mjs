// frontend/src/lib/student-page-status.js and lib/student-card.mjs: do students
// see what is saved - worked out from facts, so a refresh says the same.

import { test } from "node:test";
import assert from "node:assert/strict";
import { cardDifferences, studentCard } from "../lib/student-card.mjs";
import { studentPageBarText, studentPageLine, studentPageStatus, studentPageSteps, STUCK_MINUTES } from "../frontend/src/lib/student-page-status.js";

const TZ = "Europe/Brussels";
const doc = (over = {}) => ({
  id: "pe1", organization: "O", title: "PE1", state: "published", roster_mode: "open",
  opens_at: "2026-10-08T07:25:00.000Z", deadline_at: "2026-10-12T20:30:00.000Z", ...over,
});
const card = (over) => studentCard(doc(over), { timezone: TZ, acceptedCount: 3 });
const T = Date.parse("2026-10-08T09:00:00Z");
const min = (m) => T - m * 60_000;

test("the card the saved document makes is compared field by field, the acceptance count never", () => {
  assert.deepEqual(cardDifferences(card(), { ...card(), accepted_count: 40 }), []);
  const d = cardDifferences(card({ deadline_at: "2026-10-14T20:30:00.000Z" }), card());
  assert.deepEqual(d.map((x) => [x.key, x.label, x.saved, x.served]), [["deadline_at", "deadline", "2026-10-14T20:30:00.000Z", "2026-10-12T20:30:00.000Z"]]);
  // Omitted on the wire and undefined in the builder are the same answer.
  const served = JSON.parse(JSON.stringify(card()));
  assert.deepEqual(cardDifferences(card(), served), []);
});

test("students see what is saved: current, and nothing to say anywhere else", () => {
  const s = studentPageStatus({ saved: card(), served: { status: "ok", card: card() }, since: min(30), deploy: null, now: T });
  assert.equal(s.state, "current");
  assert.equal(studentPageLine(s), "");
  assert.equal(studentPageBarText(s), "");
});

test("just saved, the site not updated yet: updating, and the header says which step and how long", () => {
  const s = studentPageStatus({
    saved: card({ deadline_at: "2026-10-14T20:30:00.000Z" }), served: { status: "ok", card: card() },
    since: min(2), deploy: { status: "in_progress", html_url: "https://x/1" }, now: T,
  });
  assert.equal(s.state, "updating");
  assert.equal(s.site, "running");
  assert.equal(studentPageLine(s), "Students still see the version before your last save: updating the student site (2 min so far; usually 3 to 4 minutes).");
  assert.equal(studentPageBarText(s), "Updating the student page, step 2 of 3 (2 min so far).");
  assert.deepEqual(studentPageSteps(s).map((x) => x.state), ["done", "active", "todo"]);
});

test("long after the save, nothing running, still the old version: stuck - said, never left as 'updating'", () => {
  const behind = { saved: card({ deadline_at: "2026-10-14T20:30:00.000Z" }), served: { status: "ok", card: card() } };
  // The site was updated after the save, without the change (an org kept, a rebuild that failed).
  const s = studentPageStatus({ ...behind, since: min(STUCK_MINUTES + 2), deploy: { status: "completed", conclusion: "success" }, now: T });
  assert.equal(s.state, "stuck");
  assert.match(studentPageLine(s), /12 min after it was saved, and nothing is updating it now\.$/);
  // Inside the window it is still on its way; an update running past it is too.
  assert.equal(studentPageStatus({ ...behind, since: min(STUCK_MINUTES - 1), deploy: null, now: T }).state, "updating");
  assert.equal(studentPageStatus({ ...behind, since: min(30), deploy: { status: "queued" }, now: T }).state, "updating");
});

test("a failed start stays on screen until the page agrees", () => {
  const behind = { saved: card({ title: "PE1 v2" }), served: { status: "ok", card: card() }, since: min(1), deploy: null, now: T };
  const s = studentPageStatus({ ...behind, failure: "HTTP 502" });
  assert.equal(s.state, "failed");
  assert.equal(studentPageLine(s), "Saved, but starting the student page update failed: HTTP 502.");
  assert.deepEqual(studentPageSteps(s).map((x) => x.state), ["done", "failed", "todo"]);
  // Once students do see it, the failure is history, not a status.
  assert.equal(studentPageStatus({ ...behind, served: { status: "ok", card: card({ title: "PE1 v2" }) }, failure: "HTTP 502" }).state, "current");
});

test("no page on the site yet, a page that could not be read, and an assignment with no page", () => {
  const missing = studentPageStatus({ saved: card(), served: { status: "missing" }, since: min(1), deploy: null, now: T });
  assert.equal(missing.state, "updating");
  assert.match(studentPageLine(missing), /^The student page for this assignment is not on the site yet: updating/);
  // Unreadable is not evidence either way: nothing is claimed.
  assert.equal(studentPageStatus({ saved: card(), served: { status: "unreadable" }, since: min(1), deploy: null, now: T }).state, "unknown");
  assert.equal(studentPageStatus({ saved: null, served: { status: "missing" }, since: null, deploy: null, now: T }).state, "none");
});
