// PXL Classroom — preserve-archive-push.test.mjs
//
// Regression test for the preservation archive push.
//
// preserve.mjs fetches a student's submission SHA into a scratch bare repo and
// pushes it to <org>/pxl-classroom-archive. It used to fetch with --depth=1,
// which grafts away the commit's ancestors; the resulting pack references
// objects the archive does not have, and the remote rejects it with
//   error: remote unpack failed: index-pack failed
// That is invisible while a student repo is still a single template commit and
// starts failing the nightly finalize as soon as they build up history.
//
// These tests exercise real git over file:// (which uses the normal
// upload-pack/receive-pack protocol rather than the local-copy shortcut), so
// they reproduce the failure and pin the fix without touching the network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const git = (args, cwd) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();

// file:// URL for a local path — forces the real git wire protocol on all
// platforms (and normalises the Windows drive letter).
const fileUrl = (p) => `file:///${p.replace(/\\/g, "/").replace(/^\//, "")}`;

/**
 * Builds a source repo with `commits` commits and an empty archive repo.
 * Returns { srcUrl, arcUrl, headSha }.
 */
function buildFixture(commits) {
  const root = mkdtempSync(join(tmpdir(), "pxl-preserve-"));
  const src = join(root, "src.git");
  const arc = join(root, "arc.git");
  const work = join(root, "work");

  mkdirSync(src);
  mkdirSync(arc);
  mkdirSync(work);
  git(["init", "--bare", "--initial-branch=main", "."], src);
  git(["init", "--bare", "--initial-branch=main", "."], arc);
  // GitHub allows fetching any reachable SHA; local upload-pack does not by
  // default. Match production so `git fetch <url> <sha>` behaves the same.
  git(["config", "uploadpack.allowReachableSHA1InWant", "true"], src);

  git(["init", "--initial-branch=main", "."], work);
  git(["config", "user.email", "t@example.com"], work);
  git(["config", "user.name", "Test"], work);
  for (let i = 0; i < commits; i++) {
    git(["commit", "--allow-empty", "-m", `commit ${i + 1}`], work);
  }
  git(["push", fileUrl(src), "main"], work);
  const headSha = git(["rev-parse", "HEAD"], work);

  return { srcUrl: fileUrl(src), arcUrl: fileUrl(arc), headSha, root };
}

/** Mirrors preserve.mjs: bare init, fetch the SHA, push it to the archive. */
function preserve({ srcUrl, arcUrl, headSha, root }, { shallow }) {
  const scratch = join(root, `scratch-${shallow ? "shallow" : "full"}-${Date.now()}`);
  mkdirSync(scratch);
  git(["init", "--bare", "."], scratch);

  const fetchArgs = shallow
    ? ["fetch", "--depth=1", srcUrl, headSha]
    : ["fetch", "--no-tags", srcUrl, headSha];
  git(fetchArgs, scratch);
  git(["cat-file", "-e", headSha], scratch); // SHA landed either way

  const ref = `refs/heads/preserved/test-asgn/student`;
  git(["push", "--quiet", "--force", arcUrl, `${headSha}:${ref}`], scratch);

  // Same verification preserve.mjs performs after pushing.
  return git(["ls-remote", arcUrl, ref], scratch).split(/\s/)[0] || "";
}

test("full fetch preserves a multi-commit submission to the archive", () => {
  const fx = buildFixture(3);
  const remoteSha = preserve(fx, { shallow: false });
  assert.equal(remoteSha, fx.headSha, "archive ref must point at the submission SHA");
});

test("full fetch preserves a single-commit submission", () => {
  const fx = buildFixture(1);
  const remoteSha = preserve(fx, { shallow: false });
  assert.equal(remoteSha, fx.headSha);
});

test("shallow fetch (the old --depth=1 path) cannot push a multi-commit submission", () => {
  // Documents the bug the fix addresses. If a future git makes this work, this
  // test failing is a signal to re-read the fix, not to loosen it.
  const fx = buildFixture(3);
  assert.throws(
    () => preserve(fx, { shallow: true }),
    /index-pack failed|unpack failed|shallow|remote rejected/i,
    "a shallow pack should be rejected by the receiving repo",
  );
});

test("preserve.mjs does not use a shallow fetch", async () => {
  // Guards the source directly: the push is only correct because the fetch is
  // complete, and the two lines are far enough apart to be re-broken.
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const { dirname } = await import("node:path");
  const here = dirname(fileURLToPath(import.meta.url));
  const src = await readFile(join(here, "..", "preserve", "preserve.mjs"), "utf8");

  const fetchLine = src.split("\n").find((l) => l.includes("git(`fetch"));
  assert.ok(fetchLine, "expected a git fetch call in preserve.mjs");
  assert.ok(
    !/--depth/.test(fetchLine),
    `preserve.mjs must fetch full history before pushing to the archive, got: ${fetchLine.trim()}`,
  );
});
