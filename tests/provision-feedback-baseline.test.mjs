// The feedback baseline is made at what the student was given, on the branch
// the repository really has (TV-3, live 2026-10-15).
//
// Two defects, both seen on a `master` template. The first run read the
// default branch off the generate response, made while the copy was still
// empty, which names the organization's default: it read `main`, got 404, and
// no student had a baseline. A Retry then made one at the branch head - after
// the student had pushed, so their work was inside the baseline and the
// feedback pull request showed none of it.
//
// Spawns the real provisioning/provision.mjs against a stub of the API.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { APP_SLUG } from "../lib/deployment.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "provisioning", "provision.mjs");
const HEAD = "a".repeat(40);
const ROOT = "b".repeat(40);
// GitHub's generated first commit, as the commit list answers it.
const GENERATED = { sha: ROOT, parents: [], committer: { login: "web-flow" }, author: { login: `${APP_SLUG}[bot]` }, commit: { verification: { verified: true } } };
const PUSHED_ROOT = { sha: ROOT, parents: [], committer: { login: "ann" }, author: { login: "ann" }, commit: { verification: { verified: false } } };
const MID = "c".repeat(40);
// The commit above the first: the student's own, or the App's grading workflow.
const STUDENT_MID = { sha: MID, parents: [{ sha: ROOT }], committer: { login: "ann" }, author: { login: "ann" }, commit: { verification: { verified: false } } };
const APP_MID = { sha: MID, parents: [{ sha: ROOT }], committer: { login: "web-flow" }, author: { login: `${APP_SLUG}[bot]` }, commit: { verification: { verified: true } } };

/**
 * `existing`: the repository is there before the run (a Retry). `pushedBy`:
 * who the push log names - the App alone, or the student too. `rootCommit`:
 * the oldest commit on the branch. `defaultBranch`: what GitHub says the
 * repository's default is once it is filled in; the generate response always
 * says `main`, as GitHub's did while the copy was empty.
 */
