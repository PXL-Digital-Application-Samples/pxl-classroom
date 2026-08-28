// Temporary: build a post-lockdown replica state so find-finalizable can be
// driven through its real decisions.
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const S = process.argv[2];
const ID = "2526-examen-aut2-ek2";
const SHA = "a".repeat(40);

const repoDir = join(S, "repositories", ID);
const students = readdirSync(repoDir).map((f) => JSON.parse(readFileSync(join(repoDir, f), "utf8")));

// 1. A lockdown record with a real result row per student.
const record = {
  schema_version: 1,
  assignment_id: ID,
  locked_at: "2026-08-27T20:00:05.000Z",
  lock_method: "demotion",
  results: students.map((r) => ({
    github_login: r.github_login,
    repo_name: r.repo_name,
    repo_id: r.repo_id,
    snapshot_sha: SHA,
    snapshot_ref: "refs/heads/main",
    lockdown_at: "2026-08-27T20:00:05.000Z",
    pushed_at: "2026-08-27T19:12:00.000Z",
    uncertainty_seconds: 5,
  })),
};
mkdirSync(join(S, "lockdowns", ID), { recursive: true });
writeFileSync(join(S, "lockdowns", ID, "lockdown-record.json"), JSON.stringify(record, null, 2) + "\n");
console.log(`  lockdown record written: ${record.results.length} students, all with a snapshot`);

// 2. Preservation for each - the thing find-finalizable checks before it stops.
const mode = process.argv[3] || "all";
let preserved = 0;
for (const [i, r] of students.entries()) {
  if (mode === "one-missing" && i === 0) continue; // leave one unpreserved
  const dir = join(S, "observations", ID, r.github_login);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "preservation.json"), JSON.stringify({
    schema_version: 1,
    assignment_id: ID,
    github_login: r.github_login,
    source_sha: SHA,
    verified: true,
    archive_repo: `PXL-Automation-II/pxl-classroom-archive-${ID}`,
    preserved_ref: `refs/heads/preserved/${ID}/${r.github_login}`,
    preserved_at: "2026-08-27T20:05:00.000Z",
  }, null, 2) + "\n");
  preserved++;
}
console.log(`  preservation records written: ${preserved}/${students.length}`);
