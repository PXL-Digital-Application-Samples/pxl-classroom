// Request-layer interceptor for tests/cli-sync-starter.test.mjs.
//
// Loaded with `node --import` ahead of the real CLI binary, so what runs is
// `cli/bin/pxl-classroom.mjs sync-starter` itself - the same technique as
// tests/fixtures/dry-run-stub.mjs, which only has to prove a dry run writes
// nothing. This one has to SERVE A SYNC: a template with two commits, student
// repositories with trees and open pull requests, issues and their assignees -
// and it keeps every sync record the CLI commits, in order, so the test can
// read what a run that died part-way would have left behind.
//
// Env:
//   PXL_CLISYNC_FIXTURE  JSON, see tests/cli-sync-starter.test.mjs `fixture()`
//   PXL_CLISYNC_LOG      "<METHOD> <path>" per request, one per line
//   PXL_CLISYNC_RECORDS  every sync record written to the control repo, one JSON per line
import { readFileSync, appendFileSync } from "node:fs";

const fx = JSON.parse(readFileSync(process.env.PXL_CLISYNC_FIXTURE, "utf8"));
const LOG = process.env.PXL_CLISYNC_LOG;
const RECORDS = process.env.PXL_CLISYNC_RECORDS;
const control = new Map(Object.entries(fx.control));
const ORG = fx.org;
const CONTROL = `/repos/${ORG}/${fx.controlRepo}`;
const TPL = `/repos/${ORG}/starter`;

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
const treeOf = (entries) => json(200, {
  sha: "t", truncated: false,
  tree: Object.entries(entries).map(([path, v]) => {
    const [sha, mode] = String(v).split("@");
    return { path, type: "blob", mode: mode || "100644", sha };
  }),
});

function contents(path) {
  if (control.has(path)) {
    const body = control.get(path);
    return json(200, { type: "file", encoding: "base64", content: b64(body), sha: `sha-${path}`, path, name: path.split("/").pop() });
  }
  const prefix = `${path}/`;
  const children = [...control.keys()].filter((k) => k.startsWith(prefix));
  if (children.length) return json(200, children.map((k) => ({ type: "file", name: k.slice(prefix.length), path: k, sha: `sha-${k}` })));
  return json(404, { message: "Not Found" });
}

let issueNo = 0;
let prNo = 100;

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input.url;
  const method = String(init.method ?? (typeof input === "object" ? input.method : "") ?? "GET").toUpperCase();
  const path = decodeURIComponent(new URL(url).pathname);
  appendFileSync(LOG, `${method} ${path}\n`);
  const body = init.body ? JSON.parse(init.body) : {};

  if (path === "/user") return json(200, { login: "lecturer", id: 7 });

  // --- the control repository: contents to read, git data to write ---------
  const ctl = path.match(new RegExp(`^${CONTROL}/contents/(.*)$`));
  if (ctl && method === "GET") return contents(ctl[1]);
  if (path === `${CONTROL}/git/blobs` && method === "POST") {
    appendFileSync(RECORDS, `${Buffer.from(body.content, "base64").toString("utf8").replace(/\n/g, " ")}\n`);
    return json(201, { sha: "b".repeat(40) });
  }

  // --- the template ----------------------------------------------------------
  if (path === `${TPL}/commits` && method === "GET") {
    return json(200, fx.template.commits.map((c) => ({ sha: c.sha, commit: { message: c.message, tree: { sha: c.treeSha }, committer: { date: c.date } } })));
  }
  const detail = path.match(new RegExp(`^${TPL}/commits/([0-9a-f]{7,40})$`));
  if (detail) {
    const i = fx.template.commits.findIndex((c) => c.sha.startsWith(detail[1]));
    if (i < 0) return json(404, { message: "No commit found" });
    const c = fx.template.commits[i];
    const parent = fx.template.commits[i + 1];
    return json(200, { sha: c.sha, commit: { message: c.message }, parents: parent ? [{ sha: parent.sha }] : [], files: [] });
  }
  const ttree = path.match(new RegExp(`^${TPL}/git/trees/([0-9a-f]{40})$`));
  if (ttree) {
    const c = fx.template.commits.find((x) => x.sha === ttree[1]);
    return c ? treeOf(c.tree) : json(404, { message: "Not Found" });
  }
  if (path.startsWith(`${TPL}/git/blobs/`)) return json(200, { content: b64("starter"), encoding: "base64" });

  // --- student repositories --------------------------------------------------
  const stu = path.match(new RegExp(`^/repos/${ORG}/([^/]+)/(.*)$`));
  const repo = stu && fx.students[stu[1]];
  if (repo) {
    const rest = stu[2];
    if (rest === "commits" && method === "GET") {
      // One commit, GitHub-generated from the template's older commit.
      return json(200, [{ sha: "r".repeat(40), parents: [], commit: { tree: { sha: repo.rootTree } } }]);
    }
    if (rest === `git/trees/${fx.branch}`) return treeOf(repo.tree);
    if (rest === "pulls" && method === "GET") return json(200, repo.pulls || []);
    if (rest === "pulls" && method === "POST") {
      prNo++;
      return json(201, { number: prNo, html_url: `https://github.com/${ORG}/${stu[1]}/pull/${prNo}` });
    }
    const pr = rest.match(/^pulls\/(\d+)(\/files)?$/);
    if (pr && method === "GET") {
      const n = pr[1];
      if (pr[2]) return json(200, (repo.pullFiles?.[n] || []).map((filename) => ({ filename })));
      return json(200, { number: Number(n), commits: repo.pullCommits?.[n] ?? 1 });
    }
    if (pr && method === "PATCH") return json(200, { number: Number(pr[1]), state: body.state });
    if (/^issues\/\d+\/comments$/.test(rest) && method === "POST") return json(201, { id: 1 });
    if (rest === "issues" && method === "POST") {
      issueNo++;
      return json(201, { number: issueNo, html_url: `https://github.com/${ORG}/${stu[1]}/issues/${issueNo}` });
    }
    const asg = rest.match(/^issues\/(\d+)\/assignees$/);
    if (asg && method === "POST") {
      if (repo.assignFails) return json(422, { message: "Validation Failed" });
      const refused = new Set(repo.unassignable || []);
      return json(201, { number: Number(asg[1]), assignees: body.assignees.filter((l) => !refused.has(l)).map((login) => ({ login })) });
    }
  }

  // --- the git data walk commitWithRebase makes, in any repository ----------
  if (/\/git\/ref\//.test(path)) return json(200, { object: { sha: "h".repeat(40) } });
  if (/\/git\/commits\//.test(path) && method === "GET") return json(200, { sha: "h".repeat(40), tree: { sha: "t".repeat(40) }, parents: [] });
  if (/\/git\/trees\//.test(path)) return json(200, { sha: "t", tree: [], truncated: false });
  if (/\/git\/trees$/.test(path)) return json(201, { sha: "n".repeat(40) });
  if (/\/git\/blobs$/.test(path)) return json(201, { sha: "e".repeat(40) });
  if (/\/git\/commits$/.test(path)) return json(201, { sha: "f".repeat(40) });
  if (/\/git\/refs/.test(path)) return json(method === "POST" ? 201 : 200, { ref: "refs/heads/x", object: { sha: "f".repeat(40) } });
  return json(404, { message: `not stubbed: ${method} ${path}` });
};
