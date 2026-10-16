import fs from 'node:fs';
import path from 'node:path';
import { loadYaml } from '../lib/yaml.mjs';
import { effectiveDeadlineFor, latestEffectiveDeadline } from '../lib/effective-deadline.mjs';
import { lockedSinceReopen, reopenEndsAt } from '../lib/lock-rows.mjs';
import { brokerClosedPath, brokerReopenedPath } from '../lib/control-layout.mjs';
import { FINALIZE_ANY_STATE_FROM, everPublished, inFinalizeScope } from '../lib/finalize-scope.mjs';
import { normalizeLogin } from '../lib/github-login.mjs';
import { preservesSnapshot } from '../lib/preservation-status.mjs';

// A finalize is only done when every locked-down student's submission is also
// preserved. Lockdown alone used to be the idempotency key, so a run that
// locked down successfully and then failed in preserve was recorded as
// finished and never retried - the submissions were silently never archived.
//
// Retries are capped: a repo that can never be preserved (deleted, for
// instance) must not re-run a matrix leg every night forever. Past the ceiling
// the assignment is left alone and shows up in the report for a human.
//
// Deadline extensions are the other reason an assignment comes back. lockdown
// leaves a student with a running extension alone and records `deferred_until`
// against them; this script re-queues the assignment once that instant passes,
// and keeps the assignment counted as active until then so daily-activity.yml
// does not disable itself while somebody is still working.
const MAX_FINALIZE_ATTEMPTS = 3;

/** Every override document for an assignment. Unreadable files are skipped. */
function readOverrides(controlDir, assignmentId) {
  const dir = path.join(controlDir, 'overrides', assignmentId);
  let files;
  try { files = fs.readdirSync(dir); } catch { return []; }
  const docs = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      docs.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
    } catch (e) {
      console.error(`Unreadable override ${assignmentId}/${f}: ${e.message}`);
    }
  }
  return docs;
}

/** Whether any student of this assignment has a repository record. */
function hasRepositories(controlDir, assignmentId) {
  try {
    return fs.readdirSync(path.join(controlDir, 'repositories', assignmentId)).some((f) => f.endsWith('.json'));
  } catch {
    return false;
  }
}

/**
 * Whether students can be in this assignment: lib/finalize-scope.mjs decides,
 * for the finalize queue and the active count below alike (review 2026-10-14,
 * P2-25: the queue asked it and the count did not, so an exam archived before
 * its deadline was not active, the nightly could switch itself off, and the
 * deadline it would have locked never came) - and since R6-4 for the report
 * rebuild too, with an archived or draft assignment in scope only for a
 * deadline from the day that widening shipped.
 */
function mayHaveStudents(assignment, controlDir, assignmentId) {
  return inFinalizeScope(assignment, { hasRepositories: hasRepositories(controlDir, assignmentId) });
}

/**
 * Logins whose repository record was written after the lock and whom the lock
 * record has no row for. A deleted repository's record is older than the lock,
 * and a Retry of a student the lock already holds rewrites a record that has a
 * row, so neither is counted.
 */
function joinedAfterLock(controlDir, id, record) {
  const lockedAt = Date.parse(record?.locked_at || record?.executed_at || '');
  if (!Number.isFinite(lockedAt)) return [];
  const rows = new Set((record.results || []).map((r) => normalizeLogin(r?.github_login)).filter(Boolean));
  let files;
  try { files = fs.readdirSync(path.join(controlDir, 'repositories', id)); } catch { return []; }
  const late = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(controlDir, 'repositories', id, f), 'utf8'));
      const login = normalizeLogin(rec?.github_login);
      const created = Date.parse(rec?.created_at || '');
      if (login && !rows.has(login) && Number.isFinite(created) && created > lockedAt) late.push(login);
    } catch {
      // An unreadable record is the collector's to report; it cannot be told late or not.
    }
  }
  return late;
}

/** Every JSON document in a directory of the control repository, by file name. Unreadable ones are null. */
function readJsonDir(dir) {
  let files;
  try { files = fs.readdirSync(dir); } catch { return []; }
  return files.filter((f) => f.endsWith('.json')).map((f) => {
    try { return { name: f, doc: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }; } catch { return { name: f, doc: null }; }
  });
}

