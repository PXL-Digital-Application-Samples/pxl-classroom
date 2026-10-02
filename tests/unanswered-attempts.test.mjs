// lib/unanswered-attempts.mjs: which acceptance attempts the nightly reports
// to the lecturer as having got no answer at all.

import { test } from "node:test";
import assert from "node:assert/strict";
import { UNANSWERED_SETTLE_MS, UNANSWERED_WINDOW_MS, unansweredAttempts } from "../lib/unanswered-attempts.mjs";

const now = new Date("2026-10-03T02:00:00Z");
const ago = (min) => new Date(now.getTime() - min * 60_000).toISOString();
const issue = (number, login, title, minutesAgo, labels = []) => ({
  number,
  title,
  created_at: ago(minutesAgo),
  user: { login },
  labels: labels.map((name) => ({ name })),
});
const none = () => null;

test("an attempt handed over and never answered is reported", () => {
  const out = unansweredAttempts({ issues: [issue(66, "Sabri", "Acceptance (processed)", 600)], acceptanceOf: none, now });
  assert.deepEqual(out, [{ login: "Sabri", number: 66, created_at: ago(600), stage: "no-answer" }]);
});

test("where it stopped is read off the title", () => {
  const out = unansweredAttempts({
    issues: [
      issue(1, "a", "pxl-accept:k1.AAAA.BBBB team:x", 600),
      issue(2, "b", "Acceptance (not delivered)", 600),
      issue(3, "c", "Acceptance (processed)", 600),
    ],
    acceptanceOf: none,
    now,
  });
  assert.deepEqual(out.map((o) => o.stage), ["not-started", "not-delivered", "no-answer"]);
});

test("an answer of any kind is an answer", () => {
  const out = unansweredAttempts({
    issues: [
      issue(10, "invited", "Acceptance (processed)", 600, ["outcome:invited"]),
      issue(11, "refused", "Acceptance (processed)", 600, ["outcome:rejected"]),
      issue(12, "brokerRefused", "Acceptance attempt (rejected)", 600),
      issue(13, "decided", "Acceptance (processed)", 600),
      issue(14, "legacy", "Acceptance (processed)", 600),
    ],
    acceptanceOf: (login) =>
      login === "decided" ? { issue_number: 13 } : login === "legacy" ? { status: "provisioned" } : null,
    now,
  });
  assert.deepEqual(out, []);
});

test("a decision for an OLDER attempt does not answer a newer one", () => {
  // A team switch GitHub dropped: the record still names the first join.
  const out = unansweredAttempts({
    issues: [issue(20, "s", "Acceptance (processed)", 600)],
    acceptanceOf: () => ({ issue_number: 12 }),
    now,
  });
  assert.equal(out.length, 1);
});

test("only the newest attempt per student is judged", () => {
  const out = unansweredAttempts({
    issues: [
      issue(61, "Sabri", "Acceptance (processed)", 700),
      issue(64, "Sabri", "Acceptance (processed)", 690),
      issue(68, "Sabri", "Acceptance (processed)", 680),
    ],
    acceptanceOf: () => ({ issue_number: 68 }),
    now,
  });
  assert.deepEqual(out, [], "the newest was decided; the older ones were overtaken");
});

test("too recent may still be running, too old was reported already", () => {
  const settle = UNANSWERED_SETTLE_MS / 60_000;
  const windowMin = UNANSWERED_WINDOW_MS / 60_000;
  const out = unansweredAttempts({
    issues: [
      issue(1, "fresh", "Acceptance (processed)", settle - 1),
      issue(2, "old", "Acceptance (processed)", windowMin + 1),
      issue(3, "inside", "Acceptance (processed)", settle + 1),
    ],
    acceptanceOf: none,
    now,
  });
  assert.deepEqual(out.map((o) => o.login), ["inside"]);
});

test("an email confirmation and an unrelated issue are not acceptance attempts", () => {
  const out = unansweredAttempts({
    issues: [
      issue(1, "a", "pxl-confirm:k1.AAAA.BBBB", 600),
      issue(2, "b", "Email confirmation (processed)", 600),
      issue(3, "c", "Email confirmation (not delivered)", 600),
      issue(4, "d", "Please help", 600),
    ],
    acceptanceOf: none,
    now,
  });
  assert.deepEqual(out, []);
});
