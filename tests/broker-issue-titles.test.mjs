// The titles a broker's issues carry, and the list that must not drift.
//
// `HANDLED_ISSUE_TITLES` is written by acceptance/broker-workflow.yml and
// spelled again in lib/broker-issue-titles.mjs. That is the shape this
// repository keeps getting wrong, so the set is DERIVED from the template here
// and compared in both directions: a reworded redaction fails this test rather
// than quietly making every handled acceptance look like a stray issue on
// somebody's System Health panel.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  isAcceptanceIssueTitle,
  HANDLED_ISSUE_TITLES,
  HANDLED_TITLE_BY_PURPOSE,
  REJECTED_ISSUE_TITLE,
  handledTitleFor,
} from "../lib/broker-issue-titles.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = readFileSync(join(ROOT, "acceptance/broker-workflow.yml"), "utf8");

/** Every `gh issue edit --title` the template can perform, with $LABEL expanded. */
function titlesTheBrokerWrites() {
  const labels = [...TEMPLATE.matchAll(/LABEL="([^"]+)"/g)].map((m) => m[1]);
  const titles = [...TEMPLATE.matchAll(/--title "([^"]+)"/g)].map((m) => m[1]);
  assert.ok(labels.length > 0, "the template must still set LABEL for the redacted title");
  assert.ok(titles.length > 0, "the template must still redact with gh issue edit --title");

  const out = new Set();
  for (const title of titles) {
    if (title.includes("$LABEL")) {
      for (const label of labels) out.add(title.replaceAll("$LABEL", label));
    } else {
      out.add(title);
    }
  }
  return out;
}

test("the declared list is exactly what the broker writes", () => {
  const written = titlesTheBrokerWrites();
  assert.deepEqual(
    [...written].sort(),
    [...HANDLED_ISSUE_TITLES].sort(),
    "lib/broker-issue-titles.mjs and acceptance/broker-workflow.yml disagree about the redacted titles",
  );
});

test("every title the broker leaves is recognised as ours", () => {
  // THE REGRESSION. `!title.startsWith("pxl-accept:")` called all of these
  // stray, and the broker leaves them OPEN on purpose, so System Health
  // reported every successful acceptance as an untidy issue - 11 of 11 on
  // PXL-2TIW-DevOps-2627/broker-groepsindeling, measured 2026-09-22.
  for (const title of titlesTheBrokerWrites()) {
    assert.ok(isAcceptanceIssueTitle(title), `${JSON.stringify(title)} must be recognised`);
  }
});

test("a title the student's browser opens is recognised too", () => {
  assert.ok(isAcceptanceIssueTitle("pxl-accept:a1.AQID.BAUG"));
  assert.ok(isAcceptanceIssueTitle("pxl-accept:a1.AQID.BAUG team:rojaro"));
  assert.ok(isAcceptanceIssueTitle("pxl-confirm:a1.AQID.BAUG"));
});

test("an issue somebody else opened is not ours", () => {
  // This is what the stray sweep is actually for, and it still fires.
  assert.equal(isAcceptanceIssueTitle("Please help, I cannot push"), false);
  assert.equal(isAcceptanceIssueTitle("Acceptance"), false);
  assert.equal(isAcceptanceIssueTitle("processed"), false);
  assert.equal(isAcceptanceIssueTitle(""), false);
  assert.equal(isAcceptanceIssueTitle(null), false);
  assert.equal(isAcceptanceIssueTitle(undefined), false);
  assert.equal(isAcceptanceIssueTitle(42), false);
});

test("surrounding whitespace does not make one of ours a stranger", () => {
  assert.ok(isAcceptanceIssueTitle("  Acceptance (processed)  "));
});

test("what a handled issue becomes is one of the titles the broker writes", () => {
  // The purpose -> title map is a third spelling of the same strings, so it is
  // checked against the derived set rather than trusted. The e2e fixture uses
  // it to rewrite titles the way the real broker does.
  const written = titlesTheBrokerWrites();
  for (const [purpose, title] of Object.entries(HANDLED_TITLE_BY_PURPOSE)) {
    assert.ok(written.has(title), `${purpose} -> ${JSON.stringify(title)} is not a title the broker writes`);
  }
  assert.ok(written.has(REJECTED_ISSUE_TITLE));

  assert.equal(handledTitleFor("pxl-accept:a1.AQID.BAUG"), "Acceptance (processed)");
  assert.equal(handledTitleFor("pxl-accept:a1.AQID.BAUG team:rojaro"), "Acceptance (processed)");
  assert.equal(handledTitleFor("pxl-confirm:a1.AQID.BAUG"), "Email confirmation (processed)");
  assert.equal(handledTitleFor("pxl-accept:a1.AQID.BAUG", { rejected: true }), REJECTED_ISSUE_TITLE);

  // Anything already handled, or never ours, is left exactly as it is - so a
  // spec that seeds a redacted title gets that title back.
  assert.equal(handledTitleFor("Acceptance (processed)"), "Acceptance (processed)");
  assert.equal(handledTitleFor("Please help"), "Please help");
  assert.equal(handledTitleFor(undefined), "");
});
