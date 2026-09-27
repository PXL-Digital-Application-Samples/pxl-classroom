// The GitHub REST API version is spelled ONCE (lib/github-api-version.mjs).
// It was written eight times, and the CLI sent none.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { GITHUB_API_VERSION } from "../lib/github-api-version.mjs";
import { parse as parseYaml } from "yaml";
import { repoFiles } from "./repo-files.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOME = "lib/github-api-version.mjs";
const DATE = /\b20\d\d-\d\d-\d\d\b/;

test("the version is a GitHub API version date", () => {
  assert.match(GITHUB_API_VERSION, /^\d{4}-\d{2}-\d{2}$/);
});

test("no other file spells an API version: every X-GitHub-Api-Version header reads the constant", () => {
  const offenders = [];
  const files = repoFiles({ exts: [".mjs", ".js", ".cjs", ".vue", ".yml", ".yaml"] })
    .map((abs) => relative(root, abs).replace(/\\/g, "/"))
    .filter((f) => f !== HOME && f !== "tests/github-api-version.test.mjs");
  for (const file of files) {
    const text = readFileSync(join(root, file), "utf8");
    text.split("\n").forEach((line, i) => {
      if (/x-github-api-version/i.test(line) && DATE.test(line)) offenders.push(`${file}:${i + 1}`);
    });
    // The retired version, anywhere, as a literal.
    if (text.includes("2022-11-28")) offenders.push(`${file}: 2022-11-28`);
  }
  assert.deepEqual(offenders, [], "a second spelling of the API version");
});

test("every request helper that names a version names the constant - the CLI included", () => {
  for (const file of ["lib/gh.mjs", "lib/gittree.mjs", "frontend/src/lib/api.js", "cli/src/lib/octokit.mjs", "tests/live/live-kit.mjs",
    "scripts/check-installation-approvals.mjs", "scripts/check-publish-preflight.mjs"]) {
    const text = readFileSync(join(root, file), "utf8");
    assert.match(text, /GITHUB_API_VERSION/, `${file} does not use the constant`);
  }
});

test("the CLI's client actually SENDS the header, on every request", async () => {
  const { makeOctokit } = await import("../cli/src/lib/octokit.mjs");
  // A stand-in transport: what reaches it is what would reach GitHub.
  let seen = null;
  const fetch = async (_url, init) => {
    seen = new Headers(init.headers);
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  const octokit = makeOctokit({ token: "test", fetch });
  await octokit.request("GET /rate_limit");
  assert.equal(seen?.get("x-github-api-version"), GITHUB_API_VERSION);
});

// ---- The workflows. YAML cannot import the constant, so each step that talks
// to the REST API itself spells it in its `env:` and this holds it equal.

const workflowSteps = () => {
  const out = [];
  const files = repoFiles({ exts: [".yml", ".yaml"] }).map((abs) => relative(root, abs).replace(/\\/g, "/"));
  for (const file of files) {
    if (!file.startsWith(".github/") && !file.startsWith("acceptance/")) continue;
    const doc = parseYaml(readFileSync(join(root, file), "utf8"));
    const jobs = Object.values(doc?.jobs || {});
    const stepLists = [...jobs.map((j) => j?.steps || []), doc?.runs?.steps || []];
    for (const steps of stepLists) for (const step of steps) out.push({ file, step, name: `${file}: ${step.name || step.uses || step.run?.slice(0, 40)}` });
  }
  return out;
};

// A line that RUNS `gh api`, not a comment or a message that mentions it.
const ghApiLines = (run) => run.split("\n").map((l) => l.trim())
  .filter((l) => /\bgh api\b/.test(l) && !l.startsWith("#") && !l.startsWith("echo"));

const GH_API_HEADER = '-H "X-GitHub-Api-Version: ${GITHUB_API_VERSION}"';

test("every `gh api` in a workflow sends the version, from a step env equal to the constant", () => {
  const found = workflowSteps().filter(({ step }) => typeof step.run === "string" && ghApiLines(step.run).length);
  assert.ok(found.length >= 3, `found only ${found.length} steps running gh api - is the sweep reading the workflows?`);
  for (const { step, name } of found) {
    assert.equal(step.env?.GITHUB_API_VERSION, GITHUB_API_VERSION, `${name}: env GITHUB_API_VERSION`);
    for (const line of ghApiLines(step.run)) assert.ok(line.includes(GH_API_HEADER), `${name}: ${line}`);
  }
});

test("every github-script step sends the version, through one prelude that really sets the header", async () => {
  const found = workflowSteps().filter(({ step }) => String(step.uses || "").startsWith("actions/github-script@"));
  assert.ok(found.length >= 6, `found only ${found.length} github-script steps`);
  const preludes = new Set();
  for (const { step, name } of found) {
    assert.equal(step.env?.GITHUB_API_VERSION, GITHUB_API_VERSION, `${name}: env GITHUB_API_VERSION`);
    preludes.add(String(step.with?.script || "").trimStart().split("\n")[0]);
  }
  assert.equal(preludes.size, 1, `the github-script steps disagree on their first line: ${[...preludes].join(" | ")}`);
  const [prelude] = preludes;
  assert.match(prelude, /hook\.before/, "the first line of each github-script step is the version hook");

  // Run the prelude AS WRITTEN in the YAML against a real Octokit, the client
  // github-script hands the script as `github`.
  const { Octokit } = await import("@octokit/rest");
  let seen = null;
  const fetch = async (_url, init) => {
    seen = new Headers(init.headers);
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  const github = new Octokit({ auth: "test", request: { fetch } });
  new Function("github", "process", prelude)(github, { env: { GITHUB_API_VERSION } });
  await github.rest.actions.createWorkflowDispatch({ owner: "o", repo: "r", workflow_id: "w.yml", ref: "main" });
  assert.equal(seen?.get("x-github-api-version"), GITHUB_API_VERSION);
});

test("a script that spawns `gh api` sends the version too", () => {
  const offenders = [];
  for (const abs of repoFiles({ exts: [".mjs", ".js"] })) {
    const file = relative(root, abs).replace(/\\/g, "/");
    if (file.startsWith("tests/")) continue;
    const text = readFileSync(abs, "utf8");
    for (const m of text.matchAll(/spawn(?:Sync)?\(\s*["']gh["']\s*,\s*\[\s*["']api["'][^\]]*\]/g)) {
      if (!m[0].includes("X-GitHub-Api-Version:${GITHUB_API_VERSION}")) offenders.push(`${file}: ${m[0]}`);
    }
  }
  assert.deepEqual(offenders, []);
});

// Counts what reaches the transport for one request answered `status`.
async function attemptsFor(status) {
  const { makeOctokit } = await import("../cli/src/lib/octokit.mjs");
  let calls = 0;
  const fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ message: `HTTP ${status}` }), { status, headers: { "content-type": "application/json" } });
  };
  const octokit = makeOctokit({ token: "test", fetch, retryBaseMs: 1 });
  await assert.rejects(octokit.rest.issues.create({ owner: "o", repo: "r", title: "t" }), (e) => e.status === status);
  return calls;
}

test("the CLI asks a refused request ONCE: a 4xx is an answer, not a blip", async () => {
  // `request: { retries: 3 }` made the retry plugin skip its never-retry list,
  // so a live 422 on issues.create was sent four times.
  for (const status of [400, 401, 403, 404, 410, 422, 451]) {
    assert.equal(await attemptsFor(status), 1, `HTTP ${status} was retried`);
  }
});

test("the CLI still retries a 5xx three times", async () => {
  assert.equal(await attemptsFor(500), 4);
  assert.equal(await attemptsFor(502), 4);
});
