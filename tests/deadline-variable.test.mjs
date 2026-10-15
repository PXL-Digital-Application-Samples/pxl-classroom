// lib/deadline-variable.mjs - a student's own deadline, on their own repository
// (decided 2026-10-15: the control repository is private to staff, so a
// student's page never saw an extension; found by the live UI suite).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEADLINE_VARIABLE, deadlineVariableValue, pageDeadlineState, parseDeadlineVariable,
  readDeadlineVariable, writeDeadlineVariable,
} from "../lib/deadline-variable.mjs";

const assignment = { deadline_at: "2026-10-20T22:00:00Z" };
const ext = (login, value) => ({ github_login: login, overrides: [{ type: "deadline_extension", value, reason: "medical", overridden_by: "l", overridden_at: "2026-10-01T00:00:00Z" }] });

test("the value is the deadline in force when an extension makes it later, and nothing otherwise", () => {
  assert.equal(deadlineVariableValue(assignment, "ann", { overrides: [ext("ann", "2026-10-25T22:00:00Z")] }), "2026-10-25T22:00:00.000Z");
  assert.equal(deadlineVariableValue(assignment, "bob", { overrides: [ext("ann", "2026-10-25T22:00:00Z")] }), null, "someone else's");
  assert.equal(deadlineVariableValue(assignment, "ann", { overrides: [ext("ann", "2026-10-19T22:00:00Z")] }), null, "an extension only extends");
  assert.equal(deadlineVariableValue(assignment, "ann", { overrides: [] }), null);
  // The team's repository: its most generous member's, whoever opens it.
  const overrides = [ext("ann", "2026-10-25T22:00:00Z"), ext("cy", "2026-10-27T22:00:00Z")];
  assert.equal(deadlineVariableValue(assignment, "bob", { overrides, team: { members: ["Ann", "bob", "cy"] } }), "2026-10-27T22:00:00.000Z");
});

test("a value read back is a date only when it is a well-formed instant", () => {
  assert.equal(parseDeadlineVariable("2026-10-25T22:00:00.000Z").toISOString(), "2026-10-25T22:00:00.000Z");
  for (const bad of ["", "soon", "2026-10-25", null, undefined, "2026-13-45T99:99:99Z"]) {
    assert.equal(parseDeadlineVariable(bad), null, String(bad));
  }
});

/** A fake GitHub answering each (method, path) from a table; records the calls. */
function fake(answers) {
  const calls = [];
  const request = async (method, path, body) => {
    calls.push([method, path, body ?? null]);
    const a = answers[`${method} ${path}`] ?? { status: 404 };
    return { ok: a.status >= 200 && a.status < 300, status: a.status, data: a.data ?? null };
  };
  return { request, calls };
}
const at = `/repos/o/r/actions/variables`;
const one = `${at}/${DEADLINE_VARIABLE}`;

test("writing updates the variable that is there, and makes it where there is none", async () => {
  const there = fake({ [`PATCH ${one}`]: { status: 204 } });
  assert.deepEqual(await writeDeadlineVariable(there.request, { repoFullName: "o/r", value: "2026-10-25T22:00:00.000Z" }), { ok: true, status: 204 });
  assert.deepEqual(there.calls.map((c) => c[0]), ["PATCH"]);

  const none = fake({ [`PATCH ${one}`]: { status: 404 }, [`POST ${at}`]: { status: 201 } });
  assert.deepEqual(await writeDeadlineVariable(none.request, { repoFullName: "o/r", value: "2026-10-25T22:00:00.000Z" }), { ok: true, status: 201 });
  assert.deepEqual(none.calls.map((c) => [c[0], c[2]]), [
    ["PATCH", { name: DEADLINE_VARIABLE, value: "2026-10-25T22:00:00.000Z" }],
    ["POST", { name: DEADLINE_VARIABLE, value: "2026-10-25T22:00:00.000Z" }],
  ]);

  // A refusal is not "absent": no POST after a 403.
  const refused = fake({ [`PATCH ${one}`]: { status: 403 } });
  assert.deepEqual(await writeDeadlineVariable(refused.request, { repoFullName: "o/r", value: "2026-10-25T22:00:00.000Z" }), { ok: false, status: 403 });
  assert.equal(refused.calls.length, 1);
});

