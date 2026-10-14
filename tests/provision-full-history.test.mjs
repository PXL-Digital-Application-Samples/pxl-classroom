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
  // A tag named like the removed submit tags: copied like any other now.
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
async function withApi(srv, fn, { target = "absent", defaultBranch = "master", activity = null, repoDefault = "master", generatedFrom = null } = {}) {
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
      // An earlier run's copy, left with whatever default its push gave it.
      git(["push", "-q", "--mirror", repo], join(srv, "Org", "tpl.git"));
      // On a prepared branch where the copy has one; `main` is the org's name, which it has not.
      if (git(["for-each-ref", "--format=%(refname)", `refs/heads/${repoDefault}`], repo)) {
        git(["symbolic-ref", "HEAD", `refs/heads/${repoDefault}`], repo);
      }
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
          ? send(200, {
              id: 10, full_name: "Org/lab-ann", html_url: "https://github.com/Org/lab-ann", default_branch: repoDefault,
              created_at: new Date(Date.now() - 3600_000).toISOString(),
              // GitHub names the template of a repository IT generated; a pushed copy has none.
              template_repository: generatedFrom ? { full_name: generatedFrom } : null,
            })
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
        // As GitHub answers it: the file, and the commit that added it.
        return send(201, { content: { path: ".github/workflows/autograding.yml" }, commit: { sha: git(["rev-parse", "HEAD"], w) } });
      }
      // The template's own branch of a name (provision.mjs `templateOwnsBranch`).
      const tplRef = url.match(/^\/repos\/Org\/tpl\/git\/ref\/heads\/(.+)$/);
      if (tplRef && req.method === "GET") {
        const sha = git(["for-each-ref", "--format=%(objectname)", `refs/heads/${decodeURIComponent(tplRef[1])}`], join(srv, "Org", "tpl.git"));
        return sha ? send(200, { object: { sha } }) : send(404, { message: "Not Found" });
      }
      // The feedback baseline (setupFeedbackBaseline): read a ref, make one, protect it.
      const ref = url.match(/^\/repos\/Org\/lab-ann\/git\/ref\/heads\/(.+)$/);
      if (ref && req.method === "GET") {
        const name = decodeURIComponent(ref[1]);
        const sha = git(["for-each-ref", "--format=%(objectname)", `refs/heads/${name}`], repo);
        return sha ? send(200, { object: { sha } }) : send(404, { message: "Not Found" });
      }
      if (url === "/repos/Org/lab-ann/git/refs" && req.method === "POST") {
        const { ref: name, sha } = JSON.parse(body);
        git(["update-ref", name, sha], repo);
        return send(201, { ref: name, object: { sha } });
      }
      if (/^\/repos\/Org\/lab-ann\/branches\/[^/]+\/protection$/.test(url) && req.method === "PUT") return send(200, {});
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

/**
 * The bare repositories in `srv` served over git's smart HTTP, through git's own
 * `git http-backend`, answering 401 to any request without the App token's
 * header - as GitHub does. Over `file://` git never sends `http.*` config, so
 * the header the copy authenticates with was otherwise never exercised (F9).
 */
async function withGitHttp(srv, token, fn) {
  const expected = `basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  const requests = [];
  const server = createServer((req, res) => {
    const authorized = String(req.headers.authorization ?? "").toLowerCase() === expected.toLowerCase();
    requests.push({ url: req.url, authorized });
    if (!authorized) {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="GitHub"' });
      return res.end();
    }
    const u = new URL(req.url, "http://x");
    const cgi = spawn("git", ["http-backend"], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: srv,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: decodeURIComponent(u.pathname),
        QUERY_STRING: u.search.slice(1),
        REQUEST_METHOD: req.method,
        CONTENT_TYPE: req.headers["content-type"] ?? "",
        ...(req.headers["content-length"] ? { CONTENT_LENGTH: req.headers["content-length"] } : {}),
        HTTP_CONTENT_ENCODING: req.headers["content-encoding"] ?? "",
        GIT_PROTOCOL: req.headers["git-protocol"] ?? "",
        // A push is refused by http-backend unless someone is signed in.
        REMOTE_USER: "x-access-token",
        REMOTE_ADDR: "127.0.0.1",
      },
    });
    req.pipe(cgi.stdin);
    const out = [];
    cgi.stdout.on("data", (c) => out.push(c));
    cgi.on("close", () => {
      const buf = Buffer.concat(out);
      const end = buf.indexOf("\r\n\r\n");
      const headers = {};
      let status = 200;
      for (const line of buf.subarray(0, end).toString("latin1").split("\r\n")) {
        const at = line.indexOf(":");
        const name = line.slice(0, at).trim();
        const value = line.slice(at + 1).trim();
        if (name.toLowerCase() === "status") status = Number(value.split(" ")[0]);
        else if (name) headers[name] = value;
      }
      res.writeHead(status, headers);
      res.end(buf.subarray(end + 4));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`, requests);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

