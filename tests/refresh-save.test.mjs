// What Refresh says when its save is refused (frontend/src/lib/refresh-save.js).
// The read-only sentence needs BOTH halves: GitHub's 403 and GitHub's own
// answer that this account cannot push. Anything less keeps GitHub's words.
import { test } from "node:test";
import assert from "node:assert/strict";
import { refreshSaveRefusal } from "../frontend/src/lib/refresh-save.js";

const forbidden = { ok: false, status: 403, error: "HTTP 403 (Resource not accessible by integration)" };

test("a 403 for an account GitHub says cannot push is read-only, and names the repository to grant", () => {
  const r = refreshSaveRefusal(forbidden, false, "pxl-classroom-control");
  assert.equal(r.readOnly, true);
  assert.match(r.text, /can read this course's records but not change them/);
  assert.match(r.text, /pxl-classroom-control/);
  assert.doesNotMatch(r.text, /HTTP 403/);
});

test("a 403 for an account that CAN push is not called read-only (a missing App permission says the same words)", () => {
  const r = refreshSaveRefusal(forbidden, true, "pxl-classroom-control");
  assert.equal(r.readOnly, false);
  assert.equal(r.text, "Refreshed locally but save failed: HTTP 403 (Resource not accessible by integration)");
});

test("a 403 whose permission could not be read keeps GitHub's words: unreadable is not evidence", () => {
  assert.equal(refreshSaveRefusal(forbidden, null, "pxl-classroom-control").readOnly, false);
});

test("any other failure is never read-only, whatever the permission says", () => {
  for (const status of [0, 401, 404, 409, 422, 500]) {
    const r = refreshSaveRefusal({ ok: false, status, error: `HTTP ${status}` }, false, "pxl-classroom-control");
    assert.equal(r.readOnly, false, `status ${status}`);
    assert.equal(r.text, `Refreshed locally but save failed: HTTP ${status}`);
  }
});

test("a failure with no message still says something", () => {
  assert.equal(refreshSaveRefusal({ ok: false, status: 0 }, null, "x").text, "Refreshed locally but save failed: unknown error");
});
