#!/usr/bin/env node
// PXL Classroom - the deadline sentinel.
//
// Waits for one instant, recording what it can see while it waits, and stops
// when that instant arrives. It does NOT lock anything itself: the workflow runs
// lockdown's Phase 1 (`STOP_ONLY=1`) immediately afterwards, so there is exactly
// one implementation of "stop writes" and the sentinel cannot drift from it.
//
// It polls; it does not sleep. A job idling for hours is defensible-but-grey
// under GitHub's acceptable use, and the useful work happens to be exactly what
// the design was missing:
//
//     GET /orgs/{org}/repos?sort=pushed&direction=desc&per_page=100
//
// One call returns `pushed_at` for a hundred repositories. Polling each repo
// individually would be 200 x 36 = 7,200 requests against a 5,000/hr limit -
// that is the trap, and `sort=pushed` avoids it. Roughly three calls an
// iteration, ~36 iterations over three hours: about a hundred requests to watch
// a whole cohort.
//
// `pushed_at` is GitHub's own server-side timestamp and a student cannot set it,
// which is the point. A five-minute push timeline through the critical window is
// what ends the "I committed before the deadline" conversation: at 21:55 your
// last push was 21:12; at 22:05 it was 22:31. The `?until=` fallback
// (ARCHITECTURE §11.2.2) cannot do that - it filters on the committer date, and
// the committer date comes from the student's machine.
//
// The target is re-read every iteration, so a lecturer moving the assignment
// deadline while the sentinel waits is honoured without restarting anything.
// Per-student extensions are not this script's business: it wakes at the
// assignment deadline and lockdown's own planning excludes anyone still
// extended (ARCHITECTURE §6.2.2).
//
// The GROUP is re-read every iteration too, and so are the repositories it
// watches. ASSIGNMENT_IDS is only where this sentinel starts: it was fixed when
// the job was queued, and real exams publish several groups with one deadline
// at different times. A later publish arms another job in the same concurrency
// group, and that job can only wait behind this one - GitHub keeps ONE pending
// run per group and the newest ARRIVAL takes the slot, so a cron firing that
// armed before the publish can replace the arm that knew about it. Measured on
// the testbed 2026-09-17: drill-20260917-1614 shared 16:35:00 with a running
// sentinel armed for drill-20260917-1609 alone, both arms that listed it were
// cancelled in the pending slot, and it was locked by the finalize 143s late.
// So every published assignment whose deadline is this sentinel's instant is
// stopped by this sentinel, whoever armed it (ARCHITECTURE §11.2.3).
//
// A watch also outlives its CREDENTIAL: an App installation token lives for at
// most an hour and the job waits for up to 4h45m. So a watch runs in PHASES -
// this script is invoked once per phase, polls while its token lives, and hands
// the next one what it saw (SENTINEL_PHASE_MS, SENTINEL_STATE_FILE). The
// timeline is written once, by the phase that reaches the instant, so one
// watch produces one document however many tokens it took.
//
// Every failure degrades to the nightly. A dropped cron firing, a killed job, a
// deadline moved out of reach: all of them fall through to the ordinary pass,
// which locks on the first nightly after the deadline. Nothing here can make
// things worse than not having run.

import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gh } from "../lib/gh.mjs";
import { parseYaml } from "../lib/yaml.mjs";
import { CONTROL_REPO } from "../lib/deployment.mjs";
import { ASSIGNMENTS_DIR, assignmentIdFromFile, overridePath, repositoriesDir } from "../lib/control-layout.mjs";
import { extensionFrom } from "../lib/effective-deadline.mjs";
import { contentsText } from "../lib/contents-text.mjs";
import { sentinelInstant, sentinelStoppedAt } from "../lib/sentinel-window.mjs";
import { COHORT_STATES } from "../lib/finalize-scope.mjs";

const env = (k, d) => process.env[k] ?? d;

/**
 * A positive finite number, or the default.
 *
 * Empty, absent, non-numeric and zero all mean "not configured" - every one of
 * them would otherwise become a 0 that the loop below treats as a real setting.
 */
