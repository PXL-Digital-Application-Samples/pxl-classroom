// The archive is per assignment, and where an EXISTING preservation lives is
// read off the record rather than derived.
//
// Both halves matter and they pull in opposite directions, which is why they
// are two functions: `archiveRepoName` answers "where does a NEW preservation
// go" and `resolveArchiveRepo` answers "where is this one". Collapse them and
// every submission archived before per-assignment archives - including the one
// real preservation in production - resolves to a repository that does not
// exist, with no error anywhere: a 404 the lecturer discovers by clicking.
//
// Same fork guard tests/deadline-countdown.test.mjs puts on the countdown and
// tests/effective-deadline.test.mjs on the extension rule. Eight hand-built
// copies of the archive URL existed across two components, the CLI and a test
// that re-implemented the builder locally in order to assert on it.

import { test } from "node:test";
import assert from "node:assert/strict";

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  LEGACY_ARCHIVE_REPO,
  ARCHIVE_REPO_PREFIX,
  MAX_REPO_NAME_LENGTH,
  archiveRepoName,
  resolveArchiveRepo,
  archiveBranchName,
  archiveRepoUrl,
  archiveBranchesUrl,
  archiveBranchUrl,
  reportArchiveRepo,
  archiveReadme,
} from "../lib/archive-repo.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// --- one implementation, everywhere -----------------------------------------

const walk = (dir, out = []) => {
  for (const entry of readdirSync(dir)) {
    // `.claude` holds git worktrees - a full second checkout of this repo, so
    // walking into one finds a copy of every module and reports it as a fork.
    if (entry === "node_modules" || entry === "dist" || entry === ".git" || entry === ".tools" || entry === ".claude") continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(mjs|js|vue)$/.test(entry)) out.push(p);
  }
  return out;
};

const sources = () =>
  walk(root).filter(
    (p) =>
      p !== join(root, "lib", "archive-repo.mjs") &&
      p !== join(root, "frontend", "src", "lib", "archive-repo.js") &&
      !p.startsWith(join(root, "tests")),
  );