test("no value removes it, and one already gone is done", async () => {
  const gone = fake({ [`DELETE ${one}`]: { status: 404 } });
  assert.deepEqual(await writeDeadlineVariable(gone.request, { repoFullName: "o/r", value: null }), { ok: true, status: 404 });
  const removed = fake({ [`DELETE ${one}`]: { status: 204 } });
  assert.equal((await writeDeadlineVariable(removed.request, { repoFullName: "o/r", value: null })).ok, true);
  const refused = fake({ [`DELETE ${one}`]: { status: 403 } });
  assert.equal((await writeDeadlineVariable(refused.request, { repoFullName: "o/r", value: null })).ok, false);
});

test("reading: a 404 is 'none' only to a reader who can push - a locked student is answered 404 for one that exists", async () => {
  const set = fake({ [`GET ${one}`]: { status: 200, data: { value: "2026-10-25T22:00:00.000Z" } } });
  const r = await readDeadlineVariable(set.request, { repoFullName: "o/r", canPush: false });
  assert.equal(r.state, "set");
  assert.equal(r.at.toISOString(), "2026-10-25T22:00:00.000Z");

  const absent = fake({});
  assert.deepEqual(await readDeadlineVariable(absent.request, { repoFullName: "o/r", canPush: true }), { state: "none" });
  assert.deepEqual(await readDeadlineVariable(absent.request, { repoFullName: "o/r", canPush: false }), { state: "unreadable", status: 404 });
  assert.deepEqual(await readDeadlineVariable(absent.request, { repoFullName: "o/r", canPush: null }), { state: "unreadable", status: 404 });

  const broken = fake({ [`GET ${one}`]: { status: 500 } });
  assert.deepEqual(await readDeadlineVariable(broken.request, { repoFullName: "o/r", canPush: true }), { state: "unreadable", status: 500 });
  const garbage = fake({ [`GET ${one}`]: { status: 200, data: { value: "next week" } } });
  assert.equal((await readDeadlineVariable(garbage.request, { repoFullName: "o/r", canPush: true })).state, "unreadable");
});

test("what the lecturer's dialog says their page shows, against what it should", () => {
  const want = "2026-10-25T22:00:00.000Z";
  const d = (s) => new Date(s);
  assert.equal(pageDeadlineState({ expected: want, read: { state: "no-repo" } }).state, "no-repo");
  assert.equal(pageDeadlineState({ expected: want, read: { state: "unreadable", status: 500 } }).state, "unknown");
  assert.equal(pageDeadlineState({ expected: null, read: { state: "none" } }).state, "none");
  assert.equal(pageDeadlineState({ expected: want, read: { state: "set", at: d(want) } }).state, "current");
  // Behind: missing, an older date, or a date no extension gives.
  assert.deepEqual(pageDeadlineState({ expected: want, read: { state: "none" } }), { state: "behind", at: null, expected: d(want) });
  assert.equal(pageDeadlineState({ expected: want, read: { state: "set", at: d("2026-10-23T22:00:00Z") } }).state, "behind");
  assert.equal(pageDeadlineState({ expected: null, read: { state: "set", at: d(want) } }).state, "behind");
  // R6-10: extensions that could not be read are not "none" - a page showing
  // one is not behind, and nothing may be sent over it.
  assert.deepEqual(
    pageDeadlineState({ expected: null, expectedKnown: false, read: { state: "set", at: d(want) } }),
    { state: "unknown", at: null, expected: null, expectedUnknown: true },
  );
});