export function positiveNumber(raw, fallback) {
  const n = Number(String(raw ?? "").trim());
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const cfg = {
  token: env("GITHUB_TOKEN"),
  org: env("ORG"),
  dataDir: env("DATA_DIR"),
  assignmentIds: (env("ASSIGNMENT_IDS", "") || "").split(",").map((s) => s.trim()).filter(Boolean),
  deadlineAt: env("DEADLINE_AT"),
  // The instant this sentinel's GROUP is keyed on. A later phase is handed it
  // separately, because the deadline it waits for may have moved while an
  // earlier phase watched, and the group it is responsible for is still the one
  // it was armed for - the concurrency key every other arm for that instant
  // queues behind. Absent means they are the same, which is the ordinary case.
  armedAt: env("SENTINEL_ARMED_AT") || env("DEADLINE_AT"),
  key: env("SENTINEL_KEY", "unkeyed"),
  // `positiveNumber`, not `Number(env(...))`. `env()` is `?? default`, so a
  // variable that is SET BUT EMPTY - the ordinary shape of an unset workflow
  // input threaded through `env:` - yields "" and `Number("")` is 0. A 0 ms
  // poll interval is a tight loop against the GitHub API from a job that runs
  // for hours; a 0 ms runtime exits before watching anything; 0 pages samples
  // nothing and reports it as a clean read. lib/group-config.mjs reasons about
  // exactly this and reaches the same conclusion for the same reason: a missing
  // key and an empty one must both mean the default.
  pollIntervalMs: positiveNumber(env("POLL_INTERVAL_MS"), 5 * 60_000),
  // Below the job's own timeout, so the sentinel writes its timeline and exits
  // cleanly rather than being killed with the evidence still in memory.
  maxRuntimeMs: positiveNumber(env("SENTINEL_MAX_RUNTIME_MS"), 4.75 * 3600_000),
  maxPages: positiveNumber(env("SENTINEL_MAX_PAGES"), 3),
  // How long THIS invocation may watch before handing over to the next one.
  // A GitHub App installation token lives for at most an hour and this job waits
  // for up to 4h45m, so one token cannot cover a whole watch: after it expires
  // every poll is a 401, the checkout's persisted credential is dead, and the
  // stop never runs - measured on PXL-Automation-II's test-pe4, run 35220220960,
  // which polled 401 for an hour and then failed at `git pull` AT the deadline.
  // Absent means "watch to the target", which is what a single-phase run does.
  phaseMs: positiveNumber(env("SENTINEL_PHASE_MS"), Infinity),
  // Where a phase leaves its evidence for the next one. The timeline is written
  // once, by whichever phase reaches the instant, so the push record spans every
  // phase rather than starting again with a fresh token.
  stateFile: env("SENTINEL_STATE_FILE", ""),
  runUrl: `${env("GITHUB_SERVER_URL", "https://github.com")}/${env("GITHUB_REPOSITORY", "_")}` +
          `/actions/runs/${env("GITHUB_RUN_ID", "0")}`,
  runId: env("GITHUB_RUN_ID", "0"),
  runAttempt: env("GITHUB_RUN_ATTEMPT", "1"),
  // An EXTENSION'S END this sentinel was armed for (R7-12, find-armable.mjs):
  // `{ assignment_id: [login, ...] }`. Those members follow those students'
  // own deadline, not the assignment's, which has passed.
  extensions: parseExtensions(env("SENTINEL_EXTENSIONS", "")),
};

/** `SENTINEL_EXTENSIONS` as a Map of id -> logins; anything malformed is none. */
export function parseExtensions(raw) {
  let doc = null;
  try { doc = raw ? JSON.parse(raw) : null; } catch { doc = null; }
  const out = new Map();
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return out;
  for (const [id, logins] of Object.entries(doc)) {
    if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(id) || !Array.isArray(logins)) continue;
    const ok = logins.filter((l) => typeof l === "string" && /^[A-Za-z0-9](-?[A-Za-z0-9]){0,38}$/.test(l));
    if (ok.length) out.set(id, ok);
  }
  return out;
}

const log = (msg) => console.log(`[sentinel] ${msg}`);
async function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `${name}=${value ?? ""}\n`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/;

function validate() {
  if (!cfg.token) return "GITHUB_TOKEN is required (App installation token)";
  if (!cfg.org || !NAME.test(cfg.org)) return `ORG="${cfg.org}" is not a valid GitHub name`;
  if (!cfg.dataDir) return "DATA_DIR is required";
  if (!cfg.assignmentIds.length) return "ASSIGNMENT_IDS is required";
  for (const id of cfg.assignmentIds) if (!SLUG.test(id)) return `ASSIGNMENT_ID="${id}" is not a valid slug`;
  // A phase that can hand over with nowhere to hand over TO would throw away
  // the samples it took and the assignments it found, silently.
  if (Number.isFinite(cfg.phaseMs) && !cfg.stateFile) return "SENTINEL_PHASE_MS needs SENTINEL_STATE_FILE to hand over to";
  const at = new Date(cfg.deadlineAt ?? "");
  if (Number.isNaN(at.getTime())) return `DEADLINE_AT="${cfg.deadlineAt}" is not a date`;
  if (Number.isNaN(new Date(cfg.armedAt ?? "").getTime())) return `SENTINEL_ARMED_AT="${cfg.armedAt}" is not a date`;
  return null;
}

