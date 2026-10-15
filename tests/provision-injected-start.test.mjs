// Provisioning records the start of GitHub's copy when it commits to it.
//
// 2026-10-14: on an assignment whose checks are defined in PXL Classroom and
// run on GitHub Actions, provisioning commits the grading workflow to every
// new repository. That is two commits from the first second, and the report's
// "one commit is the start" read every student who did nothing as handed in -
// "On time" - and the nightly graded the workflow's own run. The commit
// provisioning made is the start now (starter_sha / starter_commit_count),
// and it is not a full-history copy.
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

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "provisioning", "provision.mjs");
const INJECTED = "d".repeat(40);

const ROOT = "e".repeat(40);
// GitHub's generated first commit, as GET /commits/{sha} answers it.
const GENERATED_ROOT = { sha: ROOT, parents: [], committer: { login: "web-flow" }, author: { login: "pxl-classroom[bot]" }, commit: { verification: { verified: true } } };
const STUDENT_COMMIT = { sha: ROOT, parents: [{ sha: "f".repeat(40) }], committer: { login: "ann" }, author: { login: "ann" }, commit: { verification: { verified: false } } };

/**
 * `existing`: the repository is there before the run (a retry of GitHub's
 * copy whose first run failed before the workflow was added), and the commit
 * under the one this run adds is `GENERATED_ROOT` or a student's.
 */