/**
 * Students a lecturer reopened with time on it whose time has run out, and whom
 * no lock since the reopen holds (review 2026-10-16, R7-20). lockdown defers a
 * reopened student to the deadline the reopen ends at and locks them again
 * after it (`planTargets`, the same lib/lock-rows.mjs predicates) - but only a
 * pass made between the reopen and that deadline writes the deferral row that
 * `extension-expired` comes back for, and nothing queued one: a deadline ahead
 * is not past, and once it was, nothing was owed. So the student was graded on
 * the old snapshot, or open for good. Matched over the team, as lockdown does:
 * one repository, one lock. An unreadable reopen record has no end, as there.
 */
function reopensEnded(controlDir, id, assignment, record) {
  const reopens = readJsonDir(path.join(controlDir, 'lockdowns', id, 'unlocked'));
  if (!reopens.length) return [];
  const overrides = readOverrides(controlDir, id);
  const teams = readJsonDir(path.join(controlDir, 'teams', id)).map((t) => t.doc?.members).filter(Array.isArray);
  const repos = new Map(readJsonDir(path.join(controlDir, 'repositories', id))
    .map((r) => [normalizeLogin(r.doc?.github_login), r.doc]).filter(([l]) => l));
  const now = Date.now();
  const owed = [];
  for (const { name, doc } of reopens) {
    const login = normalizeLogin(name.slice(0, -'.json'.length));
    if (!login || !doc) continue;
    const own = repos.get(login)?.members;
    const members = [...new Set([login, ...(Array.isArray(own) ? own : []),
      ...teams.filter((m) => m.some((x) => normalizeLogin(x) === login)).flat()].map(normalizeLogin).filter(Boolean))];
    const { deadline } = effectiveDeadlineFor(assignment, login, { overrides, team: { members } });
    const ends = reopenEndsAt(doc, deadline);
    if (!ends || ends.getTime() > now) continue;
    const rows = (record.results || []).filter((r) => members.includes(normalizeLogin(r?.github_login)));
    if (rows.some((r) => lockedSinceReopen(r, doc))) continue;
    owed.push(login);
  }
  return owed;
}

/** True when this student's submission - THIS snapshot (R7-3) - is archived and hash-verified. */
function isPreserved(controlDir, assignmentId, login, snapshotSha) {
  const p = path.join(controlDir, 'observations', assignmentId, login, 'preservation.json');
  try {
    return preservesSnapshot(JSON.parse(fs.readFileSync(p, 'utf8')), snapshotSha);
  } catch {
    return false;
  }
}

/**
 * Why this past-deadline assignment still needs a finalize run, or null when
 * it is complete / exhausted.
 */
/**
 * A BROKER LEFT OPEN IS OWED WORK (review 2026-10-14, P2-34). Closing
 * acceptance and taking the broker App's key off the public broker is step 5 of
 * the finalize, under continue-on-error so it never undoes a lock - and a
 * failure there was recorded nowhere, so no pass ever tried again and the key
 * stayed. scripts/close-acceptance.mjs writes `broker-closed.json` beside the
 * lock record; a pass is queued while it says not done, up to the same ceiling,
 * or while it is missing from a record written since it exists. An older
 * finished assignment is not re-run for it: every finalize since 2026-09-03
 * closed its broker (the nightly logs, read 2026-10-14: 93 closed, one broker
 * already deleted); the few finalized before the close step existed were
 * checked by hand with tests/live/broker-hygiene.mjs; the two it cannot read
 * are OPEN-ITEMS §15.
 */
