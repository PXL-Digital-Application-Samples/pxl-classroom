// PXL Classroom - a student changed their GitHub username.
//
// GitHub keeps every collaborator grant, the student's clones keep pushing and
// the repository is untouched: the account is one thing, identified by its id,
// and the login is a label on it. This system keys almost everything on that
// label, so the day a course told its students to rename (Web Essentials,
// 2026-10-30, seven accounts in the first look) the records named nobody. GitHub
// answers `<old> is not a user`, and anyone may register the old name afterwards.
//
// `github_id` in an acceptance record is what the two have in common, so this
// module moves everything a login keys to the new one, in one working-tree
// change: both callers (scripts/follow-renames.mjs at night, acceptance/reserve.mjs
// the moment the student presses Accept) commit it whole, because half a move
// reads as two students.
//
// THE REPOSITORY KEEPS ITS NAME. Decided 2026-10-30: `repo_name` stays as it was
// and readers that build a name from the pattern fall back to the record
// (acceptance) or to what the student can reach (lib/repo-name.mjs).
//
// IT MOVES ONE ACCOUNT, NOT ONE NAME. GitHub frees a name, so the old login can
// belong to somebody else here by the time this runs: an assignment whose record
// under it holds another id is left alone. The acceptance side of that is
// `rejected:login-reused` in acceptance/accept.mjs.
//
// WHAT STAYS AS WRITTEN is listed with its reason in LEFT_AS_WRITTEN, and
// tests/login-rename.test.mjs fails on a login field in a schema that is in
// neither list.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { stringify as yamlStringify } from "yaml";
import { claimAttemptsPath, claimPath } from "./claim.mjs";
import { ASSIGNMENTS_DIR } from "./control-layout.mjs";
import { normalizeCohortEntry } from "./cohort.mjs";
import { sameLogin } from "./github-login.mjs";
import { ROSTER_PATH } from "./roster-entries.mjs";
import { parseYaml } from "./yaml.mjs";

/** Fields that hold a student's login, wherever they appear in a document moved here. */
export const FOLLOWED_FIELDS = Object.freeze(["github_login", "login", "members"]);

/**
 * Login fields a move does not rewrite, each with the reason. Keyed `schema#field`.
 */
export const LEFT_AS_WRITTEN = Object.freeze({
  // Who pressed something, then. Not the student a record is about, and nothing
  // decides anything from them.
  "grading-result#graded_by": "the lecturer who ran the grader, at the time",
  "grading-summary#graded_by": "the lecturer who ran it, at the time",
  "grading-summary#decided_by": "the lecturer who decided, at the time",
  "override#overridden_by": "the lecturer who granted it, at the time",
  "report#live_refreshed_by": "the lecturer who refreshed, at the time",
  "retired-manifest#deleted_by": "whoever confirmed the delete, at the time",
  "roster#promoted_by": "what promoted the row, at the time",
  "sync-record#synced_by": "the lecturer who ran the sync, at the time",
  "team#created_by": "who made the team, at the time",
  "team#seeded_by": "who seeded the team, at the time",
  "unlock-record#unlocked_by": "the lecturer who reopened it, at the time",
  "unlock-record#relocked_by": "the lecturer who locked it again, at the time",
  // What GitHub answered, then.
  "sync-record#issue_assignees": "who GitHub actually assigned on that day",
  // Not a student's login.
  "participating-orgs#login": "an organization's login",
  // Never moved: rebuilt from the sources by report.mjs, or written once to be kept.
  "report#github_login": "the report is rebuilt from what moved",
  "report#members": "the report is rebuilt from what moved",
  "download-manifest#login": "written on a lecturer's own machine, never in the control repository",
});

const ACCEPTANCES = "acceptances";

/** `students/renames/` - the ledger, one file per account that has been moved. */
const RENAMES_DIR = "students/renames";

/** `students/renames/<github_id>.json` - the logins an account has been known by here. */
export const renamesPath = (githubId) => `${RENAMES_DIR}/${githubId}.json`;

/** Directories with one `<assignment>/<login>.json` per student. */
const PER_STUDENT_FILES = Object.freeze([ACCEPTANCES, "repositories", "overrides", "grading"]);

