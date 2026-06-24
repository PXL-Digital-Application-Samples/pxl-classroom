import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDashboardEntry } from "../lib/dashboard-aggregate.mjs";

test("buildDashboardEntry computes truth table", () => {
  const assignment = {
    title: "Test Assignment",
    state: "published",
    opens_at: "2026-01-01T00:00:00Z",
    deadline_at: "2026-01-02T00:00:00Z",
  };

  const students = [
    { acceptance_state: "not-accepted" },
    { acceptance_state: "accepted", repo_id: null },
    { acceptance_state: "accepted", repo_id: 1, submission_status: "on-time" },
    { acceptance_state: "accepted", repo_id: 2, submission_status: "late", warnings: ["warn1"] },
    { acceptance_state: "accepted", repo_id: 3, submission_status: "no-submission", warnings: [] },
  ];

  const entry = buildDashboardEntry(assignment, students);

  assert.equal(entry.title, "Test Assignment");
  assert.equal(entry.state, "published");
  assert.equal(entry.opens_at, "2026-01-01T00:00:00Z");
  assert.equal(entry.deadline_at, "2026-01-02T00:00:00Z");
  
  assert.equal(entry.total_students, 5);
  assert.equal(entry.accepted, 4);
  assert.equal(entry.provisioned, 3);
  assert.equal(entry.on_time, 1);
  assert.equal(entry.late, 1);
  assert.equal(entry.no_submission, 1);
  assert.equal(entry.with_warnings, 1);
  
  assert.ok(entry.generated_at);
});