const BROKER_CLOSE_RECORDED_SINCE = '2026-10-15T00:00:00Z';
function brokerOwed(controlDir, id, record) {
  // A broker a publish switched on again is the close-only entry's to close
  // and to retry (R7-4): owing a whole finalize for it is what was reverted.
  if (fs.existsSync(path.join(controlDir, brokerReopenedPath(id)))) return null;
  let closed = null;
  try {
    closed = JSON.parse(fs.readFileSync(path.join(controlDir, brokerClosedPath(id)), 'utf8'));
  } catch {
    closed = null;
  }
  if (closed?.closed === true && closed?.key_removed === true) return null;
  if (!closed) {
    const lockedAt = Date.parse(record?.locked_at || '');
    if (!Number.isFinite(lockedAt) || lockedAt < Date.parse(BROKER_CLOSE_RECORDED_SINCE)) return null;
    return 'broker-not-closed (no record of closing it)';
  }
  const attempts = Number(closed.attempts) || 1;
  if (attempts >= MAX_FINALIZE_ATTEMPTS) {
    console.error(`${id}: the broker is still not closed after ${attempts} attempts - not retrying. Close it by hand, then remove lockdowns/${id}/broker-closed.json.`);
    return null;
  }
  return `broker-not-closed (attempt ${attempts + 1})`;
}

/**
 * A BROKER OWED A CLOSE AND NOTHING ELSE (review 2026-10-16, R7-4 and R7-11).
 * Queued as `close_only`, which the nightly's finalize leg reads to run the
 * broker close and its commit alone - never the collect, the lock, the
 * archive or the scores, because a whole finalize queued by a rule of times
 * reached every assignment ever moved after its lock (`4ee1236`, reverted).
 *
 *  - A broker a publish switched on (`broker-reopened.json`, written by every
 *    publish since R7-21, scripts/mark-broker-reopened.mjs), once the
 *    deadline in force has passed: closed unless a close since did it.
 *  - The broker of an assignment archived or sent back to draft with nobody
 *    in it, which the finalize never reaches (`inFinalizeScope`): ever
 *    published, its deadline passed and from FINALIZE_ANY_STATE_FROM on - the
 *    same cutoff, so last year's courses are not swept - and not closed.
 *
 * Counted by the close record's `attempts`, up to the same ceiling.
 */
function closeOnlyReason(controlDir, id, assignment, { inScope }) {
  const read = (p) => {
    try { return JSON.parse(fs.readFileSync(path.join(controlDir, p), 'utf8')); } catch { return null; }
  };
  const closed = read(brokerClosedPath(id));
  const done = closed?.closed === true && closed?.key_removed === true;
  const ceiling = () => {
    if ((Number(closed?.attempts) || 0) < MAX_FINALIZE_ATTEMPTS) return false;
    console.error(`${id}: the broker is still not closed after ${closed.attempts} attempts - not retrying. Close it by hand, then remove lockdowns/${id}/broker-closed.json.`);
    return true;
  };
  const reopened = read(brokerReopenedPath(id));
  const reopenedAt = Date.parse(reopened?.reopened_at ?? '');
  if (Number.isFinite(reopenedAt)) {
    const closedSince = Date.parse(closed?.at ?? '') > reopenedAt;
    if (closedSince && done) return null;
    if (closedSince && ceiling()) return null;
    // Every publish marks it (R7-21), so a mark is "on since", not "on again".
    if (closedSince) return `broker-not-closed (attempt ${(Number(closed.attempts) || 1) + 1})`;
    return `broker-on (switched on by a publish at ${reopened.reopened_at}, not closed since)`;
  }
  if (inScope || done || !everPublished(assignment)) return null;
  const deadline = Date.parse(assignment?.deadline_at ?? '');
  if (!(deadline >= Date.parse(FINALIZE_ANY_STATE_FROM))) return null;
  if (closed && ceiling()) return null;
  return `broker-not-closed (${assignment.state ?? 'no state'}, nobody accepted)`;
}