/** The bare repository name a repository record names, or null. */
function repoNameOf(rec) {
  const name = rec?.repo_name?.split("/")?.[1] ?? rec?.repo_name;
  return typeof name === "string" && name ? name : null;
}

/**
 * The repositories the checkout already knows about: name -> assignment id.
 *
 * Only a starting point. The checkout is as old as this job, and a sentinel
 * armed at publish is running before anyone has accepted - `refreshWatched`
 * adds the rest while it waits.
 */
async function watchedRepos() {
  const byName = new Map();
  for (const id of cfg.assignmentIds) {
    const dir = join(cfg.dataDir, repositoriesDir(id));
    let files;
    try { files = await readdir(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      try {
        const name = repoNameOf(JSON.parse(await readFile(join(dir, f), "utf8")));
        if (name) byName.set(name, id);
      } catch { /* a malformed record is not worth failing a watch over */ }
    }
  }
  return byName;
}

// Blob text by sha. A blob is immutable, so an entry can never go stale, and a
// listing whose sha did not change since the last poll costs no second read.
const blobText = new Map();

/** A control-repo directory's files as the API sees them now. */
async function listControlDir(dir) {
  const res = await gh("GET", `/repos/${cfg.org}/${CONTROL_REPO}/contents/${dir}`);
  if (!res.ok || !Array.isArray(res.data)) return { ok: false, status: res.status, files: [] };
  const files = res.data.filter((e) => e?.type === "file" && typeof e.name === "string" && typeof e.sha === "string");
  return { ok: true, status: res.status, files };
}

/**
 * The extension in force for each member this sentinel watches for an
 * extension's end (R7-12), read again every poll as the deadlines are: the
 * latest end among its students. A read that fails keeps the end read last.
 *
 * WITHOUT AN END, THE INSTANT IT WAS ARMED FOR (review 2026-10-16, R7-25).
 * Withdrawn for all of them (404), or unread before any end was read, the
 * member followed the assignment's own deadline, hours past: the sentinel
 * fired at once and wrote a timeline of a stop AT that deadline, which
 * lockdown credits as the state there - and HEAD, with every push since, was
 * the submission. The instant this sentinel was armed for is a time it can
 * honestly stop at; the queue comes back for the student at the end they were
 * deferred to either way.
 *
 * @param {Map<string, Date>} previous
 * @returns {Promise<Map<string, Date>>}
 */
async function readExtensionDeadlines(previous) {
  const out = new Map();
  for (const [id, logins] of cfg.extensions) {
    let latest = null;
    let unread = false;
    for (const login of logins) {
      const res = await gh("GET", `/repos/${cfg.org}/${CONTROL_REPO}/contents/${overridePath(id, login)}`).catch(() => null);
      if (res?.status === 404) {
        // Gone because they renamed: the nightly moved the file to the new login
        // while this watches, and the extension still stands. Falling back would
        // stop the group at the original deadline. Only a name somebody holds can
        // have had its extension taken away.
        const named = await gh("GET", `/users/${encodeURIComponent(login)}`).catch(() => null);
        if (named?.status === 404) unread = true;
        continue;
      }
      if (!res?.ok || typeof res.data?.content !== "string") { unread = true; continue; }
      try {
        const ext = extensionFrom(JSON.parse(contentsText(res.data.content)));
        if (ext && (!latest || ext.at > latest)) latest = ext.at;
      } catch { unread = true; }
    }
    if (latest) out.set(id, latest);
    else if (unread && previous.has(id)) out.set(id, previous.get(id));
    else out.set(id, new Date(cfg.armedAt));
  }
  return out;
}

async function readBlob(sha) {
  if (blobText.has(sha)) return blobText.get(sha);
  const res = await gh("GET", `/repos/${cfg.org}/${CONTROL_REPO}/git/blobs/${sha}`);
  if (!res.ok || res.data?.encoding !== "base64" || typeof res.data.content !== "string") return null;
  const text = Buffer.from(res.data.content, "base64").toString("utf8");
  blobText.set(sha, text);
  return text;
}

/**
 * Every assignment in the organization as the control repo holds it now, or
 * null when the directory could not be listed.
 *
 * Over the API, not from the checkout, which is as old as this job. One listing
 * a poll plus a read for each document that changed since the last one, so
 * waiting costs a call rather than a call per assignment.
 *
 * @returns {Promise<Array<{id: string, doc: unknown}>|null>}
 */
async function readAssignments() {
  const listing = await listControlDir(ASSIGNMENTS_DIR);
  if (!listing.ok) {
    log(`${ASSIGNMENTS_DIR}/ unreadable (HTTP ${listing.status}) - keeping the group and deadlines last read`);
    return null;
  }
  const out = [];
  for (const file of listing.files) {
    const id = assignmentIdFromFile(file.name);
    if (!id) continue;
    // Listed but unreadable, or unparseable: `doc: null` - not a member by
    // its deadline, and not deleted either (goneMembers reads the ids).
    const text = await readBlob(file.sha);
    let doc = null;
    try {
      doc = text === null ? null : parseYaml(text);
    } catch { /* unparseable */ }
    out.push({ id, doc });
  }
  return out;
}

/**
 * The repositories the records name now: name -> assignment id. Also adds each
 * one to `watched`, which keeps every repository this watch has ever sampled so
 * its samples can be filed under their assignment.
 *
 * A sentinel read the records once, at job start, so one armed at publish
 * watched nothing for the whole exam: drill-20260917-1609 polled six times and
 * recorded no sample, because both students accepted after it began.
 *
 * What it samples is what the records name NOW, not everything it has seen: a
 * team left empty by a switch has its repository removed, no listing of the
 * org can find it again, and while it was still asked for every sample read as
 * a capped walk (review 2026-10-14). An assignment whose records could not all
 * be read keeps what it sampled last time (`previous`): a failed read is not a
 * deletion. A 404 IS an answer, while the control repository itself answers
 * (`controlReadable`, this poll's assignments listing): `repositories/<id>/`
 * does not exist before the first acceptance, nor once every record is gone,
 * and read as unreadable it kept the last set sampled for ever (TL-8).
 */
async function refreshWatched(watched, members, previous, { controlReadable = false } = {}) {
  const current = new Map();
  for (const id of members) {
    const listing = await listControlDir(repositoriesDir(id));
    const names = [];
    let whole = listing.ok || (listing.status === 404 && controlReadable);
    for (const file of listing.files) {
      if (!file.name.endsWith(".json")) continue;
      const text = await readBlob(file.sha);
      if (text === null) { whole = false; continue; }
      try {
        const name = repoNameOf(JSON.parse(text));
        if (name) names.push(name);
      } catch { /* a malformed record is not worth failing a watch over */ }
    }
    if (!whole) {
      for (const [name, of] of previous) if (of === id) current.set(name, id);
    }
    for (const name of names) {
      if (!watched.has(name)) watched.set(name, id);
      current.set(name, watched.get(name));
    }
  }
  return current;
}

/**
 * `pushed_at` for the watched repositories, newest push first.
 *
 * Paginated because a cohort can exceed a page, but capped: the ordering means
 * everything that has moved recently is on page one, and a repo that has not
 * been pushed to is not the one anyone will argue about.
 */
async function samplePushedAt(watched) {
  const seen = {};
  let complete = false;
  for (let page = 1; page <= cfg.maxPages; page++) {
    const res = await gh("GET", `/orgs/${cfg.org}/repos?sort=pushed&direction=desc&per_page=100&page=${page}`);
    if (!res.ok) return { ok: false, reason: `list repos HTTP ${res.status}`, pushed: seen };
    const list = Array.isArray(res.data) ? res.data : [];
    for (const repo of list) {
      if (watched.has(repo.name)) seen[repo.name] = repo.pushed_at;
    }
    // The org has no more repositories, or every watched one has been seen.
    // Either is a complete answer; running out of pages is not.
    if (list.length < 100 || Object.keys(seen).length >= watched.size) {
      complete = true;
      break;
    }
  }
  // A capped walk is not a clean read, and this sample is EVIDENCE - it settles
  // "I pushed before the deadline". A repository missing because the walk ran
  // out of pages is otherwise indistinguishable from one that was never pushed.
  // The ordering argument (everything recent is on page one) holds for a quiet
  // org and not for a busy one: the sort is over ALL of the org's repositories,
  // so several cohorts pushing near a shared deadline can push a watched repo
  // past the cap while it is being actively worked on.
  if (!complete) {
    return {
      ok: false,
      reason: `capped at ${cfg.maxPages} page(s): ${Object.keys(seen).length} of ${watched.size} watched repositories seen`,
      pushed: seen,
    };
  }
  return { ok: true, reason: null, pushed: seen };
}

/**
 * The assignments that stop at this sentinel's instant, as the control repo
 * stands now: every one a sentinel armed now would put in this group.
 *
 * Asked with the predicate find-armable arms with (`sentinelInstant`), so the
 * running watch and any arm queued behind it cannot disagree about who shares
 * the instant. An id that is not a slug is left out: it would reach the stop
 * step's shell loop, and no assignment the system wrote carries one.
 *
 * @param {Array<{id: string, doc: unknown}>} assignments
 * @param {string} armedAt the instant this sentinel was armed for
 * @param {Set<string>} [withRecords] ids whose repository records exist: an
 *   archived or draft assignment joins only then, as find-armable arms it
 * @returns {string[]} sorted
 */
export function assignmentsAtInstant(assignments, armedAt, withRecords = new Set()) {
  const instant = new Date(armedAt).toISOString();
  return assignments
    .filter(({ id, doc }) => SLUG.test(id) && sentinelInstant(/** @type {any} */ (doc), { hasRepositories: withRecords.has(id) }) === instant)
    .map(({ id }) => id)
    .sort();
}

/**
 * Each member's current deadline, so a lecturer moving one is honoured without
 * restarting the sentinel.
 *
 * PER ASSIGNMENT, not just the earliest. A sentinel watches every assignment
 * sharing one instant, and this used to return only the minimum - so extending
 * ONE of them did not move the minimum, the sentinel fired at the other's
 * instant, and the stop step locked the whole group. The extended cohort was
 * demoted to `pull` before its new deadline, while this file's own header
 * promised the move would be honoured.
 *
 * Not filtered on state: a member stays a member, and what it is owed is decided
 * by its deadline alone - exactly as it was when the group was only the armed
 * list.
 *
 * @param {string[]} members
 * @param {Array<{id: string, doc: unknown}>} assignments
 * @returns {{byId: Map<string, Date>, earliest: Date|null}}
 *   `byId` omits a member that is absent or has no readable deadline.
 */
export function memberDeadlines(members, assignments, extensionAt = new Map()) {
  const docs = new Map(assignments.map(({ id, doc }) => [id, doc]));
  const byId = new Map();
  let earliest = null;
  for (const id of members) {
    // A member this sentinel watches for an extension's end follows that
    // extension (R7-12); `extensionAt` holds it as last read.
    const raw = extensionAt.has(id) ? extensionAt.get(id)?.toISOString() : docs.get(id)?.deadline_at;
    if (!raw) continue;
    const at = new Date(raw);
    if (Number.isNaN(at.getTime())) continue;
    byId.set(id, at);
    if (!earliest || at < earliest) earliest = at;
  }
  return { byId, earliest };
}

/** The handover an earlier phase left, or null - the first phase is handed nothing. */
async function readState() {
  if (!cfg.stateFile) return null;
  try {
    return JSON.parse(await readFile(cfg.stateFile, "utf8"));
  } catch {
    // Absent is the ordinary case, and unreadable costs the earlier samples and
    // nothing else. Neither is worth failing a watch over.
    return null;
  }
}

async function writeState(state) {
  if (!cfg.stateFile) return;
  await writeFile(cfg.stateFile, JSON.stringify(handoverState(state), null, 2) + "\n");
}

/**
 * What one phase hands to the next: the evidence so far, and the group as it
 * stood, so a fresh token continues a watch rather than starting one.
 *
 * A phase that hands over writes NO timeline - it has not reached the instant,
 * and a timeline per phase would split the push record of one watch across two
 * documents with the same key.
 */
export function handoverState({ polls, members, joinedAt, samples }) {
  return {
    schema_version: 1,
    polls,
    members: members.map((id) => ({ id, ...(joinedAt.get(id) ? { joined_at: joinedAt.get(id) } : {}) })),
    samples,
  };
}

/**
 * Take up a handover: the members that joined while the previous phase watched,
 * and the samples it took.
 *
 * The armed list is still the start of the group - the state only adds to it,
 * so a corrupt or absent file costs the earlier evidence and nothing else.
 */
export function resumeFrom(state, armedIds) {
  const members = [...armedIds];
  const joinedAt = new Map();
  for (const m of Array.isArray(state?.members) ? state.members : []) {
    if (typeof m?.id !== "string" || !SLUG.test(m.id)) continue;
    if (!members.includes(m.id)) members.push(m.id);
    if (m.joined_at) joinedAt.set(m.id, m.joined_at);
  }
  return {
    members,
    joinedAt,
    samples: Array.isArray(state?.samples) ? state.samples : [],
    polls: Number.isInteger(state?.polls) && state.polls > 0 ? state.polls : 0,
  };
}

/**
 * The file this sentinel writes an assignment's timeline to.
 *
 * `sentinel-<key>.json`, unless an earlier sentinel of the same group already
 * wrote it. Arming is not coordinated - a publish, an edit and the cron each arm
 * one - so a second job for an instant is ordinary, and it queues behind the
 * first and reaches the instant after it has passed. It wrote the SAME path:
 * on 2026-09-17 the queued one replaced drill-20260917-1609's timeline from the
 * sentinel that stopped it (six polls) with its own single poll taken after the
 * deadline. Every sentinel keeps its own record now; lockdown.mjs reads every
 * `sentinel-*.json` and credits the earliest that fired.
 *
 * @param {string} key
 * @param {string[]} existing file names already in `lockdowns/<id>/`
 * @param {{runId: string, runAttempt: string}} run
 */
export function timelineFileName(key, existing, { runId, runAttempt }) {
  const first = `sentinel-${key}.json`;
  return existing.includes(first) ? `sentinel-${key}-${runId}-${runAttempt}.json` : first;
}

/**
 * Whether ANOTHER sentinel of this same group already stopped this assignment,
 * and the stop held.
 *
 * Arming is not coordinated, so two jobs for one instant are the normal case,
 * not an accident: the SPA arms before a publish and publish-assignment.yml arms
 * again after it, and the 4-hourly cron's 4.5h window arms a deadline in the
 * overlap twice. The duplicate queues in the same concurrency group, starts once
 * the first has finished, and reaches the instant immediately - where it used to
 * stop the cohort again, commit a second timeline and dispatch a SECOND
 * finalize. Measured 2026-09-27: every drill instant that night ran finalize
 * twice, and the second one collided with the dashboard regeneration the first
 * had triggered.
 *
 * Only a stop that is CONFIRMED counts (`confirmedOnly`, the same judge
 * lockdown.mjs uses to credit the instant): a first sentinel whose stop failed,
 * or that died with `stop: pending`, is exactly what the duplicate is still
 * there to cover. Only this group's key, so a stop at an earlier instant (a
 * deadline since moved and reopened) is not mistaken for this one. Never this
 * run's own timeline.
 *
 * @param {string} key
 * @param {Array<{name: string, doc: any}>} timelines `lockdowns/<id>/sentinel-*.json`, parsed
 * @param {string} runUrl this run's `observer_run`
 */
export function stoppedByAnotherSentinel(key, timelines, runUrl) {
  const others = (timelines || []).filter(({ name, doc }) =>
    (name === `sentinel-${key}.json` || name.startsWith(`sentinel-${key}-`)) && doc?.observer_run !== runUrl);
  return sentinelStoppedAt(others.map((t) => t.doc), { confirmedOnly: true }) !== null;
}

async function readTimelines(id) {
  const dir = join(cfg.dataDir, "lockdowns", id);
  const names = (await readdir(dir).catch(() => [])).filter((n) => /^sentinel-.*\.json$/.test(n));
  const out = [];
  for (const name of names) {
    try {
      out.push({ name, doc: JSON.parse(await readFile(join(dir, name), "utf8")) });
    } catch {
      // An unreadable timeline is not evidence of a stop.
    }
  }
  return out;
}

/**
 * The assignments this sentinel may stop, at the instant it fired.
 *
 * An assignment is due when its own current deadline has passed. One whose
 * deadline could not be re-read counts as due: the armed instant is the best
 * evidence available and it has arrived, which is also what the sentinel did
 * before this existed. The only assignment now skipped is one we positively
 * READ a later deadline for - which is exactly the lecturer-moved-it case.
 */
export function dueAssignments(assignmentIds, byId, now, gone = new Set()) {
  return assignmentIds.filter((id) => {
    // DELETED WHILE WATCHED (review 2026-10-16, R7-17): positively absent from
    // a listing that was read, so not "could not be re-read". Counted due, the
    // stop ran lockdown on an assignment that no longer exists and went red.
    if (gone.has(id)) return false;
    const at = byId.get(id);
    return !at || at.getTime() <= now;
  });
}

/**
 * The members a readable listing of `assignments/` no longer holds: deleted
 * while this sentinel watched. Null `assignments` (unread) says nothing, and
 * leaves the previous answer standing; one that comes back is a member again.
 *
 * @param {string[]} members
 * @param {Array<{id: string}>|null} assignments
 * @param {Set<string>} previous
 */
export function goneMembers(members, assignments, previous = new Set()) {
  if (!assignments) return previous;
  const present = new Set(assignments.map((a) => a.id));
  return new Set(members.filter((id) => !present.has(id)));
}

async function main() {
  const bad = validate();
  if (bad) {
    console.error(`[sentinel] ${bad}`);
    await setOutput("outcome", "fail:validation");
    process.exit(1);
  }

  const startedAt = Date.now();
  let target = new Date(cfg.deadlineAt);
  // The group: what this sentinel was armed with, then every assignment that
  // reached its instant after that. Once a member, always a member - one moved
  // away again is treated exactly like an armed one moved away. An earlier
  // phase of this same watch may already have found some of them.
  const resumed = resumeFrom(await readState(), cfg.assignmentIds);
  const { members, joinedAt } = resumed;
  const watched = await watchedRepos();
  // What the records name as of the last poll; `watched` keeps everything ever
  // sampled, for filing samples under their assignment.
  let sampling = new Map(watched);
  log(`watching ${watched.size} repository/repositories across ${members.join(", ")} until ${target.toISOString()}`);
  if (resumed.polls) log(`resuming a handover: ${resumed.polls} poll(s) and ${resumed.samples.length} sample(s) already taken`);

  const samples = resumed.samples;
  let polls = resumed.polls;
  let outcome = "fired";
  // Each member's own deadline as last read. Empty until the first poll, so a
  // member never read counts as due against the armed instant. Kept, not
  // cleared, when a later read fails: a deadline positively read as moved
  // minutes ago is better evidence than the armed instant.
  let latestByAssignment = new Map();
  // Members a readable listing no longer holds: deleted while watched (R7-17).
  let gone = new Set();
  // The extension ends this sentinel follows, as last read (R7-12).
  let extensionAt = new Map();

  // Read the group, then sample, then look at the clock. A sentinel armed close
  // to the instant still records where the cohort stood when it fired, which is
  // the evidence the whole job exists to produce - and an empty timeline would
  // be worse than a short one.
  while (true) {
    const assignments = await readAssignments();
    let moved = null;
    if (assignments) {
      // An archived or draft assignment at this instant joins where students
      // accepted (R6-22): asked only of those, so the ordinary poll costs
      // nothing more.
      const withRecords = new Set();
      const instant = new Date(cfg.armedAt).getTime();
      for (const { id, doc } of assignments) {
        const d = /** @type {any} */ (doc);
        if (members.includes(id) || COHORT_STATES.includes(d?.state) || Date.parse(d?.deadline_at ?? "") !== instant) continue;
        const listing = await listControlDir(repositoriesDir(id));
        if (listing.ok && listing.files.some((f) => f.name.endsWith(".json"))) withRecords.add(id);
      }
      for (const id of assignmentsAtInstant(assignments, cfg.armedAt, withRecords)) {
        if (members.includes(id)) continue;
        members.push(id);
        joinedAt.set(id, new Date().toISOString());
        log(`${id} shares this instant and was not armed with this sentinel - it joins, and is stopped with the rest`);
      }
      extensionAt = cfg.extensions.size ? await readExtensionDeadlines(extensionAt) : extensionAt;
      const live = memberDeadlines(members, assignments, extensionAt);
      latestByAssignment = live.byId;
      moved = live.earliest;
      const wasGone = gone;
      gone = goneMembers(members, assignments, gone);
      for (const id of gone) if (!wasGone.has(id)) log(`${id} was deleted while watched - it is not stopped, and no timeline is written for it`);
    }
    sampling = await refreshWatched(watched, members, sampling, { controlReadable: assignments !== null });

    if (sampling.size) {
      const sample = await samplePushedAt(sampling);
      polls++;
      samples.push({ observed_at: new Date().toISOString(), pushed_at: sample.pushed, error: sample.reason ?? undefined });
      if (!sample.ok) log(`poll ${polls}: ${sample.reason}`);
    } else {
      polls++;
    }

    if (moved && moved.getTime() !== target.getTime()) {
      log(`deadline moved: ${target.toISOString()} -> ${moved.toISOString()}`);
      target = moved;
      if (target.getTime() > startedAt + cfg.maxRuntimeMs) {
        outcome = "gave-up:moved";
        log("the new deadline is beyond this sentinel's reach - a later cron firing will re-arm");
        break;
      }
    }

    const now = Date.now();
    if (now >= target.getTime()) break;

    if (now - startedAt >= cfg.phaseMs) {
      // This phase's token is about to expire. The next one mints a fresh
      // token and carries on from here; nothing is stopped and no timeline is
      // written, because the instant has not arrived.
      outcome = "handover";
      log(`this phase is out of token - handing over ${samples.length} sample(s) before ${target.toISOString()}`);
      break;
    }

    if (now - startedAt >= cfg.maxRuntimeMs) {
      // Out of runway. The nightly finalize still locks and reconstructs; the
      // only thing lost is the precision this job exists for.
      outcome = "gave-up:runtime";
      log(`out of runtime before ${target.toISOString()} - the nightly finalize will handle it`);
      break;
    }

    await sleep(Math.min(cfg.pollIntervalMs, target.getTime() - now));
  }

  let due = outcome === "fired" ? dueAssignments(members, latestByAssignment, Date.now(), gone) : [];
  const skipped = members.filter((id) => !due.includes(id) && !gone.has(id));
  if (outcome === "fired" && skipped.length) {
    log(`not due at this instant, so not stopped: ${skipped.join(", ")} (deadline moved out)`);
  }

  // A duplicate of this group that finds the stop already held does nothing:
  // no second stop, no second timeline, no second finalize. It still stops any
  // member the other sentinel did not (stoppedByAnotherSentinel).
  const alreadyStopped = [];
  if (outcome === "fired") {
    for (const id of due) {
      if (stoppedByAnotherSentinel(cfg.key, await readTimelines(id), cfg.runUrl)) alreadyStopped.push(id);
    }
    if (alreadyStopped.length) {
      log(`already stopped by another sentinel for this instant, left alone: ${alreadyStopped.join(", ")}`);
      due = due.filter((id) => !alreadyStopped.includes(id));
      if (!due.length) outcome = "already-stopped";
    }
  }

  // A handover writes no timeline: this watch has not reached its instant, and
  // one document per phase would split a single watch's push record in two.
  if (outcome === "handover") {
    await writeState({ polls, members, joinedAt, samples });
    await setOutput("outcome", outcome);
    await setOutput("polls", polls);
    await setOutput("target_at", target.toISOString());
    await setOutput("fired", "false");
    await setOutput("due_assignment_ids", "");
    log(`handover after ${polls} poll(s); target ${target.toISOString()}`);
    return;
  }

  // Persist the timeline before anything else can fail. It sits beside the
  // lockdown record it explains; nothing globs that directory. Not for a member
  // another sentinel already stopped: its record is that sentinel's, and one
  // more written after the instant says nothing about the instant.
  // Nor for one deleted while watched (R7-17): writing it re-created the
  // directory the delete removed, and the timeline commit pushed it back.
  const recorded = outcome === "already-stopped" ? [] : members.filter((m) => !alreadyStopped.includes(m) && !gone.has(m));
  for (const id of recorded) {
    const dir = join(cfg.dataDir, "lockdowns", id);
    await mkdir(dir, { recursive: true });
    const joined = joinedAt.get(id);
    const doc = {
      schema_version: 1,
      assignment_id: id,
      organization: cfg.org,
      // THIS assignment's deadline as last read, not the group's earliest. The
      // two differ exactly when a lecturer moved one of them, and recording the
      // group's instant against an assignment that no longer has it is the
      // record claiming a freeze at a time that was never its deadline.
      deadline_at: (latestByAssignment.get(id) ?? target).toISOString(),
      armed_for: cfg.armedAt,
      // Present only for an assignment this sentinel was NOT armed with: when it
      // was found sharing the instant. Nobody was watching its repositories
      // before then, so the samples start there rather than recording an empty
      // map that would read as "nothing was pushed".
      ...(joined ? { joined_at: joined } : {}),
      outcome,
      // Whether the stop step covers this assignment. A sentinel can fire for
      // the group while one member has been extended past it.
      due: outcome === "fired" ? due.includes(id) : false,
      // Whether the stop HELD is not known yet: this is written before the stop
      // step runs, and `scripts/mark-sentinel-stop.mjs` sets `done` or `failed`
      // after it (lib/sentinel-window.mjs `sentinelStoppedAt`).
      ...(outcome === "fired" && due.includes(id) ? { stop: "pending" } : {}),
      polls,
      observer_run: cfg.runUrl,
      // GitHub's own push timestamps through the critical window. A student can
      // set a commit date; they cannot set these.
      samples: samples.filter((s) => !joined || s.observed_at >= joined).map((s) => ({
        observed_at: s.observed_at,
        error: s.error,
        pushed_at: Object.fromEntries(
          Object.entries(s.pushed_at).filter(([name]) => watched.get(name) === id)
        ),
      })),
    };
    const existing = await readdir(dir).catch(() => []);
    await writeFile(join(dir, timelineFileName(cfg.key, existing, cfg)), JSON.stringify(doc, null, 2) + "\n");
  }

  await setOutput("outcome", outcome);
  await setOutput("polls", polls);
  await setOutput("target_at", target.toISOString());
  // Only a sentinel that actually reached its instant should trigger the stop.
  await setOutput("fired", outcome === "fired" ? "true" : "false");
  // The assignments the stop step may lock. The workflow iterates THIS, not the
  // matrix's list: an assignment extended past this instant is still watched
  // and still gets a timeline, but must not be stopped - and one that joined the
  // instant after arming is in no matrix at all.
  await setOutput("due_assignment_ids", due.join(","));
  log(`${outcome} after ${polls} poll(s); target ${target.toISOString()}; due: ${due.join(", ") || "none"}`);
}

// Only when run as the CLI the workflow invokes, so a test can import
// `positiveNumber` without the module validating its environment and exiting on
// it. Same idiom as pages/scan.mjs; the existing tests spawn this file as a
// process, which is what proves the guard still lets the entry point run.
if (process.argv[1] && process.argv[1].endsWith("deadline-sentinel.mjs")) {
  main().catch(async (e) => {
    console.error(`[sentinel] ${e.stack || e.message}`);
    await setOutput("outcome", "fail:exception");
    await setOutput("fired", "false");
    process.exit(1);
  });
}
