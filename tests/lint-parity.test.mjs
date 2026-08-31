// PXL Classroom - lint-parity.test.mjs
//
// `npm run lint` was `eslint .`. CI's `test` job ran `npx eslint . --max-warnings 0`
// and CI's `lint` job ran actionlint plus scripts/workflow-lint.mjs, neither of
// which had any local equivalent. So a change could be linted clean locally,
// repeatedly, while CI had been red since 48ed831 over a shellcheck finding no
// local command would ever produce - and nine commits shipped on top of it.
//
// The fix is that both sides run one command. This is what stops them drifting
// apart again: CI may not lint by any route other than `npm run lint`, and that
// script has to actually carry all three checks.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const ciText = readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8");
const ci = parse(ciText);
const lintScript = readFileSync(join(root, "scripts", "lint.mjs"), "utf8");

/** Every `run:` body in ci.yml, with the job and step it came from. */
function ciRunSteps() {
  const out = [];
  for (const [jobName, job] of Object.entries(ci.jobs || {})) {
    for (const step of job.steps || []) {
      if (typeof step.run === "string") out.push({ job: jobName, name: step.name, run: step.run });
    }
  }
  return out;
}

test("npm run lint is the single entry point", () => {
  assert.equal(pkg.scripts.lint, "node scripts/lint.mjs");
});

test("CI lints only by running npm run lint", () => {
  // A second lint invocation is how they came apart the first time: CI grew
  // checks that package.json never learned about.
  const offenders = ciRunSteps().filter(
    (s) => /\b(eslint|actionlint|shellcheck|workflow-lint)\b/.test(s.run) && !/npm run lint\b/.test(s.run)
  );
  assert.deepEqual(
    offenders.map((s) => `${s.job}: ${s.name ?? s.run.trim().split("\n")[0]}`),
    [],
    "these CI steps lint by some route a developer cannot reproduce with `npm run lint`"
  );
});

test("CI does lint, by that route", () => {
  const lintSteps = ciRunSteps().filter((s) => /npm run lint\b/.test(s.run));
  assert.ok(lintSteps.length > 0, "ci.yml must run `npm run lint` somewhere");
});

test("the entry point carries all three checks", () => {
  // Not a spelling check on the file: each of these is the command the script
  // actually spawns, and dropping one silently is the failure mode.
  assert.match(lintScript, /eslint/, "eslint");
  assert.match(lintScript, /workflow-lint\.mjs/, "this repo's own workflow rules + bash -n");
  assert.match(lintScript, /actionlint/, "actionlint - the only thing running shellcheck on run: blocks");
  assert.match(lintScript, /--max-warnings/, "a warning nobody fails on is a warning nobody reads");
});

