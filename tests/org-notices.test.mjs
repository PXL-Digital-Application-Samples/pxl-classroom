// lib/org-notices.mjs: the instructor notifications, read for the Organization page.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEDUP_MARKER,
  ORG_NOTICE_LABELS,
  isOrgNotice,
  noticeLines,
  noticesForLecturer,
  noticesNeedingYou,
  parseNotice,
  plainDetails,
} from "../lib/org-notices.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const now = new Date("2026-10-02T15:00:00Z");

// Exactly the shape notify/notify.mjs writes.
const comment = ({ key, type, assignment = "lab-3", time = "2026-10-02T10:00:00.000Z", details = "Something happened." }) => ({
  body: `${DEDUP_MARKER}${key}-->\n### [ERROR] ${type}\n\n**Assignment:** ${assignment}\n**Time:** ${time}\n\n${details}\n`,
  html_url: `https://github.com/o/c/issues/1#c-${key}`,
  updated_at: time,
});

test("the marker is the one notify.mjs writes", () => {
  const src = readFileSync(join(root, "notify", "notify.mjs"), "utf8");
  assert.ok(src.includes(`const DEDUP_MARKER = "${DEDUP_MARKER}"`));
});

test("a notice is read whole", () => {
  const n = parseNotice(comment({ key: "unanswered-abc", type: "provisioning-failed", assignment: "unanswered-attempts", details: "A student's acceptance got no answer.\n\n- `fars` tried..." }));
  assert.equal(n.eventType, "provisioning-failed");
  assert.equal(n.kind, "action");
  assert.equal(n.assignmentId, "unanswered-attempts");
  assert.equal(n.at, "2026-10-02T10:00:00.000Z");
  assert.match(n.details, /^A student's acceptance got no answer/);
  assert.equal(n.key, "unanswered-abc");
});

test("only recent notices that ask for something need you, newest first", () => {
  const list = noticesNeedingYou(
    [
      comment({ key: "a", type: "provisioning-failed", time: "2026-10-01T10:00:00Z" }),
      comment({ key: "b", type: "acceptance-rejected", time: "2026-10-02T10:00:00Z" }),
      comment({ key: "c", type: "late-activity", time: "2026-10-02T11:00:00Z" }),
      comment({ key: "d", type: "preservation-failed", time: "2026-10-02T12:00:00Z" }),
      comment({ key: "e", type: "provisioning-failed", time: "2026-09-01T10:00:00Z" }),
      { body: "a human comment, not ours" },
    ],
    { now },
  );
  assert.deepEqual(list.map((n) => n.key), ["d", "a"]);
});

test("every organization-wide notice the workflows file is known, so none is hidden as a deleted assignment's", () => {
  // Read, not listed: a literal `assignment-id:` in a workflow that is not an
  // expression names no assignment, and noticesForLecturer would otherwise
  // drop it for not being in the organization's assignment list.
  const dir = join(root, ".github", "workflows");
  const literals = new Set();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".yml"))) {
    for (const m of readFileSync(join(dir, file), "utf8").matchAll(/^\s*assignment-id:\s*(.*)$/gm)) {
      const v = m[1].trim().replace(/^['"]|['"]$/g, "");
      if (!v.startsWith("${{")) literals.add(v);
    }
  }
  assert.ok(literals.size >= 3, `found ${[...literals].join(", ")}`);
  for (const id of literals) assert.ok(Object.hasOwn(ORG_NOTICE_LABELS, id), `${JSON.stringify(id)} has no label`);
});

test("a notice about an assignment that is gone is not listed; an organization-wide one always is", () => {
  const comments = [
    comment({ key: "live", type: "provisioning-failed", assignment: "lab-3", time: "2026-10-02T10:00:00Z" }),
    comment({ key: "gone", type: "preservation-failed", assignment: "drill-race-1629", time: "2026-10-02T11:00:00Z" }),
    comment({ key: "org", type: "provisioning-failed", assignment: "unrecorded-repositories", time: "2026-10-02T12:00:00Z" }),
  ];
  const keys = (opts) => noticesForLecturer(comments, { now, ...opts }).map((n) => n.key);
  assert.deepEqual(keys({ assignmentIds: new Set(["lab-3"]) }), ["org", "live"]);
  // The list of assignments not known: nothing is hidden on a guess.
  assert.deepEqual(keys({ assignmentIds: null }), ["org", "gone", "live"]);
  assert.equal(isOrgNotice({ assignmentId: "" }), true);
  assert.equal(isOrgNotice({ assignmentId: "lab-3" }), false);
});

test("one sentence first, the rest on request - a wrapped first line is not a sentence", () => {
  const wrapped = "Finalizing this assignment did not complete. Lock-down, preservation\nor the report may be incomplete.\n\nIt is re-queued automatically.";
  assert.deepEqual(noticeLines(wrapped), {
    first: "Finalizing this assignment did not complete.",
    rest: "Lock-down, preservation or the report may be incomplete.\n\nIt is re-queued automatically.",
  });
  const list = "A student repository exists that PXL Classroom has no record of.\n\n- `lab-ann` (assignment lab)\n- `lab-bob` (assignment lab)";
  assert.equal(noticeLines(list).first, "A student repository exists that PXL Classroom has no record of.");
  assert.equal(noticeLines(list).rest, "- lab-ann (assignment lab)\n- lab-bob (assignment lab)");
  assert.deepEqual(noticeLines("One line"), { first: "One line", rest: "" });
  assert.deepEqual(noticeLines(""), { first: "", rest: "" });
});

test("details are words, not markdown", () => {
  assert.equal(plainDetails("Press **Retry** for `ann` - [View workflow run](https://x)"), "Press Retry for ann - View workflow run");
});