/**
 * Every directory a move can write, so a commit stages these and never `reports/`,
 * which has one git writer (regenerate-dashboard.yml). The nightly's commit step
 * spells them, because a workflow cannot import: tests/login-rename.test.mjs holds it equal.
 */
export const MOVED_TREES = Object.freeze([
  ...PER_STUDENT_FILES, "observations", "lockdowns", "teams", "syncs", "students", ASSIGNMENTS_DIR,
]);

/** A login as GitHub accepts it: what a lookup is allowed to move a record to. */
const VALID_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

const listing = (dir) => {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
};
const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};
const writeJson = (path, doc) => writeFileSync(path, JSON.stringify(doc, null, 2) + "\n");
const assignmentDirs = (dataDir, tree) =>
  listing(join(dataDir, tree)).filter((e) => e.isDirectory()).map((e) => e.name);

/**
 * Every account the acceptance records name: github_id to the logins stored for
 * it, each spelled as the file spells it. An unreadable record names nobody.
 *
 * @param {string} dataDir
 * @param {{ledger?: boolean}} [opts]
 * @returns {Map<number, Set<string>>}
 */
export function accountsOnRecord(dataDir, { ledger = true } = {}) {
  const accounts = new Map();
  const hold = (id, login) => {
    if (!Number.isInteger(id) || id <= 0 || typeof login !== "string" || !login) return;
    if (!accounts.has(id)) accounts.set(id, new Set());
    accounts.get(id).add(login);
  };
  for (const assignment of assignmentDirs(dataDir, ACCEPTANCES)) {
    const dir = join(dataDir, ACCEPTANCES, assignment);
    for (const entry of listing(dir)) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      hold(readJson(join(dir, entry.name))?.github_id, entry.name.slice(0, -".json".length));
    }
  }
  // Not only an acceptance says whose a login is. A deleted assignment leaves the
  // claim and the roster row, and they name an account too. Only a FILE's name
  // has to match exactly: a row spelled `ann` for the account `Ann` is the same
  // login everywhere it is read, and counting it told a lecturer a student had
  // renamed, every night, who never had.
  const holdLoosely = (id, login) => {
    if (![...(accounts.get(id) ?? [])].some((held) => sameLogin(held, login))) hold(id, login);
  };
  for (const path of jsonFilesUnder(join(dataDir, "students", "claims"))) {
    const claim = readJson(path);
    holdLoosely(claim?.github_id, claim?.github_login);
  }
  try {
    const rows = parseYaml(readFileSync(join(dataDir, ROSTER_PATH), "utf8"))?.students;
    for (const row of Array.isArray(rows) ? rows : []) holdLoosely(row?.github_id, row?.github_login);
  } catch {
    // No roster, or one that does not parse: it names nobody.
  }
  // The ledger, so a write that landed under an old name after the move is moved
  // too: a finalize that read the record just before, a page open since yesterday.
  // Not for a decision: nothing there says the student has records under it, and
  // needing GitHub's answer on every Accept for good is a student refused over a
  // rate limit for having renamed once.
  if (ledger) {
    for (const path of jsonFilesUnder(join(dataDir, RENAMES_DIR))) {
      const doc = readJson(path);
      for (const login of Array.isArray(doc?.previous_logins) ? doc.previous_logins : []) hold(doc?.github_id, login);
    }
  }
  return accounts;
}

/**
 * The order to move in. `c` becoming `a` while `a` becomes `b` has to let `a` go
 * first, or the name reads as taken and a lecturer is asked to delete records.
 *
 * @template {{from: string, to: string}} T
 * @param {T[]} renames
 * @returns {T[]}
 */
export function inMoveOrder(renames) {
  const ordered = [];
  let rest = [...renames];
  while (rest.length) {
    const free = rest.filter((r) => !rest.some((other) => other !== r && sameLogin(other.from, r.to)));
    const next = free.length ? free : rest;
    ordered.push(...next);
    rest = rest.filter((r) => !next.includes(r));
  }
  return ordered;
}

/**
 * Which moves make the records agree with the account's login now. A case-only
 * change counts: a record's FILE is found by exact name, and on the runner's
 * filesystem `Ann.json` is not `ann.json`.
 *
 * @param {Set<string>|string[]} held logins on record for one account
 * @param {string} current the account's login now
 * @returns {Array<{from: string, to: string}>}
 */
