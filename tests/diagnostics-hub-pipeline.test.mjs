import { test } from "node:test";
import assert from "node:assert/strict";
import { checkHubPipelineHealth } from "../lib/diagnostics.mjs";

test("checkHubPipelineHealth - identifies runs stuck in waiting state over 15 minutes", async () => {
  const checks = [];
  const addCheck = (tierIdx, c) => checks.push({ tierIdx, ...c });
  const twentyMinsAgo = new Date(Date.now() - 20 * 60 * 1000).toISOString();

  const req = async (method, path) => {
    if (path.includes("status=waiting")) {
      return {
        ok: true,
        status: 200,
        data: {
          workflow_runs: [
            {
              id: 123456,
              name: "Deploy frontend to Pages",
              status: "waiting",
              created_at: twentyMinsAgo,
            },
          ],
        },
      };
    }
    if (path.includes("status=in_progress")) {
      return { ok: true, status: 200, data: { workflow_runs: [] } };
    }
    return { ok: false, status: 404 };
  };

  await checkHubPipelineHealth({
    req,
    addCheck,
    tierIdx: 5,
    tierId: "tier-5-pages",
    hubOwner: "hub-owner",
    hubRepo: "hub-repo",
  });

  assert.equal(checks.length, 1);
  const c = checks[0];
  assert.equal(c.severity, "fail");
  assert.equal(c.id, "hub-stuck-run-123456");
  assert.equal(c.fixAction?.type, "cancel_run");
  assert.equal(c.fixAction?.runId, 123456);
  assert.match(c.message, /stuck|waiting/i);
});

test("checkHubPipelineHealth - identifies runs stuck in in_progress state over 45 minutes", async () => {
  const checks = [];
  const addCheck = (tierIdx, c) => checks.push({ tierIdx, ...c });
  const fiftyMinsAgo = new Date(Date.now() - 50 * 60 * 1000).toISOString();

  const req = async (method, path) => {
    if (path.includes("status=waiting")) {
      return { ok: true, status: 200, data: { workflow_runs: [] } };
    }
    if (path.includes("status=in_progress")) {
      return {
        ok: true,
        status: 200,
        data: {
          workflow_runs: [
            {
              id: 789012,
              name: "Regenerate Dashboard Data",
              status: "in_progress",
              created_at: fiftyMinsAgo,
            },
          ],
        },
      };
    }
    return { ok: false, status: 404 };
  };

  await checkHubPipelineHealth({
    req,
    addCheck,
    tierIdx: 1,
    tierId: "tier-1-org",
    hubOwner: "hub-owner",
    hubRepo: "hub-repo",
  });

  assert.equal(checks.length, 1);
  const c = checks[0];
  assert.equal(c.severity, "fail");
  assert.equal(c.id, "hub-stuck-run-789012");
  assert.equal(c.fixAction?.type, "cancel_run");
  assert.equal(c.fixAction?.runId, 789012);
});

test("checkHubPipelineHealth - reports healthy when no stuck runs", async () => {
  const checks = [];
  const addCheck = (tierIdx, c) => checks.push({ tierIdx, ...c });
  const fiveMinsAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();

  const req = async (method, path) => {
    if (path.includes("status=waiting")) {
      return {
        ok: true,
        status: 200,
        data: {
          workflow_runs: [
            {
              id: 999,
              name: "Quick job",
              status: "waiting",
              created_at: fiveMinsAgo,
            },
          ],
        },
      };
    }
    if (path.includes("status=in_progress")) {
      return { ok: true, status: 200, data: { workflow_runs: [] } };
    }
    return { ok: false, status: 404 };
  };

  await checkHubPipelineHealth({
    req,
    addCheck,
    tierIdx: 5,
    tierId: "tier-5-pages",
    hubOwner: "hub-owner",
    hubRepo: "hub-repo",
  });

  assert.equal(checks.length, 1);
  const c = checks[0];
  assert.equal(c.severity, "ok");
  assert.equal(c.id, "hub-pipeline-health");
});

test("checkHubPipelineHealth - handles 404/API error gracefully without adding false alarms", async () => {
  const checks = [];
  const addCheck = (tierIdx, c) => checks.push({ tierIdx, ...c });

  const req = async () => ({ ok: false, status: 404 });

  await checkHubPipelineHealth({
    req,
    addCheck,
    tierIdx: 5,
    tierId: "tier-5-pages",
    hubOwner: "hub-owner",
    hubRepo: "hub-repo",
  });

  assert.equal(checks.length, 0);
});
