#!/usr/bin/env node
// PXL Classroom - the lint entry point. One command, run by CI and by hand.
//
// It exists because `npm run lint` and CI's lint job used to check different
// things. `npm run lint` was `eslint .`; CI's `test` job ran
// `npx eslint . --max-warnings 0` and CI's `lint` job ran actionlint plus
// scripts/workflow-lint.mjs, neither of which had a local equivalent. So a
// change could pass locally, four times over, while CI had been red since
// 48ed831 for a shellcheck finding nothing local would ever surface.
//
// Three checks, in cheapest-first order:
//
//   eslint         - no-undef above all. The Vue template compiler never sees a
//                    <script setup> body and the unit suite does not execute
//                    components, so an undeclared identifier ships silently.
//   workflow-lint  - bash -n over every `run:` block, plus this repo's own
//                    rules (scripts/workflow-lint.mjs).
//   actionlint     - workflow schema + expression checking, and shellcheck over
//                    every `run:` block, which is the half nothing else does.
//
// Both external tools are PINNED and resolved the same way in both places, and
// BOTH now come from .tools/ (gitignored) at the versions below - a different
// shellcheck reports different findings, which is the same drift in another
// coat.
//
// shellcheck used to be the `shellcheck` npm devDependency, and it was dropped
// on 2026-08-31 for supply-chain reasons rather than convenience. That wrapper
// downloads the official release and unpacks it with `decompress`, which carries
// three unfixed CRITICAL advisories - Zip Slip, arbitrary file write, and
// hardlink creation during extraction (GHSA-… via npm audit) - and there is no
// patched version to move to: the advisory range is `*` and the package is
// unmaintained. Every published `shellcheck` version from 2.x up depends on it,
// so the only npm-side escape was 1.1.0, which unpins the binary to whatever
// "stable" meant when it was published - trading a supply-chain hole for exactly
// the version drift this file exists to prevent.
//
// Fetching the official binary directly removes the dependency entirely AND
// pins harder than before: `^4.1.0` pinned the wrapper, not the tool, whereas
// SHELLCHECK_VERSION below pins the tool itself. The download is verified
// against SHELLCHECK_SHA256 - actionlint's `curl | bash` fetch has no such
// check, which is worth fixing next but is a separate change.
//
// If a tool genuinely cannot be obtained, this fails rather than skipping. A
// check that quietly does not run is what caused this file to exist. A checksum
// MISMATCH fails the same way and does not retry: the one thing it can mean is
// that the bytes are not the ones this repo pinned.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TOOLS = join(root, ".tools");

// Pinned. Bump deliberately, in one place, and both sides move together.
const ACTIONLINT_VERSION = "1.7.1";

// From the release's own actionlint_1.7.1_checksums.txt, 2026-08-31. Until now
// actionlint was fetched by piping a script from a MUTABLE BRANCH into bash -
// `curl -sSL .../actionlint/main/scripts/download-actionlint.bash | bash` - with
// no pin on the script and no checksum on anything it fetched. That is a worse
// mechanism than the npm shellcheck package this file just removed, and it sat
// two functions away from it.
const ACTIONLINT_SHA256 = Object.freeze({
  "linux_amd64.tar.gz": "f53c34493657dfea83b657e4b62cc68c25fbc383dff64c8d581613b037aacaa3",
  "linux_arm64.tar.gz": "21a20f38b19dc962d89e17fe1c6f116199e9e0d343ab33361868def14cc220fc",
  "darwin_amd64.tar.gz": "ee24184e2e7003c19eb739717b34b7c65d096f2ca0df8d571837b4f20112d573",
  "darwin_arm64.tar.gz": "a72f66f28a4cc294670abb7a5e3392033700e00cc6a385c32fb769971b71ec9f",
  "windows_amd64.zip": "5dbecc21cf2ebe982a1ae5e029ee49f5be8ca3263a936c597323ed9331d896de",
});

// 0.11.0 is what the npm wrapper was already resolving to, so this migration
// changes no finding. Bumping it is a deliberate act with a lint diff to read.
const SHELLCHECK_VERSION = "0.11.0";

// sha256 of each official release asset, measured 2026-08-31. A platform with
// no entry here FAILS rather than downloading unverified - an unpinned binary
// running over every workflow in the repo is the thing this is protecting.
const SHELLCHECK_SHA256 = Object.freeze({
  "linux.x86_64.tar.gz": "b7af85e41cc99489dcc21d66c6d5f3685138f06d34651e6d34b42ec6d54fe6f6",
  "linux.aarch64.tar.gz": "68a8133197a50beb8803f8d42f9908d1af1c5540d4bb05fdfca8c1fa47decefc",
  "darwin.x86_64.tar.gz": "c2c15e08df0e8fbc374c335b230a7ee958c313fa5714817a59aa59f1aa594f51",
  "darwin.aarch64.tar.gz": "339b930feb1ea764467013cc1f72d09cd6b869ebf1013296ba9055ab2ffbd26f",
  zip: "8a4e35ab0b331c85d73567b12f2a444df187f483e5079ceffa6bda1faa2e740e",
});

