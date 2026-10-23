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
import { copiedFrom, emptyLeftover, generatedFrom, lastPageFromLink, loginFromRepoName, parseUnrecordedLines, splitByOpening, unrecordedCandidates, unrecordedNoticeLine } from "../lib/unrecorded-repos.mjs";

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

const OPENS = "2026-09-01T08:00:00Z";

function controlDir({ fullHistory = false, recordFullHistory = false, opensAt = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pxl-unrecorded-"));
  mkdirSync(join(dir, "assignments"));
  writeFileSync(
    join(dir, "assignments", "lab.yml"),
    "state: published\nrepository_name_pattern: lab-{github_login}\ntemplate:\n  owner: Org\n  repository: starter\n" +
      (fullHistory ? "template_full_history: true\n" : "") +
      (opensAt ? `opens_at: "${opensAt}"\n` : ""),
  );
  // A team assignment: its repository names a team, never a student.
  writeFileSync(
    join(dir, "assignments", "grp.yml"),
    `state: published\nassignment_type: group\nrepository_name_pattern: grp-{team_slug}\ntemplate:\n  owner: Org\n  repository: starter\nopens_at: "${OPENS}"\n`,
  );
  mkdirSync(join(dir, "repositories", "lab"), { recursive: true });
  writeFileSync(join(dir, "repositories", "lab", "ann.json"), JSON.stringify({ github_login: "ann", repo_name: "Org/lab-ann", ...(recordFullHistory ? { full_history: true } : {}) }));
  return dir;
}

// The commit GitHub generates from a template (lib/starter-sync-cohort.mjs `generatedFromTemplate`).
const GENERATED = { sha: "gen", parents: [], committer: { login: "web-flow" }, author: { login: "pxl-classroom-provisioner[bot]" }, commit: { verification: { verified: true } } };
const PUSHED = { sha: "work", parents: [{ sha: "gen" }], committer: { login: "web-flow" }, author: { login: "a-student" }, commit: { verification: { verified: false } } };

async function run({ listStatus = 200, repos, fullHistory = false, recordFullHistory = false, opensAt = null } = {}) {
  const list = repos ?? [
    { name: "lab-ann", from: "Org/starter" },
    { name: "lab-TimoHubner444", from: "Org/starter" },
    { name: "lab-byhand", from: null },
    { name: "starter", from: null },
  ];
  const server = createServer((req, res) => {
    const send = (code, body, headers = {}) => {
      res.writeHead(code, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    const [url, query = ""] = req.url.split("?");
    // 403, not a 5xx: a 5xx is retried with backoff, which only slows the test.
    if (url === "/orgs/Org/repos") return listStatus === 200 ? send(200, list.map((r) => ({ name: r.name, ...(r.created ? { created_at: r.created } : {}) }))) : send(listStatus, { message: "no" });
    // Who can open it, who is invited, and what is in it: asked of a
    // team-shaped finding only (`emptyLeftover`).
    const sub = url.match(/^\/repos\/Org\/([^/]+)\/(collaborators|invitations|branches|activity)$/);
    if (sub) {
      const r = list.find((x) => x.name === sub[1]);
      if (sub[2] === "collaborators") return r?.collaboratorsStatus ? send(r.collaboratorsStatus, { message: "no" }) : send(200, r?.collaborators ?? []);
      if (sub[2] === "invitations") return send(200, r?.invitations ?? []);
      if (sub[2] === "branches") return send(200, [{ name: "main" }]);
      return send(200, []);
    }
    // repoTouched's read of the history, newest first.
    const history = url.match(/^\/repos\/Org\/([^/]+)\/commits$/);
    if (history && new URLSearchParams(query).get("per_page") === "21") {
      const r = list.find((x) => x.name === history[1]);
      return send(200, r?.pushed ? [PUSHED, GENERATED] : [GENERATED]);
    }
    // Commits at one per page, as GitHub pages them: the last page is the root.
    const commits = url.match(/^\/repos\/Org\/([^/]+)\/commits$/);
    if (commits) {
      const r = commits[1] === "starter" ? { root: "c0ffee" } : list.find((x) => x.name === commits[1]);
      if (!r?.root) return send(404, { message: "no" });
      const page = Number(new URLSearchParams(query).get("page") || 1);
      return page === 3
        ? send(200, [{ sha: r.root }])
        : send(200, [{ sha: "head" }], { link: `<http://x/repos/Org/${commits[1]}/commits?per_page=1&page=3>; rel="last"` });
    }
    const one = list.find((r) => url === `/repos/Org/${r.name}`);
    if (one) return send(200, { name: one.name, ...(one.from ? { template_repository: { full_name: one.from } } : {}) });
    return send(404, { message: "not stubbed: " + url });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const dir = controlDir({ fullHistory, recordFullHistory, opensAt });
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

test("S7: a full-history copy no record names is reported by its root commit; a lookalike is not", async () => {
  // Review 2026-10-14: a pushed copy names no template, so the check could
  // never see one whose record push was lost.
  assert.equal(copiedFrom("C0FFEE", "c0ffee"), true);
  assert.equal(copiedFrom("beef", "c0ffee"), false);
  assert.equal(copiedFrom(null, "c0ffee"), null, "unread is not evidence");
  assert.equal(lastPageFromLink('<https://api.github.com/x?per_page=1&page=57>; rel="last"'), 57);
  assert.equal(lastPageFromLink(""), null);

  const res = await run({
    fullHistory: true,
    repos: [
      { name: "lab-ann", from: null, root: "c0ffee" },
      { name: "lab-lost", from: null, root: "c0ffee" },
      { name: "lab-byhand", from: null, root: "beef" },
    ],
  });
  assert.equal(res.status, 0, res.log);
  assert.match(res.outputs, /^count=1$/m, res.log);
  assert.match(res.outputs, /`lab-lost` - student `lost`/);
  assert.doesNotMatch(res.outputs, /lab-byhand/, "another root: not a copy of this template");

  // Without the setting a repository naming no template is still not ours.
  const plain = await run({ repos: [{ name: "lab-lost", from: null, root: "c0ffee" }] });
  assert.match(plain.outputs, /^count=0$/m, plain.log);

  // TA-7: the setting turned off since, while a record says a copy was made
  // with it: a lost copy is still found.
  const since = await run({
    recordFullHistory: true,
    repos: [{ name: "lab-ann", from: null, root: "c0ffee" }, { name: "lab-lost", from: null, root: "c0ffee" }],
  });
  assert.match(since.outputs, /^count=1$/m, since.log);
  assert.match(since.outputs, /`lab-lost` - student `lost`/);
});

test("a repository made before its assignment opened is last year's, not a lost acceptance", async () => {
  // PXL-Digital-SNE-Werkplekleren, 2026-10-23: `portfolio-{github_login}` builds
  // on last year's repository, and 341 earlier portfolios were candidates every
  // night, the same first 50 looked at and the rest never.
  const res = await run({
    opensAt: OPENS,
    repos: [
      { name: "lab-ann", from: "Org/starter", created: "2026-09-02T10:00:00Z" },
      { name: "lab-lastyear", from: "Org/starter", created: "2025-09-20T10:00:00Z" },
      { name: "lab-thisyear", from: "Org/starter", created: "2026-09-03T10:00:00Z" },
      { name: "lab-nodate", from: "Org/starter" },
    ],
  });
  assert.equal(res.status, 0, res.log);
  assert.match(res.outputs, /^count=2$/m, res.log);
  assert.match(res.outputs, /`lab-thisyear` - student `thisyear`/);
  assert.match(res.outputs, /`lab-nodate` - student `nodate`/, "an unknown creation time is not evidence it is old");
  assert.doesNotMatch(res.outputs, /lab-lastyear/);
  assert.match(res.log, /made since their assignment opened \(1 older\)/);

  // Without an opening on the assignment nothing is left out.
  const unopened = await run({ repos: [{ name: "lab-lastyear", from: "Org/starter", created: "2025-09-20T10:00:00Z" }] });
  assert.match(unopened.outputs, /^count=1$/m, unopened.log);
});

test("splitByOpening: older ones apart, the rest newest first, unknown kept", () => {
  const byId = new Map([["lab", { opens_at: OPENS }], ["free", {}]]);
  const created = new Map([["lab-a", "2026-09-05T00:00:00Z"], ["lab-b", "2026-09-10T00:00:00Z"], ["lab-old", "2024-01-01T00:00:00Z"], ["free-x", "2020-01-01T00:00:00Z"]]);
  const { current, older } = splitByOpening(
    [{ assignment_id: "lab", repo: "lab-a" }, { assignment_id: "lab", repo: "LAB-OLD" }, { assignment_id: "lab", repo: "lab-b" }, { assignment_id: "lab", repo: "lab-c" }, { assignment_id: "free", repo: "free-x" }],
    byId,
    created,
  );
  assert.deepEqual(older.map((c) => c.repo), ["LAB-OLD"], "case does not matter");
  assert.deepEqual(current.map((c) => c.repo).slice(0, 2), ["lab-b", "lab-a"], "newest first");
  assert.ok(current.some((c) => c.repo === "lab-c"), "no creation time: kept");
  assert.ok(current.some((c) => c.repo === "free-x"), "no opening: kept");
});

test("an empty team repository nobody can open is a leftover, not a student off the list", async () => {
  // PXL-Systems-Expert, 2026-10-23: two team repositories left by teams
  // everybody left were reported every night as "the student can work in it".
  const team = (name, extra = {}) => ({ name, from: "Org/starter", created: "2026-10-01T10:00:00Z", ...extra });
  const res = await run({
    repos: [
      team("grp-left-behind"),
      team("grp-invited", { invitations: [{ id: 1 }] }),
      team("grp-member", { collaborators: [{ login: "bo" }] }),
      team("grp-worked-in", { pushed: true }),
      team("grp-unreadable", { collaboratorsStatus: 403 }),
    ],
  });
  assert.equal(res.status, 0, res.log);
  assert.doesNotMatch(res.outputs, /grp-left-behind/, "nobody can open it and nothing is in it");
  assert.match(res.log, /::notice::1 empty repository in Org .*safe to delete: grp-left-behind/);
  for (const kept of ["grp-invited", "grp-member", "grp-worked-in", "grp-unreadable"]) assert.match(res.outputs, new RegExp(`\`${kept}\``), `${kept} is still reported`);
  assert.match(res.outputs, /^count=4$/m);
});

test("emptyLeftover: every read answered, all empty, untouched", () => {
  const ok = (data) => ({ ok: true, data });
  assert.equal(emptyLeftover({ collaborators: ok([]), invitations: ok([]), touched: "untouched" }), true);
  assert.equal(emptyLeftover({ collaborators: ok([{}]), invitations: ok([]), touched: "untouched" }), false);
  assert.equal(emptyLeftover({ collaborators: ok([]), invitations: ok([{}]), touched: "untouched" }), false, "a teammate not accepted yet");
  assert.equal(emptyLeftover({ collaborators: ok([]), invitations: ok([]), touched: "touched" }), false);
  assert.equal(emptyLeftover({ collaborators: ok([]), invitations: ok([]), touched: "unknown" }), false);
  assert.equal(emptyLeftover({ collaborators: { ok: false, status: 403 }, invitations: ok([]), touched: "untouched" }), false, "unreadable is not empty");
  assert.equal(emptyLeftover({ collaborators: ok([]), invitations: null, touched: "untouched" }), false);
});

test("an individual repository names its student and is reported however empty", async () => {
  const res = await run({ repos: [{ name: "lab-lost", from: "Org/starter", created: "2026-10-01T10:00:00Z" }] });
  assert.match(res.outputs, /`lab-lost` - student `lost`/, res.log);
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
  // Read only: metadata to list and look, contents and administration to ask a
  // team-shaped finding what is in it and who is invited (`emptyLeftover`).
  const perms = Object.fromEntries(Object.entries(token.with).filter(([k]) => k.startsWith("permission-")));
  assert.deepEqual(perms, { "permission-metadata": "read", "permission-contents": "read", "permission-administration": "read" }, "read only");
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