function finalizeReason(controlDir, lockdownsDir, id, assignment) {
  const lockdownFile = path.join(lockdownsDir, id, 'lockdown-record.json');
  if (!fs.existsSync(lockdownFile)) return 'not-finalized';

  let record;
  try {
    record = JSON.parse(fs.readFileSync(lockdownFile, 'utf8'));
  } catch (e) {
    // An unreadable record cannot prove the work is done; treat it as pending
    // rather than assuming success.
    console.error(`Unreadable lockdown record for ${id}: ${e.message}`);
    return 'unreadable-lockdown-record';
  }

  // A student whose extension was still running was skipped by lockdown, not
  // failed - they have no snapshot and never will until their own deadline
  // passes. Once it has, the assignment needs another finalize pass for them.
  //
  // This is new work rather than a retry of failed work, so the attempts
  // ceiling below does not apply to it - and it cannot loop, because the second
  // pass either captures a snapshot or records an error, and neither is
  // deferred any more.
  const dueDeferred = (record.results || []).filter(
    (r) => r.github_login && !r.snapshot_sha && r.deferred_until &&
      new Date(r.deferred_until).getTime() <= Date.now()
  );
  // ...and one a lecturer reopened with time on it (R7-3), deferred the same
  // way to the deadline that reopen ends at, and locked again now.
  if (dueDeferred.length > 0) {
    const reopened = dueDeferred.filter((r) => r.reopened_at).length;
    return `extension-expired (${dueDeferred.length} student(s) deferred past their extension` +
      (reopened ? `, ${reopened} of them reopened until it` : "") + ")";
  }
  // ...and one reopened with time on it that no pass deferred (R7-20).
  const ended = reopensEnded(controlDir, id, assignment, record);
  if (ended.length > 0) {
    return `reopen-ended (${ended.length} student(s) reopened until a deadline that has passed, not locked again yet)`;
  }

  // A STUDENT WHO GOT A REPOSITORY AFTER THE LOCK (review 2026-10-15, R6-5): a
  // lecturer's Retry for a student with an extension, after the cohort's lock
  // ran. No row names them, so nothing above queued a pass, and their
  // repository was never locked, archived or graded. New work, so no ceiling:
  // the pass writes their row (locked, or deferred until their own deadline),
  // or moves `locked_at` past their record.
  const joinedLate = joinedAfterLock(controlDir, id, record);
  if (joinedLate.length > 0) {
    return `joined-after-lock (${joinedLate.length} student(s) with a repository and no row)`;
  }

  // A captured SHA not yet archived is owed a preservation; a snapshot that
  // could not be READ (`snapshot_unread`, lockdown.mjs) is owed a second read,
  // which only another lockdown pass makes (review 2026-10-14 - it used to be
  // treated as an error retrying could not fix, and the student was never
  // preserved). A reopened student is owed nothing.
  const pending = (record.results || []).filter(
    (r) => r.github_login && !r.reopened_at &&
      ((r.snapshot_sha && !isPreserved(controlDir, id, r.github_login, r.snapshot_sha)) || (!r.snapshot_sha && r.snapshot_unread))
  );
  if (pending.length === 0) return brokerOwed(controlDir, id, record);

  const attempts = record.finalize_attempts ?? 1;
  if (attempts >= MAX_FINALIZE_ATTEMPTS) {
    console.error(
      `${id}: ${pending.length} unpreserved submission(s) but ${attempts} finalize attempts ` +
      `already made (ceiling ${MAX_FINALIZE_ATTEMPTS}) - not retrying. ` +
      `Investigate, then reset finalize_attempts in lockdowns/${id}/lockdown-record.json to retry.`
    );
    return null;
  }
  return `preservation-incomplete (${pending.length} pending, attempt ${attempts + 1})`;
}

