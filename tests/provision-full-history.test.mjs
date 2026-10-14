// PXL Classroom - provision-full-history.test.mjs
//
// `template_full_history`: the repository is created EMPTY and the template is
// pushed into it with every branch, tag and commit (asked 2026-10-14, for a git
// exercise with prepared branches). GitHub's template copy gives one commit,
// and with all branches one commit each sharing no history, so the branches
// of such an exercise could not be merged into each other.
//
// These spawn the real provisioning/provision.mjs against a stub of the API
// and a directory of real bare repositories standing in for github.com
// (GITHUB_SERVER_URL), so the clone and the push are git's own.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stringify } from "yaml";
import { APP_SLUG } from "../lib/deployment.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "provisioning", "provision.mjs");

const ident = { GIT_AUTHOR_NAME: "Lecturer", GIT_AUTHOR_EMAIL: "l@example.com", GIT_COMMITTER_NAME: "Lecturer", GIT_COMMITTER_EMAIL: "l@example.com" };
const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...ident }, stdio: ["ignore", "pipe", "pipe"] }).trim();
const commit = (cwd, file, text, msg) => {
  mkdirSync(dirname(join(cwd, file)), { recursive: true });
  writeFileSync(join(cwd, file), text);
  git(["add", file], cwd);
  git(["commit", "-q", "-m", msg], cwd);
};

/** A template on `master` with history, two prepared branches, a tag and a pull ref. */
function makeServer() {
  const srv = mkdtempSync(join(tmpdir(), "pxl-gitsrv-"));
  const work = join(srv, "work");
  mkdirSync(work);
  git(["init", "-q", "-b", "master"], work);
  commit(work, "app.py", "print('v1')\n", "Start");
  commit(work, "app.py", "print('v2') # bug\n", "Add a bug");
  git(["tag", "v1"], work);
  git(["checkout", "-q", "-b", "feature-x"], work);
  commit(work, "feature.py", "x = 1\n", "Feature x");
  git(["checkout", "-q", "master"], work);
  git(["checkout", "-q", "-b", "bugfix"], work);
  commit(work, "app.py", "print('v2')\n", "Fix the bug");
  git(["checkout", "-q", "master"], work);
  // How a STUDENT declares a submission: never copied (the collector reads one wherever it came from).
  git(["tag", "submit/2026-01-01T00-00-00Z-abc1234"], work);
  mkdirSync(join(srv, "Org"));
  git(["clone", "-q", "--bare", work, join(srv, "Org", "tpl.git")], srv);
  // What GitHub has and refuses on a push: a pull request's ref.
  git(["update-ref", "refs/pull/1/head", git(["rev-parse", "feature-x"], work)], join(srv, "Org", "tpl.git"));
  return srv;
}

const refs = (bare) => git(["for-each-ref", "--format=%(refname) %(objectname)"], bare).split("\n").filter(Boolean).sort();
const hasRefs = (bare) => existsSync(bare) && refs(bare).length > 0;

/**
 * `target`: what is at the student's name before the run - "absent", "empty"
 * (our own failed copy, an hour old) or "has-commits" (a repository to reuse).
 * `defaultBranch`: what GitHub reports for the template.
 */
