// A sha conflict on a contents write is not always a concurrent edit.
//
// GitHub's Contents API is eventually consistent: a GET moments after a write
// can still answer with the sha that write replaced. `commitFile` reads the sha
// and then PUTs with it, so a stale read means the PUT is refused - with
// GitHub's own wording, "is at 7575ba33... but expected f7a2cdb8...", which was
// shown verbatim to a lecturer on PXL-Automation-II after pressing "Fill in 1
// email" and then editing a cell. Two hashes, no subject, nothing to act on.
//
// THE OBVIOUS FIX IS DATA LOSS, which is the whole reason this module exists.
// If the sha was stale then the CONTENT was stale too, so the document the
// caller built is one commit behind; writing it over the fresh sha silently
// drops whatever the caller never saw. In the measured case that is the address
// the harvest had written a second earlier. The refusal was doing its job.

import { test } from "node:test";
import assert from "node:assert/strict";

import { conflictAction, isShaConflict, RETRY, REFUSE } from "../lib/write-conflict.mjs";

test("A STALE SHA RETRIES - the content is identical, so nobody else wrote", () => {
  assert.equal(conflictAction({ baseContent: "same", freshContent: "same" }), RETRY);
});

test("A REAL CONCURRENT EDIT REFUSES - the content moved underneath", () => {
  // The half that makes the retry safe. Without it, the retry would write a
  // document built before the other edit and drop it.
  assert.equal(conflictAction({ baseContent: "base", freshContent: "somebody else" }), REFUSE);
});

test("an UNREADABLE re-read refuses, because it is not evidence of anything", () => {
  // Same rule the roster read and the org-owner check apply: unreadable yields
  // no claim about the world. This is the side where being wrong destroys work.
  for (const freshContent of [null, undefined, 0, false, {}]) {
    assert.equal(
      conflictAction({ baseContent: "base", freshContent }),
      REFUSE,
      `expected REFUSE for ${JSON.stringify(freshContent)}`,
    );
  }
});

test("NO baseline retries, because there is nothing to compare", () => {
  // A brand new file, or a document assembled from a form rather than edited
  // from one that was read. Refusing those would break writes that were never
  // in danger - the assignment editor writes this way.
  assert.equal(conflictAction({ baseContent: undefined, freshContent: "anything" }), RETRY);
  assert.equal(conflictAction({ freshContent: null }), RETRY);
});

test("an EMPTY baseline is a baseline, not a missing one", () => {
  // `""` is a real document - a file someone emptied. Treating it as "no
  // baseline" would turn the one case that most needs the check into a retry.
  assert.equal(conflictAction({ baseContent: "", freshContent: "" }), RETRY);
  assert.equal(conflictAction({ baseContent: "", freshContent: "now has content" }), REFUSE);
});

test("a conflict is recognised by STATUS, never by GitHub's wording", () => {
  // The wording is the thing this change exists to stop showing people, and a
  // check that read it would break the day GitHub rewrote it.
  assert.equal(isShaConflict({ status: 409 }), true);
  assert.equal(isShaConflict({ status: 422 }), true);
  for (const status of [200, 201, 401, 403, 404, 422.5, 500]) {
    if (status === 422) continue;
    assert.equal(isShaConflict({ status }), false, `expected false for ${status}`);
  }
  assert.equal(isShaConflict(null), false);
  assert.equal(isShaConflict({}), false);
});

test("the two outcomes are distinct strings, so a caller cannot confuse them", () => {
  assert.notEqual(RETRY, REFUSE);
  assert.equal(typeof RETRY, "string");
  assert.equal(typeof REFUSE, "string");
});
