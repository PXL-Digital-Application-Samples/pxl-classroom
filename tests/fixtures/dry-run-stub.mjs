// Request-layer interceptor for the dry-run behaviour test.
//
// Loaded with `node --import` ahead of the real CLI binary, so the CLI under
// test is the actual `cli/bin/pxl-classroom.mjs` - not a re-implementation of
// it - and every HTTP call it makes is recorded before it leaves the process.
//
// It runs in a CHILD process on purpose. The first version of this harness
// patched `globalThis.fetch` and `process.stdout.write` inside the test process
// and silently swallowed three of eight tests: node's own reporter writes
// through process.stdout, so a patched stdout captured the runner's events into
// a string instead of emitting them, and the suite reported `pass 5, fail 0`
// while a third of it never appeared. A child process has its own stdout and
// its own globals, and there is nothing to restore.
//
// Not `tests/fixtures/fetch-stub.mjs`, deliberately - same `--import` + log
// file technique, different job. That one answers a static list of
// {match, status, body} routes and hands back a duck-typed response; this one
// has to SERVE A REPOSITORY (the contents API returns a file for an exact path
// and a directory listing for a prefix, and the CLI walks both) and has to
// return a real `Response`, which is what Octokit v22 reads headers off. A
// route table cannot express either. If a third caller ever wants this, that is
// the moment to merge them.
//
// Env:
//   PXL_DRYRUN_FIXTURE  JSON { caseId, org, repo: { "<path>": "<content>" } }
//   PXL_DRYRUN_LOG      file to append "<METHOD> <path>" to, one per request
import { readFileSync, appendFileSync } from "node:fs";

const fixture = JSON.parse(readFileSync(process.env.PXL_DRYRUN_FIXTURE, "utf8"));
const LOG = process.env.PXL_DRYRUN_LOG;
const repo = new Map(Object.entries(fixture.repo));

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** An exact key is a file, a key prefix is a directory, anything else is 404. */
function contents(path) {
  if (repo.has(path)) {
    const body = repo.get(path);
    return json(200, {
      type: "file", encoding: "base64", content: b64(body), sha: `sha-${path}`,
      path, name: path.split("/").pop(), size: body.length,
    });
  }
  const prefix = `${path}/`;
  const children = [...repo.keys()].filter((k) => k.startsWith(prefix));
  if (children.length) {
    return json(200, children.map((k) => ({
      type: "file", name: k.slice(prefix.length), path: k, sha: `sha-${k}`, size: repo.get(k).length,
    })));
  }
  return json(404, { message: "Not Found" });
}

/** Per-case reads outside the control repo. Never consulted for a mutation. */
function extra(path) {
  if (fixture.caseId === "feedback") {
    if (/\/pulls$/.test(path)) return json(200, []);
  }
  if (fixture.caseId === "sync-starter") {
    if (/\/repos\/[^/]+\/starter\/commits$/.test(path)) return json(200, [{ sha: "tpl-sha" }]);
    if (/\/repos\/[^/]+\/starter\/commits\/[^/]+$/.test(path)) {
      return json(200, {
        sha: "tpl-sha",
        commit: { message: "Update starter" },
        parents: [{ sha: "tpl-parent" }],
        files: [{ filename: "README.md", status: "modified" }],
      });
    }
    // The three trees must DIFFER or the sync finds nothing to do and writes
    // nothing - which would make the dry-run half of the test free.
    //   template head    README.md -> blob-new
    //   template parent  README.md -> blob-old  (so the commit changed it)
    //   student main     README.md -> blob-old  (untouched: updated in place)
    const tree = (sha) =>
      json(200, { sha: "t", truncated: false, tree: [{ path: "README.md", type: "blob", mode: "100644", sha }] });
    if (/\/git\/trees\/tpl-sha/.test(path)) return tree("blob-new");
    if (/\/git\/trees\/tpl-parent/.test(path)) return tree("blob-old");
    if (/\/git\/trees\//.test(path)) return tree("blob-old");
    if (/\/git\/blobs\//.test(path)) return json(200, { content: b64("hello"), encoding: "base64", sha: "blob-new" });
    if (/\/pulls$/.test(path)) return json(200, []);
  }
  return null;
}

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input.url;
  const method = String(init.method ?? (typeof input === "object" ? input.method : "") ?? "GET").toUpperCase();
  const path = decodeURIComponent(new URL(url).pathname);
  appendFileSync(LOG, `${method} ${path}\n`);

  if (MUTATING.has(method)) {
    // Answer plausibly so the WET run reaches every write it would make,
    // rather than stopping at the first one.
    if (/\/git\/trees$/.test(path)) return json(201, { sha: "tree-sha" });
    if (/\/git\/commits$/.test(path)) return json(201, { sha: "commit-sha" });
    if (/\/git\/refs/.test(path)) return json(200, { ref: "refs/heads/main", object: { sha: "commit-sha" } });
    if (/\/git\/blobs$/.test(path)) return json(201, { sha: "blob-new" });
    if (/\/pulls$/.test(path)) return json(201, { number: 1, html_url: "https://example.invalid/pr/1" });
    if (/\/issues$/.test(path)) return json(201, { number: 1, html_url: "https://example.invalid/i/1" });
    if (/\/dispatches$/.test(path)) return new Response(null, { status: 204 });
    return json(200, { content: { sha: "new-sha" }, commit: { sha: "commit-sha" } });
  }

  const fromCase = extra(path);
  if (fromCase) return fromCase;

  const m = path.match(/^\/repos\/[^/]+\/[^/]+\/contents\/(.*)$/);
  if (m) return contents(m[1]);

  if (path === "/user") return json(200, { login: "lecturer", id: 7 });
  // The git-data read path commitWithRebase walks before writing: ref -> commit
  // -> tree. Serving these is what lets the WET run reach the POSTs.
  if (/\/git\/ref\//.test(path)) return json(200, { object: { sha: "head-sha" } });
  if (/\/git\/commits\//.test(path)) return json(200, { sha: "head-sha", tree: { sha: "tree-sha" }, parents: [] });
  if (/\/git\/trees\//.test(path)) return json(200, { sha: "tree-sha", tree: [], truncated: false });
  if (/\/git\/blobs\//.test(path)) return json(200, { sha: "blob-sha", content: "", encoding: "utf-8" });
  if (/\/pulls$/.test(path)) return json(200, []);
  if (/\/commits$/.test(path)) return json(200, []);
  return json(404, { message: "Not Found" });
};
