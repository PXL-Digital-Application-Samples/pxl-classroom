#!/usr/bin/env node
// PXL Classroom - LIVE check of lib/gittree.mjs's inline text shortcut. Not
// part of `npm test`.
//
//   node tests/live/inline-commit.mjs
//
// The shortcut writes text files through a tree entry's `content` instead of a
// blob request each, and GitHub's documentation says nothing about how that
// string is encoded. The module verifies every file against git's own hash and
// falls back to a blob when they differ - which is SAFE either way, and also
// means a GitHub that re-encodes would make the shortcut silently useless. So
// this asks the real API, with the files a .NET starter actually contains: a
// UTF-8 BOM, CRLF line endings, non-ASCII, and a binary file beside them.
//
// Commits to one private repository on pxl-classroom-testbed, created on the
// first run and reused after. It deletes nothing.

import { createHash } from "node:crypto";
import { commitWithRebase } from "../../lib/gittree.mjs";
import { api, die, loadEnv, reporter } from "./live-kit.mjs";

const env = loadEnv();
// The TESTBED, named - not TEST_ORG. This creates a repository, and .env.test's
// TEST_ORG has pointed at a real course organization. PROBE_ORG overrides.
const org = process.env.PROBE_ORG || "pxl-classroom-testbed";
const token = env.TEST_LECTURER_TOKEN;
if (!token) die("TEST_LECTURER_TOKEN is required (.env.test)");
const REPO = "pxl-gittree-inline-probe";
const r = reporter();

const gitSha = (b) => createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${b.length}\0`), b])).digest("hex");

const stamp = new Date().toISOString();
// A code point, never a literal U+FEFF in the source (lint refuses it).
const BOM = String.fromCharCode(0xfeff);
const files = [
  ["Lab4/Program.cs", `${BOM}using System;\r\n\r\n// ${stamp}\r\nConsole.WriteLine("Hallo, wereld");\r\n`],
  ["Lab4/Lab4.csproj", `${BOM}<Project Sdk="Microsoft.NET.Sdk">\r\n  <!-- ${stamp} -->\r\n</Project>\r\n`],
  ["Lab4/README.md", `# Labo 4 - één, twee, drie\n\nCafé, naïve, Zoë ✓ 🚀\n\n${stamp}\n`],
  ["Lab4/tabs.txt", `a\tb\tc\n${stamp}\n  trailing  \n\n`],
  ["Lab4/no-newline.txt", `no newline at the end ${stamp}`],
].map(([path, text]) => ({ path, content: Buffer.from(text, "utf8") }));
// The shapes most likely to trip `content`: an EMPTY file (.gitkeep,
// __init__.py - if GitHub refused "" the scratch tree would fail on every
// commit carrying one, and the shortcut would quietly never happen), a path
// with a space, non-ASCII and a `#`, and an executable script whose mode must
// survive.
files.push(
  { path: "Lab4/Data/.gitkeep", content: Buffer.alloc(0) },
  { path: "Lab4/Mijn Oefening #2/Één.cs", content: Buffer.from(`${BOM}// ${stamp}\r\n`, "utf8") },
  { path: "Lab4/run.sh", content: Buffer.from(`#!/bin/sh\necho ${stamp}\n`), mode: "100755" },
);
files.push({ path: "Lab4/icon.bin", content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10, ...Buffer.from(stamp)]) });

// What the .NET Advanced sync was: 93 changed text files in one commit.
const cohortFiles = (tag) =>
  Array.from({ length: 93 }, (_, i) => ({
    path: `Lab5/Src/Module${String(i).padStart(2, "0")}.cs`,
    content: Buffer.from(`${BOM}namespace Lab5;\r\n// ${tag} ${stamp}\r\npublic class Module${i} { }\r\n`, "utf8"),
  }));