// Comments are stripped first. The ones this change added name the old
// per-org archive and quote the naming rule, so a scan including them fails
// against its own explanation - the trap tests/promote-roster.test.mjs and
// tests/student-wait-copy.test.mjs both document. Whole-line `//` only, so a
// `https://` inside real code is not mistaken for a comment.
function codeOf(p) {
  return readFileSync(p, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

test("nothing builds an archive repository name of its own", () => {
  // The tell is the prefix with something glued after it. `lib/audit.mjs` may
  // still name the bare legacy repo (it re-exports it as ARCHIVE_REPO for the
  // old per-org archive), so the pattern deliberately requires a suffix.
  const offenders = sources()
    .filter((p) => /pxl-classroom-archive-|pxl-classroom-archive\$\{|pxl-classroom-archive['"]\s*\+/.test(codeOf(p)))
    .map((p) => relative(root, p));

  assert.deepEqual(
    offenders,
    [],
    `these compose an archive repository name instead of using lib/archive-repo.mjs:\n  ${offenders.join("\n  ")}`,
  );
});

test("nothing builds a preserved/ branch URL of its own", () => {
  // `preserved/${...}` interpolated into a path. preserve.mjs writes the ref
  // (it is the writer, and records it), so it is the one exemption.
  const allowed = new Set([join(root, "preserve", "preserve.mjs")]);
  const offenders = sources()
    .filter((p) => !allowed.has(p))
    .filter((p) => /preserved\/\$\{/.test(codeOf(p)))
    .map((p) => relative(root, p));

  assert.deepEqual(
    offenders,
    [],
    `these build a preserved ref themselves instead of using archiveBranchName/archiveBranchUrl:\n  ${offenders.join("\n  ")}`,
  );
});

test("report.mjs propagates the archive fields preserve.mjs writes", () => {
  // The `preserved_sha` class of bug, guarded from the other end: that field
  // was read by four features and written by nobody, because report.mjs read a
  // name preservation.json has never carried. These two are the reverse -
  // written by preserve.mjs since it was first added, read by nobody - and the
  // whole per-assignment archive rests on them reaching the report.
  const reportSrc = readFileSync(join(root, "report", "report.mjs"), "utf8");
  const preserveSrc = readFileSync(join(root, "preserve", "preserve.mjs"), "utf8");

  assert.match(reportSrc, /archive_repo:\s*preservation\?\.archive_repo/, "report.mjs must carry preservation.json's archive_repo");
  assert.match(reportSrc, /archive_ref:\s*preservation\?\.preserved_ref/, "report.mjs must carry preservation.json's preserved_ref");
  assert.match(preserveSrc, /archive_repo:/, "preserve.mjs must still write archive_repo");
  assert.match(preserveSrc, /preserved_ref:/, "preserve.mjs must still write preserved_ref");
});

// --- naming ------------------------------------------------------------------

test("a new preservation goes to the assignment's own archive", () => {
  assert.equal(archiveRepoName("linux-processes"), "pxl-classroom-archive-linux-processes");
  assert.equal(
    archiveRepoName("2526-automation-scripting-practicum-exam-2"),
    "pxl-classroom-archive-2526-automation-scripting-practicum-exam-2",
  );
});

test("the name never exceeds what GitHub accepts", () => {
  // An assignment id is schema-constrained to 100 characters
  // (`^[a-z0-9][a-z0-9-]{0,99}$`) and GitHub refuses a repository name longer
  // than 100, so the prefix alone can push a legitimate id past the limit.
  // Unhandled, that lands as fail:create-archive for the whole cohort at the
  // deadline - the worst moment this system has.
  const longest = "a".repeat(100);
  const name = archiveRepoName(longest);
  assert.equal(name.length, MAX_REPO_NAME_LENGTH);
  assert.ok(name.startsWith(ARCHIVE_REPO_PREFIX));
  assert.match(name, /^[a-z0-9][a-z0-9-]*$/, "still a legal repository name");
});

test("two long ids sharing a prefix do not collide", () => {
  // The digest is of the WHOLE id, not of the truncated head - otherwise two
  // assignments in the same course year land in one archive and the second
  // cohort's push either fails or lands beside the first.
  const a = archiveRepoName("2526-" + "x".repeat(90) + "-exam-1");
  const b = archiveRepoName("2526-" + "x".repeat(90) + "-exam-2");
  assert.notEqual(a, b);
  assert.equal(a.length, MAX_REPO_NAME_LENGTH);
  assert.equal(b.length, MAX_REPO_NAME_LENGTH);
});

test("the name is deterministic, or a later lookup misses the archive", () => {
  assert.equal(archiveRepoName("x".repeat(120)), archiveRepoName("x".repeat(120)));
});

test("an unusable id yields null, not a name that would land somewhere else", () => {
  // Null so preserve.mjs fails loudly on validation, and so a Vue computed
  // renders nothing rather than throwing and taking the pane down.
  assert.equal(archiveRepoName(""), null);
  assert.equal(archiveRepoName(null), null);
  assert.equal(archiveRepoName(undefined), null);
  assert.equal(archiveRepoName("---"), null);
  assert.equal(archiveRepoName(42), null);
});

// --- resolution: the record wins --------------------------------------------

test("a recorded archive repo wins over any naming rule", () => {
  assert.equal(
    resolveArchiveRepo({ org: "PXLAutomation", recorded: "PXLAutomation/pxl-classroom-archive" }),
    "PXLAutomation/pxl-classroom-archive",
  );
  assert.equal(
    resolveArchiveRepo({ org: "PXLAutomation", recorded: "PXLAutomation/pxl-classroom-archive-hw-1" }),
    "PXLAutomation/pxl-classroom-archive-hw-1",
  );
});

test("a bare recorded name is qualified with the org", () => {
  assert.equal(
    resolveArchiveRepo({ org: "PXLAutomation", recorded: "pxl-classroom-archive-hw-1" }),
    "PXLAutomation/pxl-classroom-archive-hw-1",
  );
});

test("no record means the OLD per-org archive, never today's naming rule", () => {
  // This is the whole backward-compatibility story. A preserved row without
  // the field predates per-assignment archives, and everything preserved then
  // went to <org>/pxl-classroom-archive. Deriving instead hands a lecturer a
  // 404 for every submission archived before the change - including the only
  // real preservation in production.
  assert.equal(
    resolveArchiveRepo({ org: "PXLAutomation" }),
    `PXLAutomation/${LEGACY_ARCHIVE_REPO}`,
  );
  assert.equal(
    resolveArchiveRepo({ org: "PXLAutomation", recorded: null }),
    `PXLAutomation/${LEGACY_ARCHIVE_REPO}`,
  );
  assert.equal(
    resolveArchiveRepo({ org: "PXLAutomation", recorded: "  " }),
    `PXLAutomation/${LEGACY_ARCHIVE_REPO}`,
    "whitespace is not a record",
  );
});

test("resolveArchiveRepo cannot be handed an assignment id", () => {
  // Not a style point. If it accepted one it would eventually use it, and the
  // fallback above would silently become "derive today's name" - which is the
  // exact 404 this module exists to prevent. Enforced on the signature so the
  // temptation is not available.
  const src = readFileSync(join(root, "lib", "archive-repo.mjs"), "utf8");
  const fn = src.slice(src.indexOf("export function resolveArchiveRepo"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.ok(!/assignmentId/.test(body), "resolveArchiveRepo must not reference an assignment id");
});

test("nothing resolvable is null, so a caller renders no link rather than a dead one", () => {
  assert.equal(resolveArchiveRepo({}), null);
  assert.equal(resolveArchiveRepo(), null);
  assert.equal(resolveArchiveRepo({ recorded: "pxl-classroom-archive-hw-1" }), null, "a bare name needs an org");
});

// --- branch names ------------------------------------------------------------

test("a recorded ref wins over reconstructing the branch", () => {
  assert.equal(
    archiveBranchName({ assignmentId: "hw-1", login: "alice", recordedRef: "refs/heads/preserved/hw-1/team-alpha" }),
    "preserved/hw-1/team-alpha",
    "refs/heads/ is stripped for a browse URL",
  );
  assert.equal(
    archiveBranchName({ assignmentId: "hw-1", login: "alice", recordedRef: "preserved/hw-1/team-alpha" }),
    "preserved/hw-1/team-alpha",
    "a ref already in branch form is left alone",
  );
});

test("a group is preserved under its team slug, not its members' logins", () => {
  // The SPA reconstructed `preserved/<id>/<login>` unconditionally, so every
  // group submission linked to a branch that does not exist: preserve.mjs
  // pushes `rec.team_slug || login`, and a team shares one repository.
  assert.equal(
    archiveBranchName({ assignmentId: "project-2026", login: "alice", teamSlug: "team-alpha" }),
    "preserved/project-2026/team-alpha",
  );
  assert.equal(
    archiveBranchName({ assignmentId: "project-2026", login: "alice" }),
    "preserved/project-2026/alice",
  );
});

test("no key and no ref is null", () => {
  assert.equal(archiveBranchName({ assignmentId: "hw-1" }), null);
  assert.equal(archiveBranchName({ login: "alice" }), null);
  assert.equal(archiveBranchName(), null);
});

// --- URLs --------------------------------------------------------------------

test("the branch URL encodes the ref", () => {
  assert.equal(
    archiveBranchUrl({ org: "PXLAutomation", assignmentId: "linux-processes", login: "alice", recorded: "PXLAutomation/pxl-classroom-archive-linux-processes" }),
    "https://github.com/PXLAutomation/pxl-classroom-archive-linux-processes/tree/preserved%2Flinux-processes%2Falice",
  );
});

test("a pre-change row still links into the old archive", () => {
  assert.equal(
    archiveBranchUrl({ org: "PXLAutomation", assignmentId: "linux-processes", login: "alice" }),
    "https://github.com/PXLAutomation/pxl-classroom-archive/tree/preserved%2Flinux-processes%2Falice",
  );
});

test("a login or id with URL-significant characters is encoded, not interpolated raw", () => {
  assert.equal(
    archiveBranchUrl({ org: "PXLAutomation", assignmentId: "devops_lab-1", login: "student.name+test" }),
    "https://github.com/PXLAutomation/pxl-classroom-archive/tree/preserved%2Fdevops_lab-1%2Fstudent.name%2Btest",
  );
});

test("an unresolvable link is null", () => {
  assert.equal(archiveBranchUrl({ org: "PXLAutomation", assignmentId: "hw-1" }), null, "no login and no team");
  assert.equal(archiveBranchUrl({ assignmentId: "hw-1", login: "alice" }), null, "no org");
  assert.equal(archiveRepoUrl({}), null);
});

test("archiveBranchesUrl points at the branch list, which is where the work is", () => {
  // A preservation is a BRANCH. The default branch holds only a README, so the
  // repository root reads as an empty repository - a lecturer opening a
  // finished exam's archive concluded the evidence was gone (2026-09-02). The
  // UI links here instead.
  assert.equal(
    archiveBranchesUrl({ recorded: "PXLAutomation/pxl-classroom-archive-hw-1" }),
    "https://github.com/PXLAutomation/pxl-classroom-archive-hw-1/branches",
  );
  assert.equal(archiveBranchesUrl({}), null, "nothing to link to is no link, never a dead one");
});

test("archiveRepoUrl accepts an already-resolved slug", () => {
  assert.equal(
    archiveRepoUrl({ recorded: "PXLAutomation/pxl-classroom-archive-hw-1" }),
    "https://github.com/PXLAutomation/pxl-classroom-archive-hw-1",
  );
});

// --- the report's own archive ------------------------------------------------

test("a report with nothing preserved has no archive to link to", () => {
  // Before the first preservation the repository does not exist. Offering a
  // button to it is the page guessing why it is stuck - the rule the student
  // waiting screen is held to.
  assert.equal(reportArchiveRepo({ org: "PXLAutomation", students: [] }), null);
  assert.equal(
    reportArchiveRepo({ org: "PXLAutomation", students: [{ github_login: "alice", preservation_status: "not-required" }] }),
    null,
  );
  assert.equal(reportArchiveRepo(), null);
});

test("the report's archive comes off a preserved row", () => {
  assert.equal(
    reportArchiveRepo({
      org: "PXLAutomation",
      students: [
        { github_login: "alice", preservation_status: "failed" },
        { github_login: "bob", preservation_status: "preserved", archive_repo: "PXLAutomation/pxl-classroom-archive-hw-1" },
      ],
    }),
    "PXLAutomation/pxl-classroom-archive-hw-1",
  );
});

test("a preserved row with no recorded repo still resolves to the old archive", () => {
  assert.equal(
    reportArchiveRepo({
      org: "PXLAutomation",
      students: [{ github_login: "alice", preservation_status: "preserved", preserved_sha: "a".repeat(40) }],
    }),
    `PXLAutomation/${LEGACY_ARCHIVE_REPO}`,
  );
});

test("a mixed report prefers a row that actually recorded one", () => {
  // A cohort preserved before the change and then retried after it has rows in
  // both archives. The banner's single link should point at the one that was
  // written down rather than at the legacy fallback.
  assert.equal(
    reportArchiveRepo({
      org: "PXLAutomation",
      students: [
        { github_login: "alice", preservation_status: "preserved" },
        { github_login: "bob", preservation_status: "preserved", archive_repo: "PXLAutomation/pxl-classroom-archive-hw-1" },
      ],
    }),
    "PXLAutomation/pxl-classroom-archive-hw-1",
  );
});

// ==================================================== the archive's own README
//
// Every preservation is a branch, so the archive's default branch holds this
// file and nothing else - and the repository ROOT, which is where a link lands,
// therefore shows one small file and reads as an empty repository. A lecturer
// opening the archive for a finished exam concluded exactly that (2026-09-02):
// that the evidence was gone. GitHub's auto_init README is the repository name,
// which does nothing to correct it.
//
// What is NOT tested here is the write itself in preserve.mjs. That path needs
// a gh/fetch mock this suite does not have, and the write is deliberately
// cosmetic - it is logged and never fails a preservation.

test("the README names the assignment it belongs to", () => {
  const md = archiveReadme({ assignmentId: "2526-examen-aut2-ek2" });
  assert.ok(md.includes("2526-examen-aut2-ek2"));
});

test("it says the submissions are branches, and names the tab that lists them", () => {
  // The whole job of the file: someone opening the root must not conclude the
  // work was lost.
  const md = archiveReadme({ assignmentId: "hw-1" });
  assert.match(md, /branch/i);
  assert.match(md, /Branches tab/);
});

test("it does NOT restate the branch naming scheme", () => {
  // Deliberate omission: nobody types one of these by hand, and a pattern
  // spelled out in prose is a second source of truth that drifts from
  // archiveBranchName. Anchored to the real builder rather than to a literal,
  // so this cannot pass vacuously if the scheme is ever changed.
  const sample = archiveBranchName({ assignmentId: "hw-1", login: "alice" });
  assert.ok(sample, "archiveBranchName produced nothing - this guard has no anchor");
  const prefix = sample.split("/")[0];
  const md = archiveReadme({ assignmentId: "hw-1" });
  assert.ok(!md.includes(sample), `README spells out ${sample}`);
  assert.ok(!md.includes(`${prefix}/`), `README spells out the ${prefix}/ scheme`);
});

test("no assignment to name yields no README rather than a blank one", () => {
  // preserve.mjs skips the write on null. A README headed "Archived submissions -"
  // with nothing after it is worse than the auto_init one it would replace.
  assert.equal(archiveReadme({ assignmentId: "" }), null);
  assert.equal(archiveReadme({ assignmentId: "   " }), null);
  assert.equal(archiveReadme({}), null);
  assert.equal(archiveReadme(), null);
});
