// What the nightly collect REPORTS about what it did.
//
// The data was never wrong. The report on it was, for eight days, in every
// organization, on every student:
//
//   [FAIL] snapshot tomccargo - Cannot read properties of undefined (reading 'slice')
//   [FAIL] done - partial (1 ok, 1 err)
//
// One student, counted as collected AND as an error. On 2026-08-18 the commit
// read moved from `/commits/{ref}` (an object) to `/commits?sha=…&per_page=1`
// (a LIST) so the commit count could be taken from the Link header. Every read
// was updated except the summary row, which still did `commitRes.data.sha` -
// undefined on an array - and threw on the last line of a successful
// collection, after the observation was written and the counter incremented.
//
// Nothing caught it because the exit code stays 0 for `partial`, the nightly
// job stays green, and nobody reads a summary that has always looked like that.
// That is the cost: a real collect failure was indistinguishable from the noise.
//
// These drive the real script against a stub API, so the assertion is on what
// it actually produces rather than on the shape of a mock.

import { test } from "node:test";
import assert from "node:assert/strict";
// spawn, not spawnSync: the stub API server lives in this process, and a
// synchronous spawn blocks the event loop that would answer the child.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const collectScript = join(here, "..", "collect", "collect.mjs");

const SHA = "a".repeat(40);
const ID = "exam";

/** A stub GitHub API answering the three calls collect makes per student. */
async function withStubApi(fn, { commitCount = 3, brokenRepos = [] } = {}) {
  const server = createServer((req, res) => {
    const send = (code, body, headers = {}) => {
      res.writeHead(code, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    const url = req.url.split("?")[0];

    if (url === "/rate_limit") return send(200, { resources: {} });

    const repoMatch = url.match(/^\/repos\/[^/]+\/([^/]+)$/);
    if (repoMatch) {
      if (brokenRepos.includes(repoMatch[1])) return send(404, { message: "Not Found" });
      return send(200, { id: 99, default_branch: "main" });
    }

    if (/^\/repos\/[^/]+\/[^/]+\/commits$/.test(url)) {
      // A LIST, which is the whole point - and a Link header carrying the
      // total, which is how commit_count is derived at per_page=1.
      return send(
        200,
        [{ sha: SHA, commit: { committer: { date: "2026-08-20T10:00:00Z" }, author: { name: "Alice", email: "alice@example.test" }, message: "work" } }],
        { link: `<https://api/x?page=${commitCount}>; rel="last"` },
      );
    }

    // No submit/* tags, and no user lookup needed.
    if (url.includes("/git/matching-refs/")) return send(200, []);
    if (url.startsWith("/users/")) return send(200, { name: "Alice", email: "alice@example.test" });

    return send(404, { message: `unstubbed ${url}` });
  });

  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base);
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
}

function makeControlDir(logins) {
  const dir = mkdtempSync(join(tmpdir(), "pxl-collect-"));
  mkdirSync(join(dir, "assignments"), { recursive: true });
  writeFileSync(
    join(dir, "assignments", `${ID}.yml`),
    `state: published\ndeadline_at: "2099-01-01T00:00:00.000Z"\nsubmission_ref: refs/heads/main\n`,
  );
  mkdirSync(join(dir, "repositories", ID), { recursive: true });
  for (const login of logins) {
    writeFileSync(
      join(dir, "repositories", ID, `${login}.json`),
      JSON.stringify({ github_login: login, repo_name: `TestOrg/${ID}-${login}`, repo_id: 42 }),
    );
  }
  return dir;
}

function runCollect(dir, apiBase) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [collectScript], {
      env: {
        ...process.env,
        GITHUB_TOKEN: "stub-token",
        GITHUB_API_URL: apiBase,
        ORG: "TestOrg",
        ASSIGNMENT_ID: ID,
        DATA_DIR: dir,
        GITHUB_OUTPUT: join(dir, "out.env"),
        GITHUB_STEP_SUMMARY: join(dir, "summary.md"),
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (status) => {
      const outPath = join(dir, "out.env");
      const outputs = Object.fromEntries(
        (existsSync(outPath) ? readFileSync(outPath, "utf8") : "")
          .split("\n").filter(Boolean).map((l) => {
            const [k, ...v] = l.split("=");
            return [k, v.join("=")];
          }),
      );
      resolve({ status, stdout, stderr, outputs, dir });
    });
  });
}

test("a healthy cohort collects with ZERO errors", async () => {
  // The regression, stated as the property it broke: every student was reported
  // as an error immediately after being collected successfully.
  await withStubApi(async (api) => {
    const dir = makeControlDir(["alice", "bob"]);
    const res = await runCollect(dir, api);

    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.outputs.error_count, "0", `errors reported on a healthy cohort:\n${res.stdout}`);
    assert.equal(res.outputs.collected_count, "2");
    assert.equal(res.outputs.outcome, "collected", "not `partial` - nothing failed");
    assert.ok(!/Cannot read properties of undefined/.test(res.stdout), "the summary row must not throw");
  });
});

test("the observation is written, with the commit count from the Link header", async () => {
  await withStubApi(
    async (api) => {
      const dir = makeControlDir(["alice"]);
      await runCollect(dir, api);
      const obsDir = join(dir, "observations", ID, "alice");
      const files = readdirSync(obsDir).filter((f) => f.endsWith(".json"));
      assert.equal(files.length, 1);
      const obs = JSON.parse(readFileSync(join(obsDir, files[0]), "utf8"));
      assert.equal(obs.sha, SHA);
      // per_page=1, so the last page number IS the total. A silent fallback to
      // `commits.length` would report 1 commit for every student in the cohort.
      assert.equal(obs.commit_count, 7);
      assert.equal(obs.type, "snapshot");
    },
    { commitCount: 7 },
  );
});

test("a genuinely broken repository IS an error, and is the only one", async () => {
  // The other half: now that a healthy student reports zero errors, a real
  // failure has to still stand out - that is what the noise was hiding.
  await withStubApi(
    async (api) => {
      const dir = makeControlDir(["alice", "bob"]);
      const res = await runCollect(dir, api);
      assert.equal(res.outputs.error_count, "1", res.stdout);
      assert.equal(res.outputs.collected_count, "1");
      assert.equal(res.outputs.outcome, "partial");
      assert.match(res.stdout, /snapshot bob/);
    },
    { brokenRepos: [`${ID}-bob`] },
  );
});
