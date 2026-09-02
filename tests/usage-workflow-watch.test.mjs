import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("weekly usage dispatches expose a correlation ID and mint the billing permission", async () => {
  const workflow = await read(".github/workflows/weekly-usage-report.yml");
  assert.match(workflow, /request_id:/);
  assert.match(workflow, /run-name:.*inputs\.request_id/);
  assert.match(workflow, /permission-organization-administration: read/);
});

test("new organization setup probes Enhanced Billing before provisioning", async () => {
  const workflow = await read(".github/workflows/setup-org.yml");
  const probe = workflow.indexOf("Probe Enhanced Billing Usage API");
  const provision = workflow.indexOf("Create pxl-classroom-control repository");
  assert.ok(probe >= 0, "setup-org.yml must contain a billing preflight");
  assert.ok(provision > probe, "billing preflight must run before organization state is created");
  assert.match(workflow, /permission-organization-administration: read/);
});

test("all usage surfaces watch the correlated Actions run instead of polling stale reports", async () => {
  for (const path of [
    "frontend/src/components/UsagePanel.vue",
    "frontend/src/views/UsageView.vue",
  ]) {
    const source = await read(path);
    assert.match(source, /createWorkflowRequestId/);
    assert.match(source, /getWorkflowRunByRequestId/);
    assert.match(source, /request_id: requestId/);
    assert.doesNotMatch(source, /setInterval\(async \(\) =>/);
  }
});