test("the external tools are pinned, and shellcheck is not the runner's", () => {
  // actionlint at a floating version reports different findings over time; a
  // shellcheck taken from whatever the runner image ships is the same drift in
  // another coat, since that is what decides which SC* codes appear.
  assert.match(lintScript, /ACTIONLINT_VERSION = "\d+\.\d+\.\d+"/, "actionlint version is pinned in one place");
  assert.match(lintScript, /SHELLCHECK_VERSION = "\d+\.\d+\.\d+"/, "shellcheck version is pinned in one place");
  assert.match(lintScript, /-shellcheck/, "passed explicitly rather than left to PATH");

  // It USED TO BE the `shellcheck` npm devDependency, and that assertion lived
  // here. The package was dropped on 2026-08-31: every published version from
  // 2.x up unpacks the official release with `decompress`, which carries three
  // unfixed CRITICAL advisories and has no patched version to move to - the
  // advisory range is `*`. The only npm escape was 1.1.0, which unpins the
  // binary to whatever "stable" meant at publish time and trades a supply-chain
  // hole for exactly the drift this test exists to prevent.
  //
  // So the invariant is unchanged and the mechanism is stronger: `^4.1.0` pinned
  // the WRAPPER, while SHELLCHECK_VERSION pins the TOOL. Re-adding the package
  // fails here rather than quietly restoring the chain.
  assert.ok(
    !pkg.devDependencies?.shellcheck && !pkg.dependencies?.shellcheck,
    "the `shellcheck` npm package pulls unfixed-critical `decompress` - fetch the pinned binary instead",
  );
  assert.doesNotMatch(
    lintScript,
    /node_modules[\\/"]+[^\n]*shellcheck/,
    "shellcheck no longer comes from node_modules",
  );
});

test("no tool is fetched by piping a remote script into a shell", () => {
  // actionlint was obtained with
  //   curl -sSL .../rhysd/actionlint/main/scripts/download-actionlint.bash | bash
  // - a script from a MUTABLE BRANCH, executed unverified, which then fetched a
  // binary that was also unverified. Worse than the npm shellcheck package that
  // was removed for supply-chain reasons in the same pass, and two functions
  // away from it. Both tools are pinned release assets now.
  // BLOCK comments stripped as well as line comments. The explanation of this
  // very rule lives in a /** */ above fetchPinnedTool and quotes the old
  // `| bash` command it exists to forbid, so a line-comment-only strip fails
  // against its own prose - the trap this repo keeps rediscovering, hit again.
  const code = lintScript.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.doesNotMatch(code, /raw\.githubusercontent\.com/, "no script is fetched from a branch");
  assert.doesNotMatch(code, /\|\s*bash\b/, "nothing is piped into a shell");
  assert.doesNotMatch(code, /download-actionlint/, "the upstream installer script is not used");
});

test("both downloaded tools are checksum-verified, and a mismatch is fatal", () => {
  // A pinned VERSION only says which bytes were asked for. Without a digest,
  // a re-cut release, a hijacked tag or an intercepted download all run
  // unnoticed - and these binaries are handed every `run:` block in the repo.
  assert.match(lintScript, /SHELLCHECK_SHA256/, "the pinned shellcheck digests must exist");
  assert.match(lintScript, /ACTIONLINT_SHA256/, "the pinned actionlint digests must exist");
  assert.match(lintScript, /createHash\("sha256"\)/, "and be computed over the downloaded archive");

  // Every platform the resolvers can select needs an entry in both maps, or the
  // tool silently has no digest on somebody's machine and refuses to run there.
  for (const constant of ["SHELLCHECK_SHA256", "ACTIONLINT_SHA256"]) {
    const at = lintScript.indexOf(`const ${constant} = Object.freeze({`);
    assert.ok(at > 0, `${constant} must be declared`);
    const block = lintScript.slice(at, lintScript.indexOf("});", at));
    const digests = [...block.matchAll(/"([0-9a-f]{64})"/g)];
    assert.ok(digests.length >= 5, `${constant} must cover every supported platform, found ${digests.length}`);
  }

  const verify = lintScript.slice(lintScript.indexOf("const actual = createHash"));
  // Comments blanked before the absence check below, for the reason this repo
  // keeps rediscovering: the comment inside that branch explains the rule by
  // quoting it ("Deliberately no retry and no fallback"), so a raw scan reads
  // the prose as code and fails against the very thing it is asserting.
  const branch = verify.slice(0, verify.indexOf("\n  }") + 4).replace(/\/\/[^\n]*/g, "");
  assert.match(branch, /actual !== expected/, "the comparison must be there");
  assert.match(branch, /rmSync\(archive/, "a failing archive is deleted rather than left to be picked up");
  assert.doesNotMatch(branch, /retry|again/i, "a checksum mismatch is not a transient error to retry");

  // Every platform the resolver can select must have a digest, or it refuses.
  assert.match(
    lintScript,
    /if \(!expected\) \{/,
    "a platform with no pinned digest must FAIL, never download unverified",
  );
});

test("a missing tool fails the run instead of skipping the check", () => {
  // The whole bug was a check that did not run and said nothing.
  const missingToolBranch = lintScript.slice(lintScript.indexOf("if (!actionlint)"));
  assert.match(missingToolBranch, /failed = true/, "an unobtainable tool must fail, not warn");
  assert.doesNotMatch(
    lintScript,
    /SKIP_ACTIONLINT|skipActionlint|--no-actionlint/,
    "no escape hatch: one would be used, and then relied on"
  );
});

test(".tools is ignored, so the fetched binary never lands in a commit", () => {
  const ignored = readFileSync(join(root, ".gitignore"), "utf8");
  assert.match(ignored, /^\.tools\/$/m);
});
