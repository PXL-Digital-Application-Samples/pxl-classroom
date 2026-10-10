// frontend/src/lib/data-freshness.js - when the data on the Progress and
// Grading tabs was read, for the info blocks beside Refresh and Read all
// scores again (2026-10-08: the only timestamp was a footer under the table).

import { test } from "node:test";
import assert from "node:assert/strict";

import { commitsRead, sameMoment, scoresRead } from "../frontend/src/lib/data-freshness.js";

test("commits: the oldest read of the students with a repository, and how it was made", () => {
  const r = commitsRead([
    { repo_name: "o/a", latest_observed_at: "2026-10-10T00:47:00Z", latest_observation_type: "scheduled" },
    { repo_name: "o/b", latest_observed_at: "2026-10-10T09:12:00Z", latest_observation_type: "manual" },
    { repo_name: "o/c", latest_observed_at: null },
    { repo_name: null, latest_observed_at: "2020-01-01T00:00:00Z" }, // no repository: not this question
  ]);
  assert.deepEqual(r, { at: "2026-10-10T00:47:00Z", type: "scheduled", newest: "2026-10-10T09:12:00Z", read: 2, unread: 1 });
});

test("commits: nobody read yet is said as such, not as a time", () => {
  assert.deepEqual(commitsRead([{ repo_name: "o/a" }]), { at: null, type: null, newest: null, read: 0, unread: 1 });
  assert.deepEqual(commitsRead([]), { at: null, type: null, newest: null, read: 0, unread: 0 });
});

test("one moment is within a minute", () => {
  assert.equal(sameMoment("2026-10-10T00:47:00Z", "2026-10-10T00:47:40Z"), true);
  assert.equal(sameMoment("2026-10-10T00:47:00Z", "2026-10-10T00:49:00Z"), false);
  assert.equal(sameMoment(null, "2026-10-10T00:47:00Z"), false);
});

test("scores: the oldest per-student read, not the summary's own time - one student read again rewrites that", () => {
  const summary = {
    generated_at: "2026-10-09T10:00:00Z", graded_by: "lect",
    students: [
      { login: "a", graded_at: "2026-10-08T07:26:00Z" },
      { login: "b", graded_at: "2026-10-08T07:26:30Z" },
      { login: "c", graded_at: "2026-10-09T10:00:00Z" },
    ],
  };
  assert.deepEqual(scoresRead(summary), { at: "2026-10-08T07:26:00Z", again: 1, latest: "2026-10-09T10:00:00Z", uniform: false });
});

test("scores: one read for everybody is uniform, so who read them may be said", () => {
  const r = scoresRead({ generated_at: "2026-10-08T07:27:00Z", students: [{ graded_at: "2026-10-08T07:26:00Z" }, { graded_at: "2026-10-08T07:26:50Z" }] });
  assert.equal(r.uniform, true);
  assert.equal(r.again, 0);
  assert.equal(r.latest, null);
});

test("scores: no per-student time falls back to the summary's, and no summary is nothing", () => {
  assert.deepEqual(scoresRead({ generated_at: "2026-10-08T07:27:00Z", students: [] }), { at: "2026-10-08T07:27:00Z", again: 0, latest: null, uniform: true });
  assert.equal(scoresRead(null), null);
  assert.equal(scoresRead({ students: [] }), null);
});