/** fetch, counting. `noShortcut` refuses the scratch tree the way GitHub refuses a bad one (422), which forces the old path. */
function counter({ noShortcut = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const line = `${init?.method ?? "GET"} ${String(url).replace("https://api.github.com", "")}`;
    calls.push(line);
    if (noShortcut && line.endsWith("/git/trees") && !JSON.parse(init.body).base_tree) {
      return new Response(JSON.stringify({ message: "refused by the probe" }), { status: 422 });
    }
    return fetch(url, init);
  };
  return { calls, fetchImpl };
}

async function commitAndCheck(label, changes, { noShortcut = false, expectBlobs }) {
  const { calls, fetchImpl } = counter({ noShortcut });
  const t0 = Date.now();
  const res = await commitWithRebase({
    fetch: fetchImpl, token, owner: org, repo: REPO, branch: "main", message: `${label} ${stamp}`, changes,
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const blobs = calls.filter((c) => c.startsWith("POST") && c.endsWith("/git/blobs")).length;
  if (blobs === expectBlobs) r.ok(`${label}: ${calls.length} requests, ${blobs} blob(s), ${secs}s`);
  else r.bad(`${label}: ${blobs} blob requests where ${expectBlobs} were expected (${calls.length} requests, ${secs}s)`);

  // Independently of the module: what is now in the repository, byte for byte
  // and mode for mode.
  const tree = await api(`/repos/${org}/${REPO}/git/trees/${res.commitSha}?recursive=1`, { token });
  if (!tree.ok) die(`could not read the tree back: HTTP ${tree.status}`);
  const byPath = new Map((tree.data.tree || []).map((e) => [e.path, e]));
  let bad = 0;
  for (const f of changes) {
    const e = byPath.get(f.path);
    const want = gitSha(f.content);
    if (e?.sha !== want) { bad++; r.bad(`${label}: ${f.path} has ${e?.sha}, the bytes hash to ${want}`); }
    if (f.mode && e?.mode !== f.mode) { bad++; r.bad(`${label}: ${f.path} has mode ${e?.mode}, not ${f.mode}`); }
  }
  if (!bad) r.ok(`${label}: all ${changes.length} files byte-identical${changes.some((f) => f.mode) ? ", modes kept" : ""}`);
  return Number(secs);
}

async function main() {
  console.log(`\nInline commit probe - ${org}/${REPO}\n`);
  const existing = await api(`/repos/${org}/${REPO}`, { token });
  if (existing.status === 404) {
    const made = await api(`/orgs/${org}/repos`, {
      token, method: "POST", body: { name: REPO, private: true, auto_init: true, description: "lib/gittree.mjs live probe" },
    });
    if (!made.ok) die(`could not create ${org}/${REPO}: HTTP ${made.status} ${made.data?.message}`);
    r.note(`created ${org}/${REPO}`);
  } else if (!existing.ok) {
    die(`could not read ${org}/${REPO}: HTTP ${existing.status}`);
  }

  // Edge cases: everything text inlined, the one binary file as a blob.
  await commitAndCheck("edge cases", files, { expectBlobs: 1 });

  // The real shape, both ways. The fallback run is the path every commit took
  // before the shortcut, and still takes when GitHub refuses one.
  const fast = await commitAndCheck("93 files, shortcut", cohortFiles("fast"), { expectBlobs: 0 });
  const slow = await commitAndCheck("93 files, forced fallback", cohortFiles("slow"), { noShortcut: true, expectBlobs: 93 });
  r.note(`per student: ${fast}s with the shortcut, ${slow}s without`);

  // What timed out on 2026-11-13: 341 files and 18 MiB a student, of which 332
  // text files and 7.4 MiB went in ONE scratch tree and 341 entries in ONE
  // commit tree, each 4-5s against GitHub's ten. Now in pieces - and whether
  // a tree built step by step is the tree, deletes included, is GitHub's to
  // say: the read-back below compares every path.
  const big = (tag) =>
    Array.from({ length: 330 }, (_, i) => ({
      path: `Lab9/wwwroot/lib/pkg${String(i % 11).padStart(2, "0")}/file${String(i).padStart(3, "0")}.js`,
      content: Buffer.from(`// ${tag} ${stamp} ${i}\n`.padEnd(22 * 1024, "x"), "utf8"),
    }));
  const longest = { ms: 0, line: "" };
  const timed = counter();
  const timedFetch = async (url, init) => {
    const t = Date.now();
    const res = await timed.fetchImpl(url, init);
    const ms = Date.now() - t;
    if (ms > longest.ms) Object.assign(longest, { ms, line: timed.calls.at(-1) });
    return res;
  };
  const t0 = Date.now();
  const first = await commitWithRebase({
    fetch: timedFetch, token, owner: org, repo: REPO, branch: "main", message: `330 files, 7 MiB ${stamp}`, changes: big("in"),
  });
  const trees = timed.calls.filter((c) => c === `POST /repos/${org}/${REPO}/git/trees`).length;
  const blobs = timed.calls.filter((c) => c.endsWith("/git/blobs")).length;
  // 4 scratch trees (7 MiB in pieces of 2) and 4 steps (330 entries by 100).
  if (blobs === 0 && trees === 8) r.ok(`330 files, 7 MiB: ${trees} tree requests, 0 blobs, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  else r.bad(`330 files, 7 MiB: ${trees} tree requests and ${blobs} blobs where 8 and 0 were expected`);
  if (longest.ms < 5000) r.ok(`the longest request took ${(longest.ms / 1000).toFixed(1)}s (${longest.line})`);
  else r.bad(`a request took ${(longest.ms / 1000).toFixed(1)}s, half of GitHub's limit: ${longest.line}`);
  const after = await api(`/repos/${org}/${REPO}/git/trees/${first.commitSha}?recursive=1`, { token });
  // Files only: a folder's own entry changes with what is in it.
  const blobsOf = (tree) => new Map((tree || []).filter((e) => e.type === "blob").map((e) => [e.path, e.sha]));
  const have = blobsOf(after.data?.tree);
  const wrong = big("in").filter((f) => have.get(f.path) !== gitSha(f.content)).length;
  if (after.ok && !after.data.truncated && wrong === 0) r.ok("330 files, 7 MiB: all byte-identical");
  else r.bad(`330 files, 7 MiB: ${wrong} file(s) differ (read HTTP ${after.status}, truncated ${after.data?.truncated})`);

  // A rename of the folder: 330 deletes and 330 writes, stepped, deletes first.
  const moved = big("in").map((f) => ({ ...f, path: f.path.replace("Lab9/", "Lab09/") }));
  const second = await commitWithRebase({
    token, owner: org, repo: REPO, branch: "main", message: `rename, 660 entries ${stamp}`,
    changes: [...moved, ...big("in").map((f) => ({ path: f.path, content: null }))],
  });
  const renamed = await api(`/repos/${org}/${REPO}/git/trees/${second.commitSha}?recursive=1`, { token });
  const now = blobsOf(renamed.data?.tree);
  const left = [...now.keys()].filter((p) => p.startsWith("Lab9/")).length;
  const missing = moved.filter((f) => now.get(f.path) !== gitSha(f.content)).length;
  const others = [...have.keys()].filter((p) => !p.startsWith("Lab9/") && now.get(p) !== have.get(p)).length;
  if (renamed.ok && left === 0 && missing === 0 && others === 0) r.ok("rename of 330 files: old folder gone, new one byte-identical, nothing else touched");
  else r.bad(`rename of 330 files: ${left} left under the old name, ${missing} wrong under the new, ${others} other path(s) changed`);
  // And put away again, so the probe repository does not grow by 7 MiB a run.
  await commitWithRebase({
    token, owner: org, repo: REPO, branch: "main", message: `remove the 330 ${stamp}`,
    changes: moved.map((f) => ({ path: f.path, content: null })),
  });

  console.log(`\n${r.failures() ? `${r.failures()} FAILED` : "all good"}\n`);
  process.exit(r.failures() ? 1 : 0);
}

main().catch((e) => die(e.stack || String(e)));
