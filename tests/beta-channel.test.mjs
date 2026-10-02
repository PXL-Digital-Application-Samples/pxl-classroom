// The beta channel: the `beta` branch's SPA at `<site>/beta/`, on the same
// origin as production (ARCHITECTURE.md §10.8, ADMIN.md §9).
//
// Each test is one way it would otherwise go wrong, and each was a real defect
// in the first draft of the design: a deep link that lands on production, a
// redirect loop when no beta exists, an invitation link that carries `beta/`,
// branch code in a job that can read the App key, a beta writing documents the
// hub's schemas do not describe, and a broken beta taking production's deploy
// with it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { parse } from "yaml";
import { repoFiles } from "./repo-files.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

const deploy = parse(read(".github/workflows/deploy-frontend.yml"));
const betaJob = deploy.jobs["build-beta"];
const buildJob = deploy.jobs.build;
const stepNamed = (job, re) => job.steps.find((s) => re.test(s.name ?? ""));

// ---------------------------------------------------------------- the URL shim

/** The inline script of an HTML file, located by a phrase inside it. */
function inlineScript(file, marker) {
  const scripts = [...read(file).matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const found = scripts.find((s) => s.includes(marker));
  assert.ok(found, `${file}: no inline script containing "${marker}" - renamed?`);
  return found;
}

const SHIM = inlineScript("frontend/public/404.html", "pathSegmentsToKeep");
const DECODER = inlineScript("frontend/index.html", "SPA shim decoder");

/** Run 404.html against a missing URL; return where it redirects. */
function redirectFor(url) {
  const u = new URL(url);
  let target = null;
  const location = {
    protocol: u.protocol, hostname: u.hostname, port: u.port,
    pathname: u.pathname, search: u.search, hash: u.hash,
    replace: (to) => { target = to; },
  };
  vm.runInNewContext(SHIM, { window: { location } });
  assert.ok(target, `404.html did not redirect ${url}`);
  return target;
}

/** Run index.html's decoder on the redirected URL; return the URL it restores. */
function restoredFrom(url) {
  const u = new URL(url);
  let restored = null;
  const location = { pathname: u.pathname, search: u.search, hash: u.hash };
  const history = { replaceState: (_s, _t, to) => { restored = to; } };
  vm.runInNewContext(DECODER, { window: { location, history } });
  return restored ?? `${u.pathname}${u.search}${u.hash}`;
}

const SITE = "https://example.github.io";

test("a production deep link still reaches the production app", () => {
  const to = redirectFor(`${SITE}/pxl-classroom/dashboard/PXL-X/admin?tab=roster`);
  assert.equal(to, `${SITE}/pxl-classroom/?/dashboard/PXL-X/admin&tab=roster`);
  assert.equal(restoredFrom(to), "/pxl-classroom/dashboard/PXL-X/admin?tab=roster");
});

test("a beta deep link reaches the beta app, not production", () => {
  // 404.html is the ONE fallback for the whole Pages site. Keeping a single
  // segment rewrote this onto /pxl-classroom/?/beta/... - production, looking
  // for an organization called `beta`.
  const to = redirectFor(`${SITE}/pxl-classroom/beta/dashboard/PXL-X/roster`);
  assert.equal(to, `${SITE}/pxl-classroom/beta/?/dashboard/PXL-X/roster`);
  assert.equal(restoredFrom(to), "/pxl-classroom/beta/dashboard/PXL-X/roster");
});

test("the beta path always resolves, so the shim cannot loop", () => {
  // With no beta/index.html, beta/?/... 404s straight back into 404.html, which
  // redirects to it again. Publishing a page in the beta's place, always, is
  // what ends that.
  assert.ok(existsSync(join(ROOT, "pages/beta-unavailable.html")));
  const assemble = stepNamed(buildJob, /Assemble the beta channel/);
  assert.ok(assemble, "build: no step assembling beta/");
  assert.match(assemble.run, /cp pages\/beta-unavailable\.html frontend\/dist\/beta\/index\.html/);
  assert.ok(
    deploy.on.push.paths.includes("pages/beta-unavailable.html"),
    "the placeholder is a build input, so a change to it has to deploy",
  );
});

// ---------------------------------------------------------- the build itself

test("the beta is built under beta/ and hands out production links", () => {
  const prod = stepNamed(buildJob, /^Build$/).env;
  const beta = stepNamed(betaJob, /^Build$/).env;
  assert.equal(beta.VITE_BASE_URL, prod.VITE_BASE_URL.replace(/\/$/, "/beta/"));
  // The segment 404.html checks is the one the build publishes under.
  assert.match(SHIM, /\[2\] === 'beta'/);
  assert.equal(beta.VITE_PUBLIC_BASE_URL, prod.VITE_BASE_URL);
  assert.equal(beta.VITE_BUILD_CHANNEL, "beta");
});

test("branch code never runs in a job that can read a hub credential", () => {
  assert.equal(betaJob.environment, undefined, "build-beta must have no environment");
  const text = JSON.stringify(betaJob);
  for (const secret of ["PXL_APP_PRIVATE_KEY", "PXL_BROKER_PRIVATE_KEY", "PXL_CLAIM_PRIVATE_KEY", "PXL_INVITE_SIGNING_KEY"]) {
    assert.equal(text.includes(secret), false, `build-beta reads ${secret}`);
  }
  const checkout = betaJob.steps.find((s) => String(s.uses ?? "").startsWith("actions/checkout@"));
  assert.equal(checkout.with["persist-credentials"], false);
  assert.deepEqual(betaJob.permissions, { contents: "read" });
  // The credentialed job takes the beta as files, and runs none of them.
  const download = stepNamed(buildJob, /Download the beta build/);
  assert.match(String(download.uses), /^actions\/download-artifact@/);
});

test("a beta whose schemas differ from main does not publish", () => {
  const guard = stepNamed(betaJob, /schemas differ from main/);
  assert.ok(guard, "build-beta: no schema check");
  assert.match(guard.run, /git diff --quiet origin\/main HEAD -- schemas\//);
  const order = betaJob.steps.map((s) => s.name);
  assert.ok(
    order.indexOf(guard.name) < order.indexOf("Build"),
    "the schema check has to run before the build it guards",
  );
});

test("a failed beta does not cost production its deploy", () => {
  assert.deepEqual([buildJob.needs].flat(), ["build-beta"]);
  assert.match(String(buildJob.if), /!cancelled\(\)/);
  // ...and production never takes a beta that did not build.
  const download = stepNamed(buildJob, /Download the beta build/);
  assert.match(download.if, /needs\.build-beta\.result == 'success'/);
});

test("EVERY job downstream of the beta decides for itself, at any depth", () => {
  // A failed job skips everything after it through the WHOLE `needs:` chain,
  // not only its direct dependents. The first version guarded `build` and left
  // `deploy` on the default `success()`, so on 2026-10-02 a beta that
  // correctly refused to build (schemas changed on main) skipped four
  // production deploys while `build` itself had succeeded.
  const jobs = deploy.jobs;
  const needsOf = (name) => [jobs[name]?.needs ?? []].flat();
  const downstreamOfBeta = (name, seen = new Set()) => needsOf(name).some((n) =>
    n === "build-beta" || (!seen.has(n) && (seen.add(n), downstreamOfBeta(n, seen))));
  const affected = Object.keys(jobs).filter((name) => downstreamOfBeta(name));
  assert.ok(affected.includes("deploy"), "the deploy job is downstream of the beta - or this test checks nothing");
  for (const name of affected) {
    assert.match(String(jobs[name].if ?? ""), /!cancelled\(\)|always\(\)/,
      `${name} would be skipped by a failed beta build - give it an explicit if:`);
  }
  assert.match(String(jobs.deploy.if), /needs\.build\.result == 'success'/,
    "deploy runs on the production build's result, never on the beta's");
});

test("a push to beta deploys from main, the only place the site deploys from", () => {
  const wf = parse(read(".github/workflows/beta-channel.yml"));
  assert.deepEqual(wf.on.push.branches, ["beta"]);
  const run = wf.jobs.dispatch.steps.map((s) => s.run ?? "").join("\n");
  assert.match(run, /actions\/workflows\/deploy-frontend\.yml\/dispatches/);
  assert.match(run, /-f ref=main/);
});

// ------------------------------------------------------ links the app hands out

test("no link is composed from the page's own base", () => {
  // On the beta, BASE_URL is /pxl-classroom/beta/. A link built from it and
  // handed to a cohort puts them on an unreleased app, and breaks when the
  // branch is deleted. Links to keep or pass on use publicBaseUrl().
  const offenders = [];
  const files = repoFiles({ under: "frontend/src", exts: [".js", ".vue"] });
  assert.ok(files.length > 50, `expected the SPA's sources, found ${files.length}`);
  for (const file of files) {
    readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      if (/location\.origin/.test(line) && /BASE_URL/.test(line)) offenders.push(`${file}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, []);
  const invite = read("frontend/src/lib/invite.js");
  assert.match(invite, /export function invitationUrl\(org, token, base = publicBaseUrl\(\)\)/);
  assert.match(invite, /export function confirmationUrl\(org, token, base = publicBaseUrl\(\)\)/);
});
