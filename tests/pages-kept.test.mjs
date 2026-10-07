// A Pages deploy that could not read an organization keeps that org's last
// pages and succeeds (scripts/fetch-pages-data.mjs keepPrevious). Three things
// hang off that, each found by the review of 2026-10-07:
//   - the watchdog must not read such a deploy as one that brought every page
//     up to date (lib/pages-kept.mjs: the run says so by a step that ran);
//   - the alert about it must never fail the deploy it reports on;
//   - "the previous deployment" must be this workflow's own, never an artifact
//     a fork's pull request uploaded under the same name.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { KEPT_STEP_NAME, keptAnOrganization } from "../lib/pages-kept.mjs";
import { reportKeptOrgs } from "../scripts/report-kept-orgs.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW = readFileSync(join(root, ".github/workflows/deploy-frontend.yml"), "utf8");
const steps = parse(WORKFLOW).jobs.build.steps;

test("the deploy says it kept an org by the step lib/pages-kept.mjs names, run only then", () => {
  const fetch = steps.find((s) => /fetch-pages-data\.mjs/.test(s.run || ""));
  assert.ok(fetch?.id, "the fetch step has an id its output can be read by");
  const report = steps.find((s) => s.name === KEPT_STEP_NAME);
  assert.ok(report, `a step named exactly "${KEPT_STEP_NAME}" - the watchdog reads it by that name`);
  assert.equal(report.if, `steps.${fetch.id}.outputs.kept == 'true'`, "and it runs only when an org was kept");
  assert.match(report.run, /report-kept-orgs\.mjs/);
});

test("keptAnOrganization: the step ran - not skipped, not absent", () => {
  const job = (conclusion) => [{ steps: [{ name: "Build", conclusion: "success" }, { name: KEPT_STEP_NAME, conclusion }] }];
  assert.equal(keptAnOrganization(job("success")), true);
  assert.equal(keptAnOrganization(job("failure")), true, "an alert that could not post still means an org was kept");
  assert.equal(keptAnOrganization(job("skipped")), false);
  assert.equal(keptAnOrganization(job(null)), false, "still running is not an answer");
  assert.equal(keptAnOrganization([{ steps: [{ name: "Build", conclusion: "success" }] }]), false);
  assert.equal(keptAnOrganization(undefined), false);
});

test("the previous deployment is this workflow's own successful run on main, never any artifact by that name", () => {
  const unpack = steps.find((s) => s.name === "Unpack the previous deployment").run;
  assert.doesNotMatch(unpack, /actions\/artifacts\?name=/, "not the repository-wide artifact list a fork can add to");
  assert.match(unpack, /actions\/workflows\/deploy-frontend\.yml\/runs\?branch=main&status=success/);
  assert.match(unpack, /head_repository\.id == \.repository\.id/, "from this repository");
  assert.match(unpack, /\.event == "push" or \.event == "workflow_dispatch"/, "and not a pull request's run");
  assert.match(unpack, /actions\/runs\/\$\{RUN\}\/artifacts\?name=github-pages/, "that run's own artifact");
  assert.match(unpack, /find "\$PREV" ! -type f ! -type d/, "and nothing in it but files and folders");
});

test("the deployed site is kept long enough to keep an org's pages from it after a quiet spell", () => {
  const upload = steps.find((s) => /upload-pages-artifact/.test(s.uses || ""));
  assert.ok(Number(upload.with["retention-days"]) >= 7, "the action's default is one day");
});

// --- the alert ----------------------------------------------------------------

function stubGitHub({ postStatus = 201 } = {}) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const method = opts.method || "GET";
    calls.push({ method, url: String(url), body: opts.body ? JSON.parse(opts.body) : null });
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (/\/issues\?labels=pxl-tracking/.test(url)) return json([{ number: 7, title: "[NOTICE] PXL Classroom - Pipeline Watchdog Alerts" }]);
    if (/\/issues\/7\/comments/.test(url) && method === "GET") return json([]);
    if (/\/issues\/7\/comments/.test(url) && method === "POST") return json({ message: postStatus >= 500 ? "Bad Gateway" : "ok" }, postStatus);
    return json({}, 404);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const KEPT = [{ org: "PXL-Java-Essentials", why: "502: Bad Gateway" }];
const quiet = () => {};

test("an alert GitHub refuses to post is a warning, never a failed deploy", async () => {
  const gh = stubGitHub({ postStatus: 502 });
  const lines = [];
  try {
    const out = await reportKeptOrgs({ kept: KEPT, owner: "o", repo: "r", token: "t", alerts: { level: "all" }, log: (l) => lines.push(l) });
    assert.deepEqual(out, [{ org: "PXL-Java-Essentials", outcome: "failed" }]);
    assert.ok(lines.some((l) => /^::warning::Could not post the alert that PXL-Java-Essentials/.test(l)));
  } finally {
    gh.restore();
  }
});

test("the alert is posted once a day per org, naming what to check", async () => {
  const gh = stubGitHub();
  try {
    const out = await reportKeptOrgs({ kept: KEPT, owner: "o", repo: "r", token: "t", alerts: { level: "all", notify_logins: ["admin1"] }, day: "2026-10-07", log: quiet });
    assert.deepEqual(out, [{ org: "PXL-Java-Essentials", outcome: "posted" }]);
    const post = gh.calls.find((c) => c.method === "POST");
    assert.match(post.body.body, /pxl-watchdog-dedup:kept-pxl-java-essentials-2026-10-07-->/);
    assert.match(post.body.body, /@admin1/);
    assert.match(post.body.body, /502: Bad Gateway/, "with why it could not be read");
  } finally {
    gh.restore();
  }
});

test("alerts switched off are off for this alert too", async () => {
  const gh = stubGitHub();
  try {
    const out = await reportKeptOrgs({ kept: KEPT, owner: "o", repo: "r", token: "t", alerts: { level: "off" }, log: quiet });
    assert.deepEqual(out, [{ org: "PXL-Java-Essentials", outcome: "off" }]);
    assert.deepEqual(gh.calls, [], "nothing is asked of GitHub");
  } finally {
    gh.restore();
  }
});