const isWindows = process.platform === "win32";
const exe = (name) => (isWindows ? `${name}.exe` : name);

const results = [];
let failed = false;

// A hang is worse than a failure, because it looks exactly like work in
// progress. actionlint's shellcheck subprocess DEADLOCKS on Windows once a
// `run:` block's script exceeds the ~4 KB anonymous-pipe buffer: actionlint
// copies the script to shellcheck's stdin, the copy blocks on a full pipe, and
// Wait() never returns. Linux pipes hold 64 KB, so CI is unaffected - which is
// the worst shape for this, because the local command hangs for ever while
// everything remote stays green. It cost an hour once and shipped a workflow
// change with "local actionlint could not be run to completion" in its commit
// message instead of a lint result; the next one gets a named failure in two
// minutes. The whole suite runs in seconds, so this can never fire on
// slowness alone.
const STEP_TIMEOUT_MS = 120_000;

function run(label, command, args, opts = {}) {
  process.stdout.write(`\n── ${label}\n`);
  const res = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: false,
    timeout: STEP_TIMEOUT_MS,
    ...opts,
  });
  if (res.error) {
    const timedOut = res.error.code === "ETIMEDOUT" || res.signal !== null;
    console.error(`[FAIL] ${label}: ${timedOut ? `timed out after ${STEP_TIMEOUT_MS / 1000}s` : res.error.message}`);
    if (timedOut && label === "actionlint") {
      console.error(
        "       This is almost certainly a `run:` block whose script exceeds ~4 KB.\n" +
          "       Split the step - platform-neutral, and the blocks read better anyway.\n" +
          "       A Windows-only workaround would reintroduce the local-vs-CI drift\n" +
          "       this script exists to end. See CLAUDE.md, Linting."
      );
    }
    results.push({ label, ok: false });
    failed = true;
    return false;
  }
  const ok = res.status === 0;
  results.push({ label, ok });
  if (!ok) failed = true;
  return ok;
}

/**
 * Download a pinned release binary into .tools/, verify it, unpack it.
 *
 * ONE implementation for both tools, because they had drifted into two very
 * different trust levels. shellcheck was fetched, checksummed and refused on
 * mismatch; actionlint was `curl -sSL .../main/scripts/download-actionlint.bash
 * | bash` - a script piped from a MUTABLE BRANCH straight into a shell, with no
 * pin and no checksum on the script or the binary it then fetched. That is a
 * worse mechanism than the npm package the shellcheck change removed, sitting
 * two functions away from it, and it ran on every developer machine and every
 * CI lint job.
 *
 * The rules are the shellcheck ones, now applied to both: a platform with no
 * pinned digest FAILS rather than downloading unverified; a mismatch is fatal
 * with no retry and no fallback, because the one thing it can mean is that the
 * bytes are not the ones this repo pinned.
 *
 * @param {object} spec
 * @param {string} spec.bin        binary name, without any .exe
 * @param {string} spec.version    pinned version, for messages
 * @param {string} spec.url        full asset URL
 * @param {string} spec.asset      asset filename
 * @param {string} spec.expected   sha256 of the asset, or undefined
 * @param {string} spec.platformKey how this platform was named, for the error
 * @param {string} spec.constant   the constant to update, for the error
 * @param {number} spec.strip      tar --strip-components (0 = binary at root)
 * @param {string} [spec.nested]   directory the archive unpacks into, if any
 */
