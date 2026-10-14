// One builder for a snapshot observation, used by the nightly collector and
// by the assignment page's Refresh: lib/observation.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { commitAuthor, isBotAuthorName, snapshotObservation, taggedSubmissionObservation } from "../lib/observation.mjs";
import { parseSubmitTagRef } from "../lib/submit-tag.mjs";
import { observationPath } from "../lib/control-layout.mjs";
import { validateAgainst } from "../lib/validate.mjs";

const commit = (over = {}) => ({
  sha: "a".repeat(40),
  commit: {
    message: "lab 3 done",
    author: { name: "Ann De Wit", email: "ann.dewit@student.pxl.be", date: "2026-09-26T08:00:00Z" },
    committer: { date: "2026-09-26T08:01:00Z" },
    ...over,
  },
});
const base = {
  assignmentId: "labs", login: "ann", repoId: 42, ref: "refs/heads/main",
  commit: commit(), commitCount: 7, observedAt: "2026-09-26T09:00:00.000Z",
};

test("a Refresh observation (manual, no run) is valid against the schema", () => {
  const doc = snapshotObservation({ ...base, collectionType: "manual" });
  const v = validateAgainst("observation", doc);
  assert.equal(v.valid, true, JSON.stringify(v.errors));
  assert.equal("observer_run" in doc, false, "absent, not null: the schema wants a uri");
  assert.equal(doc.commit_date, "2026-09-26T08:01:00Z", "the COMMIT's time, committer first");
  assert.equal(doc.late_commit_count, null, "not counted is null, never 0");
});

test("a collector observation (scheduled, with its run) is valid too", () => {
  const doc = snapshotObservation({ ...base, collectionType: "scheduled", observerRun: "https://github.com/o/r/actions/runs/1", lateCommitCount: 0 });
  assert.equal(validateAgainst("observation", doc).valid, true);
  assert.equal(doc.observer_run, "https://github.com/o/r/actions/runs/1");
});

test("the author: machines and noreply addresses are removed, people kept", () => {
  assert.deepEqual(commitAuthor(commit()), { name: "Ann De Wit", email: "ann.dewit@student.pxl.be" });
  assert.deepEqual(
    commitAuthor(commit({ author: { name: "pxl-classroom-provisioner[bot]", email: "123+x@users.noreply.github.com" } })),
    { name: null, email: null },
  );
  for (const n of ["github-actions[bot]", "GitHub", "web-flow", "PXL Classroom Provisioner"]) assert.equal(isBotAuthorName(n), true, n);
  assert.equal(isBotAuthorName("Ann"), false);
});

test("an author the caller already resolved is used as given", () => {
  const doc = snapshotObservation({ ...base, collectionType: "scheduled", author: { name: "From profile", email: null } });
  assert.equal(doc.author_name, "From profile");
  assert.equal(doc.author_email, null);
});

test("the path is the one the collector has always written", () => {
  assert.equal(observationPath("labs", "ann", "2026-09-26T09:00:00.000Z"), "observations/labs/ann/2026-09-26T09-00-00-000Z.json");
});

test("ONE builder: neither writer spells an observation by hand any more", () => {
  const collector = readFileSync(new URL("../collect/collect.mjs", import.meta.url), "utf8");
  const page = readFileSync(new URL("../frontend/src/views/AssignmentDetailView.vue", import.meta.url), "utf8");
  for (const [name, src] of [["collect.mjs", collector], ["AssignmentDetailView.vue", page]]) {
    assert.match(src, /snapshotObservation\(/, `${name} must build through lib/observation.mjs`);
    assert.doesNotMatch(src, /type:\s*["']snapshot["']/, `${name} spells a snapshot observation by hand`);
  }
});

test("a tag a student can make (dashes in the time) is a valid tagged-submission observation, and the collector validates it before writing", () => {
  const parsed = parseSubmitTagRef("refs/tags/submit/2026-10-14T14-05-00Z-abc1234");
  const doc = taggedSubmissionObservation({
    assignmentId: "labs", login: "ann", repoId: 42, observedAt: "2026-10-14T15:00:00.000Z",
    submit: { ...parsed, tagged_sha: "a".repeat(40) }, observerRun: "https://github.com/o/r/actions/runs/1",
  });
  const v = validateAgainst("observation", doc);
  assert.equal(v.valid, true, JSON.stringify(v.errors));
  assert.equal(doc.declared_at, "2026-10-14T14:05:00Z");
  const noRun = taggedSubmissionObservation({
    assignmentId: "labs", login: "ann", repoId: 42, observedAt: doc.observed_at, submit: { ...parsed, tagged_sha: "a".repeat(40) },
  });
  assert.equal("observer_run" in noRun, false, "absent, not null: the schema wants a uri");

  const collector = readFileSync(new URL("../collect/collect.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(collector, /type:\s*["']tagged-submission["']/, "built through lib/observation.mjs");
  const built = collector.indexOf("taggedSubmissionObservation(");
  const checked = collector.indexOf('validateAgainst("observation", tagObservation)', built);
  const written = collector.indexOf("writeFile(tagPath", built);
  assert.ok(built > 0 && checked > built && written > checked, "built, then validated, then written");
});
