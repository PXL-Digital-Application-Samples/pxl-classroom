// PXL Classroom - unrecorded-repos.test.mjs
//
// A student repository that exists with no record is a student nobody
// collects, locks, archives or grades - and the student cannot tell.
//
// Measured 2026-09-28 on PXL-SNB-Security-Expert2627: thirteen acceptances in
// one minute, one run lost the push to the control repo five times, and that
// student was outside the list for two days. Two things answer it now: the
// acceptance notifies when its own record push fails, and the nightly looks
// for the same state from the other side. These pin both.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { generatedFrom, loginFromRepoName, parseUnrecordedLines, unrecordedCandidates, unrecordedNoticeLine } from "../lib/unrecorded-repos.mjs";

test("a notice line and its reading are one pair: every finding round-trips", () => {
  const findings = [
    { repo: "2526-sysex-ek2-test2-tomcoolpxl", login: "tomcoolpxl", assignment_id: "2526-sysex-ek2-test2" },
    { repo: "lab-x", login: null, assignment_id: "lab" },
  ];
  const details = `Intro.\n\n${findings.map(unrecordedNoticeLine).join("\n")}\n\nAdvice.`;
  assert.deepEqual(parseUnrecordedLines(details), [
    { repo: "2526-sysex-ek2-test2-tomcoolpxl", login: "tomcoolpxl", assignmentId: "2526-sysex-ek2-test2" },
    { repo: "lab-x", login: null, assignmentId: "lab" },
  ]);
  assert.deepEqual(parseUnrecordedLines("No list here."), []);
  // The notice as it was posted on 2026-10-08, before this pair existed.
  assert.equal(parseUnrecordedLines("- `2526-sysex-ek2-test2-tomcoolpxl` - student `tomcoolpxl` (assignment `2526-sysex-ek2-test2`)")[0].login, "tomcoolpxl");
});

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "scripts", "find-unrecorded-repos.mjs");

const LAB = { id: "lab", state: "published", repository_name_pattern: "lab-{github_login}" };

test("a repository the pattern produces that no record names is a candidate", () => {
  const found = unrecordedCandidates({
    assignments: [LAB],
    recorded: new Map([["lab", ["Org/lab-ann"]]]),
    repoNames: ["lab-ann", "lab-Timo", "pxl-classroom-control", "starter"],
  });
  assert.deepEqual(found, [{ assignment_id: "lab", repo: "lab-Timo" }]);
});

test("a record matches whatever its case and whether or not it names the owner", () => {
  const found = unrecordedCandidates({
    assignments: [LAB],
    recorded: new Map([["lab", ["ORG/LAB-TIMO", "lab-ann"]]]),
    repoNames: ["lab-ann", "lab-Timo"],
  });
  assert.deepEqual(found, []);
});

test("only an assignment students can hold a repository of is looked at", () => {
  for (const state of ["draft", "archived"]) {
    assert.deepEqual(
      unrecordedCandidates({ assignments: [{ ...LAB, state }], recorded: new Map(), repoNames: ["lab-timo"] }),
      [],
      state,
    );
  }
  assert.equal(unrecordedCandidates({ assignments: [{ ...LAB, state: "closed" }], recorded: new Map(), repoNames: ["lab-timo"] }).length, 1);
});

test("a name a more specific assignment explains belongs to that one", () => {
  // `lab-{github_login}` also matches `lab-exam-timo`; the exam owns it.
  const exam = { id: "exam", state: "published", repository_name_pattern: "lab-exam-{github_login}" };
  const found = unrecordedCandidates({ assignments: [LAB, exam], recorded: new Map(), repoNames: ["lab-exam-timo"] });
  assert.deepEqual(found, [{ assignment_id: "exam", repo: "lab-exam-timo" }]);
});

test("generatedFrom: only GitHub's own template_repository is proof", () => {
  const tpl = { owner: "Org", repository: "starter" };
  assert.equal(generatedFrom({ ok: true, data: { template_repository: { full_name: "org/Starter" } } }, tpl), true);
  assert.equal(generatedFrom({ ok: true, data: { template_repository: { full_name: "Org/other" } } }, tpl), false);
  assert.equal(generatedFrom({ ok: true, data: {} }, tpl), false, "made by hand with a matching name");
  assert.equal(generatedFrom({ ok: false, status: 500 }, tpl), null, "unreadable is not evidence");
  assert.equal(generatedFrom({ ok: true, data: { template_repository: { full_name: "/" } } }, {}), false);
});

test("loginFromRepoName reads the login out of the ordinary pattern, and nothing out of another", () => {
  assert.equal(loginFromRepoName("lab-{github_login}", "lab-TimoHubner444"), "TimoHubner444");
  assert.equal(loginFromRepoName("{github_login}-portfolio", "ann-portfolio"), "ann");
  assert.equal(loginFromRepoName("grp-{team_slug}", "grp-team-a"), null);
  assert.equal(loginFromRepoName("lab-{github_login}", "other-ann"), null);
  assert.equal(loginFromRepoName("lab-{github_login}", "lab-"), null);
});

// --- the script, against a stub API ------------------------------------------

