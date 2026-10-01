import { test } from "node:test";
import assert from "node:assert/strict";
import { runWatchdog } from "../scripts/pipeline-watchdog.mjs";

test("runWatchdog - skips when alertLevel is off", async () => {
  const result = await runWatchdog({
    owner: "hub-owner",
    repo: "hub-repo",
    token: "mock-token",
    alertLevel: "off",
    autoCancel: false,
    notifyLogins: ["tomcoolpxl"],
  });

  assert.equal(result.outcome, "skipped_disabled");
});

test("runWatchdog - detects stuck runs, auto-cancels, and posts alerts with mentions", async () => {
  const calls = [];
  const twentyFiveMinsAgo = new Date(Date.now() - 25 * 60 * 1000).toISOString();

  // Mock global fetch for gh() calls
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const urlStr = String(url);
    const method = opts?.method || "GET";
    calls.push({ method, url: urlStr, body: opts?.body ? JSON.parse(opts.body) : null });

    if (urlStr.includes("/actions/runs?status=waiting")) {
      return new Response(
        JSON.stringify({
          workflow_runs: [
            {
              id: 998877,
              name: "Deploy frontend to Pages",
              status: "waiting",
              event: "workflow_dispatch",
              created_at: twentyFiveMinsAgo,
              html_url: "https://github.com/hub-owner/hub-repo/actions/runs/998877",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }

    if (urlStr.includes("/actions/runs?status=in_progress") || urlStr.includes("/actions/runs?status=completed")) {
      return new Response(JSON.stringify({ workflow_runs: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    // Cancel call
    if (urlStr.includes("/actions/runs/998877/cancel")) {
      return new Response(JSON.stringify({}), { status: 202, headers: { "content-type": "application/json" } });
    }

    // Workflow dispatch re-trigger
    if (urlStr.includes("/actions/workflows/deploy-frontend.yml/dispatches")) {
      return new Response(null, { status: 204 });
    }

    // Issues lookup
    if (urlStr.includes("/issues?labels=pxl-tracking")) {
      return new Response(
        JSON.stringify([
          {
            number: 42,
            title: "[NOTICE] PXL Classroom - Pipeline Watchdog Alerts",
          },
        ]),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }

    // Issue comments lookup
    if (urlStr.includes("/issues/42/comments")) {
      if (method === "GET") {
        return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "POST") {
        return new Response(JSON.stringify({ id: 101 }), { status: 201, headers: { "content-type": "application/json" } });
      }
    }

    return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const res = await runWatchdog({
      owner: "hub-owner",
      repo: "hub-repo",
      token: "mock-token",
      alertLevel: "stuck_and_failures",
      autoCancel: true,
      notifyLogins: ["tomcoolpxl"],
    });

    assert.equal(res.outcome, "notified");
    assert.equal(res.stuckRuns.length, 1);
    assert.deepEqual(res.cancelledRuns, [998877]);

    // Verify cancellation was issued
    const cancelCall = calls.find((c) => c.method === "POST" && c.url.includes("/runs/998877/cancel"));
    assert.ok(cancelCall, "Should have called cancel for zombie run");

    // Verify deploy-frontend was re-dispatched
    const dispatchCall = calls.find(
      (c) => c.method === "POST" && c.url.includes("/actions/workflows/deploy-frontend.yml/dispatches")
    );
    assert.ok(dispatchCall, "Should have re-dispatched deploy-frontend.yml");

    // Verify comment with @tomcoolpxl mention was posted
    const commentCall = calls.find((c) => c.method === "POST" && c.url.includes("/issues/42/comments"));
    assert.ok(commentCall, "Should have posted an alert comment to issue #42");
    assert.match(commentCall.body?.body, /@tomcoolpxl/);
    assert.match(commentCall.body?.body, /pxl-watchdog-dedup:stuck-998877/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("runWatchdog - deduplicates alerts when marker is already present", async () => {
  const calls = [];
  const thirtyMinsAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const urlStr = String(url);
    const method = opts?.method || "GET";
    calls.push({ method, url: urlStr, body: opts?.body ? JSON.parse(opts.body) : null });

    if (urlStr.includes("/actions/runs?status=waiting")) {
      return new Response(
        JSON.stringify({
          workflow_runs: [
            {
              id: 554433,
              name: "Regenerate Dashboard Data",
              status: "waiting",
              event: "workflow_dispatch",
              created_at: thirtyMinsAgo,
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (urlStr.includes("/actions/runs?status=in_progress") || urlStr.includes("/actions/runs?status=completed")) {
      return new Response(JSON.stringify({ workflow_runs: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (urlStr.includes("/actions/runs/554433/cancel")) {
      return new Response(JSON.stringify({}), { status: 202, headers: { "content-type": "application/json" } });
    }
    if (urlStr.includes("/issues?labels=pxl-tracking")) {
      return new Response(
        JSON.stringify([{ number: 10, title: "[NOTICE] PXL Classroom - Pipeline Watchdog Alerts" }]),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (urlStr.includes("/issues/10/comments")) {
      if (method === "GET") {
        return new Response(
          JSON.stringify([
            {
              body: "<!-- pxl-watchdog-dedup:stuck-554433-->\nExisting alert comment",
            },
          ]),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const res = await runWatchdog({
      owner: "hub-owner",
      repo: "hub-repo",
      token: "mock-token",
      alertLevel: "stuck_and_failures",
      autoCancel: true,
      notifyLogins: ["tomcoolpxl"],
    });

    assert.equal(res.outcome, "notified");
    const postedComment = calls.find((c) => c.method === "POST" && c.url.includes("/issues/10/comments"));
    assert.equal(postedComment, undefined, "Should not have posted duplicate comment");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