function fetchPinnedTool({ bin, version, url, asset, expected, platformKey, constant, strip, nested }) {
  const local = join(TOOLS, exe(bin));
  if (existsSync(local)) return local;

  if (!expected) {
    console.error(
      `\n[FAIL] No pinned ${bin} checksum for ${process.platform}/${process.arch} (${platformKey}).\n` +
        `       Add the asset's sha256 to ${constant} in scripts/lint.mjs.\n` +
        "       Downloading it unverified is not the fallback: this binary reads every\n" +
        "       workflow in the repo.\n",
    );
    return null;
  }

  console.log(`   downloading ${bin} ${version} into .tools/ ...`);
  mkdirSync(TOOLS, { recursive: true });
  const archive = join(TOOLS, asset);

  const got = spawnSync("curl", ["-sSL", "--fail", "-o", archive, url], { stdio: "inherit" });
  if (got.status !== 0 || !existsSync(archive)) return null;

  const actual = createHash("sha256").update(readFileSync(archive)).digest("hex");
  if (actual !== expected) {
    // Deliberately no retry and no fallback. The bytes are not the pinned ones,
    // and the only safe thing to do with them is not run them.
    rmSync(archive, { force: true });
    console.error(
      `\n[FAIL] ${bin} ${version} (${asset}) failed its checksum.\n` +
        `       expected ${expected}\n       actual   ${actual}\n` +
        `       Refusing to run it. If the release was legitimately re-cut, update\n` +
        `       ${constant} in scripts/lint.mjs deliberately.\n`,
    );
    return null;
  }

  // TWO EXTRACTORS, because one does not cover both platforms.
  //
  // `tar` on Windows is whichever of several binaries PATH finds first, and in
  // Git Bash that is GNU tar 1.35, which cannot read a zip at all ("This does
  // not look like a tar archive") and reads `-C C:\...` as a REMOTE HOST spec
  // ("Cannot connect to C: resolve failed"). PowerShell's Expand-Archive is
  // always present on Windows and has neither problem. Everywhere else the
  // asset is a .tar.gz and any tar handles it.
  //
  // Both run with cwd: TOOLS and a bare filename, so no drive letter is ever
  // passed to a tool that might read the colon as a host separator.
  const out = isWindows
    ? spawnSync(
        "powershell",
        ["-NoProfile", "-NonInteractive", "-Command", `Expand-Archive -LiteralPath '${asset}' -DestinationPath . -Force`],
        { cwd: TOOLS, stdio: "inherit" },
      )
    : spawnSync("tar", ["-xzf", asset, ...(strip ? ["--strip-components", String(strip)] : [])], {
        cwd: TOOLS,
        stdio: "inherit",
      });
  rmSync(archive, { force: true });
  if (out.status !== 0) return null;

  // A zip unpacks into its own directory; lift the binary up beside it so both
  // platforms end at the same path and the cache check above is one test.
  if (!existsSync(local) && nested) {
    const dir = join(TOOLS, nested);
    const inner = join(dir, exe(bin));
    if (existsSync(inner)) {
      renameSync(inner, local);
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return existsSync(local) ? local : null;
}

/**
 * The pinned shellcheck, so local and CI report identically and nothing here
 * depends on `decompress`.
 *
 * `.tar.gz` rather than the `.tar.xz` the project also publishes: every tar that
 * matters handles gzip, while xz needs liblzma and Git Bash's bsdtar is not
 * guaranteed to have it. Windows takes the `.zip`. Same binary, same release.
 */
function resolveShellcheck() {
  const key = isWindows
    ? "zip"
    : `${process.platform === "darwin" ? "darwin" : "linux"}.${process.arch === "arm64" ? "aarch64" : "x86_64"}.tar.gz`;
  const asset = `shellcheck-v${SHELLCHECK_VERSION}.${key}`;
  return fetchPinnedTool({
    bin: "shellcheck",
    version: SHELLCHECK_VERSION,
    url: `https://github.com/koalaman/shellcheck/releases/download/v${SHELLCHECK_VERSION}/${asset}`,
    asset,
    expected: SHELLCHECK_SHA256[key],
    platformKey: key,
    constant: "SHELLCHECK_SHA256",
    strip: 1,
    nested: `shellcheck-v${SHELLCHECK_VERSION}`,
  });
}

/** The pinned actionlint. Its tarball puts the binary at the root, so no strip. */
function resolveActionlint() {
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  const key = isWindows ? "windows_amd64.zip" : `${process.platform === "darwin" ? "darwin" : "linux"}_${arch}.tar.gz`;
  const asset = `actionlint_${ACTIONLINT_VERSION}_${key}`;
  return fetchPinnedTool({
    bin: "actionlint",
    version: ACTIONLINT_VERSION,
    url: `https://github.com/rhysd/actionlint/releases/download/v${ACTIONLINT_VERSION}/${asset}`,
    asset,
    expected: ACTIONLINT_SHA256[key],
    platformKey: key,
    constant: "ACTIONLINT_SHA256",
    strip: 0,
  });
}

// 1. eslint. --max-warnings 0 because a warning nobody fails on is a warning
//    nobody reads.
run("eslint", process.execPath, [
  join(root, "node_modules", "eslint", "bin", "eslint.js"),
  ".",
  "--max-warnings",
  "0",
]);

// 2. This repo's own workflow rules, plus bash -n.
run("workflow-lint", process.execPath, [join(root, "scripts", "workflow-lint.mjs")]);

// 3. actionlint + shellcheck.
const actionlint = resolveActionlint();
const shellcheck = resolveShellcheck();

if (!actionlint) {
  console.error(
    "\n[FAIL] actionlint could not be obtained.\n" +
      "       It needs `bash` and `curl` on PATH (Git Bash provides both on Windows).\n" +
      "       Skipping it is not an option: it is the only thing that runs shellcheck\n" +
      "       over workflow `run:` blocks, and CI will run it regardless."
  );
  results.push({ label: "actionlint", ok: false });
  failed = true;
} else if (!shellcheck) {
  console.error(
    "\n[FAIL] shellcheck could not be obtained.\n" +
      `       It is downloaded into .tools/ on first use (v${SHELLCHECK_VERSION}); check network\n` +
      "       access to github.com, or delete .tools/ and retry.\n" +
      "       Running actionlint without it would silently skip every SC* check,\n" +
      "       which is exactly the local-vs-CI gap this script exists to close."
  );
  results.push({ label: "actionlint", ok: false });
  failed = true;
} else {
  run("actionlint", actionlint, ["-shellcheck", shellcheck]);
}

const width = Math.max(...results.map((r) => r.label.length));
process.stdout.write("\n");
for (const r of results) {
  process.stdout.write(`${r.ok ? "  ok  " : " FAIL "} ${r.label.padEnd(width)}\n`);
}
process.exit(failed ? 1 : 0);
