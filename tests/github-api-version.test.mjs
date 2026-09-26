// The GitHub REST API version is spelled ONCE (lib/github-api-version.mjs).
// It was written eight times, and the CLI sent none.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { GITHUB_API_VERSION } from "../lib/github-api-version.mjs";
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
