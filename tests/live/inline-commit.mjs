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

  console.log(`\n${r.failures() ? `${r.failures()} FAILED` : "all good"}\n`);
  process.exit(r.failures() ? 1 : 0);
}

main().catch((e) => die(e.stack || String(e)));
