// GitHub's noreply addresses, decided by DOMAIN in one place.
//
// The rule was `includes("noreply.github.com")` in three places (collect.mjs,
// twice in AssignmentDetailView.vue), which CodeQL flagged on its first scan and
// which discarded a real mailbox that merely contained the string. See
// lib/github-noreply.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { isGitHubNoreplyAddress } from "../lib/github-noreply.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("the addresses GitHub issues for private email are noreply", () => {
  for (const address of [
    "12345678+alice@users.noreply.github.com",
    "alice@users.noreply.github.com",
    "49699333+dependabot[bot]@users.noreply.github.com",
    "Alice@Users.NoReply.GitHub.com",
    "  alice@users.noreply.github.com  ",
    "alice@noreply.github.com",
  ]) {
    assert.equal(isGitHubNoreplyAddress(address), true, address);
  }
});

test("a mailbox that only CONTAINS the domain is somebody's real address", () => {
  for (const address of [
    "ann+noreply.github.com@gmail.com",
    "noreply.github.com@student.pxl.be",
    "alice@noreply.github.com.example.org",
    "alice@evilnoreply.github.com",
    "alice@github.com",
    "rayane.waddah@student.pxl",
  ]) {
    assert.equal(isGitHubNoreplyAddress(address), false, address);
  }
});

test("anything that is not an address is not a noreply address", () => {
  for (const value of [null, undefined, "", "   ", "noreply.github.com", "@users.noreply.github.com", "Tom Cool", 42]) {
    assert.equal(isGitHubNoreplyAddress(value), false, String(value));
  }
});

test("no source file tests for the noreply domain by substring again", () => {
  // The rule has one home. A fourth hand-written copy is how it got three.
  // That home is excluded because its comment quotes the substring it replaced;
  // this first ran green only while the module was untracked, and failed on
  // itself the moment it was committed.
  const files = execFileSync(
    "git",
    ["ls-files", "-z", "--", "*.mjs", "*.js", "*.vue", ":!tests/**", ":!**/node_modules/**", ":!lib/github-noreply.mjs"],
    { cwd: root, encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean);
  assert.ok(files.length > 50, `sanity: expected the source tree, found ${files.length} files`);

  const offenders = files.filter((f) =>
    /\.(includes|indexOf|endsWith)\(\s*['"`][^'"`]*noreply\.github\.com/.test(readFileSync(join(root, f), "utf8")),
  );
  assert.deepEqual(offenders, [], "use isGitHubNoreplyAddress from lib/github-noreply.mjs");
});
