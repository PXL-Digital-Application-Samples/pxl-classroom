// lib/assignment-now.mjs: the assignment as GitHub holds it at the moment a
// job acts (review 2026-10-16, R7-1), and the three answers it can give.

import { test } from "node:test";
import assert from "node:assert/strict";
import { deadlineAhead, readAssignmentNow } from "../lib/assignment-now.mjs";
import { contentsText } from "../lib/contents-text.mjs";

const b64 = (s) => Buffer.from(s).toString("base64").replace(/(.{60})/g, "$1\n");
const ask = (routes) => {
  const asked = [];
  const request = async (method, path) => {
    asked.push(path);
    const hit = routes[path];
    if (hit instanceof Error) throw hit;
    return hit ?? { ok: false, status: 404 };
  };
  return { request, asked };
};
const base = { org: "O", controlRepo: "ctl", assignmentId: "exam" };

test("read: the first spelling that exists, parsed", async () => {
  const { request, asked } = ask({ "/repos/O/ctl/contents/assignments/exam.yaml": { ok: true, status: 200, data: { content: b64("deadline_at: '2030-01-01T00:00:00Z'\ntitle: Ünïcödé exam\n") } } });
  const now = await readAssignmentNow({ ...base, request });
  assert.equal(now.status, "read");
  assert.equal(now.assignment.title, "Ünïcödé exam", "UTF-8 survives the base64 with its line breaks");
  assert.deepEqual(asked, ["/repos/O/ctl/contents/assignments/exam.yml", "/repos/O/ctl/contents/assignments/exam.yaml"]);
});

test("read: a .json document", async () => {
  const { request } = ask({ "/repos/O/ctl/contents/assignments/exam.json": { ok: true, status: 200, data: { content: b64(JSON.stringify({ deadline_at: "2030-01-01T00:00:00Z" })) } } });
  assert.equal((await readAssignmentNow({ ...base, request })).assignment.deadline_at, "2030-01-01T00:00:00Z");
});

test("absent: every spelling 404s", async () => {
  const { request } = ask({});
  assert.deepEqual(await readAssignmentNow({ ...base, request }), { status: "absent" });
});

test("unread: a refusal, a thrown request, a body with no content, or a document that does not parse", async () => {
  const path = "/repos/O/ctl/contents/assignments/exam.yml";
  for (const hit of [{ ok: false, status: 403 }, new Error("socket hang up"), { ok: true, status: 200, data: {} },
    { ok: true, status: 200, data: { content: b64("a: [unclosed") } }, { ok: true, status: 200, data: { content: b64("just a string") } }]) {
    const { request } = ask({ [path]: hit });
    assert.equal((await readAssignmentNow({ ...base, request })).status, "unread", String(hit?.message ?? hit?.status ?? "body"));
  }
});

test("deadlineAhead: only a parseable deadline after now", () => {
  const now = Date.parse("2026-10-16T12:00:00Z");
  assert.equal(deadlineAhead({ deadline_at: "2026-10-16T12:00:01Z" }, now), true);
  assert.equal(deadlineAhead({ deadline_at: "2026-10-16T12:00:00Z" }, now), false, "the instant itself has passed");
  assert.equal(deadlineAhead({ deadline_at: "2026-10-16T11:00:00Z" }, now), false);
  assert.equal(deadlineAhead({}, now), false);
  assert.equal(deadlineAhead({ deadline_at: "soon" }, now), false);
  assert.equal(deadlineAhead(null, now), false);
});

test("contentsText decodes what Buffer encodes, with and without the API's line breaks", () => {
  for (const s of ["", "plain", "Flemish 't Hooft é ü ∑ 🎓", "x".repeat(500)]) {
    const enc = Buffer.from(s).toString("base64");
    assert.equal(contentsText(enc), s);
    assert.equal(contentsText(enc.replace(/(.{60})/g, "$1\n")), s);
  }
});
