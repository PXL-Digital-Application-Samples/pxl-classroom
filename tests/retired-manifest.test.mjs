// The one document that outlives a deleted assignment.
//
// Nothing iterates `retired/`, nothing regenerates it, and no later run will
// correct it - so a field spelled ambiguously on the day of the delete stays
// ambiguous for as long as the record is worth keeping. The first manifest
// written in anger recorded `archive_repo` as a bare repository name while
// `broker_repo_deleted` beside it carried `owner/name`, which leaves a reader
// years later inferring the organization from the document whose whole job is
// to need no context.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildRetiredManifest } from "../lib/retired-manifest.mjs";
import { ARCHIVE_REPO_PREFIX, LEGACY_ARCHIVE_REPO } from "../lib/archive-repo.mjs";
import { validateAgainst } from "../lib/validate.mjs";

const ORG = "PXL-Automation-II";

const ARGS = {
  org: ORG,
  assignmentId: "linux-processes-2026",
  title: "Linux Processes",
  deletedBy: "tomcoolpxl",
  brokerRepo: "broker-linux-processes-2026",
  brokerDeleted: true,
  removedPaths: ["assignments/linux-processes-2026.yml", "reports/linux-processes-2026.json"],
  deletedAt: "2026-09-04T17:36:52.464Z",
};

const check = (doc) => validateAgainst("retired-manifest", JSON.parse(JSON.stringify(doc)));

test("what the panel writes is a valid manifest", () => {
  const { valid, errors } = check(buildRetiredManifest(ARGS));
  assert.equal(valid, true, JSON.stringify(errors, null, 2));
});

test("every repository it names is owner/name", () => {
  const doc = buildRetiredManifest(ARGS);
  assert.equal(doc.broker_repo_deleted, `${ORG}/broker-linux-processes-2026`);
  assert.equal(doc.archive_repo, `${ORG}/${ARCHIVE_REPO_PREFIX}linux-processes-2026`);

  // Derived, not spelled: the point is that the two fields agree on what a
  // repository reference looks like, whatever that turns out to be.
  for (const field of ["broker_repo_deleted", "archive_repo"]) {
    assert.ok(doc[field].startsWith(`${ORG}/`), `${field} must carry the organization`);
  }
});

test("a broker that was not deleted is null, not a name that still exists", () => {
  const doc = buildRetiredManifest({ ...ARGS, brokerDeleted: false });
  assert.equal(doc.broker_repo_deleted, null);
  assert.equal(check(doc).valid, true);

  const none = buildRetiredManifest({ ...ARGS, brokerRepo: null, brokerDeleted: true });
  assert.equal(none.broker_repo_deleted, null);
});

test("the archive comes from the rows, not from today's naming rule", () => {
  // THE COHORT THIS GOT WRONG. Preserved before per-assignment archives
  // existed, so the work is in the org's single legacy `pxl-classroom-archive`.
  // Composing `pxl-classroom-archive-<id>` names a repository that never held a
  // line of it - in the one document written to be read without context.
  const legacy = buildRetiredManifest({
    ...ARGS,
    students: [
      { github_login: "alice", preservation_status: "preserved", archive_repo: `${ORG}/${LEGACY_ARCHIVE_REPO}` },
      { github_login: "bram", preservation_status: "preserved", archive_repo: `${ORG}/${LEGACY_ARCHIVE_REPO}` },
    ],
  });
  assert.equal(legacy.archive_repo, `${ORG}/${LEGACY_ARCHIVE_REPO}`);
  assert.notEqual(
    legacy.archive_repo,
    `${ORG}/${ARCHIVE_REPO_PREFIX}linux-processes-2026`,
    "today's naming rule must not override where the submissions actually are",
  );
  assert.equal(legacy.preserved_submissions, 2);
  assert.equal(check(legacy).valid, true);
});

