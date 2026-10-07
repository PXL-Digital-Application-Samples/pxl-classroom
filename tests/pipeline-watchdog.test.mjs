import { test } from "node:test";
import assert from "node:assert/strict";
import { runWatchdog, ranFor, watchedRun, pagesRedeployDue, RUN_LIST_CAP } from "../scripts/pipeline-watchdog.mjs";
import { REGISTRY_BRANCH } from "../lib/org-registry.mjs";

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

    if (urlStr.includes("/actions/runs?status=in_progress") || urlStr.includes("/actions/runs?status=completed") || urlStr.includes("/actions/runs?status=queued")) {
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
    if (urlStr.includes("/actions/runs?status=in_progress") || urlStr.includes("/actions/runs?status=completed") || urlStr.includes("/actions/runs?status=queued")) {
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

// 2026-10-03, run 37158975135: GitHub's code scanning on the registry branch,
// after Setup Organization registered PXL-3TIN-SE-26-27. The branch holds one
// YAML file, so CodeQL found no source and failed in 31 seconds, as it had on
// every registration since 2026-09-17 - and the alert said "failed after 46
// minutes". Replayed here beside a real failure on main.
test("runWatchdog - ignores the registry branch, and a failure says how long the run ran", async () => {
  const calls = [];
  const at = (minsAgo, plusSeconds = 0) => new Date(Date.now() - minsAgo * 60_000 + plusSeconds * 1000).toISOString();

  const codeqlOnRegistry = {
    id: 37158975135, name: `Push on ${REGISTRY_BRANCH}`, path: "dynamic/github-code-scanning/codeql",
    event: "dynamic", head_branch: REGISTRY_BRANCH, status: "completed", conclusion: "failure",
    created_at: at(46), run_started_at: at(46), updated_at: at(46, 31),
  };
  const deployOnMain = {
    id: 111222, name: "Deploy frontend to Pages", event: "push", head_branch: "main",
    status: "completed", conclusion: "failure",
    created_at: at(46), run_started_at: at(46), updated_at: at(46, 31),
  };
  const stuckOnRegistry = {
    id: 333444, name: `Push on ${REGISTRY_BRANCH}`, event: "dynamic", head_branch: REGISTRY_BRANCH,
    status: "waiting", created_at: at(25),
  };

  const originalFetch = globalThis.fetch;
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  globalThis.fetch = async (url, opts) => {
    const urlStr = String(url);
    const method = opts?.method || "GET";
    calls.push({ method, url: urlStr, body: opts?.body ? JSON.parse(opts.body) : null });
    if (urlStr.includes("/actions/runs?status=waiting")) return json({ workflow_runs: [stuckOnRegistry] });
    if (urlStr.includes("/actions/runs?status=in_progress")) return json({ workflow_runs: [] });
    if (urlStr.includes("/actions/runs?status=queued")) return json({ workflow_runs: [] });
    if (urlStr.includes("/actions/runs?status=completed")) return json({ workflow_runs: [codeqlOnRegistry, deployOnMain] });
    if (urlStr.includes("/issues?labels=pxl-tracking")) return json([{ number: 20, title: "[NOTICE] PXL Classroom - Pipeline Watchdog Alerts" }]);
    if (urlStr.includes("/issues/20/comments")) return method === "GET" ? json([]) : json({ id: 1 }, 201);
    return json({});
  };

  try {
    const res = await runWatchdog({
      owner: "hub-owner", repo: "hub-repo", token: "mock-token",
      alertLevel: "stuck_and_failures", autoCancel: true, notifyLogins: ["tomcoolpxl"],
    });

    assert.deepEqual(res.failedRuns.map((r) => r.id), [111222], "only the failure on main is the pipeline's");
    assert.deepEqual(res.stuckRuns, [], "a run on the registry branch is not stuck pipeline either");
    assert.ok(!calls.some((c) => c.method === "POST" && c.url.includes("/cancel")), "and it is never cancelled");

    const posted = calls.filter((c) => c.method === "POST" && c.url.includes("/issues/20/comments"));
    assert.equal(posted.length, 1);
    assert.match(posted[0].body.body, /#111222\*\* failed after running for 31 seconds\./);
    assert.doesNotMatch(posted[0].body.body, /46 minutes/, "how long ago it failed is not how long it ran");
    assert.doesNotMatch(posted[0].body.body, /37158975135/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ranFor - the run's own duration, or nothing when GitHub did not say", () => {
  assert.equal(ranFor({ run_started_at: "2026-10-03T22:35:38Z", updated_at: "2026-10-03T22:36:09Z" }), "31 seconds");
  assert.equal(ranFor({ created_at: "2026-10-03T22:00:00Z", updated_at: "2026-10-03T22:46:00Z" }), "46 minutes");
  assert.equal(ranFor({ updated_at: "2026-10-03T22:36:09Z" }), null);
  assert.equal(ranFor({ run_started_at: "2026-10-03T22:36:09Z", updated_at: "2026-10-03T22:35:38Z" }), null);
});

test("watchedRun - the registry branch is not the pipeline; every other branch is", () => {
  assert.equal(watchedRun({ head_branch: REGISTRY_BRANCH }), false);
  assert.equal(watchedRun({ head_branch: "main" }), true);
  assert.equal(watchedRun({ head_branch: "beta" }), true);
  assert.equal(watchedRun({}), true, "a run with no branch is still watched");
});

// One page was the whole read: 20 finished runs every 30 minutes, while an
// acceptance burst finishes more (38 runs between 09:55 and 10:40 UTC on
// 2026-10-02). A fake GitHub that pages like the real one, Link header and all.
function pagingGitHub({ completedPages, calls }) {
  const json = (body, status = 200, headers = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  return async (url, opts) => {
    const u = new URL(String(url));
    const method = opts?.method || "GET";
    calls.push({ method, url: u.href, body: opts?.body ? JSON.parse(opts.body) : null });
    if (u.pathname.endsWith("/actions/runs") && u.searchParams.get("status") === "completed") {
      const page = Number(u.searchParams.get("page") || 1);
      const next = new URL(u.href);
      next.searchParams.set("page", String(page + 1));
      const link = page < completedPages.length ? { link: `<${next.href}>; rel="next"` } : {};
      return json({ total_count: completedPages.flat().length, workflow_runs: completedPages[page - 1] || [] }, 200, link);
    }
    if (u.pathname.endsWith("/actions/runs")) return json({ total_count: 0, workflow_runs: [] });
    if (u.pathname.endsWith("/issues") && method === "GET") return json([{ number: 30, title: "[NOTICE] PXL Classroom - Pipeline Watchdog Alerts" }]);
    if (u.pathname.endsWith("/issues/30/comments")) return method === "GET" ? json([]) : json({ id: 1 }, 201);
    return json({});
  };
}

const finished = (id, conclusion, minsAgo) => ({
  id, name: `Accept assignment`, event: "repository_dispatch", head_branch: "main", status: "completed", conclusion,
  created_at: new Date(Date.now() - (minsAgo + 1) * 60_000).toISOString(),
  run_started_at: new Date(Date.now() - (minsAgo + 1) * 60_000).toISOString(),
  updated_at: new Date(Date.now() - minsAgo * 60_000).toISOString(),
});

test("runWatchdog - a failure on the SECOND page of finished runs is reported", async () => {
  const calls = [];
  const pageOne = Array.from({ length: 100 }, (_, i) => finished(5000 + i, "success", 2));
  const pageTwo = [finished(6001, "failure", 25), finished(6002, "success", 26)];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = pagingGitHub({ completedPages: [pageOne, pageTwo], calls });
  try {
    const res = await runWatchdog({
      owner: "hub-owner", repo: "hub-repo", token: "mock-token",
      alertLevel: "stuck_and_failures", autoCancel: true, notifyLogins: ["tomcoolpxl"],
    });
    assert.deepEqual(res.failedRuns.map((r) => r.id), [6001]);
    assert.equal(res.outcome, "notified");

    // It asked for finished runs CREATED within six hours: a run is listed by
    // when it started, and the deadline sentinel can run for 4h45m before it
    // fails. The hour that is reported is judged on when the run finished.
    // The repository-wide list, not the deploy workflow's own (deployHistory).
    const finishedList = (c) => c.url.includes("/actions/runs?") && c.url.includes("status=completed");
    const first = new URL(calls.find(finishedList).url);
    const since = Date.parse(first.searchParams.get("created").replace(/^>=/, ""));
    assert.ok(Math.abs(Date.now() - 6 * 3600_000 - since) < 60_000, `created filter was ${first.searchParams.get("created")}`);
    assert.equal(first.searchParams.get("per_page"), "100");
    assert.equal(calls.filter(finishedList).length, 2, "both pages were read");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("runWatchdog - a list at GitHub's cap is not an all-clear, at any alert level", async () => {
  const calls = [];
  const capped = Array.from({ length: RUN_LIST_CAP }, (_, i) => finished(7000 + i, "success", 5));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = pagingGitHub({ completedPages: [capped], calls });
  try {
    // critical_only would say nothing about failures at all - and still has
    // to say that it could not see.
    const res = await runWatchdog({
      owner: "hub-owner", repo: "hub-repo", token: "mock-token",
      alertLevel: "critical_only", autoCancel: true, notifyLogins: ["tomcoolpxl"],
    });
    assert.equal(res.outcome, "incomplete");
    assert.deepEqual(res.capped, ["finished"]);
    const posted = calls.filter((c) => c.method === "POST" && c.url.includes("/issues/30/comments"));
    assert.equal(posted.length, 1);
    assert.match(posted[0].body.body, /could not read every run/);
    assert.match(posted[0].body.body, /pxl-watchdog-dedup:incomplete-\d{4}-\d\d-\d\dT\d\d-->/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// --- student pages behind the data -------------------------------------------

const T = (hhmm) => Date.parse(`2026-10-06T${hhmm}:00Z`);
const run = (file, conclusion, hhmm, status = "completed") => ({
  path: `.github/workflows/${file}`, conclusion, status, created_at: new Date(T(hhmm) - 60_000).toISOString(), updated_at: new Date(T(hhmm)).toISOString(),
});
const deploy = (conclusion, hhmm) => run("deploy-frontend.yml", conclusion, hhmm);
const regen = (conclusion, hhmm) => run("regenerate-dashboard.yml", conclusion, hhmm);

test("pagesRedeployDue - 2026-10-06: a publish's deploy failed on one 504, and nothing else came", () => {
  // As it would have been had the lecturer not published again: regenerated
  // 19:40, its deploy failed 19:41. The next scan, 20:10, deploys.
  const completed = [deploy("success", "19:29"), regen("success", "19:40"), deploy("failure", "19:41")];
  assert.deepEqual(pagesRedeployDue({ completed, now: T("20:10") }), { due: true, reason: "the newest deploy failed" });
  // Inside the grace the ordinary path may still be on it.
  assert.equal(pagesRedeployDue({ completed, now: T("19:45") }).due, false);
  // And once the lecturer's second publish deployed, nothing is due.
  const after = [...completed, regen("success", "19:56"), deploy("success", "19:57")];
  assert.equal(pagesRedeployDue({ completed: after, now: T("20:10") }).due, false);
});

test("pagesRedeployDue - a regeneration whose dispatch never started a deploy is caught too", () => {
  // The dispatch is the regeneration's last job, so a failed one fails its run.
  const completed = [deploy("success", "19:00"), regen("failure", "19:30")];
  assert.deepEqual(pagesRedeployDue({ completed, now: T("19:45") }), {
    due: true, reason: "the data was regenerated after the last successful deploy",
  });
});

test("pagesRedeployDue - nothing is due while a deploy is on its way, queued included", () => {
  const completed = [deploy("success", "19:00"), regen("success", "19:30")];
  for (const status of ["queued", "waiting", "in_progress"]) {
    assert.equal(pagesRedeployDue({ completed, active: [run("deploy-frontend.yml", null, "19:31", status)], now: T("20:00") }).due, false, status);
  }
  // Another workflow running is not a deploy.
  assert.equal(pagesRedeployDue({ completed, active: [run("ci.yml", null, "19:31", "in_progress")], now: T("20:00") }).due, true);
});

test("pagesRedeployDue - three failed deploys in a row are alerted, not retried again", () => {
  const completed = [deploy("success", "18:00"), deploy("failure", "18:30"), deploy("failure", "19:00"), deploy("failure", "19:30")];
  const verdict = pagesRedeployDue({ completed, now: T("20:30") });
  assert.equal(verdict.due, false);
  assert.match(verdict.reason, /3 deploys in a row failed/);
  // A cancelled deploy is neither a failure nor a success.
  const withCancel = [deploy("success", "18:00"), deploy("failure", "18:30"), deploy("cancelled", "19:00"), deploy("failure", "19:30")];
  assert.equal(pagesRedeployDue({ completed: withCancel, now: T("20:30") }).due, true);
});

test("pagesRedeployDue - pages as new as the data need nothing", () => {
  assert.equal(pagesRedeployDue({ completed: [regen("success", "19:00"), deploy("success", "19:02")], now: T("20:00") }).due, false);
  assert.equal(pagesRedeployDue({ completed: [], now: T("20:00") }).due, false);
  // A cancelled regeneration changed nothing it could publish.
  assert.equal(pagesRedeployDue({ completed: [deploy("success", "19:00"), regen("cancelled", "19:30")], now: T("20:00") }).due, false);
});

// --- review 2026-10-07 ---------------------------------------------------------

const keptDeploy = (hhmm) => ({ ...deploy("success", hhmm), kept: true });

test("pagesRedeployDue - a deploy that KEPT an org's old pages is behind, not up to date", () => {
  // One 502 for one org: that org kept its old pages, the deploy succeeded,
  // and the publish that triggered it never reached its students.
  const completed = [regen("success", "19:40")];
  const deploys = [deploy("success", "19:00"), keptDeploy("19:42")];
  assert.deepEqual(pagesRedeployDue({ completed, deploys, now: T("20:00") }), {
    due: true, reason: "the newest deploy kept an organization's old pages",
  });
  assert.equal(pagesRedeployDue({ completed, deploys, now: T("19:45") }).due, false, "after the grace, like a failure");
  // The redeploy read every org: nothing more is due.
  assert.equal(pagesRedeployDue({ completed, deploys: [...deploys, deploy("success", "20:05")], now: T("20:30") }).due, false);
});

test("pagesRedeployDue - three deploys that failed or kept an org stop the retries, however long ago", () => {
  // The scan's six-hour window forgot a failure as it aged, so a deploy that
  // always fails was retried three times every six hours, for ever. The
  // history is the deploy workflow's own list, whatever its age.
  const deploys = [deploy("success", "01:00"), deploy("failure", "02:00"), keptDeploy("03:00"), deploy("failure", "04:00")];
  const verdict = pagesRedeployDue({ completed: [], deploys, now: T("23:00") });
  assert.equal(verdict.due, false);
  assert.match(verdict.reason, /3 deploys in a row failed or kept/);
});

function stubRuns(routes) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const method = opts.method || "GET";
    const href = String(url);
    calls.push({ method, url: href, body: opts.body ? JSON.parse(opts.body) : null });
    for (const [pattern, answer] of routes) {
      if (pattern.test(href) && (!answer.method || answer.method === method)) {
        return answer.status === 204
          ? new Response(null, { status: 204 })
          : new Response(JSON.stringify(answer.body ?? {}), { status: answer.status ?? 200, headers: { "content-type": "application/json" } });
      }
    }
    return new Response(JSON.stringify({ workflow_runs: [] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const at = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const deployRun = (id, conclusion, minutesAgo, event = "workflow_dispatch") => ({
  id, path: ".github/workflows/deploy-frontend.yml", status: "completed", conclusion, event,
  created_at: at(minutesAgo + 2), updated_at: at(minutesAgo),
});
const keptJobs = { jobs: [{ steps: [{ name: "Tell an administrator about organizations kept as they were", conclusion: "success" }] }] };
const cleanJobs = { jobs: [{ steps: [{ name: "Tell an administrator about organizations kept as they were", conclusion: "skipped" }] }] };

test("deployHistory - reads whether a deploy kept an org only as far as the decision needs, and only ours", async () => {
  const { deployHistory } = await import("../scripts/pipeline-watchdog.mjs");
  const gh = stubRuns([
    [/actions\/workflows\/deploy-frontend\.yml\/runs/, { body: { workflow_runs: [
      deployRun(5, "success", 10, "pull_request"), // a fork's run of a file by this name
      deployRun(4, "success", 20),
      deployRun(3, "failure", 30),
      deployRun(2, "success", 40),
      deployRun(1, "success", 50),
    ] } }],
    [/actions\/runs\/4\/jobs/, { body: keptJobs }],
    [/actions\/runs\/3\/jobs/, { body: { jobs: [{ name: "build", conclusion: "failure", steps: [] }, { name: "deploy", conclusion: "skipped", steps: [] }] } }],
    [/actions\/runs\/2\/jobs/, { body: cleanJobs }],
  ]);
  try {
    const history = await deployHistory({ owner: "o", repo: "r", ghOpts: { token: "t", throwOnError: true } });
    assert.deepEqual(history.map((r) => [r.id, r.conclusion, r.kept]), [[4, "success", true], [3, "failure", false], [2, "success", false]]);
    const jobReads = gh.calls.filter((c) => /\/jobs/.test(c.url)).map((c) => c.url.match(/runs\/(\d+)\/jobs/)[1]);
    assert.deepEqual(jobReads, ["4", "3", "2"], "never the fork's run, and nothing past the first up-to-date deploy");
  } finally {
    gh.restore();
  }
});

test("deployHistory - a run failed by the beta build, whose pages went live, is a deploy that worked", async () => {
  // The run also builds the beta channel; a beta that failed failed the run,
  // and the watchdog redeployed good pages and then stopped retrying real ones.
  const { deployHistory } = await import("../scripts/pipeline-watchdog.mjs");
  const gh = stubRuns([
    [/actions\/workflows\/deploy-frontend\.yml\/runs/, { body: { workflow_runs: [deployRun(8, "failure", 20)] } }],
    [/actions\/runs\/8\/jobs/, { body: { jobs: [{ name: "build-beta", conclusion: "failure", steps: [] }, { name: "build", conclusion: "success", steps: [] }, { name: "deploy", conclusion: "success", steps: [] }] } }],
  ]);
  try {
    const history = await deployHistory({ owner: "o", repo: "r", ghOpts: { token: "t", throwOnError: true } });
    assert.deepEqual(history.map((r) => [r.id, r.conclusion, r.kept]), [[8, "success", false]]);
    assert.equal(pagesRedeployDue({ completed: [], deploys: history, now: Date.now() }).due, false);
  } finally {
    gh.restore();
  }
});

test("runWatchdog - a redeploy GitHub refuses is alerted, and every other alert still goes out", async () => {
  // The dispatch threw straight out of the scan: a 502 on it skipped the
  // stuck and failed runs' alerts, scan after scan.
  const gh = stubRuns([
    [/status=completed&created/, { body: { workflow_runs: [
      { id: 50, name: "Regenerate Dashboard", path: ".github/workflows/regenerate-dashboard.yml", status: "completed", conclusion: "failure", event: "workflow_dispatch", created_at: at(32), updated_at: at(30), html_url: "https://x/50" },
    ] } }],
    [/actions\/workflows\/deploy-frontend\.yml\/runs/, { body: { workflow_runs: [deployRun(9, "success", 120)] } }],
    [/actions\/runs\/9\/jobs/, { body: cleanJobs }],
    [/deploy-frontend\.yml\/dispatches/, { method: "POST", status: 502, body: { message: "Bad Gateway" } }],
    [/issues\?labels=pxl-tracking/, { body: [{ number: 7, title: "[NOTICE] PXL Classroom - Pipeline Watchdog Alerts" }] }],
    [/issues\/7\/comments/, { method: "GET", body: [] }],
    [/issues\/7\/comments/, { method: "POST", status: 201, body: { id: 1 } }],
  ]);
  try {
    const res = await runWatchdog({ owner: "o", repo: "r", token: "t", alertLevel: "stuck_and_failures", autoCancel: true, notifyLogins: [] });
    assert.equal(res.pagesRedeploy.due, true);
    assert.match(res.pagesRedeploy.failed, /502/);
    const posted = gh.calls.filter((c) => c.method === "POST" && /issues\/7\/comments/.test(c.url)).map((c) => c.body.body);
    assert.ok(posted.some((b) => /pxl-watchdog-dedup:failed-50-->/.test(b)), "the failed run's alert still went out");
    assert.ok(posted.some((b) => /Student pages are behind, and the deploy could not be started/.test(b)), "and the refused redeploy is said");
  } finally {
    gh.restore();
  }
});

test("runWatchdog - a stuck deploy whose replacement could not be dispatched is not reported as re-dispatched", async () => {
  const gh = stubRuns([
    [/status=waiting/, { body: { workflow_runs: [
      { id: 77, name: "Deploy frontend to Pages", path: ".github/workflows/deploy-frontend.yml", status: "waiting", event: "workflow_dispatch", created_at: at(25), html_url: "https://x/77" },
    ] } }],
    [/actions\/runs\/77\/cancel/, { method: "POST", status: 202, body: {} }],
    [/deploy-frontend\.yml\/dispatches/, { method: "POST", status: 502, body: { message: "Bad Gateway" } }],
    [/issues\?labels=pxl-tracking/, { body: [{ number: 7, title: "[NOTICE] PXL Classroom - Pipeline Watchdog Alerts" }] }],
    [/issues\/7\/comments/, { method: "GET", body: [] }],
    [/issues\/7\/comments/, { method: "POST", status: 201, body: { id: 1 } }],
  ]);
  try {
    const res = await runWatchdog({ owner: "o", repo: "r", token: "t", alertLevel: "stuck_and_failures", autoCancel: true, notifyLogins: [] });
    assert.notEqual(res.pagesRedeploy.reason, "re-dispatched after cancelling a stuck deploy");
  } finally {
    gh.restore();
  }
});
