// lib/submit-tag.mjs - a student's submit tag, as the collector reads it.
//
// 2026-10-14: the documented command wrote the time with colons, which git
// refuses in a ref name ("not a valid tag name"), so no student could ever have
// made one. The test makes real tags with real git, with the command the
// RUNBOOK and the control-repo template now give.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseSubmitTagRef } from "../lib/submit-tag.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

test("the documented tag name is one git can make, and it reads back as the ISO time", () => {
  const w = mkdtempSync(join(tmpdir(), "pxl-tag-"));
  git(["init", "-q"], w);
  git(["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "x"], w);
  const sha = git(["rev-parse", "--short", "HEAD"], w);
  // The colon form is refused by git itself - why the format changed.
  assert.throws(() => git(["tag", `submit/2026-10-14T14:05:00Z-${sha}`], w), /not a valid tag name/);
  git(["tag", `submit/2026-10-14T14-05-00Z-${sha}`], w);
  const ref = git(["for-each-ref", "--format=%(refname)", "refs/tags/submit/"], w);
  assert.deepEqual(parseSubmitTagRef(ref), { tag: `submit/2026-10-14T14-05-00Z-${sha}`, declared_at: "2026-10-14T14:05:00Z" });
});

test("both places that give students the command give the form git accepts", () => {
  for (const file of ["RUNBOOK.md", join("control-repo-template", "README.md")]) {
    const text = readFileSync(join(root, file), "utf8");
    assert.match(text, /git tag submit\/\$\(date -u \+%Y-%m-%dT%H-%M-%SZ\)/, file);
    assert.doesNotMatch(text, /%H:%M:%SZ/, file);
  }
});

test("anything else is not a submit tag", () => {
  assert.equal(parseSubmitTagRef("refs/tags/v1"), null);
  assert.equal(parseSubmitTagRef("refs/tags/submit/yesterday-abc1234"), null);
  assert.equal(parseSubmitTagRef("refs/tags/submit/2026-10-14T14-05-00Z"), null, "the commit is part of the name");
  // A colon form some other tool wrote is still read.
  assert.equal(parseSubmitTagRef("refs/tags/submit/2026-10-14T14:05:00Z-abc1234")?.declared_at, "2026-10-14T14:05:00Z");
});
