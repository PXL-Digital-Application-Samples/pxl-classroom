// lib/org-notices.mjs: the instructor notifications, read for the Organization page.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEDUP_MARKER, noticesNeedingYou, parseNotice, plainDetails } from "../lib/org-notices.mjs";

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

test("details are words, not markdown", () => {
  assert.equal(plainDetails("Press **Retry** for `ann` - [View workflow run](https://x)"), "Press Retry for ann - View workflow run");
});