export function renamesFor(held, current) {
  if (typeof current !== "string" || !VALID_LOGIN.test(current)) return [];
  return [...held].filter((login) => login !== current).map((from) => ({ from, to: current }));
}

function rewrite(value, from, to) {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const r = rewrite(item, from, to);
      changed ||= r.changed;
      return r.value;
    });
    return { value: changed ? next : value, changed };
  }
  if (!value || typeof value !== "object") return { value, changed: false };
  let changed = false;
  const next = {};
  for (const [key, field] of Object.entries(value)) {
    if ((key === "github_login" || key === "login") && typeof field === "string" && sameLogin(field, from) && field !== to) {
      next[key] = to;
      changed = true;
    } else if (key === "members" && Array.isArray(field) && field.some((m) => sameLogin(m, from) && m !== to)) {
      const members = [];
      for (const m of field) {
        const named = sameLogin(m, from) ? to : m;
        if (!members.some((held) => sameLogin(held, named))) members.push(named);
      }
      next[key] = members;
      changed = true;
    } else {
      const r = rewrite(field, from, to);
      next[key] = r.value;
      changed ||= r.changed;
    }
  }
  return { value: changed ? next : value, changed };
}

/** Rewrite one JSON document in place; true when it changed. */
function rewriteFile(path, from, to) {
  const doc = readJson(path);
  if (doc === null) return false;
  const r = rewrite(doc, from, to);
  if (r.changed) writeJson(path, r.value);
  return r.changed;
}

/** Every JSON file under `dir`, at any depth. */
function jsonFilesUnder(dir) {
  const out = [];
  for (const entry of listing(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsonFilesUnder(path));
    else if (entry.isFile() && entry.name.endsWith(".json")) out.push(path);
  }
  return out;
}

/** The name in `dir` that is this login, whatever its case. */
const nameIn = (dir, login, suffix = "") =>
  listing(dir).map((e) => e.name).find((name) => name.endsWith(suffix) && sameLogin(name.slice(0, name.length - suffix.length), login)) ?? null;

/**
 * Whose acceptance of this assignment sits under this login: "this-account",
 * "someone-else", or null when none does or it does not say.
 */
function acceptedBy(dataDir, assignment, login, githubId) {
  const dir = join(dataDir, ACCEPTANCES, assignment);
  const name = nameIn(dir, login, ".json");
  if (name === null) return null;
  const id = readJson(join(dir, name))?.github_id;
  if (!Number.isInteger(id)) return null;
  return id === githubId ? "this-account" : "someone-else";
}

/**
 * Does this assignment already hold the new login as well? Then the student
 * accepted under it before anything followed the rename, they have two records
 * and perhaps two repositories, and which is the real one is a person's call.
 */
function holdsBoth(dataDir, assignment, from, to) {
  // (`acceptedBy` says whether the second one is this account's at all.)
  if (sameLogin(from, to)) return false;
  return ["acceptances", "repositories"].some((tree) => {
    const dir = join(dataDir, tree, assignment);
    return nameIn(dir, from, ".json") !== null && nameIn(dir, to, ".json") !== null;
  });
}

const inRepo = (dataDir, path) => relative(dataDir, path).split(sep).join("/");

function moveFile(dataDir, fromPath, toPath, changed) {
  renameSync(fromPath, toPath);
  changed.push(inRepo(dataDir, fromPath), inRepo(dataDir, toPath));
}

/**
 * Move `<dir>/<from>/*` to `<dir>/<to>/*`. A name already there stays and the
 * moved copy goes: observations are named by when they were taken, so the two
 * are one look at one moment.
 */
function moveDirectory(dataDir, dir, from, to, changed) {
  const name = nameIn(dir, from);
  if (name === null || name === to) return;
  // Through a neighbour: `Ann` to `ann` is one directory on a filesystem that
  // ignores case, and a move into it would move each file onto itself.
  const interim = join(dir, `.moving-${to}`);
  renameSync(join(dir, name), interim);
  mkdirSync(join(dir, to), { recursive: true });
  for (const entry of listing(interim)) {
    const target = join(dir, to, entry.name);
    if (existsSync(target)) rmSync(join(interim, entry.name), { recursive: true, force: true });
    else renameSync(join(interim, entry.name), target);
    changed.push(inRepo(dataDir, join(dir, name, entry.name)), inRepo(dataDir, target));
  }
  rmdirSync(interim);
}