async function withApi(srv, fn, { target = "absent", defaultBranch = "master", activity = null, repoDefault = "master" } = {}) {
  const calls = [];
  const repo = join(srv, "Org", "lab-ann.git");
  if (target !== "absent") {
    git(["init", "-q", "--bare", repo], srv);
    if (target === "has-commits") {
      const w = mkdtempSync(join(tmpdir(), "pxl-seed-"));
      git(["clone", "-q", join(srv, "Org", "tpl.git"), w], srv);
      commit(w, "mine.txt", "the student's\n", "Student work");
      git(["push", "-q", repo, "master"], w);
    }
    if (target === "copy") {
      // An earlier run's copy, left with the org's default branch name.
      git(["push", "-q", "--mirror", repo], join(srv, "Org", "tpl.git"));
    }
  }
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const send = (code, data, headers = {}) => {
        res.writeHead(code, { "content-type": "application/json", ...headers });
        res.end(data === undefined ? "" : JSON.stringify(data));
      };
      const [url, query = ""] = req.url.split("?");
      calls.push(`${req.method} ${url}${body ? " " + body : ""}`);
      if (url === "/rate_limit") return send(200, { rate: { remaining: 5000 } });
      if (url === "/repos/Org/tpl" && req.method === "GET") return send(200, { id: 7, is_template: true, private: true, default_branch: defaultBranch });
      if (url === "/repos/Org/lab-ann" && req.method === "GET") {
        return existsSync(repo)
          ? send(200, { id: 10, full_name: "Org/lab-ann", html_url: "https://github.com/Org/lab-ann", default_branch: repoDefault, created_at: new Date(Date.now() - 3600_000).toISOString() })
          : send(404, { message: "Not Found" });
      }
      if (url === "/repos/Org/lab-ann/activity") return activity ? send(200, activity) : send(404, { message: "Not Found" });
      if (url === "/repos/Org/lab-ann" && req.method === "DELETE") {
        rmSync(repo, { recursive: true, force: true });
        return send(204);
      }
      if (url === "/orgs/Org/repos" && req.method === "POST") {
        if (existsSync(repo)) return send(422, { message: "name already exists on this account" });
        git(["init", "-q", "--bare", repo], srv);
        return send(201, { id: 11, full_name: "Org/lab-ann", html_url: "https://github.com/Org/lab-ann" });
      }
      if (url === "/repos/Org/lab-ann" && req.method === "PATCH") {
        const { default_branch } = JSON.parse(body);
        git(["symbolic-ref", "HEAD", `refs/heads/${default_branch}`], repo);
        return send(200, { default_branch });
      }
      const head = url.match(/^\/repos\/Org\/lab-ann\/branches\/([^/]+)$/);
      if (head) return send(200, { commit: { sha: git(["rev-parse", `refs/heads/${decodeURIComponent(head[1])}`], repo) } });
      if (url === "/repos/Org/lab-ann/commits") {
        if (!hasRefs(repo)) return send(409, { message: "Git Repository is empty." });
        // As GitHub pages it: one per page, the `last` link's page is the count.
        const sha = new URLSearchParams(query).get("sha") || "HEAD";
        const n = Number(git(["rev-list", "--count", sha], repo));
        const link = n > 1 ? { link: `<http://x/repos/Org/lab-ann/commits?sha=${sha}&per_page=1&page=${n}>; rel="last"` } : {};
        return send(200, [{ sha: git(["rev-parse", sha], repo) }], link);
      }
      if (url === "/repos/Org/lab-ann/contents/" && req.method === "GET") {
        return hasRefs(repo) ? send(200, [{ name: "app.py", type: "file" }]) : send(404, { message: "This repository is empty." });
      }
      if (/^\/repos\/Org\/lab-ann\/contents\/\.github\/workflows\/(autograding|classroom)\.yml$/.test(url) && req.method === "GET") {
        return send(404, { message: "Not Found" });
      }
      if (url === "/repos/Org/lab-ann/contents/.github/workflows/autograding.yml" && req.method === "PUT") {
        // The injected grading workflow is a commit on the default branch.
        const w = mkdtempSync(join(tmpdir(), "pxl-inject-"));
        git(["clone", "-q", repo, w], srv);
        commit(w, ".github/workflows/autograding.yml", Buffer.from(JSON.parse(body).content, "base64").toString("utf8"), "Add autograding workflow");
        git(["push", "-q", "origin", "HEAD"], w);
        return send(201, { content: { path: ".github/workflows/autograding.yml" } });
      }
      if (/\/collaborators\/ann$/.test(url) && req.method === "PUT") return send(204);
      if (url === "/repos/Org/tpl/generate") return send(500, { message: "generate must not be called" });
      return send(404, { message: "not stubbed: " + url });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`, calls, repo);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

function provision(apiBase, srv, { fullHistory = "true", recreateEmpty = "false", dryRun = false, assignment = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pxl-provision-"));
  // Provisioning reads the assignment from the control checkout for step 5.5.
  if (assignment) {
    mkdirSync(join(dir, "control", "assignments"), { recursive: true });
    writeFileSync(join(dir, "control", "assignments", "lab.yml"), stringify(assignment));
  }
  return new Promise((resolve, reject) => {
    const child = spawn("node", [script], {
      cwd: dir,
      env: {
        ...process.env,
        GITHUB_TOKEN: "stub-token",
        GITHUB_API_URL: apiBase,
        GITHUB_SERVER_URL: pathToFileURL(srv).href,
        ORG: "Org",
        TEMPLATE_OWNER: "Org",
        TEMPLATE_REPO: "tpl",
        TEMPLATE_REPOSITORY_ID: "",
        TARGET_REPO: "lab-ann",
        ASSIGNMENT_ID: "lab",
        STUDENT_LOGIN: "ann",
        STUDENT_PERMISSION: "push",
        DRY_RUN: dryRun ? "1" : "0",
        FEEDBACK_PR: "false",
        RECREATE_EMPTY: recreateEmpty,
        TEMPLATE_FULL_HISTORY: fullHistory,
        PXL_FILL_WAIT_CHECKS: "2",
        GITHUB_OUTPUT: join(dir, "out.env"),
        GITHUB_STEP_SUMMARY: join(dir, "summary.md"),
      },
    });
    let log = "";
    child.stdout.on("data", (d) => (log += d));
    child.stderr.on("data", (d) => (log += d));
    child.on("error", reject);
    child.on("close", (status) => {
      const out = join(dir, "out.env");
      resolve({ status, log, outputs: existsSync(out) ? readFileSync(out, "utf8") : "" });
    });
  });
}

const output = (outputs, name) => {
  const lines = outputs.split("\n").filter((l) => l.startsWith(`${name}=`));
  return lines.length ? lines[lines.length - 1].slice(name.length + 1) : undefined;
};
const tplRefs = (srv) => refs(join(srv, "Org", "tpl.git")).filter((l) => !l.startsWith("refs/pull/") && !l.startsWith("refs/tags/submit/"));

test("every branch, tag and commit arrives with the same SHAs; GitHub's pull refs do not", async () => {
  const srv = makeServer();
  await withApi(srv, async (api, calls, repo) => {
    const r = await provision(api, srv);
    assert.equal(r.status, 0, r.log);
    assert.equal(output(r.outputs, "outcome"), "created");
    assert.deepEqual(refs(repo), tplRefs(srv), "the template's branches and tag, exactly");
    assert.ok(!calls.some((c) => c.includes("/generate")), "GitHub's template copy is not used");
    assert.ok(calls.some((c) => c.startsWith("POST /orgs/Org/repos") && c.includes('"auto_init":false')), "created empty");
  });
});

test("the default branch is the template's, and what it was given is the output", async () => {
  const srv = makeServer();
  await withApi(srv, async (api, calls, repo) => {
    const r = await provision(api, srv);
    assert.equal(r.status, 0, r.log);
    assert.ok(calls.some((c) => c.startsWith("PATCH /repos/Org/lab-ann") && c.includes('"default_branch":"master"')));
    const master = git(["rev-parse", "refs/heads/master"], join(srv, "Org", "tpl.git"));
    assert.equal(output(r.outputs, "starter_sha"), master);
    assert.equal(output(r.outputs, "starter_commit_count"), "2", "Start and Add a bug");
    // Shared history: the prepared branches merge into the default branch.
    assert.equal(git(["merge-base", "refs/heads/master", "refs/heads/feature-x"], repo), master);
  });
});

test("a grading workflow injected after the copy is part of what it was given", async () => {
  // The injection is a commit on the default branch; a starting commit read
  // before it would call every student started.
  const srv = makeServer();
  const assignment = {
    id: "lab",
    autograde: { enabled: true, execution_environment: "github_actions", tests: [{ id: "t1", type: "run", command: "npm test", points: 10 }] },
  };
  await withApi(srv, async (api, calls, repo) => {
    const r = await provision(api, srv, { assignment });
    assert.equal(r.status, 0, r.log);
    assert.ok(calls.some((c) => c.startsWith("PUT /repos/Org/lab-ann/contents/.github/workflows/autograding.yml")), "injected");
    const head = git(["rev-parse", "refs/heads/master"], repo);
    const tplHead = git(["rev-parse", "refs/heads/master"], join(srv, "Org", "tpl.git"));
    assert.notEqual(head, tplHead);
    assert.equal(git(["rev-parse", "refs/heads/master~1"], repo), tplHead, "on top of the template's history");
    assert.equal(output(r.outputs, "starter_sha"), head);
    assert.equal(output(r.outputs, "starter_commit_count"), "3");
  });
});

test("our own empty leftover is removed and copied again; an existing repository is reused and records nothing", async () => {
  const srv = makeServer();
  await withApi(srv, async (api, calls, repo) => {
    const r = await provision(api, srv, { recreateEmpty: "true" });
    assert.equal(r.status, 0, r.log);
    assert.ok(calls.includes("DELETE /repos/Org/lab-ann"), "the empty leftover went");
    assert.equal(output(r.outputs, "outcome"), "created");
    assert.deepEqual(refs(repo), tplRefs(srv));
  }, { target: "empty" });

  const srv2 = makeServer();
  await withApi(srv2, async (api, calls, repo) => {
    const before = refs(repo);
    const r = await provision(api, srv2, { recreateEmpty: "true" });
    assert.equal(r.status, 0, r.log);
    assert.equal(output(r.outputs, "outcome"), "reused");
    assert.equal(output(r.outputs, "starter_sha"), "", "a reuse made nothing, so it says nothing was given");
    assert.ok(!calls.some((c) => c.startsWith("POST /orgs/Org/repos") || c.startsWith("DELETE")), "nothing created or removed");
    assert.deepEqual(refs(repo), before, "the student's work is untouched");
  }, { target: "has-commits" });
});

test("a submit/ tag in the template is not copied: it would be every student's declared submission", async () => {
  const srv = makeServer();
  await withApi(srv, async (api, calls, repo) => {
    const r = await provision(api, srv);
    assert.equal(r.status, 0, r.log);
    assert.ok(refs(join(srv, "Org", "tpl.git")).some((l) => l.startsWith("refs/tags/submit/")), "the template has one");
    assert.ok(!refs(repo).some((l) => l.startsWith("refs/tags/submit/")));
    assert.ok(refs(repo).some((l) => l.startsWith("refs/tags/v1 ")), "the others travel");
  });
});

test("a reused copy only PXL Classroom pushed to: what it was given is recovered, and its default branch set", async () => {
  // Review 2026-10-14: a run that failed after the copy left a repository whose
  // retry recorded nothing, and the report counted the template's commits.
  const srv = makeServer();
  const bot = { actor: { login: `${APP_SLUG}[bot]` }, activity_type: "push" };
  await withApi(srv, async (api, calls) => {
    const r = await provision(api, srv, { recreateEmpty: "true" });
    assert.equal(r.status, 0, r.log);
    assert.equal(output(r.outputs, "outcome"), "reused");
    assert.equal(output(r.outputs, "starter_sha"), git(["rev-parse", "refs/heads/master"], join(srv, "Org", "tpl.git")));
    assert.equal(output(r.outputs, "starter_commit_count"), "2");
    assert.ok(calls.some((c) => c.startsWith("PATCH /repos/Org/lab-ann") && c.includes('"default_branch":"master"')), "the default branch an earlier run left unset");
    assert.ok(!calls.some((c) => c.startsWith("POST /orgs/Org/repos")), "nothing copied again");
  }, { target: "copy", activity: [bot, bot, bot], repoDefault: "main" });
});

test("...but one a person pushed to, or whose push log cannot be read, recovers nothing", async () => {
  for (const activity of [[{ actor: { login: `${APP_SLUG}[bot]` } }, { actor: { login: "ann" } }], null]) {
    const srv = makeServer();
    await withApi(srv, async (api, calls) => {
      const r = await provision(api, srv, { recreateEmpty: "true" });
      assert.equal(r.status, 0, r.log);
      assert.equal(output(r.outputs, "starter_sha"), "");
      assert.ok(!calls.some((c) => c.startsWith("PATCH")), "and nothing is changed on it");
    }, { target: "copy", activity, repoDefault: "main" });
  }
});

test("a dry run creates and copies nothing", async () => {
  const srv = makeServer();
  await withApi(srv, async (api, calls, repo) => {
    const r = await provision(api, srv, { dryRun: true });
    assert.equal(r.status, 0, r.log);
    assert.equal(output(r.outputs, "outcome"), "dry-run:ok");
    assert.ok(!calls.some((c) => /^(POST|PATCH|PUT|DELETE) /.test(c)), calls.join("\n"));
    assert.equal(existsSync(repo), false);
  });
});

test("a copy that fails leaves its repository said, and fails the run; a template with no default branch fails first", async () => {
  // The repository exists by then; its team must be told, or the next
  // teammate is refused over their own team's repository.
  const srv = makeServer();
  await withApi(srv, async (api) => {
    rmSync(join(srv, "Org", "tpl.git"), { recursive: true, force: true });
    const r = await provision(api, srv);
    assert.equal(r.status, 1, r.log);
    assert.equal(output(r.outputs, "outcome"), "fail:create");
    assert.equal(output(r.outputs, "repo_id"), "11", "said before the copy");
    assert.match(r.log, /copying Org\/tpl with its history/);
    assert.match(r.log, /Retry this student in ten minutes/);
  });

  const srv2 = makeServer();
  await withApi(srv2, async (api, calls) => {
    const r = await provision(api, srv2);
    assert.equal(r.status, 1, r.log);
    assert.match(r.log, /no usable default branch/);
    assert.ok(!calls.some((c) => c.startsWith("POST /orgs/Org/repos")), "refused before creating anything");
  }, { defaultBranch: "" });
});

test("without the setting, GitHub's template copy is used and nothing is recorded as given", async () => {
  const srv = makeServer();
  await withApi(srv, async (api, calls) => {
    const r = await provision(api, srv, { fullHistory: "false" });
    assert.ok(calls.some((c) => c.startsWith("POST /repos/Org/tpl/generate")));
    assert.ok(!calls.some((c) => c.startsWith("POST /orgs/Org/repos")));
    assert.notEqual(r.status, 0, "the stub refuses generate");
  });
});
