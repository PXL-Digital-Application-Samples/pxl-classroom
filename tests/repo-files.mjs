// The files a source sweep scans: the ones git sees, never the filesystem.
//
// Every "nothing builds this by hand" guard used to walk the directory tree and
// skip a list of names it kept for itself - `node_modules`, `dist`, `.tools`,
// and, one test at a time, `.claude`. That last one is where Claude Code keeps
// its git worktrees, each a full second checkout of this repository, so a walk
// that went in found `lib/broker-repo.mjs` a second time and reported the owning
// module's own copy as a hand-built name. Ten lists had learned the name; the
// control-path and broker-name guards had not, and went red on every machine
// with a worktree and never in CI, which has none. The list of what is not
// source already exists, and it is `.gitignore`.
//
// Tracked files AND untracked ones `.gitignore` admits. The second half is not
// a convenience: a sweep over committed files alone passes on a new module
// until it is `git add`ed, which is how tests/github-noreply.test.mjs once ran
// green over a file that failed it the moment it was committed.
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let listed;

/** Every file git tracks or would track, repo-relative with forward slashes, sorted. */
function gitFiles() {
  if (listed) return listed;
  const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  // `--cached` still names a file deleted from the working tree but not yet
  // staged, and a conflicted path once per stage; `--others` names an untracked
  // nested repository as a directory. None of those is a file to read.
  listed = [...new Set(out.split("\0").filter(Boolean))]
    .filter((rel) => statSync(join(ROOT, rel), { throwIfNoEntry: false })?.isFile())
    .sort();
  // A sweep over nothing reports a clean repository.
  if (listed.length === 0) throw new Error(`git ls-files found no files under ${ROOT}`);
  return listed;
}

/**
 * Absolute paths of the repository's files, optionally narrowed.
 *
 * @param {object} [options]
 * @param {string | string[]} [options.under] repo-relative directories, forward
 *   slashes; only files inside one of them are kept
 * @param {string[]} [options.exts] endings to keep, e.g. `[".mjs", ".vue"]`
 * @returns {string[]}
 */
export function repoFiles({ under, exts } = {}) {
  const dirs = under === undefined ? null : [].concat(under).map((d) => d.replace(/\/+$/, ""));
  return gitFiles()
    .filter((rel) => !dirs || dirs.some((d) => rel.startsWith(`${d}/`)))
    .filter((rel) => !exts || exts.some((e) => rel.endsWith(e)))
    .map((rel) => join(ROOT, rel));
}