function followRoster(dataDir, from, to, githubId, changed, conflicts) {
  const path = join(dataDir, ROSTER_PATH);
  if (!existsSync(path)) return;
  let doc;
  try {
    doc = parseYaml(readFileSync(path, "utf8"));
  } catch {
    return;
  }
  const rows = Array.isArray(doc?.students) ? doc.students : [];
  const row = rows.find((s) => sameLogin(s?.github_login, from));
  if (!row) return;
  // A row that says whose it is, and it is somebody else's.
  if (Number.isInteger(row.github_id) && row.github_id !== githubId) return;
  if (!sameLogin(from, to) && rows.some((s) => sameLogin(s?.github_login, to))) {
    conflicts.push({ kind: "roster", detail: `the roster has a row for both @${from} and @${to}` });
    return;
  }
  // Spelled exactly, unlike every other comparison of a login: a row that already
  // says this changes nothing, and that is what stops a move reporting itself nightly.
  const before = JSON.stringify(row);
  row.github_login = to;
  row.github_id = githubId;
  if (JSON.stringify(row) === before) return;
  writeFileSync(path, yamlStringify(doc));
  changed.push(ROSTER_PATH);
}

function followCohorts(dataDir, from, to, changed) {
  const stale = normalizeCohortEntry(`login:${from}`);
  const fresh = normalizeCohortEntry(`login:${to}`);
  if (!stale || !fresh || stale === fresh) return;
  const dir = join(dataDir, ASSIGNMENTS_DIR);
  for (const entry of listing(dir)) {
    if (!entry.isFile() || !/\.ya?ml$/.test(entry.name)) continue;
    const path = join(dir, entry.name);
    let doc;
    try {
      doc = parseYaml(readFileSync(path, "utf8"));
    } catch {
      continue;
    }
    if (!Array.isArray(doc?.cohort) || !doc.cohort.some((c) => normalizeCohortEntry(c) === stale)) continue;
    doc.cohort = [...new Set(doc.cohort.map((c) => (normalizeCohortEntry(c) === stale ? fresh : c)))];
    writeFileSync(path, yamlStringify(doc));
    changed.push(`${ASSIGNMENTS_DIR}/${entry.name}`);
  }
}

/**
 * Move everything `from` keys to `to`, in the working tree. Touches nothing on
 * GitHub, and running it a second time changes nothing.
 *
 * An assignment that already holds `to` as well is left exactly as it is and
 * named in `conflicts`; the rest of the organization still moves.
 *
 * @param {string} dataDir the control repository's checkout
 * @param {{from: string, to: string, githubId: number}} rename
 * @returns {{changed: string[], conflicts: Array<{kind: string, assignment?: string, detail: string}>}}
 */