async function withApi(fn, { existing = false, pushedBy = ["app"], rootCommit = GENERATED, defaultBranch = "master", baselineThere = false, repoReadStatus = 200, middle = STUDENT_MID, refStatus = 201, longHistory = false } = {}) {
  const calls = [];
  let generated = existing;
  // The whole branch as one page, newest first: the student's head, `middle`
  // (theirs, or the App's grading workflow), and the first commit.
  const history = [
    { sha: HEAD, parents: [{ sha: middle.sha }], author: { login: "ann" }, committer: { login: "ann" }, commit: { verification: { verified: false } } },
    middle,
    rootCommit,
  ];
  const server = createServer((req, res) => {
    const send = (code, body, headers = {}) => {
      res.writeHead(code, { "content-type": "application/json", ...headers });
      res.end(body === undefined ? "" : JSON.stringify(body));
    };
    const [url, query = ""] = req.url.split("?");
    calls.push(`${req.method} ${url}${query ? `?${query}` : ""}`);
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (body) calls.push(`BODY ${req.method} ${url} ${body}`);
      if (url === "/rate_limit") return send(200, { rate: { remaining: 5000 } });
      if (url === "/repos/Org/tpl" && req.method === "GET") return send(200, { id: 7, is_template: true, private: true, default_branch: "master" });
      if (url === "/repos/Org/tpl/generate") {
        generated = true;
        return send(201, { id: 10, full_name: "Org/lab-ann", html_url: "https://github.com/Org/lab-ann", default_branch: "main" });
      }
      if (url === "/repos/Org/lab-ann" && req.method === "GET") {
        if (!generated) return send(404, { message: "Not Found" });
        if (repoReadStatus !== 200 && calls.filter((c) => c === "GET /repos/Org/lab-ann").length > 1) return send(repoReadStatus, { message: "Forbidden" });
        return send(200, { id: 10, full_name: "Org/lab-ann", html_url: "https://github.com/Org/lab-ann", default_branch: defaultBranch, template_repository: { full_name: "Org/tpl" }, created_at: "2026-10-14T08:00:00Z" });
      }
      if (url === "/repos/Org/lab-ann/contents/" && req.method === "GET") return send(200, [{ name: "README.md", type: "file" }]);
      // The grading workflow an earlier run added, so a Retry adds nothing.
      if (url === "/repos/Org/lab-ann/contents/.github/workflows/autograding.yml" && req.method === "GET") return send(200, { name: "autograding.yml" });
      if (url === "/repos/Org/lab-ann/git/ref/heads/master") return send(200, { object: { sha: HEAD } });
      if (url === "/repos/Org/lab-ann/git/ref/heads/pxl-baseline") return baselineThere ? send(200, { object: { sha: ROOT } }) : send(404, { message: "Not Found" });
      if (url === "/repos/Org/lab-ann/git/refs" && req.method === "POST") {
        // `refStatus` 422: a teammate's run made it in between; it is there now.
        if (refStatus === 422) {
          baselineThere = true;
          return send(422, { message: "Reference already exists" });
        }
        return send(201, { ref: "refs/heads/pxl-baseline" });
      }
      if (url === "/repos/Org/lab-ann/branches/pxl-baseline/protection" && req.method === "PUT") return send(200, {});
      if (url === "/repos/Org/lab-ann/activity") {
        return send(200, pushedBy.map((who) => ({ actor: { login: who === "app" ? `${APP_SLUG}[bot]` : who } })));
      }
      if (url === "/repos/Org/lab-ann/commits") {
        // Three commits on master: the newest first, the `last` page the oldest.
        const params = new URLSearchParams(query);
        // `longHistory`: a full page, so the first commit is beyond it.
        if (params.get("per_page") === "100") return send(200, longHistory ? Array.from({ length: 100 }, () => history[0]) : history);
        const page = params.get("page");
        return page === "3"
          ? send(200, [rootCommit])
          : send(200, [{ sha: HEAD }], { link: `<http://x/repos/Org/lab-ann/commits?sha=master&per_page=1&page=3>; rel="last"` });
      }
      if (/\/collaborators\/ann$/.test(url) && req.method === "PUT") return send(204);
      return send(404, { message: "not stubbed: " + url });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`, calls);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

function provision(apiBase, { autograde = false, record = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pxl-provision-baseline-"));
  mkdirSync(join(dir, "control", "assignments"), { recursive: true });
  if (record) {
    mkdirSync(join(dir, "control", "repositories", "lab"), { recursive: true });
    writeFileSync(join(dir, "control", "repositories", "lab", "ann.json"), JSON.stringify(record));
  }
  writeFileSync(join(dir, "control", "assignments", "lab.yml"), stringify({
    id: "lab", deadline_at: "2026-10-20T22:00:00Z", feedback_pr: true,
    ...(autograde ? { autograde: { enabled: true, execution_environment: "github_actions", tests: [{ id: "t", name: "t", run: "true", points: 1 }] } } : {}),
  }));
  return new Promise((resolve, reject) => {
    const child = spawn("node", [script], {
      cwd: dir,
      env: {
        ...process.env, GITHUB_TOKEN: "stub-token", GITHUB_API_URL: apiBase, ORG: "Org", TEMPLATE_OWNER: "Org", TEMPLATE_REPO: "tpl",
        TEMPLATE_REPOSITORY_ID: "", TARGET_REPO: "lab-ann", ASSIGNMENT_ID: "lab", STUDENT_LOGIN: "ann", STUDENT_PERMISSION: "push",
        DRY_RUN: "0", RECREATE_EMPTY: "false", FEEDBACK_PR: "true", FEEDBACK_PR_BASELINE_BRANCH: "pxl-baseline",
        TEMPLATE_FULL_HISTORY: "false", PXL_FILL_WAIT_CHECKS: "2",
        GITHUB_OUTPUT: join(dir, "out.env"), GITHUB_STEP_SUMMARY: join(dir, "summary.md"),
      },
    });
    let log = "";
    child.stdout.on("data", (d) => (log += d));
    child.stderr.on("data", (d) => (log += d));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, log, outputs: existsSync(join(dir, "out.env")) ? readFileSync(join(dir, "out.env"), "utf8") : "" }));
  });
}

const output = (outputs, name) => {
  const lines = outputs.split("\n").filter((l) => l.startsWith(`${name}=`));
  return lines.length ? lines[lines.length - 1].slice(name.length + 1) : undefined;
};
const madeAt = (calls) => {
  const post = calls.find((c) => c.startsWith("BODY POST /repos/Org/lab-ann/git/refs "));
  return post ? JSON.parse(post.slice("BODY POST /repos/Org/lab-ann/git/refs ".length)).sha : null;
};

test("a new repository from a master template gets its baseline on master, never on the main the generate response named", async () => {
  await withApi(async (api, calls) => {
    const r = await provision(api);
    assert.equal(r.status, 0, r.log);
    assert.ok(!calls.some((c) => c.includes("/git/ref/heads/main")), "it asked for main");
    assert.equal(madeAt(calls), HEAD, "at what they were given, the head of a repository this run made");
    assert.equal(output(r.outputs, "baseline_sha"), HEAD);
    assert.ok(calls.some((c) => c.startsWith("PUT /repos/Org/lab-ann/branches/pxl-baseline/protection")), "and protected");
  });
});

test("a Retry over a repository the student has pushed to puts the baseline at GitHub's first commit, not on their work", async () => {
  await withApi(async (api, calls) => {
    const r = await provision(api);
    assert.equal(r.status, 0, r.log);
    assert.equal(output(r.outputs, "outcome"), "reused");
    assert.equal(madeAt(calls), ROOT, "the head holds the student's work");
    assert.equal(output(r.outputs, "baseline_sha"), ROOT);
    assert.match(r.log, /what it was given: master has the student's work on it/);
  }, { existing: true, pushedBy: ["app", "ann"] });
});

test("R6-41: the App's own commit above GitHub's is part of what they were given - the template ships a workflow or not", async () => {
  // Only GitHub's first commit was taken, and only where this run added no
  // workflow, so a Retry refused where the template ships one, and the App's
  // own commits read as the student's work.
  await withApi(async (api, calls) => {
    const r = await provision(api);
    assert.equal(r.status, 0, r.log);
    assert.equal(madeAt(calls), MID, "the App's grading workflow, not the student's head");
  }, { existing: true, pushedBy: ["app", "ann"], middle: APP_MID });
});

test("R6-41: a start an earlier run recorded is used first", async () => {
  await withApi(async (api, calls) => {
    const r = await provision(api, { record: { github_login: "ann", repo_name: "Org/lab-ann", starter_sha: MID } });
    assert.equal(r.status, 0, r.log);
    assert.equal(madeAt(calls), MID);
  }, { existing: true, pushedBy: ["app", "ann"] });
});

test("R6-41: a baseline a teammate's run made in between is adopted, not a failure", async () => {
  await withApi(async (api) => {
    const r = await provision(api);
    assert.equal(r.status, 0, r.log);
    assert.equal(output(r.outputs, "baseline_sha"), ROOT);
    assert.match(r.log, /pxl-baseline was made meanwhile/);
  }, { existing: true, pushedBy: ["app", "ann"], refStatus: 422 });
});

test("...and at the head when nobody but PXL Classroom has pushed to it", async () => {
  await withApi(async (api, calls) => {
    const r = await provision(api);
    assert.equal(r.status, 0, r.log);
    assert.equal(madeAt(calls), HEAD);
  }, { existing: true, pushedBy: ["app"] });
});

test("a Retry that cannot tell what they were given makes no baseline rather than guessing, and says why", async () => {
  // The oldest commit is not GitHub's copy (a history someone rewrote).
  await withApi(async (api, calls) => {
    const r = await provision(api);
    assert.equal(r.status, 0, "the repository is usable without a baseline");
    assert.equal(madeAt(calls), null);
    assert.equal(output(r.outputs, "baseline_sha"), "");
    assert.match(r.log, /no pxl-baseline: somebody has pushed to it since it was made/);
  }, { existing: true, pushedBy: ["ann"], rootCommit: PUSHED_ROOT });
  // A history longer than the one page read: GitHub's first commit is not on
  // it, so where it starts is not known. (A grading workflow the App added on
  // top of GitHub's copy is walked through since R6-41, test above.)
  await withApi(async (api, calls) => {
    const r = await provision(api, { autograde: true });
    assert.equal(madeAt(calls), null, r.log);
    assert.match(r.log, /no pxl-baseline: somebody has pushed to it since it was made/);
  }, { existing: true, pushedBy: ["ann"], longHistory: true });
});

test("an existing baseline is what baseline_sha says, not the head; an unreadable default branch makes none", async () => {
  await withApi(async (api, calls) => {
    const r = await provision(api);
    assert.equal(r.status, 0, r.log);
    assert.equal(madeAt(calls), null, "nothing made over it");
    assert.equal(output(r.outputs, "baseline_sha"), ROOT);
  }, { existing: true, baselineThere: true });
  await withApi(async (api, calls) => {
    const r = await provision(api);
    assert.equal(madeAt(calls), null, r.log);
    assert.ok(!calls.some((c) => c.includes("/git/ref/heads/main")), "never a guessed main");
    assert.match(r.log, /default branch could not be read - no baseline/);
  }, { repoReadStatus: 403 });
});