function provision(apiBase, srv, { fullHistory = "true", recreateEmpty = "false", dryRun = false, assignment = null, feedbackPr = "false", serverUrl = pathToFileURL(srv).href, token = "stub-token" } = {}) {
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
        GITHUB_TOKEN: token,
        GITHUB_API_URL: apiBase,
        GITHUB_SERVER_URL: serverUrl,
        ORG: "Org",
        TEMPLATE_OWNER: "Org",
        TEMPLATE_REPO: "tpl",
        TEMPLATE_REPOSITORY_ID: "",
        TARGET_REPO: "lab-ann",
        ASSIGNMENT_ID: "lab",
        STUDENT_LOGIN: "ann",
        STUDENT_PERMISSION: "push",
        DRY_RUN: dryRun ? "1" : "0",
        FEEDBACK_PR: feedbackPr,
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
const tplRefs = (srv) => refs(join(srv, "Org", "tpl.git")).filter((l) => !l.startsWith("refs/pull/"));

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

test("F9: over HTTP the clone and the push authenticate with the App token's header, and without it fail at once, saying so", async () => {
  const token = "ghs_stubInstallationToken123";
  const srv = makeServer();
  await withGitHttp(srv, token, async (gitBase, requests) => {
    await withApi(srv, async (api, calls, repo) => {
      const r = await provision(api, srv, { serverUrl: gitBase, token });
      assert.equal(r.status, 0, r.log);
      assert.deepEqual(refs(repo), tplRefs(srv), "copied whole, over HTTP");
      assert.ok(requests.some((q) => q.url.includes("/Org/tpl.git/") && q.authorized), "the clone carried the header");
      assert.ok(requests.some((q) => q.url.includes("/Org/lab-ann.git/git-receive-pack") && q.authorized), "and so did the push");
      assert.ok(requests.every((q) => !q.url.includes(token) && !q.url.includes("x-access-token")), "never in a URL");
      assert.doesNotMatch(r.log, new RegExp(token), "nor in the log");
    });
  });

  // Not accepted: a 401 with prompts off is a failure in our words, not a wait.
  const srv2 = makeServer();
  await withGitHttp(srv2, token, async (gitBase, requests) => {
    await withApi(srv2, async (api) => {
      const began = Date.now();
      const r = await provision(api, srv2, { serverUrl: gitBase, token: "ghs_somebodyElse" });
      assert.equal(r.status, 1, r.log);
      assert.match(r.log, /the clone of the template was refused by GitHub: PXL Classroom's access to that repository was not accepted/);
      assert.ok(requests.length > 0 && requests.every((q) => !q.authorized));
      assert.ok(Date.now() - began < 60_000, "no prompt waited for a password");
    });
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
    assert.equal(output(r.outputs, "full_history"), "true");
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

test("S2: the feedback baseline is made on the copy, and a template branch with its name is never adopted", async () => {
  // Review 2026-10-14: the copy brings every template branch, and one named
  // like the baseline was adopted and protected - blocking the exercise that
  // needs it, and opening the template's own difference as every student's
  // feedback PR. The publish preflight refuses such a template; this is the
  // backstop for one changed after publishing.
  const srv = makeServer();
  await withApi(srv, async (api, calls) => {
    const r = await provision(api, srv, { feedbackPr: "true" });
    assert.equal(r.status, 0, r.log);
    assert.ok(calls.some((c) => c.startsWith("POST /repos/Org/lab-ann/git/refs")), "made on the copy");
    assert.ok(calls.some((c) => c.startsWith("PUT /repos/Org/lab-ann/branches/pxl-baseline/protection")), "and protected");
  });

  const tpl = makeServer();
  const work = mkdtempSync(join(tmpdir(), "pxl-tplbase-"));
  git(["clone", "-q", join(tpl, "Org", "tpl.git"), work], tpl);
  git(["checkout", "-q", "-b", "pxl-baseline"], work);
  commit(work, "notes.md", "the template's own\n", "A branch that happens to be called pxl-baseline");
  git(["push", "-q", "origin", "pxl-baseline"], work);
  const theirs = git(["rev-parse", "HEAD"], work);
  await withApi(tpl, async (api, calls, repo) => {
    const r = await provision(api, tpl, { feedbackPr: "true" });
    assert.equal(r.status, 0, r.log);
    assert.match(r.log, /the template has its own pxl-baseline branch/);
    assert.ok(!calls.some((c) => c.includes("/branches/pxl-baseline/protection")), "not protected");
    assert.equal(git(["rev-parse", "refs/heads/pxl-baseline"], repo), theirs, "left as the template has it");
    assert.equal(output(r.outputs, "baseline_sha") || "", "", "no baseline recorded");
  });
});

test("P2-21: on a REUSED copy the template's own pxl-baseline is not adopted either; one an earlier run made is", async () => {
  // Review 2026-10-14: the check asked "did this run copy the branches", so a
  // retry over an earlier run's copy adopted and protected the template's branch.
  const tpl = makeServer();
  const work = mkdtempSync(join(tmpdir(), "pxl-tplbase-reuse-"));
  git(["clone", "-q", join(tpl, "Org", "tpl.git"), work], tpl);
  git(["checkout", "-q", "-b", "pxl-baseline"], work);
  commit(work, "notes.md", "the template's own\n", "A branch that happens to be called pxl-baseline");
  git(["push", "-q", "origin", "pxl-baseline"], work);
  await withApi(tpl, async (api, calls) => {
    const r = await provision(api, tpl, { feedbackPr: "true" });
    assert.equal(r.status, 0, r.log);
    assert.equal(output(r.outputs, "outcome"), "reused");
    assert.match(r.log, /the template has its own pxl-baseline branch/);
    assert.ok(!calls.some((c) => c.includes("/branches/pxl-baseline/protection")), "not protected");
  }, { target: "copy", repoDefault: "master" });

  // The template has none: the pxl-baseline in the copy is ours, from the earlier run.
  const srv = makeServer();
  await withApi(srv, async (api, calls, repo) => {
    git(["update-ref", "refs/heads/pxl-baseline", git(["rev-parse", "refs/heads/master"], repo)], repo);
    const r = await provision(api, srv, { feedbackPr: "true" });
    assert.equal(r.status, 0, r.log);
    assert.match(r.log, /pxl-baseline already exists/);
    assert.ok(calls.some((c) => c.startsWith("PUT /repos/Org/lab-ann/branches/pxl-baseline/protection")), "adopted and protected");
  }, { target: "copy", repoDefault: "master" });
});

test("every tag of the template travels as it is: nothing reads a tag as a submission", async () => {
  // Submit tags were removed (2026-10-14), so a `submit/` tag in a template is
  // just a tag, and the exercise's own tags (`v1`) are part of what it gives.
  const srv = makeServer();
  await withApi(srv, async (api, calls, repo) => {
    const r = await provision(api, srv);
    assert.equal(r.status, 0, r.log);
    assert.ok(refs(repo).some((l) => l.startsWith("refs/tags/v1 ")));
    assert.ok(refs(repo).some((l) => l.startsWith("refs/tags/submit/")), "copied like any other");
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
    assert.equal(output(r.outputs, "full_history"), "true", "a recovered copy is said to be one");
    assert.ok(calls.some((c) => c.startsWith("PATCH /repos/Org/lab-ann") && c.includes('"default_branch":"master"')), "the default branch an earlier run left unset");
    assert.ok(!calls.some((c) => c.startsWith("POST /orgs/Org/repos")), "nothing copied again");
  }, { target: "copy", activity: [bot, bot, bot], repoDefault: "main" });
});

test("F4b: the copy is recovered even after the setting was turned off, since it is still a full-history copy", async () => {
  // Review 2026-10-14: a copy made while the setting was on, whose run
  // failed, retried after it was turned off, recorded nothing.
  const srv = makeServer();
  const bot = { actor: { login: `${APP_SLUG}[bot]` }, activity_type: "push" };
  await withApi(srv, async (api) => {
    const r = await provision(api, srv, { fullHistory: "false" });
    assert.equal(r.status, 0, r.log);
    assert.equal(output(r.outputs, "outcome"), "reused");
    assert.equal(output(r.outputs, "full_history"), "true");
    assert.equal(output(r.outputs, "starter_sha"), git(["rev-parse", "refs/heads/master"], join(srv, "Org", "tpl.git")));
  }, { target: "copy", activity: [bot, bot], repoDefault: "master" });
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

test("a reused copy left on a prepared branch: the default is set BEFORE the grading workflow is added, so it lands on the template's default", async () => {
  // Review 2026-10-14: the PATCH ran at the end, after step 5.5 had put the
  // grading workflow on whatever branch was default - `bugfix` here - so the
  // branch that is graded never got one.
  const srv = makeServer();
  const bot = { actor: { login: `${APP_SLUG}[bot]` }, activity_type: "push" };
  const assignment = { id: "lab", autograde: { enabled: true, execution_environment: "github_actions", tests: [{ name: "t", run: "true", points: 1 }] } };
  await withApi(srv, async (api, calls, repo) => {
    const r = await provision(api, srv, { recreateEmpty: "true", assignment });
    assert.equal(r.status, 0, r.log);
    const patchAt = calls.findIndex((c) => c.startsWith("PATCH /repos/Org/lab-ann") && c.includes('"default_branch":"master"'));
    const putAt = calls.findIndex((c) => c.startsWith("PUT /repos/Org/lab-ann/contents/.github/workflows/autograding.yml"));
    assert.ok(patchAt >= 0 && putAt > patchAt, calls.join("\n"));
    assert.match(git(["log", "-1", "--format=%s", "refs/heads/master"], repo), /Add autograding workflow/);
    assert.doesNotMatch(git(["log", "-1", "--format=%s", "refs/heads/bugfix"], repo), /Add autograding workflow/);
    assert.equal(output(r.outputs, "starter_sha"), git(["rev-parse", "refs/heads/master"], repo), "what it was given includes the App's own workflow");
    assert.equal(output(r.outputs, "starter_commit_count"), "3");
  }, { target: "copy", activity: [bot, bot], repoDefault: "bugfix" });
});

test("a repository GitHub generated from the template is never taken for a full-history copy, whoever pushed to it", async () => {
  // Review 2026-10-14: the setting ticked after some accepted with GitHub's
  // copy, a teammate's run reusing one of those would record its head as a
  // starting commit - and starter sync then refuses the assignment for good.
  const srv = makeServer();
  const bot = { actor: { login: `${APP_SLUG}[bot]` }, activity_type: "push" };
  await withApi(srv, async (api, calls) => {
    const r = await provision(api, srv, { recreateEmpty: "true" });
    assert.equal(r.status, 0, r.log);
    assert.equal(output(r.outputs, "starter_sha"), "");
    assert.ok(!calls.some((c) => c.startsWith("GET /repos/Org/lab-ann/activity")), "not even asked");
    assert.ok(!calls.some((c) => c.startsWith("PATCH")));
  }, { target: "copy", activity: [bot], repoDefault: "main", generatedFrom: "Org/tpl" });
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

test("AC12: a failed copy says why in its own words; git's lines, which name branches and files, never reach the public log", async () => {
  const { gitCopyFailure } = await import("../provisioning/provision.mjs");
  const said = gitCopyFailure("the push into the student's repository", {
    status: 1,
    stderr: "remote: error: GH013: Repository rule violations found for refs/heads/solution-secret.\n ! [remote rejected] solution-secret -> solution-secret (push declined)",
  }, 240000);
  assert.match(said, /a rule on the repository rejected it/);
  assert.doesNotMatch(said, /solution-secret/);
  assert.match(gitCopyFailure("the clone of the template", { signal: "SIGTERM" }, 240000), /did not finish within 4 minutes/);
  assert.match(gitCopyFailure("the clone of the template", { status: 128, stderr: "fatal: Authentication failed for 'https://github.com/Org/tpl.git/'" }, 240000), /access .* was not accepted/);
  assert.equal(gitCopyFailure("the clone of the template", { status: 128, stderr: "fatal: something about prepared-branch-x" }, 240000), "the clone of the template failed (git exited with code 128)");

  // For real: the template is gone from the server, so the clone fails.
  const srv = makeServer();
  rmSync(join(srv, "Org", "tpl.git"), { recursive: true, force: true });
  await withApi(srv, async (api) => {
    const r = await provision(api, srv);
    assert.equal(r.status, 1, r.log);
    assert.match(r.log, /the clone of the template failed \(git exited with code \d+\)/);
    assert.doesNotMatch(r.log, /fatal:/, "nothing git said");
  });
});

test("AC7: a teammate waits for a full-history copy as long as that copy may take, counted from the repository's creation", async () => {
  const { fillWaitChecks } = await import("../provisioning/provision.mjs");
  const now = new Date("2026-10-14T12:00:00Z");
  const ago = (s) => new Date(now.getTime() - s * 1000).toISOString();
  const step = 4 * 60 * 1000;
  // GitHub's copy fills in seconds: the two minutes stand.
  assert.equal(fillWaitChecks({ fullHistory: false, createdAt: ago(5), now, base: 60, stepMs: step }), 60);
  // Created just now: clone and push may take 4 + 4 minutes, and a minute more.
  assert.equal(fillWaitChecks({ fullHistory: true, createdAt: ago(0), now, base: 60, stepMs: step }), 270);
  assert.equal(fillWaitChecks({ fullHistory: true, createdAt: ago(300), now, base: 60, stepMs: step }), 120, "what is left of it");
  assert.equal(fillWaitChecks({ fullHistory: true, createdAt: ago(600), now, base: 60, stepMs: step }), 60, "never less than the two minutes");
  assert.equal(fillWaitChecks({ fullHistory: true, createdAt: undefined, now, base: 60, stepMs: step }), 270, "an unreadable age waits the whole limit");
  // Inside the job's fifteen minutes, and inside the ten a new repository is
  // kept from a retry's removal.
  const { STILL_FILLING_MS } = await import("../lib/existing-repo.mjs");
  const longest = fillWaitChecks({ fullHistory: true, createdAt: ago(0), now }) * 2000;
  assert.ok(longest < STILL_FILLING_MS, "the wait ends before the repository stops counting as new");
  for (const wf of ["acceptance-handler.yml", "retry-acceptance.yml"]) {
    const text = readFileSync(new URL(`../.github/workflows/${wf}`, import.meta.url), "utf8");
    const minutes = Number(text.match(/timeout-minutes: (\d+)/)?.[1]);
    assert.ok(longest + 5 * 60 * 1000 <= minutes * 60 * 1000, `${wf}: five minutes left for the rest of the run`);
  }
});

test("without the setting, GitHub's template copy is asked for, never an empty repository and a push", async () => {
  // Which route only: this stub refuses `generate`. That GitHub's copy then
  // records no start is tests/provision-injected-start.test.mjs, against a
  // generate that works (review 2026-10-14, P2-24: the title claimed it here).
  const srv = makeServer();
  await withApi(srv, async (api, calls) => {
    const r = await provision(api, srv, { fullHistory: "false" });
    assert.ok(calls.some((c) => c.startsWith("POST /repos/Org/tpl/generate")));
    assert.ok(!calls.some((c) => c.startsWith("POST /orgs/Org/repos")));
    assert.notEqual(r.status, 0, "the stub refuses generate");
    assert.ok(!output(r.outputs, "starter_sha"), "and no start is said");
    assert.notEqual(output(r.outputs, "full_history"), "true");
  });
});