test("preserved_submissions counts only rows that were actually preserved", () => {
  const doc = buildRetiredManifest({
    ...ARGS,
    students: [
      { github_login: "alice", preservation_status: "preserved", archive_repo: `${ORG}/${ARCHIVE_REPO_PREFIX}linux-processes-2026` },
      // The other three states report.schema.json actually declares, so this
      // counts real values rather than ones the test invented.
      { github_login: "bram", preservation_status: "failed" },
      { github_login: "cara", preservation_status: "not-required" },
      { github_login: "dries", preservation_status: null },
    ],
  });
  assert.equal(doc.preserved_submissions, 1);
  assert.equal(doc.archive_repo, `${ORG}/${ARCHIVE_REPO_PREFIX}linux-processes-2026`);
});

test("nothing preserved is zero, and the archive falls back to the name", () => {
  // The finalize-drill case, measured live on 2026-09-05: an archive repository
  // that existed and held one generated README and no `preserved/*` branch. The
  // count is what tells a reader that deleting it cost nothing - and that a 404
  // here is an end-of-year cleanup rather than a name recorded wrong.
  const doc = buildRetiredManifest({ ...ARGS, students: [] });
  assert.equal(doc.preserved_submissions, 0);
  assert.equal(doc.archive_repo, `${ORG}/${ARCHIVE_REPO_PREFIX}linux-processes-2026`);
  assert.equal(check(doc).valid, true);
});

test("an unreadable report is not evidence of an empty cohort", () => {
  // It still yields 0, because there is nothing else it could say - but the
  // delete must not fail over it, and the archive name must still be recorded.
  const doc = buildRetiredManifest({ ...ARGS, students: null });
  assert.equal(doc.preserved_submissions, 0);
  assert.ok(doc.archive_repo, "the archive is still named");
  assert.equal(check(doc).valid, true);
});

test("an unusable id yields null, never the org's legacy archive", () => {
  // THE MECHANISM, demonstrated rather than asserted about. resolveArchiveRepo
  // reads an absent `recorded` as "preserved before per-assignment archives
  // existed" and answers with the legacy per-org repository - right for reading
  // an old report row, and a straight lie in a manifest, where it would name a
  // repository holding nothing of this cohort's.
  const doc = buildRetiredManifest({ ...ARGS, assignmentId: "" });
  assert.equal(doc.archive_repo, null);
  assert.notEqual(doc.archive_repo, `${ORG}/${LEGACY_ARCHIVE_REPO}`);
});

test("an absent lecturer is null, not an empty string that reads like a name", () => {
  const doc = buildRetiredManifest({ ...ARGS, deletedBy: undefined, title: undefined });
  assert.equal(doc.deleted_by, null);
  assert.equal(doc.title, null);
  assert.equal(check(doc).valid, true);
});

test("removed_paths survives a tree entry that is not a path", () => {
  const doc = buildRetiredManifest({ ...ARGS, removedPaths: ["a.yml", "", null, undefined, "b.json"] });
  assert.deepEqual(doc.removed_paths, ["a.yml", "b.json"]);
  assert.equal(check(doc).valid, true);
});

test("a bare repository name is refused by the schema", () => {
  // What the first live manifest carried. The schema is what stops it coming
  // back, so it has to actually reject it.
  const doc = buildRetiredManifest(ARGS);
  assert.equal(check({ ...doc, archive_repo: "pxl-classroom-archive-linux-processes-2026" }).valid, false);
  assert.equal(check({ ...doc, broker_repo_deleted: "broker-linux-processes-2026" }).valid, false);
});

test("a field dropped from the manifest is caught", () => {
  const doc = buildRetiredManifest(ARGS);
  for (const key of Object.keys(doc)) {
    const without = { ...doc };
    delete without[key];
    assert.equal(check(without).valid, false, `${key} may be omitted, so nothing records it`);
  }
});

test("the Admin Panel builds this document nowhere else", () => {
  // ONE SOURCE OF TRUTH. The manifest used to be an object literal inside
  // deleteAssignment(), which is why no test could import it and no schema
  // could be pointed at it.
  const src = readFileSync(new URL("../frontend/src/views/AdminView.vue", import.meta.url), "utf8");
  assert.match(src, /buildRetiredManifest\(/, "the panel must call the shared builder");
  assert.doesNotMatch(
    src,
    /archive_repo\s*:/,
    "the panel is hand-building a manifest field again - lib/retired-manifest.mjs owns it",
  );
});
