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

import { latestSubmitTag, parseSubmitTagRef } from "../lib/submit-tag.mjs";

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

test("the command the control repo's README gives makes a tag, and the collector and the page read it as the latest", () => {
  const readme = readFileSync(join(root, "control-repo-template", "README.md"), "utf8");
  const command = /```bash\n(git tag submit\/[^\n]+)\n```/.exec(readme)?.[1];
  assert.ok(command, "the README carries the command in a bash block");
  const w = mkdtempSync(join(tmpdir(), "pxl-tag-"));
  git(["init", "-q"], w);
  git(["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "x"], w);
  // The command as written, minus its push: there is no remote here.
  execFileSync("bash", ["-c", command.replace(/ && git push origin --tags$/, "")], { cwd: w, stdio: "pipe" });
  const refs = git(["for-each-ref", "--format=%(refname)", "refs/tags/submit/"], w).split("\n");
  assert.equal(refs.length, 1);
  const latest = latestSubmitTag([{ ref: "refs/tags/submit/2020-01-01T00-00-00Z-abc1234" }, { ref: refs[0] }, { ref: "refs/tags/v1" }]);
  assert.equal(latest?.ref, refs[0]);
  assert.match(latest.declared_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
});

test("the README's PowerShell command makes the same tag, in UTC (run where PowerShell is installed)", (t) => {
  // Review 2026-10-14: the one command was bash-only. In PowerShell `date -u` is
  // ambiguous in pwsh 7 and `&&` a parse error in 5.1; split by hand, `-u`
  // became `-UFormat` and wrote local time labelled Z.
  let pwsh = null;
  for (const exe of ["pwsh", "powershell"]) {
    try {
      execFileSync(exe, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], { stdio: "pipe" });
      pwsh = exe;
      break;
    } catch {
      // not installed here
    }
  }
  if (!pwsh) return t.skip("no PowerShell on this machine");
  const readme = readFileSync(join(root, "control-repo-template", "README.md"), "utf8");
  const command = /```powershell\r?\n(git tag [^\r\n]+)\r?\n```/.exec(readme)?.[1];
  assert.ok(command, "the README carries a PowerShell command");
  const w = mkdtempSync(join(tmpdir(), "pxl-tag-ps-"));
  git(["init", "-q"], w);
  git(["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "x"], w);
  const before = Date.now();
  execFileSync(pwsh, ["-NoProfile", "-Command", command.replace(/; git push origin --tags$/, "")], { cwd: w, stdio: "pipe" });
  const ref = git(["for-each-ref", "--format=%(refname)", "refs/tags/submit/"], w);
  const parsed = parseSubmitTagRef(ref);
  assert.ok(parsed, ref);
  // UTC: within a minute either side of now, whatever this machine's zone.
  assert.ok(Math.abs(Date.parse(parsed.declared_at) - before) < 90_000, `${parsed.declared_at} vs ${new Date(before).toISOString()}`);
});

test("no document gives students the colon form, and the RUNBOOK points at the README rather than keeping a second copy", () => {
  for (const file of ["RUNBOOK.md", "ARCHITECTURE.md", join("control-repo-template", "README.md")]) {
    assert.doesNotMatch(readFileSync(join(root, file), "utf8"), /%H:%M:%SZ/, file);
  }
  assert.doesNotMatch(readFileSync(join(root, "RUNBOOK.md"), "utf8"), /git tag submit\//);
});

test("the latest is by declared time, whichever separator; the collector and the student page both ask lib/submit-tag.mjs", () => {
  const latest = latestSubmitTag([
    { ref: "refs/tags/submit/2026-10-14T14-05-00Z-aaaaaaa" },
    { ref: "refs/tags/submit/2026-10-14T09:00:00Z-bbbbbbb" },
    { ref: "refs/tags/submit/2026-10-14T15-00-00Z-ccccccc", object: { sha: "c".repeat(40), type: "commit" } },
  ]);
  assert.equal(latest?.tag, "submit/2026-10-14T15-00-00Z-ccccccc");
  assert.equal(latest.object.sha, "c".repeat(40), "the entry's own fields come along");
  assert.equal(latestSubmitTag([]), null);
  assert.equal(latestSubmitTag(null), null);
  for (const file of [join("collect", "collect.mjs"), join("frontend", "src", "views", "AssignmentView.vue")]) {
    const src = readFileSync(join(root, file), "utf8");
    assert.match(src, /import \{[^}]*latestSubmitTag[^}]*\} from ['"][./]*lib\/submit-tag\.mjs['"]/, file);
    assert.doesNotMatch(src, /refs\\\/tags\\\/\(?submit/, `${file} spells no submit-tag pattern of its own`);
  }
});

test("anything else is not a submit tag", () => {
  assert.equal(parseSubmitTagRef("refs/tags/v1"), null);
  assert.equal(parseSubmitTagRef("refs/tags/submit/yesterday-abc1234"), null);
  assert.equal(parseSubmitTagRef("refs/tags/submit/2026-10-14T14-05-00Z"), null, "the commit is part of the name");
  // A colon form some other tool wrote is still read.
  assert.equal(parseSubmitTagRef("refs/tags/submit/2026-10-14T14:05:00Z-abc1234")?.declared_at, "2026-10-14T14:05:00Z");
});
