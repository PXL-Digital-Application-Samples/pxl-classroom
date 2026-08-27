// A lecturer must not read "Live" over a page that says "Registration cap
// reached".
//
// InvitationShare's status line is the STUDENT-FACING truth: it is gated on the
// same conditions AssignmentView uses to decide whether to show an Accept
// button. Its "Cap reached" branch compares `accepted_count` against
// `max_acceptances`.
//
// Two of its three callers never supplied `accepted_count`. AdminView builds
// its share object field by field (the comment there already warns that "a
// field omitted here is invisible to the share block", about the invite fields)
// and DashboardView passes a dashboard entry, which carries `accepted` and, before
// this change, no cap at all. `Number(undefined) || 0` is 0, so `accepted >=
// cap` was permanently false and the block read "Live - students can accept
// now" over a full cohort, on the two surfaces a lecturer actually looks at.
//
// The fix has two halves and both matter: give the callers the number they
// already hold, and make the component treat an ABSENT count as unknown rather
// than as zero - so a caller that forgets again degrades to "we cannot promise
// there is room" instead of to a false all-clear.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildDashboardEntry } from "../lib/dashboard-aggregate.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

function statusSource() {
  const src = read("frontend/src/components/InvitationShare.vue");
  const at = src.indexOf("const cap = Number(a.max_acceptances)");
  assert.ok(at > 0, "the cap check must still exist in InvitationShare");
  return src.slice(at, src.indexOf("})", at));
}

test("an absent accepted_count is treated as unknown, not as zero", () => {
  const body = statusSource();

  assert.ok(
    !/const accepted = Number\(a\.accepted_count\) \|\| 0\s*\n\s*if \(cap && accepted >= cap\)/.test(body),
    "coercing an absent count to 0 makes the cap check permanently false - the bug",
  );
  assert.match(body, /accepted_count !== undefined/, "it must distinguish absent from zero");
  assert.match(body, /countKnown/, "and gate the cap comparison on that");

  // And it must not promise room it cannot verify.
  assert.match(body, /while places remain/, "an unknown count with a cap in force must be hedged");
});

test("a known, full cohort still reports Cap reached", () => {
  const body = statusSource();
  const capBranch = body.slice(body.indexOf("if (cap &&"), body.indexOf("const room"));
  assert.match(capBranch, /Cap reached/, "the cap branch must survive");
  assert.match(capBranch, /countKnown/, "and only fire when the count is known");
});

test("every caller passes accepted_count, or the check cannot fire", () => {
  // The three surfaces. AssignmentDetailView was always correct; the other two
  // are the regression this file guards.
  const callers = [
    ["frontend/src/views/AdminView.vue", "banner"],
    ["frontend/src/views/DashboardView.vue", "compact"],
    ["frontend/src/views/AssignmentDetailView.vue", "inline"],
  ];
  for (const [file, variant] of callers) {
    const src = read(file);
    assert.ok(
      /accepted_count/.test(src),
      `${file} renders InvitationShare (${variant}) and must supply accepted_count`,
    );
  }
});

test("the dashboard entry carries the cap, so the compact variant can judge it", () => {
  const entry = buildDashboardEntry(
    { title: "T", state: "published", opens_at: null, deadline_at: null, timezone: "Europe/Brussels", max_acceptances: 50 },
    [{ acceptance_state: "accepted", repo_id: 1 }],
  );
  assert.equal(entry.max_acceptances, 50);
  assert.equal(entry.accepted, 1);

  // An assignment with no cap has no cap - never a substituted number.
  const uncapped = buildDashboardEntry(
    { title: "T", state: "published", opens_at: null, deadline_at: null, timezone: "Europe/Brussels" },
    [],
  );
  assert.equal(uncapped.max_acceptances, null, "absent must stay absent, not become a default");
});