async function main() {
  const controlDir = process.argv[2] || '.';
  const org = process.argv[3];
  const assignmentsDir = path.join(controlDir, 'assignments');
  const lockdownsDir = path.join(controlDir, 'lockdowns');
  const finalizable = [];

  if (fs.existsSync(assignmentsDir)) {
    const files = fs.readdirSync(assignmentsDir);
    for (const file of files) {
      if (file.endsWith('.yml') || file.endsWith('.yaml') || file.endsWith('.json')) {
        const id = file.replace(/\.(yml|yaml|json)$/, '');
        try {
          const assignment = await loadYaml(path.join(assignmentsDir, file));
          if (!assignment || !assignment.deadline_at) continue;

          // Only an assignment students could actually have accepted into.
          // A draft with a past deadline - a template someone started and left
          // - has no repositories, no lockdown record, and therefore looked
          // "not-finalized" forever. It queued a four-step finalize matrix leg
          // on a system whose whole point is billing zero minutes when idle.
          //
          // BUT A STATE IS NOT EVIDENCE OF THAT (review 2026-10-14). Archived
          // (or sent back to draft) after students accepted and before the
          // nightly, an exam was never locked, never archived, and its broker
          // kept the App's private key on a public repository for good. The
          // evidence is the repository records: a published or closed one
          // queues as before, any other only when students have repositories.
          const inScope = mayHaveStudents(assignment, controlDir, id);
          const deadline = new Date(assignment.deadline_at).getTime();
          const now = Date.now();
          // Not `deadline > now`: a deadline that does not parse is NaN, and is
          // no deadline that has passed.
          if (!(deadline <= now)) continue;

          // Out of scope, an assignment may still owe its broker a close (R7-11).
          if (!inScope) {
            const close = closeOnlyReason(controlDir, id, assignment, { inScope });
            if (close) {
              console.error(`${id}: queueing the broker close alone - ${close}`);
              finalizable.push({ org, assignment_id: id, close_only: true });
            }
            continue;
          }

          const reason = finalizeReason(controlDir, lockdownsDir, id, assignment);
          if (reason) {
            console.error(`${id}: queueing finalize - ${reason}`);
            finalizable.push({ org, assignment_id: id });
            continue;
          }
          // Nothing else owed: a broker switched on again still is (R7-4).
          const close = closeOnlyReason(controlDir, id, assignment, { inScope });
          if (close) {
            console.error(`${id}: queueing the broker close alone - ${close}`);
            finalizable.push({ org, assignment_id: id, close_only: true });
          }
        } catch (e) {
          console.error(`Error processing ${file}:`, e.message);
        }
      }
    }
  }
  
  // Find all active assignments (deadline in the future, or no deadline, and
  // published). activeCount == 0 is what disables daily-activity.yml, so this
  // has to count an assignment whose own deadline has passed but which still
  // has a student working under a granted extension - otherwise the nightly
  // switches itself off, stops observing that student, and never comes back to
  // finalize them.
  let activeCount = 0;
  if (fs.existsSync(assignmentsDir)) {
    const files = fs.readdirSync(assignmentsDir);
    for (const file of files) {
      if (file.endsWith('.yml') || file.endsWith('.yaml') || file.endsWith('.json')) {
        const id = file.replace(/\.(yml|yaml|json)$/, '');
        try {
          const assignment = await loadYaml(path.join(assignmentsDir, file));
          if (assignment && mayHaveStudents(assignment, controlDir, id)) {
            const latest = latestEffectiveDeadline(assignment, readOverrides(controlDir, id));
            if (!latest || latest.getTime() > Date.now()) {
              activeCount++;
            }
          }
        } catch (e) {
          // COUNTS AS ACTIVE, and says so. This was a silent `catch(e) {}`, so an
          // assignment whose YAML would not parse was simply not counted - and
          // `activeCount === 0` is what makes daily-activity.yml DISABLE ITSELF.
          // One unreadable file could therefore switch off the nightly that
          // enforces every deadline, from a read failure. Unreadable is not
          // evidence that nothing is active; the cost of being wrong the other
          // way is one cron firing that finds nothing to do.
          console.error(`${id}: unreadable, counting it as active - ${e.message}`);
          activeCount++;
        }
      }
    }
  }
  
  // OWED WORK KEEPS THE NIGHTLY ON (review 2026-10-14). An assignment queued
  // for a finalize pass tonight - a preservation that partly failed, a
  // snapshot not read, an extension expiring - counts as active, so the
  // nightly cannot switch itself off on a run whose finalize then succeeds
  // only partly: `partial` exits 0, and the retry it owed would never run.
  // The night after, when nothing is owed, it counts nothing and switches off.
  activeCount += finalizable.length;
  fs.writeFileSync(`active-${org}.json`, JSON.stringify({ active: activeCount }));
  console.log(JSON.stringify(finalizable));
}
main();
