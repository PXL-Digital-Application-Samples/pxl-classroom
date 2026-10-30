// A student renamed their GitHub account (lib/login-rename.mjs). Fixtures are the
// shapes production writes, checked against the schemas after the move: the point
// of this module is that nothing still names the old login, and that what moved
// is still a valid document.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml, stringify } from "yaml";
import { isOrgNotice, parseNotice } from "../lib/org-notices.mjs";
import {
  FOLLOWED_FIELDS,
  LEFT_AS_WRITTEN,
  MOVED_TREES,
  accountsOnRecord,
  currentLogin,
  inMoveOrder,
  moveLogin,
  renamesFor,
} from "../lib/login-rename.mjs";
import { renamedOwnRepo } from "../lib/repo-name.mjs";
import { validateAgainst } from "../lib/validate.mjs";
import { assignmentAdmitsLogin } from "../lib/cohort.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ID = "lab";
const OLD = "Old-Name";
const NEW = "NewNamePXL";
const OTHER = "someone-else";

function put(dir, path, doc) {
  const full = join(dir, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, typeof doc === "string" ? doc : JSON.stringify(doc, null, 2) + "\n");
}

function control() {
  const dir = mkdtempSync(join(tmpdir(), "pxl-rename-"));
  const acceptance = (login, id) => ({ schema_version: 1, assignment_id: ID, github_login: login, github_id: id, accepted_at: "2026-10-01T09:00:00Z", status: "accepted" });
  put(dir, `acceptances/${ID}/${OLD}.json`, acceptance(OLD, 77));
  put(dir, `acceptances/${ID}/${OTHER}.json`, acceptance(OTHER, 88));
  put(dir, `repositories/${ID}/${OLD}.json`, { schema_version: 1, assignment_id: ID, github_login: OLD, repo_name: `Org/lab-${OLD}`, repo_id: 5, members: [OLD] });
  put(dir, `repositories/${ID}/${OTHER}.json`, { schema_version: 1, assignment_id: ID, github_login: OTHER, repo_name: `Org/lab-${OTHER}`, repo_id: 6 });
  put(dir, `observations/${ID}/${OLD}/2026-10-01T09-00-00-000Z.json`, { schema_version: 1, github_login: OLD, repo_name: `Org/lab-${OLD}` });
  put(dir, `observations/${ID}/${OLD}/preservation.json`, { github_login: OLD, preserved_ref: `refs/heads/preserved/${ID}/${OLD}` });
  put(dir, `observations/${ID}/${OTHER}/2026-10-01T09-00-00-000Z.json`, { schema_version: 1, github_login: OTHER });
  put(dir, `overrides/${ID}/${OLD}.json`, { schema_version: 1, github_login: OLD, overrides: [{ type: "deadline_extension", overridden_by: "lecturer1" }] });
  put(dir, `lockdowns/${ID}/lockdown-record.json`, { schema_version: 1, results: [{ github_login: OLD, lock_status: "locked" }, { github_login: OTHER, lock_status: "locked" }] });
  put(dir, `lockdowns/${ID}/unlocked/${OLD}.json`, { schema_version: 1, github_login: OLD, unlocked_by: "lecturer1" });
  put(dir, `lockdowns/${ID}/relocked/${OLD}/2026-10-02.json`, { schema_version: 1, github_login: OLD });
  put(dir, `teams/${ID}/alpha.json`, { schema_version: 1, team_slug: "alpha", members: [OLD, OTHER], created_by: OLD });
  put(dir, `teams/${ID}/bravo.json`, { schema_version: 1, team_slug: "bravo", members: ["third"] });
  put(dir, `grading/${ID}/summary.json`, { schema_version: 1, graded_by: "lecturer1", results: [{ login: OLD, earned_points: 3, total_points: 4 }] });
  put(dir, `grading/${ID}/${OLD}.json`, { schema_version: 1, github_login: OLD, graded_by: "lecturer1" });
  put(dir, `syncs/${ID}/s1.json`, { schema_version: 1, synced_by: "lecturer1", results: [{ github_login: OLD, issue_assignees: [OLD], at_sha: "abc" }] });
  put(dir, "students/claims/77.json", { schema_version: 1, github_login: OLD, github_id: 77, email: "a@student.pxl.be" });
  put(dir, "students/roster.yml", stringify({ schema_version: 1, students: [{ student_number: "1", full_name: "A", github_login: OLD }, { student_number: "2", full_name: "B", github_login: OTHER }] }));
  put(dir, `assignments/${ID}.yml`, stringify({ id: ID, cohort: [`login:${OLD.toLowerCase()}`, "num:2"] }));
  put(dir, "assignments/untouched.yml", stringify({ id: "untouched", cohort: ["num:2"] }));
  return dir;
}