export function moveLogin(dataDir, { from, to, githubId }) {
  if (!Number.isInteger(githubId) || githubId <= 0) throw new TypeError(`moveLogin needs the account's id, got ${githubId}`);
  const changed = [];
  const conflicts = [];
  if (from === to) return { changed, conflicts };

  const assignments = new Set();
  for (const tree of [...PER_STUDENT_FILES, "observations", "lockdowns", "teams", "syncs"]) {
    for (const a of assignmentDirs(dataDir, tree)) assignments.add(a);
  }

  for (const assignment of assignments) {
    // ONLY THIS ACCOUNT'S. GitHub frees a name, so another account can hold the
    // old one here, in another assignment: its records are not this student's,
    // and moving them made the two swap every night.
    if (acceptedBy(dataDir, assignment, from, githubId) === "someone-else") continue;
    if (holdsBoth(dataDir, assignment, from, to)) {
      // The new name's record is another account's that has not moved away yet:
      // not a duplicate, and tomorrow's run finds the name free.
      if (acceptedBy(dataDir, assignment, to, githubId) === "someone-else") continue;
      conflicts.push({ kind: "both", assignment, detail: `${assignment} has records for both @${from} and @${to}` });
      continue;
    }
    const lockdowns = join(dataDir, "lockdowns", assignment);
    const perStudent = [...PER_STUDENT_FILES.map((tree) => join(dataDir, tree, assignment)), join(lockdowns, "unlocked")];
    // Never over a file that is there: `overrides/` and `grading/` can hold the new
    // name with no acceptance under it, and `Ann.json` beside `ann.json` is one
    // login to `holdsBoth` and two files to this file system.
    const occupied = perStudent.filter((dir) => {
      const name = nameIn(dir, from, ".json");
      return name !== null && name !== `${to}.json` && listing(dir).some((e) => e.name === `${to}.json`);
    });
    if (occupied.length) {
      conflicts.push({ kind: "both", assignment, detail: `${assignment} has records for both @${from} and @${to}` });
      continue;
    }
    for (const dir of perStudent) {
      const name = nameIn(dir, from, ".json");
      if (name !== null && name !== `${to}.json`) moveFile(dataDir, join(dir, name), join(dir, `${to}.json`), changed);
    }
    moveDirectory(dataDir, join(lockdowns, "relocked"), from, to, changed);
    moveDirectory(dataDir, join(dataDir, "observations", assignment), from, to, changed);

    // What now names the student: their own files, and the documents holding a
    // row per student. Never another student's observations.
    const documents = [
      ...PER_STUDENT_FILES.map((tree) => join(dataDir, tree, assignment, `${to}.json`)),
      ...jsonFilesUnder(join(dataDir, "observations", assignment, to)),
      ...jsonFilesUnder(lockdowns),
      ...jsonFilesUnder(join(dataDir, "teams", assignment)),
      ...jsonFilesUnder(join(dataDir, "grading", assignment)),
      ...jsonFilesUnder(join(dataDir, "syncs", assignment)),
    ];
    for (const path of new Set(documents)) {
      if (existsSync(path) && rewriteFile(path, from, to)) changed.push(inRepo(dataDir, path));
    }
  }

  for (const relative of [claimPath(githubId), claimAttemptsPath(githubId)]) {
    const path = join(dataDir, relative);
    if (existsSync(path) && rewriteFile(path, from, to)) changed.push(relative);
  }

  // A name in the ledger with no acceptance moved just now is a write that came in
  // late. The roster and the cohorts were moved the first time, and a row naming
  // that login today is a lecturer's, about whoever holds it. An acceptance moved
  // is a real rename, whatever the ledger says: someone can go back to a name.
  const ledgerPath = join(dataDir, renamesPath(githubId));
  const ledger = readJson(ledgerPath);
  const previous = Array.isArray(ledger?.previous_logins) ? ledger.previous_logins : [];
  const movedAcceptance = changed.some((p) => p.startsWith(`${ACCEPTANCES}/`));
  if (movedAcceptance || !previous.some((p) => sameLogin(p, from))) {
    followRoster(dataDir, from, to, githubId, changed, conflicts);
    followCohorts(dataDir, from, to, changed);
  }
  // A change of case is the same name, and no old name to follow.
  if (changed.length && !sameLogin(from, to) && !previous.includes(from)) {
    mkdirSync(join(dataDir, RENAMES_DIR), { recursive: true });
    writeJson(ledgerPath, { schema_version: 1, github_id: githubId, previous_logins: [...previous, from] });
    changed.push(renamesPath(githubId));
  }
  return { changed: [...new Set(changed)], conflicts };
}

/**
 * The login an account goes by now, or null when GitHub did not say - a deleted
 * account, a failed read. Never a guess: null moves nothing.
 *
 * @param {(method: string, path: string) => Promise<{ok?: boolean, status?: number, data?: any}>} request
 * @param {number} githubId
 * @returns {Promise<string|null>}
 */
export async function currentLogin(request, githubId) {
  return (await accountNow(request, githubId)).login;
}

/**
 * The same question for a caller to whom "no such account" and "no answer" are
 * different: a deleted account has no access left to take away, and a failed read
 * says nothing about whether they do.
 *
 * @param {(method: string, path: string) => Promise<{ok?: boolean, status?: number, data?: any}>} request
 * @param {number} githubId
 * @returns {Promise<{login: string|null, deleted: boolean}>}
 */
export async function accountNow(request, githubId) {
  if (!Number.isInteger(githubId) || githubId <= 0) return { login: null, deleted: false };
  let res;
  try {
    res = await request("GET", `/user/${githubId}`);
  } catch {
    return { login: null, deleted: false };
  }
  const login = res?.ok ? res.data?.login : null;
  return { login: typeof login === "string" && VALID_LOGIN.test(login) ? login : null, deleted: res?.status === 404 };
}
