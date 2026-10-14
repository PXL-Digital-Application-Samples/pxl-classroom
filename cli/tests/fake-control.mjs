// A stand-in for github.com that holds one control repository as commits, for
// the CLI's write commands: the Contents API at a ref, and the Git Data calls
// lib/gittree.mjs makes, with a fast-forward-only ref update.
//
// A command under test is run against it in-process: `install()` swaps
// `globalThis.fetch` (which Octokit uses) and points the CLI's config at a
// scratch directory holding a token. `writeAs()` commits as somebody else, so a
// test can change the repository between the command's read and its write -
// the case every precondition in the CLI exists for.

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const CONTROL = "pxl-classroom-control";
const json = (body, status = 200) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const blobSha = (text) => createHash("sha1").update(`blob ${Buffer.byteLength(text)}\0${text}`).digest("hex");

/**
 * @param {{org?: string, files?: Record<string, string|object>, user?: string,
 *          routes?: (call: {method: string, path: string, query: string, body: unknown}) => (Response|object|undefined),
 *          onCall?: (call: {method: string, path: string, query: string, body: unknown}) => void}} [opts]
 *   `files`: path -> content; an object is written as pretty JSON.
 *   `routes`: anything outside the control repository (a student repository's
 *   check runs, say); an object is answered as 200 JSON.
 *   `onCall`: runs before every request is answered - where a test changes
 *   the repository between a command's read and its write.
 */
export function fakeControlRepo({ org = "Org", files = {}, user = "lecturer1", routes = () => undefined, onCall = () => {} } = {}) {
  const text = (v) => (typeof v === "string" ? v : JSON.stringify(v, null, 2) + "\n");
  let seq = 0;
  const nextSha = (kind) => createHash("sha1").update(`${kind}-${++seq}`).digest("hex");
  /** commit sha -> { parent, files: Map(path -> text) } */
  const commits = new Map();
  const trees = new Map();
  const blobs = new Map();
  const root = nextSha("commit");
  commits.set(root, { parent: null, files: new Map(Object.entries(files).map(([p, v]) => [p, text(v)])) });
  let head = root;
  const calls = [];
  const dispatched = [];

  const at = (ref) => commits.get(ref && commits.has(ref) ? ref : head)?.files ?? new Map();

  function contents(path, ref) {
    const map = at(ref);
    if (map.has(path)) {
      const t = map.get(path);
      return json({ type: "file", name: path.split("/").pop(), path, sha: blobSha(t), content: Buffer.from(t).toString("base64"), encoding: "base64" });
    }
    const prefix = path ? `${path}/` : "";
    const seen = new Map();
    for (const [p, t] of map) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const name = rest.split("/")[0];
      if (seen.has(name)) continue;
      const isDir = rest.includes("/");
      seen.set(name, { type: isDir ? "dir" : "file", name, path: `${prefix}${name}`, sha: isDir ? nextSha("tree") : blobSha(t) });
    }
    return seen.size ? json([...seen.values()]) : json({ message: "Not Found" }, 404);
  }

  /** Commit `changes` (path -> content, null deletes) on top of head, as another writer. */
  function writeAs(changes, { message = "elsewhere" } = {}) {
    const next = new Map(at(head));
    for (const [p, v] of Object.entries(changes)) {
      if (v === null) next.delete(p);
      else next.set(p, text(v));
    }
    const sha = nextSha("commit");
    commits.set(sha, { parent: head, files: next, message, external: true });
    head = sha;
    return sha;
  }

  async function fetchImpl(url, init = {}) {
    const u = new URL(String(url));
    const method = (init.method || "GET").toUpperCase();
    const body = init.body ? JSON.parse(String(init.body)) : null;
    const path = decodeURIComponent(u.pathname);
    const call = { method, path, query: u.search, body };
    calls.push(call);
    onCall(call);
    const repo = `/repos/${org}/${CONTROL}`;

    if (path === "/user") return json({ login: user });
    if (/\/actions\/workflows\/[^/]+\/dispatches$/.test(path) && method === "POST") {
      dispatched.push({ path, body });
      return json(null, 204);
    }
    if (!path.startsWith(repo)) {
      const answer = routes(call);
      if (answer instanceof Response) return answer;
      if (answer !== undefined) return json(answer);
      return json({ message: `not faked: ${method} ${path}` }, 404);
    }
    const rest = path.slice(repo.length);

    if (method === "GET" && rest.startsWith("/contents")) {
      return contents(rest.replace(/^\/contents\/?/, ""), u.searchParams.get("ref"));
    }
    if (method === "GET" && rest === "/git/ref/heads/main") return json({ ref: "refs/heads/main", object: { sha: head } });
    const commit = rest.match(/^\/git\/commits\/([0-9a-f]{40})$/);
    if (method === "GET" && commit) {
      if (!commits.has(commit[1])) return json({ message: "Not Found" }, 404);
      return json({ sha: commit[1], tree: { sha: `tree-of-${commit[1]}` }, parents: commits.get(commit[1]).parent ? [{ sha: commits.get(commit[1]).parent }] : [] });
    }
    if (method === "POST" && rest === "/git/blobs") {
      const t = Buffer.from(body.content, body.encoding === "base64" ? "base64" : "utf8").toString("utf8");
      const sha = blobSha(t);
      blobs.set(sha, t);
      return json({ sha }, 201);
    }
    if (method === "POST" && rest === "/git/trees") {
      // Without a base tree it is lib/gittree.mjs's scratch tree for the
      // inline shortcut; answered truncated, so every file goes up as a blob.
      if (!body.base_tree) return json({ sha: "scratch" }, 201);
      const parent = String(body.base_tree).replace(/^tree-of-/, "");
      const next = new Map(at(parent));
      for (const e of body.tree || []) {
        if (e.sha === null) next.delete(e.path);
        else if (typeof e.content === "string") next.set(e.path, e.content);
        else next.set(e.path, blobs.get(e.sha) ?? "");
      }
      const sha = nextSha("tree");
      trees.set(sha, next);
      return json({ sha }, 201);
    }
    if (method === "GET" && rest === "/git/trees/scratch") return json({ sha: "scratch", truncated: true, tree: [] });
    if (method === "POST" && rest === "/git/commits") {
      const sha = nextSha("commit");
      commits.set(sha, { parent: body.parents?.[0] ?? null, files: trees.get(body.tree) ?? new Map(), message: body.message });
      return json({ sha }, 201);
    }
    if (method === "PATCH" && rest === "/git/refs/heads/main") {
      const c = commits.get(body.sha);
      if (!c) return json({ message: "Object does not exist" }, 422);
      if (c.parent !== head && !body.force) return json({ message: "Update is not a fast forward" }, 422);
      head = body.sha;
      return json({ ref: "refs/heads/main", object: { sha: head } });
    }
    return json({ message: `not faked: ${method} ${path}` }, 404);
  }

  return {
    fetch: fetchImpl,
    calls,
    dispatched,
    writeAs,
    /** The repository as the branch holds it now: path -> parsed JSON or text. */
    file: (p) => {
      const t = at(head).get(p);
      if (t === undefined) return undefined;
      try { return JSON.parse(t); } catch { return t; }
    },
    has: (p) => at(head).has(p),
    head: () => head,
    /** Commits the command made and the branch took (not `writeAs`, not the seed). */
    commitsByCommand: () => {
      const out = [];
      for (let sha = head; sha && commits.get(sha)?.parent; sha = commits.get(sha).parent) {
        if (!commits.get(sha).external) out.unshift(commits.get(sha));
      }
      return out;
    },
  };
}

