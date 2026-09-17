// frontend/src/lib/blank-starter.js - the starter repository for an assignment
// that has no starter code.
//
// 2026-09-17, twice in one day: pxl-werkplekleren created a repository called
// `empty-template`, published an assignment on it and lost both acceptances to
// `generate HTTP 422 Could not clone: ... is empty`, and a lecturer asked
// whether the template could be skipped the way GitHub Classroom allowed. The
// button exists so the answer is a repository rather than an explanation. What
// is tested here is the half that decides, run rather than grepped.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CANNOT_CREATE,
  CREATE_FAILED,
  NAME_TAKEN,
  blankStarterFailure,
  blankStarterName,
} from "../frontend/src/lib/blank-starter.js";

const CTX = { org: "PXL-Werkplekleren", name: "starter-portfolio" };

// The exact body measured on pxl-classroom-testbed, 2026-09-17, by creating
// probe-starter-<stamp> twice. Copied from the run, not invented: a fixture the
// test made up would pass against code that cannot read the real one.
const NAME_EXISTS = {
  ok: false,
  status: 422,
  data: {
    message: "Repository creation failed.",
    errors: [
      {
        resource: "Repository",
        code: "custom",
        field: "name",
        message: "name already exists on this account",
      },
    ],
  },
};

test("the name is derived from the slug, and absent without one", () => {
  assert.equal(blankStarterName("portfolio"), "starter-portfolio");
  assert.equal(blankStarterName("  portfolio  "), "starter-portfolio");
  assert.equal(blankStarterName(""), "");
  assert.equal(blankStarterName(undefined), "");
  assert.equal(blankStarterName(null), "");
  assert.equal(blankStarterName(42), "");
});

test("a 201 is the end of it", () => {
  assert.deepEqual(blankStarterFailure({ ok: true, status: 201, data: {} }, CTX), { ok: true });
});

test("a name that exists is refused and never adopted", () => {
  const verdict = blankStarterFailure(NAME_EXISTS, CTX);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, NAME_TAKEN);
  // The whole point of the refusal: the lecturer is told nothing happened, and
  // that the repository standing there may be another assignment's. A slug
  // repeats across years; `starter-<slug>` pins the slug and not the id.
  assert.match(verdict.message, /PXL-Werkplekleren\/starter-portfolio already exists/);
  assert.match(verdict.message, /nothing was created/);
  assert.match(verdict.message, /has not been adopted/);
});

test("a 403 says who can do it instead, because it is not a failure", () => {
  const verdict = blankStarterFailure(
    { ok: false, status: 403, data: { message: "Resource not accessible by integration" } },
    CTX,
  );
  assert.equal(verdict.code, CANNOT_CREATE);
  assert.match(verdict.message, /not allowed to create repositories in PXL-Werkplekleren/);
  assert.match(verdict.message, /owner/);
});

test("any other 422 is not read as a name clash", () => {
  // Same status, different cause - GitHub answers 422 to plenty. Reading the
  // status alone would tell a lecturer a repository exists when none does.
  const verdict = blankStarterFailure(
    {
      ok: false,
      status: 422,
      data: {
        message: "Repository creation failed.",
        errors: [{ resource: "Repository", field: "name", message: "name is invalid" }],
      },
    },
    CTX,
  );
  assert.equal(verdict.code, CREATE_FAILED);
  assert.match(verdict.message, /HTTP 422/);
  assert.match(verdict.message, /Nothing was changed/);
});

test("GitHub's own reason is carried, not its useless top-level message", () => {
  // Reachable with a long title: `starter-` plus a 100-character slug is over
  // GitHub's limit. "Could not create X (HTTP 422): Repository creation
  // failed." tells a lecturer nothing they can act on; the row does.
  const verdict = blankStarterFailure(
    {
      ok: false,
      status: 422,
      data: {
        message: "Repository creation failed.",
        errors: [
          {
            resource: "Repository",
            field: "name",
            message: "name is too long (maximum is 100 characters)",
          },
        ],
      },
    },
    CTX,
  );
  assert.equal(verdict.code, CREATE_FAILED);
  assert.match(verdict.message, /name is too long \(maximum is 100 characters\)\./);
  assert.doesNotMatch(verdict.message, /Repository creation failed/);
});

test("a message that already ends in a full stop does not gain a second one", () => {
  const verdict = blankStarterFailure(
    { ok: false, status: 500, data: { message: "Server Error." } },
    CTX,
  );
  assert.doesNotMatch(verdict.message, /\.\./);
  assert.match(verdict.message, /Server Error\. Nothing was changed\./);
});

test("a body with no errors array, or none at all, still yields a message", () => {
  for (const response of [
    { ok: false, status: 500, data: { message: "Server Error" } },
    { ok: false, status: 502, data: null },
    { ok: false, status: 422, data: { errors: "not an array" } },
    { ok: false, status: undefined, data: undefined },
    {},
    null,
  ]) {
    const verdict = blankStarterFailure(response, CTX);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.code, CREATE_FAILED);
    assert.ok(verdict.message.includes("PXL-Werkplekleren/starter-portfolio"));
  }
});

test("an error row that is not an object does not throw inside the click", () => {
  const verdict = blankStarterFailure(
    { ok: false, status: 422, data: { errors: [null, "name already exists on this account"] } },
    CTX,
  );
  assert.equal(verdict.code, CREATE_FAILED);
});