function controlDir() {
  const dir = mkdtempSync(join(tmpdir(), "pxl-unrecorded-"));
  mkdirSync(join(dir, "assignments"));
  writeFileSync(
    join(dir, "assignments", "lab.yml"),
    "state: published\nrepository_name_pattern: lab-{github_login}\ntemplate:\n  owner: Org\n  repository: starter\n",
  );
  mkdirSync(join(dir, "repositories", "lab"), { recursive: true });
  writeFileSync(join(dir, "repositories", "lab", "ann.json"), JSON.stringify({ github_login: "ann", repo_name: "Org/lab-ann" }));
  return dir;
}

async function run({ listStatus = 200, repos } = {}) {
  const list = repos ?? [
    { name: "lab-ann", from: "Org/starter" },
    { name: "lab-TimoHubner444", from: "Org/starter" },
    { name: "lab-byhand", from: null },
    { name: "starter", from: null },
  ];
  const server = createServer((req, res) => {
    const send = (code, body) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const url = req.url.split("?")[0];
    // 403, not a 5xx: a 5xx is retried with backoff, which only slows the test.
    if (url === "/orgs/Org/repos") return listStatus === 200 ? send(200, list.map((r) => ({ name: r.name }))) : send(listStatus, { message: "no" });
    const one = list.find((r) => url === `/repos/Org/${r.name}`);
    if (one) return send(200, { name: one.name, ...(one.from ? { template_repository: { full_name: one.from } } : {}) });
    return send(404, { message: "not stubbed: " + url });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const dir = controlDir();
  const out = join(dir, "out.env");
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn("node", [script, dir, "Org"], {
        env: { ...process.env, GITHUB_TOKEN: "stub", GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`, GITHUB_OUTPUT: out },
      });
      let log = "";
      child.stdout.on("data", (d) => (log += d));
      child.stderr.on("data", (d) => (log += d));
      child.on("error", reject);
      child.on("close", (status) => resolve({ status, log, outputs: existsSync(out) ? readFileSync(out, "utf8") : "" }));
    });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test("the script reports the unrecorded student, and not a hand-made repository of the same shape", async () => {
  const res = await run();
  assert.equal(res.status, 0, res.log);
  assert.match(res.outputs, /^count=1$/m);
  assert.match(res.outputs, /`lab-TimoHubner444` - student `TimoHubner444` \(assignment `lab`\)/);
  assert.doesNotMatch(res.outputs, /lab-byhand/, "not generated from the template, so not ours to report");
  assert.doesNotMatch(res.outputs, /lab-ann/, "recorded");
  assert.match(res.outputs, /\*\*Retry\*\* beside each one adds the student/);
  // Written in the one format the Organization page reads back.
  assert.deepEqual(parseUnrecordedLines(res.outputs.match(/details<<(\w+)\n([\s\S]*?)\n\1/)[2]).map((l) => [l.repo, l.login]), [["lab-TimoHubner444", "TimoHubner444"]]);
  assert.match(res.outputs, /^dedup=unrecorded-[0-9a-f]{16}$/m);
});

test("nothing to report writes a zero and no notice text", async () => {
  const res = await run({ repos: [{ name: "lab-ann", from: "Org/starter" }] });
  assert.equal(res.status, 0, res.log);
  assert.match(res.outputs, /^count=0$/m);
  assert.doesNotMatch(res.outputs, /details/);
});

test("a listing that could not be read says it did NOT RUN, and never fails the job", async () => {
  const res = await run({ listStatus: 403 });
  assert.equal(res.status, 0, "advisory: it must not fail the collect leg");
  assert.match(res.log, /::warning::Unrecorded-repository check DID NOT RUN for Org/);
  assert.match(res.outputs, /^count=0$/m);
});

// --- the wiring ---------------------------------------------------------------

test("the nightly runs it per org, advisory, and notifies only when something was found", () => {
  const steps = parse(readFileSync(join(root, ".github/workflows/daily-activity.yml"), "utf8")).jobs.collect.steps;
  const find = steps.find((s) => s.id === "unrecorded");
  const token = steps.find((s) => s.id === "unrecorded_token");
  const notice = steps.find((s) => s.name === "Tell the lecturer about repositories with no record");
  assert.ok(find && token && notice, "all three steps exist");
  for (const s of [find, token, notice]) assert.equal(s["continue-on-error"], true, `${s.name} can never fail the collect leg`);
  assert.match(find.run, /scripts\/find-unrecorded-repos\.mjs control/);
  assert.match(String(notice.if), /steps\.unrecorded\.outputs\.count != '0'/);
  assert.deepEqual(Object.keys(token.with).filter((k) => k.startsWith("permission-")), ["permission-metadata"], "metadata only");
});

test("an acceptance whose record push fails notifies the lecturer, naming the student", () => {
  const steps = parse(readFileSync(join(root, ".github/workflows/acceptance-handler.yml"), "utf8")).jobs.accept.steps;
  const record = steps.findIndex((s) => s.id === "record");
  const notice = steps.findIndex((s) => s.name === "Notify the lecturer of a repository that was not recorded");
  assert.ok(record > -1 && notice === record + 1, "the notice follows the record step");
  assert.match(steps[record].name, /Write repository record/);
  assert.equal(String(steps[notice].if), "failure() && steps.record.outcome == 'failure'");
  assert.equal(steps[notice]["continue-on-error"], true);
  assert.match(steps[notice].with.details, /steps\.accept\.outputs\.github_login/);
  assert.match(steps[notice].with.details, /Press \*\*Retry\*\*/);
});