/**
 * Point the CLI at `fake`: its fetch, a scratch config directory with a token,
 * and stdout / stderr captured as text (the runner's own binary frames pass
 * through). Returns `restore()` and the captured `out()` / `err()`.
 */
export function install(fake) {
  const dir = mkdtempSync(join(tmpdir(), "pxl-cli-home-"));
  mkdirSync(join(dir, "pxl-classroom"), { recursive: true });
  writeFileSync(join(dir, "pxl-classroom", "token"), JSON.stringify({ access_token: "fake-token" }));
  const saved = {
    fetch: globalThis.fetch,
    env: { APPDATA: process.env.APPDATA, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, HOME: process.env.HOME },
    out: process.stdout.write,
    err: process.stderr.write,
    exitCode: process.exitCode,
  };
  globalThis.fetch = fake.fetch;
  process.env.APPDATA = dir;
  process.env.XDG_CONFIG_HOME = dir;
  process.env.HOME = dir;
  let out = "";
  let err = "";
  const capture = (onText, original) => function (chunk, ...rest) {
    if (typeof chunk === "string") { onText(chunk); return true; }
    return original.call(this, chunk, ...rest);
  };
  process.stdout.write = capture((c) => { out += c; }, saved.out);
  process.stderr.write = capture((c) => { err += c; }, saved.err);
  process.exitCode = undefined;
  return {
    out: () => out,
    err: () => err,
    exitCode: () => process.exitCode,
    restore() {
      globalThis.fetch = saved.fetch;
      for (const [k, v] of Object.entries(saved.env)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      process.stdout.write = saved.out;
      process.stderr.write = saved.err;
      process.exitCode = saved.exitCode;
    },
  };
}