async function withApi(fn, { templateGrades = false, existing = null, contentsEmpty = false, grantStatus = 204, injectStatus = 201, variableStatus = 201, raced = false } = {}) {
  const calls = [];
  let generated = Boolean(existing);
  // `raced`: a teammate's run wrote the workflow between this run's check and
  // its write, so the write is refused because the file now exists (R6-16).
  let written = false;
  const server = createServer((req, res) => {
    const send = (code, body, headers = {}) => {
      res.writeHead(code, { "content-type": "application/json", ...headers });
      res.end(body === undefined ? "" : JSON.stringify(body));
    };
    const [url, query = ""] = req.url.split("?");
    calls.push(`${req.method} ${url}${query ? `?${query}` : ""}`);
    req.resume();
    if (url === "/rate_limit") return send(200, { rate: { remaining: 5000 } });
    if (url === "/repos/Org/tpl" && req.method === "GET") return send(200, { id: 7, is_template: true, private: true, default_branch: "main" });
    if (url === "/repos/Org/tpl/generate") {
      generated = true;
      return send(201, { id: 10, full_name: "Org/lab-ann", html_url: "https://github.com/Org/lab-ann", default_branch: "main" });
    }
    if (url === "/repos/Org/lab-ann" && req.method === "GET") {
      return generated
        ? send(200, { id: 10, full_name: "Org/lab-ann", default_branch: "main", template_repository: { full_name: "Org/tpl" }, created_at: "2026-10-14T08:00:00Z" })
        : send(404, { message: "Not Found" });
    }
    if (url === `/repos/Org/lab-ann/commits/${INJECTED}`) return send(200, { sha: INJECTED, parents: [{ sha: ROOT }] });
    if (url === `/repos/Org/lab-ann/commits/${ROOT}`) return send(200, existing === "student" ? STUDENT_COMMIT : GENERATED_ROOT);
    // `contentsEmpty`: GitHub never finishes copying the template in.
    if (url === "/repos/Org/lab-ann/contents/" && req.method === "GET") return contentsEmpty ? send(404, { message: "This repository is empty." }) : send(200, [{ name: "README.md", type: "file" }]);
    if (/^\/repos\/Org\/lab-ann\/contents\/\.github\/workflows\/(autograding|classroom)\.yml$/.test(url) && req.method === "GET") {
      return (templateGrades || written) && url.endsWith("autograding.yml") ? send(200, { name: "autograding.yml" }) : send(404, { message: "Not Found" });
    }
    if (url === "/repos/Org/lab-ann/contents/.github/workflows/autograding.yml" && req.method === "PUT") {
      let body = "";
      req.on("data", (c) => (body += c));
      return req.on("end", () => {
        calls.push(`MESSAGE ${JSON.parse(body || "{}").message}`);
        if (raced) {
          written = true;
          return send(422, { message: "Invalid request.\n\n\"sha\" wasn't supplied." });
        }
        if (injectStatus !== 201) return send(injectStatus, { message: "Resource not accessible by integration" });
        return send(201, { content: { path: ".github/workflows/autograding.yml" }, commit: { sha: INJECTED } });
      });
    }
    if (url === "/repos/Org/lab-ann/commits" && query.includes("path=")) {
      // The commit that added the workflow: the teammate's run's, by the App.
      return send(200, [{ sha: INJECTED, author: { login: "pxl-classroom-provisioner[bot]" }, commit: { verification: { verified: true } } }]);
    }
    if (url === "/repos/Org/lab-ann/commits") {
      // GitHub's one commit plus the workflow: the `last` page is 2.
      return send(200, [{ sha: INJECTED }], { link: `<http://x/repos/Org/lab-ann/commits?sha=${INJECTED}&per_page=1&page=2>; rel="last"` });
    }
    // 201: an invitation GitHub emailed (they were not in the organization).
    if (/\/collaborators\/ann$/.test(url) && req.method === "PUT") {
      if (grantStatus === 204) return send(204);
      if (grantStatus === 201) return send(201, { id: 55, invitee: { login: "ann" }, permissions: "write" });
      return send(grantStatus, { message: "Forbidden" });
    }
    // The student's own deadline (lib/deadline-variable.mjs): none there yet.
    if (url === "/repos/Org/lab-ann/actions/variables/PXL_DEADLINE" && req.method === "PATCH") return send(404, { message: "Not Found" });
    if (url === "/repos/Org/lab-ann/actions/variables" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      return req.on("end", () => {
        calls.push(`BODY ${body}`);
        send(variableStatus, variableStatus === 201 ? {} : { message: "Resource not accessible by integration" });
      });
    }
    return send(404, { message: "not stubbed: " + url });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`, calls);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

/** `files`: more of the control repository, path -> JSON document. */
function provision(apiBase, { dryRun = false, files = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pxl-provision-inject-"));
  mkdirSync(join(dir, "control", "assignments"), { recursive: true });
  writeFileSync(join(dir, "control", "assignments", "lab.yml"), stringify({
    id: "lab", deadline_at: "2026-10-20T22:00:00Z",
    autograde: { enabled: true, execution_environment: "github_actions", tests: [{ id: "t", name: "t", run: "true", points: 1 }] },
  }));
  for (const [path, doc] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, "control", path)), { recursive: true });
    writeFileSync(join(dir, "control", path), JSON.stringify(doc));
  }
  return new Promise((resolve, reject) => {
    const child = spawn("node", [script], {
      cwd: dir,
      env: {
        ...process.env, GITHUB_TOKEN: "stub-token", GITHUB_API_URL: apiBase, ORG: "Org", TEMPLATE_OWNER: "Org", TEMPLATE_REPO: "tpl",
        TEMPLATE_REPOSITORY_ID: "", TARGET_REPO: "lab-ann", ASSIGNMENT_ID: "lab", STUDENT_LOGIN: "ann", STUDENT_PERMISSION: "push",
        DRY_RUN: dryRun ? "1" : "0", RECREATE_EMPTY: "false", FEEDBACK_PR: "false", TEMPLATE_FULL_HISTORY: "false", PXL_FILL_WAIT_CHECKS: "2",
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

test("GitHub's copy that provisioning committed the grading workflow to records that commit as its start", async () => {
  await withApi(async (api, calls) => {
    const r = await provision(api);
    assert.equal(r.status, 0, r.log);
    assert.ok(calls.some((c) => c.startsWith("PUT /repos/Org/lab-ann/contents/.github/workflows/autograding.yml")));
    // Not run on its own commit: a red cross on every student's first commit,
    // and a run per acceptance (seen live, drill-20261014-2211).
    assert.ok(calls.includes("MESSAGE Add autograding workflow [skip ci]"), calls.filter((c) => c.startsWith("MESSAGE")).join(", "));
    assert.equal(output(r.outputs, "starter_sha"), INJECTED);
    assert.equal(output(r.outputs, "starter_commit_count"), "2");
    assert.equal(output(r.outputs, "full_history"), "false", "not a copy of the template's history");
  });
});

test("P2-20: a retry that adds the workflow its first run never did records that commit as the start - over GitHub's copy only", async () => {
  // Review 2026-10-14: only a first run's start was recorded, so the student
  // read two commits, "On time", with nothing done.
  await withApi(async (api, calls) => {
    const r = await provision(api);
    assert.equal(r.status, 0, r.log);
    assert.equal(output(r.outputs, "outcome"), "reused");
    assert.ok(calls.some((c) => c.startsWith("PUT /repos/Org/lab-ann/contents/.github/workflows/autograding.yml")), "the retry adds it");
    assert.equal(output(r.outputs, "starter_sha"), INJECTED);
    assert.equal(output(r.outputs, "starter_commit_count"), "2");
  }, { existing: "generated" });
  // Over a commit that is not GitHub's copy: not what they were given.
  await withApi(async (api) => {
    const r = await provision(api);
    assert.equal(r.status, 0, r.log);
    assert.equal(output(r.outputs, "starter_sha"), "", "nothing recorded rather than a guess");
    assert.match(r.log, /not GitHub's copy alone, so no start is recorded/);
  }, { existing: "student" });
});

test("...and one provisioning added nothing to records none: one commit is the start, as ever", async () => {
  await withApi(async (api) => {
    const r = await provision(api);
    assert.equal(r.status, 0, r.log);
    assert.equal(output(r.outputs, "starter_sha"), "");
  }, { templateGrades: true });
});

test("TA-9: a grading workflow that cannot be added fails the run, so a student who would never be graded is seen - and still recorded", async () => {
  // It logged and reported the acceptance done: green, and that student's work
  // was never graded.
  await withApi(async (api) => {
    const r = await provision(api);
    assert.equal(r.status, 1, r.log);
    assert.equal(output(r.outputs, "outcome"), "fail:grading-workflow");
    assert.match(r.log, /the grading workflow could not be added \(HTTP 403\)/);
    assert.match(r.log, /Retry acceptance/);
    assert.equal(output(r.outputs, "granted"), "true", "they hold it, so the record step still records them");
    assert.equal(output(r.outputs, "repo_name"), "Org/lab-ann");
  }, { injectStatus: 403 });
  // A template that ships its own grading workflow is not written over: no
  // write, no failure.
  await withApi(async (api, calls) => {
    const r = await provision(api);
    assert.equal(r.status, 0, r.log);
    assert.ok(!calls.some((c) => c.startsWith("PUT /repos/Org/lab-ann/contents/.github/workflows/autograding.yml")));
    assert.match(r.log, /workflow already present from template - skipping injection/);
  }, { templateGrades: true, injectStatus: 500 });
});

test("R6-44: a grading workflow that cannot be added fails the run at its END - the invitation, the deadline and the rest are still done", async () => {
  // It failed at once, after the grant: the student was emailed an invitation
  // and their page was never told (no `invited`), and their deadline variable,
  // baseline and start were skipped with it.
  await withApi(async (api, calls) => {
    const r = await provision(api, { files: { "overrides/lab/ann.json": extension("ann", "2026-10-25T22:00:00Z") } });
    assert.equal(r.status, 1, r.log);
    assert.equal(output(r.outputs, "outcome"), "fail:grading-workflow");
    assert.equal(output(r.outputs, "invited"), "true", "their page is told an invitation is waiting");
    assert.ok(calls.some((c) => c.startsWith("BODY ")), "their own deadline still reaches their repository");
    assert.equal(output(r.outputs, "repo_id"), "10");
    // The failure is the last word of the log, after everything else ran.
    assert.match(r.log.trim().split("\n").at(-1), /fail:grading-workflow - .*could not be added \(HTTP 403\)/);
  }, { injectStatus: 403, grantStatus: 201 });
});

test("R6-16: a write refused because a teammate's run (or GitHub's retried PUT) already added the workflow is done, and records that commit", async () => {
  await withApi(async (api) => {
    const r = await provision(api);
    assert.equal(r.status, 0, r.log);
    assert.notEqual(output(r.outputs, "outcome"), "fail:grading-workflow");
    assert.match(r.log, /the grading workflow is there already \(the write answered HTTP 422\)/);
    assert.equal(output(r.outputs, "starter_sha"), INJECTED, "the App's commit is the start");
  }, { raced: true });
});

test("TL-7: `granted` is said the moment the student holds the repository, so a later failure still leaves them on a record lockdown reads", async () => {
  // The grant held, then GitHub never filled the repository in: the run fails
  // AFTER the student has access, and the workflow writes their record from
  // `granted` (LD5). ~30s: the population wait is not shortened for the test.
  await withApi(async (api) => {
    const r = await provision(api);
    assert.notEqual(r.status, 0, "the run fails");
    assert.equal(output(r.outputs, "outcome"), "fail:template-not-populated", r.log);
    assert.equal(output(r.outputs, "granted"), "true");
    assert.equal(output(r.outputs, "repo_name"), "Org/lab-ann");
  }, { contentsEmpty: true });
  // A grant GitHub refused: nobody holds it, so no `granted`.
  await withApi(async (api) => {
    const r = await provision(api);
    assert.equal(output(r.outputs, "outcome"), "fail:grant", r.log);
    assert.equal(output(r.outputs, "granted"), undefined);
  }, { grantStatus: 403 });
  // A dry run grants nothing and says nothing.
  await withApi(async (api, calls) => {
    const r = await provision(api, { dryRun: true });
    assert.equal(output(r.outputs, "granted"), undefined, r.log);
    assert.ok(!calls.some((c) => c.startsWith("PUT ")), "nothing written");
  });
});

// THE STUDENT'S OWN DEADLINE (lib/deadline-variable.mjs, decided 2026-10-15):
// an extension granted before they accepted reaches their page only if the
// repository carries it from the start.
const extension = (login, value) => ({
  schema_version: 1, assignment_id: "lab", github_login: login,
  overrides: [{ type: "deadline_extension", value, reason: "medical", overridden_by: "l", overridden_at: "2026-10-01T00:00:00Z" }],
});

test("an extension granted before they accepted is written to the new repository, the date and nothing else", async () => {
  await withApi(async (api, calls) => {
    const r = await provision(api, { files: { "overrides/lab/ann.json": extension("ann", "2026-10-25T22:00:00Z") } });
    assert.equal(r.status, 0, r.log);
    const body = calls.find((c) => c.startsWith("BODY "));
    assert.deepEqual(JSON.parse(body.slice(5)), { name: "PXL_DEADLINE", value: "2026-10-25T22:00:00.000Z" });
    // The run log is public: no date, no word of an extension.
    assert.doesNotMatch(r.log, /2026-10-25|extension|own-deadline/i);
  });
});

test("a team repository carries its most generous member's; nobody extended, or someone else extended, writes nothing", async () => {
  await withApi(async (api, calls) => {
    const r = await provision(api, {
      files: {
        "overrides/lab/cy.json": extension("cy", "2026-10-27T22:00:00Z"),
        "teams/lab/alpha.json": { schema_version: 1, assignment_id: "lab", team_slug: "alpha", team_name: "Alpha", members: ["Ann", "cy"] },
      },
    });
    assert.equal(r.status, 0, r.log);
    assert.equal(JSON.parse(calls.find((c) => c.startsWith("BODY ")).slice(5)).value, "2026-10-27T22:00:00.000Z");
  });
  for (const files of [{}, { "overrides/lab/bob.json": extension("bob", "2026-10-27T22:00:00Z") }]) {
    await withApi(async (api, calls) => {
      const r = await provision(api, { files });
      assert.equal(r.status, 0, r.log);
      assert.ok(!calls.some((c) => c.includes("/actions/variables")), JSON.stringify(files));
    });
  }
});

test("a variable GitHub refuses does not fail the acceptance, and the log says so without the date", async () => {
  await withApi(async (api) => {
    const r = await provision(api, { files: { "overrides/lab/ann.json": extension("ann", "2026-10-25T22:00:00Z") } });
    assert.equal(r.status, 0, r.log);
    assert.equal(output(r.outputs, "outcome"), "created");
    assert.match(r.log, /the repository's deadline variable could not be written \(HTTP 403\)/);
    assert.doesNotMatch(r.log, /2026-10-25/);
  }, { variableStatus: 403 });
});
