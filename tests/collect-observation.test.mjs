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
async function withStubApi(fn, { commitCount = 3, brokenRepos = [], delayMs = 0, stats = null } = {}) {
  // `delayMs`: how slowly the repository read answers, and `stats.peak` the
  // most of those in flight at once - what tells a collector reading students
  // one after another from one reading several together.
  let inFlight = 0;
  const server = createServer(async (req, res) => {
    const send = (code, body, headers = {}) => {
      res.writeHead(code, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    if (delayMs && /^\/repos\/[^/]+\/[^/]+$/.test(req.url.split("?")[0])) {
      inFlight++;
      if (stats) stats.peak = Math.max(stats.peak ?? 0, inFlight);
      await new Promise((r) => setTimeout(r, delayMs));
      inFlight--;
    }
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

function runCollect(dir, apiBase, extraEnv = {}) {
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
        ...extraEnv,
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

// NetAdv's 146 students, read one after another at about a second a request,
// ran past the job's ten minutes on 2026-11-14 and the last 35 were never
// observed. Several are read at once now; the summary keeps the roster's order
// and every count is still one per student.
test("students are read several at a time, and the summary keeps their order", async () => {
  const stats = { peak: 0 };
  const logins = ["a1", "b2", "c3", "d4", "e5", "f6", "g7", "h8", "i9"];
  await withStubApi(
    async (api) => {
      const dir = makeControlDir(logins);
      const res = await runCollect(dir, api);
      assert.equal(res.status, 0, res.stderr);
      assert.equal(res.outputs.collected_count, String(logins.length - 1));
      assert.equal(res.outputs.error_count, "1", "the broken one, once");
      assert.ok(stats.peak >= 2, `read one at a time (peak ${stats.peak})`);
      assert.ok(stats.peak <= 4, `more than four at once (peak ${stats.peak})`);
      const summary = readFileSync(join(dir, "summary.md"), "utf8");
      const order = logins.map((l) => summary.indexOf(`| ${l} |`));
      assert.ok(order.every((at) => at >= 0), summary);
      assert.deepEqual(order, [...order].sort((x, y) => x - y), `rows out of roster order:\n${summary}`);
      for (const l of logins.filter((x) => x !== "e5")) {
        assert.equal(readdirSync(join(dir, "observations", ID, l)).filter((f) => f.endsWith(".json")).length, 1, l);
      }
    },
    { delayMs: 150, stats, brokenRepos: [`${ID}-e5`] },
  );
});

// Cut off by the job's timeout, the collector said nothing: GitHub calls that
// `cancelled`, and the nightly's notice fires on `failure()` only. It stops
// starting students at its budget instead, and names who it did not reach.
test("past its time budget the collector starts no student, and names the ones it did not reach", async () => {
  // 24 students, four at a time, 400ms each: about six rounds, against a
  // budget of 1.5s that lets three or four start. Wide margins on both sides,
  // so a slow runner still reads some and leaves some.
  const logins = Array.from({ length: 24 }, (_, i) => `s${String(i).padStart(2, "0")}`);
  await withStubApi(
    async (api) => {
      const dir = makeControlDir(logins);
      const res = await runCollect(dir, api, { COLLECT_BUDGET_MS: "1500" });
      assert.equal(res.status, 0, `partial, not a failure: ${res.stderr}`);
      const reached = Number(res.outputs.collected_count);
      const unreached = Number(res.outputs.unreached_count);
      assert.ok(reached >= 1 && unreached >= 1, `some read, some not (read ${reached}, not ${unreached})`);
      assert.equal(reached + unreached, logins.length, "every student is either read or named");
      assert.equal(res.outputs.error_count, "0", "not reached is not an error of the repository");
      assert.equal(res.outputs.outcome, "partial");
      const out = readFileSync(join(dir, "out.env"), "utf8");
      assert.match(out, /unreached_details<<PXL_[0-9a-f]{16}\nTonight's collection ran out of time/);
      assert.match(out, /- `s23` \(assignment `exam`\)/, "the last on the roster is one not reached");
      assert.match(res.stdout, /\[FAIL\] budget - \d+ student\(s\) not reached/);
    },
    { delayMs: 400 },
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
      // And the lecturer is told, rather than left a log line (lib/missing-repos.mjs).
      assert.equal(res.outputs.missing_count, "1");
      assert.match(res.outputs.missing_dedup, /^missing-[0-9a-f]{16}$/);
      assert.match(readFileSync(join(dir, "out.env"), "utf8"), /missing_details<<PXL_[0-9a-f]{16}\n[\s\S]*`TestOrg\/exam-bob` \(assignment `exam`\) - student `bob`/);
    },
    { brokenRepos: [`${ID}-bob`] },
  );
});