const read = (dir, path) => JSON.parse(readFileSync(join(dir, path), "utf8"));

/** Every file under dir that still names the old login, other than where it is meant to. */
function stillNaming(dir, login) {
  const out = [];
  const walk = (at) => {
    for (const e of readdirSync(join(dir, at), { withFileTypes: true })) {
      const path = at ? `${at}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path);
      else if (path.toLowerCase().includes(login.toLowerCase()) || readFileSync(join(dir, path), "utf8").toLowerCase().includes(login.toLowerCase())) out.push(path);
    }
  };
  walk("");
  return out;
}

test("every record follows, and only what is meant to keep the old name still has it", () => {
  const dir = control();
  const { changed, conflicts } = moveLogin(dir, { from: OLD, to: NEW, githubId: 77 });
  assert.deepEqual(conflicts, []);
  assert.ok(changed.length > 10);

  assert.equal(read(dir, `acceptances/${ID}/${NEW}.json`).github_login, NEW);
  assert.equal(read(dir, `acceptances/${ID}/${NEW}.json`).github_id, 77);
  assert.equal(existsSync(join(dir, `acceptances/${ID}/${OLD}.json`)), false);
  assert.equal(read(dir, `overrides/${ID}/${NEW}.json`).github_login, NEW);
  assert.equal(read(dir, `lockdowns/${ID}/unlocked/${NEW}.json`).github_login, NEW);
  assert.equal(read(dir, `lockdowns/${ID}/relocked/${NEW}/2026-10-02.json`).github_login, NEW);
  assert.deepEqual(read(dir, `lockdowns/${ID}/lockdown-record.json`).results.map((r) => r.github_login), [NEW, OTHER]);
  assert.deepEqual(read(dir, `teams/${ID}/alpha.json`).members, [NEW, OTHER]);
  assert.deepEqual(read(dir, `teams/${ID}/bravo.json`).members, ["third"]);
  assert.equal(read(dir, `grading/${ID}/summary.json`).results[0].login, NEW);
  assert.equal(read(dir, `grading/${ID}/${NEW}.json`).github_login, NEW);
  assert.equal(read(dir, `syncs/${ID}/s1.json`).results[0].github_login, NEW);
  assert.equal(read(dir, "students/claims/77.json").github_login, NEW);
  assert.equal(parseYaml(readFileSync(join(dir, "students/roster.yml"), "utf8")).students[0].github_login, NEW);
  assert.deepEqual(parseYaml(readFileSync(join(dir, `assignments/${ID}.yml`), "utf8")).cohort, [`login:${NEW.toLowerCase()}`, "num:2"]);

  // Observations travel, and the snapshot's history stays readable.
  assert.equal(read(dir, `observations/${ID}/${NEW}/2026-10-01T09-00-00-000Z.json`).github_login, NEW);
  assert.equal(read(dir, `observations/${ID}/${NEW}/preservation.json`).github_login, NEW);
  assert.equal(existsSync(join(dir, `observations/${ID}/${OLD}`)), false);

  // What stays: the repository's name, where the snapshot actually is, what
  // GitHub assigned that day, and who made the team.
  const left = stillNaming(dir, OLD).sort();
  assert.deepEqual(left, [
    `observations/${ID}/${NEW}/2026-10-01T09-00-00-000Z.json`,
    `observations/${ID}/${NEW}/preservation.json`,
    `repositories/${ID}/${NEW}.json`,
    "students/renames/77.json",
    `syncs/${ID}/s1.json`,
    `teams/${ID}/alpha.json`,
  ].sort());
  const ledger = read(dir, "students/renames/77.json");
  assert.deepEqual(ledger, { schema_version: 1, github_id: 77, previous_logins: [OLD] });
  assert.equal(validateAgainst("login-rename", structuredClone(ledger)).valid, true);
  assert.equal(read(dir, `repositories/${ID}/${NEW}.json`).repo_name, `Org/lab-${OLD}`);
  assert.deepEqual(read(dir, `repositories/${ID}/${NEW}.json`).members, [NEW]);
  assert.equal(read(dir, `repositories/${ID}/${NEW}.json`).repo_id, 5);
  assert.equal(read(dir, `observations/${ID}/${NEW}/preservation.json`).preserved_ref, `refs/heads/preserved/${ID}/${OLD}`);
  assert.equal(read(dir, `teams/${ID}/alpha.json`).created_by, OLD);
  assert.deepEqual(read(dir, `syncs/${ID}/s1.json`).results[0].issue_assignees, [OLD]);

  // Another student's records are not touched.
  assert.equal(read(dir, `repositories/${ID}/${OTHER}.json`).github_login, OTHER);
  assert.equal(read(dir, `observations/${ID}/${OTHER}/2026-10-01T09-00-00-000Z.json`).github_login, OTHER);
  rmSync(dir, { recursive: true, force: true });
});

test("a second run changes nothing: this runs every night, and on every Accept", () => {
  const dir = control();
  moveLogin(dir, { from: OLD, to: NEW, githubId: 77 });
  const before = stillNaming(dir, NEW).map((p) => [p, readFileSync(join(dir, p), "utf8")]);
  const again = moveLogin(dir, { from: OLD, to: NEW, githubId: 77 });
  assert.deepEqual(again.changed, []);
  assert.deepEqual(stillNaming(dir, NEW).map((p) => [p, readFileSync(join(dir, p), "utf8")]), before);
  rmSync(dir, { recursive: true, force: true });
});

test("an assignment holding both names is left for a person, and the rest of the organization still moves", () => {
  const dir = control();
  put(dir, `acceptances/${ID}/${NEW}.json`, { schema_version: 1, assignment_id: ID, github_login: NEW, github_id: 77, accepted_at: "2026-10-20T09:00:00Z", status: "accepted" });
  put(dir, `acceptances/other/${OLD}.json`, { schema_version: 1, assignment_id: "other", github_login: OLD, github_id: 77, accepted_at: "2026-10-01T09:00:00Z", status: "accepted" });
  const { conflicts } = moveLogin(dir, { from: OLD, to: NEW, githubId: 77 });
  assert.deepEqual(conflicts.map((c) => [c.kind, c.assignment]), [["both", ID]]);
  // Nothing of that assignment moved.
  assert.equal(read(dir, `acceptances/${ID}/${OLD}.json`).github_login, OLD);
  assert.equal(read(dir, `acceptances/${ID}/${NEW}.json`).accepted_at, "2026-10-20T09:00:00Z");
  assert.equal(read(dir, `repositories/${ID}/${OLD}.json`).github_login, OLD);
  assert.deepEqual(read(dir, `teams/${ID}/alpha.json`).members, [OLD, OTHER]);
  // The other assignment did.
  assert.equal(read(dir, `acceptances/other/${NEW}.json`).github_login, NEW);
  rmSync(dir, { recursive: true, force: true });
});

test("a roster that already has a row for the new name is reported, never merged", () => {
  const dir = control();
  put(dir, "students/roster.yml", stringify({ schema_version: 1, students: [{ student_number: "1", github_login: OLD }, { student_number: "3", github_login: NEW }] }));
  const { conflicts } = moveLogin(dir, { from: OLD, to: NEW, githubId: 77 });
  assert.deepEqual(conflicts.map((c) => c.kind), ["roster"]);
  assert.deepEqual(parseYaml(readFileSync(join(dir, "students/roster.yml"), "utf8")).students.map((s) => s.github_login), [OLD, NEW]);
  rmSync(dir, { recursive: true, force: true });
});

test("a case-only change moves the file: the runner's filesystem tells them apart", () => {
  const dir = control();
  const { changed, conflicts } = moveLogin(dir, { from: OLD, to: OLD.toLowerCase(), githubId: 77 });
  assert.deepEqual(conflicts, []);
  assert.ok(changed.length > 0);
  assert.equal(read(dir, `acceptances/${ID}/${OLD.toLowerCase()}.json`).github_login, OLD.toLowerCase());
  assert.ok(readdirSync(join(dir, `acceptances/${ID}`)).includes(`${OLD.toLowerCase()}.json`));
  assert.ok(!readdirSync(join(dir, `observations/${ID}`)).some((n) => n.startsWith(".moving")));
  rmSync(dir, { recursive: true, force: true });
});

test("the cohort gate admits the new name after the move, and only then", () => {
  const dir = control();
  const load = () => ({
    assignment: parseYaml(readFileSync(join(dir, `assignments/${ID}.yml`), "utf8")),
    roster: parseYaml(readFileSync(join(dir, "students/roster.yml"), "utf8")),
  });
  const before = load();
  assert.equal(assignmentAdmitsLogin(before.assignment, NEW, before.roster), false);
  moveLogin(dir, { from: OLD, to: NEW, githubId: 77 });
  const after = load();
  assert.equal(assignmentAdmitsLogin(after.assignment, NEW, after.roster), true);
  assert.equal(assignmentAdmitsLogin(after.assignment, OLD, after.roster), false);
  rmSync(dir, { recursive: true, force: true });
});

test("the account is found by id, and only a real id counts", () => {
  const dir = control();
  put(dir, `acceptances/${ID}/noid.json`, { github_login: "noid" });
  put(dir, `acceptances/${ID}/broken.json`, "{ not json");
  const accounts = accountsOnRecord(dir);
  assert.deepEqual([...accounts.get(77)], [OLD]);
  assert.deepEqual([...accounts.get(88)], [OTHER]);
  assert.equal(accounts.size, 2);
  rmSync(dir, { recursive: true, force: true });
});

test("renamesFor: the current name is no move, an unusable answer is none", () => {
  assert.deepEqual(renamesFor(new Set(["a", "b"]), "b"), [{ from: "a", to: "b" }]);
  assert.deepEqual(renamesFor(new Set(["b"]), "b"), []);
  assert.deepEqual(renamesFor(new Set(["a"]), null), []);
  assert.deepEqual(renamesFor(new Set(["a"]), "../evil"), []);
  assert.deepEqual(renamesFor(new Set(["Ann"]), "ann"), [{ from: "Ann", to: "ann" }]);
});

test("currentLogin: a failed read, a deleted account and a bad id say nothing", async () => {
  const answer = (res) => async () => res;
  assert.equal(await currentLogin(answer({ ok: true, data: { login: "now" } }), 5), "now");
  assert.equal(await currentLogin(answer({ ok: false, status: 404 }), 5), null);
  assert.equal(await currentLogin(answer({ ok: false, status: 500 }), 5), null);
  assert.equal(await currentLogin(async () => { throw new Error("down"); }, 5), null);
  assert.equal(await currentLogin(answer({ ok: true, data: {} }), 5), null);
  let asked = 0;
  assert.equal(await currentLogin(async () => { asked++; return { ok: true, data: { login: "x" } }; }, "5"), null);
  assert.equal(asked, 0);
});

test("renamedOwnRepo: a repository named for a login nobody holds, one only, in this organization", () => {
  const repo = (name, owner = "Org") => ({ name, owner: { login: owner } });
  const who = { org: "Org", pattern: "lab-{github_login}", login: NEW };
  const gone = new Set([OLD.toLowerCase()]);
  assert.equal(renamedOwnRepo([repo(`lab-${OLD}`)], who, gone).name, `lab-${OLD}`);
  // A classmate's they were added to fits the pattern just as well, and is theirs by nothing.
  assert.equal(renamedOwnRepo([repo("lab-bob")], who, gone), null, "a living account's");
  assert.equal(renamedOwnRepo([repo(`lab-${OLD}`)], who), null, "nobody has asked GitHub: not known");
  assert.equal(renamedOwnRepo([repo(`lab-${OLD}`), repo("lab-bob")], who, gone).name, `lab-${OLD}`, "their own beside a classmate's");
  assert.equal(renamedOwnRepo([repo(`lab-${OLD}`), repo("lab-gone2")], who, new Set([...gone, "gone2"])), null, "two: a name cannot say which");
  assert.equal(renamedOwnRepo([repo(`lab-${OLD}`, "Elsewhere")], who, gone), null, "another organization");
  assert.equal(renamedOwnRepo([repo("notes")], who, gone), null, "does not fit");
  assert.equal(renamedOwnRepo([repo(`lab-${NEW}`)], who, new Set([NEW.toLowerCase()])), null, "today's name is not a rename");
  assert.equal(renamedOwnRepo([repo(`lab-${OLD}`)], { ...who, pattern: "grp-{team_slug}" }, gone), null, "a team's name says nothing about a login");
  assert.equal(renamedOwnRepo([repo(`lab-${OLD}`)], { ...who, pattern: "lab" }, gone), null);
  assert.equal(renamedOwnRepo(undefined, who, gone), null);
  assert.equal(renamedOwnRepo([repo("x-Old-y")], { ...who, pattern: "x-{github_login}-y" }, new Set(["old"])).name, "x-Old-y");
  // Another assignment's repository of theirs, not this pattern for an account called `2-newnamepxl`.
  assert.equal(renamedOwnRepo([repo(`lab-2-${NEW}`)], who, new Set([`2-${NEW}`.toLowerCase()])), null);
});

test("one account moves, not one name: another account holding the old login keeps what is theirs", () => {
  const dir = control();
  put(dir, `acceptances/later/${OLD}.json`, { schema_version: 1, assignment_id: "later", github_login: OLD, github_id: 99, accepted_at: "2026-10-20T09:00:00Z", status: "accepted" });
  put(dir, `repositories/later/${OLD}.json`, { schema_version: 1, assignment_id: "later", github_login: OLD, repo_name: `Org/later-${OLD}`, repo_id: 9 });
  put(dir, "students/claims/99.json", { schema_version: 1, github_login: OLD, github_id: 99, email: "b@student.pxl.be" });
  moveLogin(dir, { from: OLD, to: NEW, githubId: 77 });
  assert.equal(read(dir, `acceptances/${ID}/${NEW}.json`).github_id, 77);
  assert.equal(read(dir, `acceptances/later/${OLD}.json`).github_id, 99);
  assert.equal(existsSync(join(dir, `acceptances/later/${NEW}.json`)), false);
  assert.equal(read(dir, "students/claims/99.json").github_login, OLD);
  // The other account has nothing to move, tonight or any other night: no swapping.
  assert.deepEqual(renamesFor(new Set([OLD]), OLD), []);
  rmSync(dir, { recursive: true, force: true });
});

test("a roster row that names another account is theirs", () => {
  const dir = control();
  put(dir, "students/roster.yml", stringify({ schema_version: 1, students: [{ student_number: "1", github_login: OLD, github_id: 99 }] }));
  moveLogin(dir, { from: OLD, to: NEW, githubId: 77 });
  assert.equal(parseYaml(readFileSync(join(dir, "students/roster.yml"), "utf8")).students[0].github_login, OLD);
  rmSync(dir, { recursive: true, force: true });
});

test("a chain of renames goes in the order that frees each name, and a name not yet free is no conflict", () => {
  assert.deepEqual(
    inMoveOrder([{ from: "c", to: "a" }, { from: "a", to: "b" }]),
    [{ from: "a", to: "b" }, { from: "c", to: "a" }],
  );
  assert.equal(inMoveOrder([{ from: "a", to: "b" }, { from: "b", to: "a" }]).length, 2, "a swap still ends");

  const dir = control();
  put(dir, `acceptances/${ID}/${NEW}.json`, { schema_version: 1, assignment_id: ID, github_login: NEW, github_id: 123, accepted_at: "2026-10-20T09:00:00Z", status: "accepted" });
  const { conflicts } = moveLogin(dir, { from: OLD, to: NEW, githubId: 77 });
  assert.deepEqual(conflicts.filter((c) => c.kind === "both"), [], "another account's record is not a duplicate of theirs");
  assert.equal(read(dir, `acceptances/${ID}/${OLD}.json`).github_id, 77);
  rmSync(dir, { recursive: true, force: true });
});

test("a write that lands under the old name after the move is moved too, and the roster is left to the lecturer", () => {
  const dir = control();
  moveLogin(dir, { from: OLD, to: NEW, githubId: 77 });
  // A finalize that read the record just before, a page open since yesterday.
  put(dir, `observations/${ID}/${OLD}/2026-10-03T09-00-00-000Z.json`, { schema_version: 1, github_login: OLD });
  put(dir, `grading/other/${OLD}.json`, { schema_version: 1, github_login: OLD });
  // And a lecturer who has since typed the old name, which is whoever holds it now.
  put(dir, "students/roster.yml", stringify({ schema_version: 1, students: [{ student_number: "9", github_login: OLD }] }));

  const held = accountsOnRecord(dir).get(77);
  assert.ok(held.has(OLD), "the ledger still says this account was known by it");
  const { changed } = moveLogin(dir, { from: OLD, to: NEW, githubId: 77 });
  assert.ok(changed.length > 0);
  assert.equal(read(dir, `observations/${ID}/${NEW}/2026-10-03T09-00-00-000Z.json`).github_login, NEW);
  assert.equal(read(dir, `grading/other/${NEW}.json`).github_login, NEW);
  assert.equal(parseYaml(readFileSync(join(dir, "students/roster.yml"), "utf8")).students[0].github_login, OLD);
  assert.deepEqual(read(dir, "students/renames/77.json").previous_logins, [OLD], "named once");
  rmSync(dir, { recursive: true, force: true });
});

test("an account known only from a claim or a roster row is followed too", () => {
  const dir = mkdtempSync(join(tmpdir(), "pxl-rename-"));
  put(dir, "students/claims/5.json", { schema_version: 1, github_login: "claimed", github_id: 5, email: "c@student.pxl.be" });
  put(dir, "students/roster.yml", stringify({ schema_version: 1, students: [{ student_number: "1", github_login: "rowed", github_id: 6 }] }));
  const accounts = accountsOnRecord(dir);
  assert.deepEqual([...accounts.get(5)], ["claimed"]);
  assert.deepEqual([...accounts.get(6)], ["rowed"]);
  moveLogin(dir, { from: "claimed", to: "claimed2", githubId: 5 });
  assert.equal(read(dir, "students/claims/5.json").github_login, "claimed2");
  rmSync(dir, { recursive: true, force: true });
});

test("a roster row spelled in another case is no rename, and asks nobody anything", () => {
  const dir = mkdtempSync(join(tmpdir(), "pxl-rename-"));
  put(dir, `acceptances/${ID}/Ann.json`, { github_login: "Ann", github_id: 5 });
  put(dir, "students/roster.yml", stringify({ schema_version: 1, students: [{ student_number: "1", github_login: "ann", github_id: 5 }] }));
  put(dir, "students/claims/5.json", { schema_version: 1, github_login: "ANN", github_id: 5, email: "a@student.pxl.be" });
  assert.deepEqual([...accountsOnRecord(dir).get(5)], ["Ann"]);
  rmSync(dir, { recursive: true, force: true });
});

test("a change of case leaves no name in the ledger, and a second run changes nothing", () => {
  const dir = control();
  const first = moveLogin(dir, { from: OLD, to: OLD.toLowerCase(), githubId: 77 });
  assert.ok(first.changed.length > 0);
  assert.equal(existsSync(join(dir, "students/renames/77.json")), false);
  assert.deepEqual(moveLogin(dir, { from: OLD, to: OLD.toLowerCase(), githubId: 77 }).changed, []);
  rmSync(dir, { recursive: true, force: true });
});

test("an override already under the new name is never overwritten", () => {
  const dir = control();
  put(dir, `overrides/${ID}/${NEW}.json`, { schema_version: 1, github_login: NEW, overrides: [{ type: "annotation", overridden_by: "lecturer2" }] });
  const { conflicts } = moveLogin(dir, { from: OLD, to: NEW, githubId: 77 });
  assert.deepEqual(conflicts.map((c) => [c.kind, c.assignment]), [["both", ID]]);
  assert.equal(read(dir, `overrides/${ID}/${NEW}.json`).overrides[0].overridden_by, "lecturer2");
  assert.equal(read(dir, `overrides/${ID}/${OLD}.json`).github_login, OLD);
  assert.equal(read(dir, `acceptances/${ID}/${OLD}.json`).github_id, 77, "the assignment moves whole or not at all");
  rmSync(dir, { recursive: true, force: true });
});

test("the ledger is left out for a decision", () => {
  const dir = control();
  moveLogin(dir, { from: OLD, to: NEW, githubId: 77 });
  assert.ok(accountsOnRecord(dir).get(77).has(OLD));
  assert.ok(!accountsOnRecord(dir, { ledger: false }).get(77).has(OLD));
  rmSync(dir, { recursive: true, force: true });
});

test("moveLogin refuses to move a name without saying whose it is", () => {
  const dir = control();
  assert.throws(() => moveLogin(dir, { from: OLD, to: NEW }), /account's id/);
  rmSync(dir, { recursive: true, force: true });
});

test("the nightly's commit stages exactly what a move can write, and never reports/", () => {
  const workflow = parseYaml(readFileSync(join(root, ".github/workflows/daily-activity.yml"), "utf8"));
  const step = workflow.jobs.collect.steps.find((s) => s.name === "Commit + push the moved records");
  const listed = /for dir in ([^;]+);/.exec(step.run)?.[1].trim().split(/\s+/);
  assert.deepEqual([...listed].sort(), [...MOVED_TREES].sort());
  assert.ok(!listed.includes("reports"));
  // And a move writes into nothing else.
  const dir = control();
  const { changed } = moveLogin(dir, { from: OLD, to: NEW, githubId: 77 });
  assert.deepEqual([...new Set(changed.map((p) => p.split("/")[0]))].filter((t) => !MOVED_TREES.includes(t)), []);
  rmSync(dir, { recursive: true, force: true });
});

test("the nightly tells the lecturer, and a notice about both names is one they are asked to act on", () => {
  assert.equal(parseNotice({ body: "### x renamed-accounts\n\n**Assignment:** renamed-accounts\n**Time:** 2026-10-30T00:00:00Z\n\nIt moved." }).kind, "info");
  assert.equal(parseNotice({ body: "### x renamed-accounts-conflict\n\n**Assignment:** renamed-accounts\n**Time:** 2026-10-30T00:00:00Z\n\nBoth." }).kind, "action");
  assert.equal(isOrgNotice({ assignmentId: "renamed-accounts" }), true);
});

// A guard over two lists is exhaustive, not comparative: a login field a new
// schema declares fails here until someone decides whether a rename follows it.
test("every field that holds a login is followed or left on purpose, with a reason", () => {
  const LOGIN_FIELD = /_by$|^login$|^logins$|^github_login$|^members$|assignees$/;
  const seen = new Set();
  const undecided = [];
  const walk = (schema, name) => {
    if (!schema || typeof schema !== "object") return;
    for (const [field, spec] of Object.entries(schema.properties ?? {})) {
      if (LOGIN_FIELD.test(field)) {
        const key = `${name}#${field}`;
        seen.add(key);
        if (!(key in LEFT_AS_WRITTEN) && !FOLLOWED_FIELDS.includes(field)) undecided.push(key);
      }
      walk(spec, name);
    }
    for (const key of ["items", "additionalProperties", "not"]) walk(schema[key], name);
    for (const key of ["allOf", "anyOf", "oneOf"]) for (const s of schema[key] ?? []) walk(s, name);
    for (const s of Object.values(schema.definitions ?? schema.$defs ?? {})) walk(s, name);
  };
  for (const file of readdirSync(join(root, "schemas"))) {
    if (file.endsWith(".schema.json")) walk(JSON.parse(readFileSync(join(root, "schemas", file), "utf8")), file.replace(".schema.json", ""));
  }
  assert.deepEqual(undecided, []);
  // And the table may not outlive a field.
  assert.deepEqual(Object.keys(LEFT_AS_WRITTEN).filter((k) => !seen.has(k)), []);
});
