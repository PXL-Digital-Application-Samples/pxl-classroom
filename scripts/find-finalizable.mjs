import fs from 'node:fs';
import path from 'node:path';
import { loadYaml } from '../lib/yaml.mjs';
import { latestEffectiveDeadline } from '../lib/effective-deadline.mjs';
import { brokerClosedPath } from '../lib/control-layout.mjs';
import { inFinalizeScope } from '../lib/finalize-scope.mjs';
import { normalizeLogin } from '../lib/github-login.mjs';

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

/** True when this student's submission is archived and hash-verified. */
function isPreserved(controlDir, assignmentId, login) {
  const p = path.join(controlDir, 'observations', assignmentId, login, 'preservation.json');
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')).verified === true;
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
 * checked by hand with tests/live/broker-hygiene.mjs (REVIEW-TRACKER P2-41).
 */
const BROKER_CLOSE_RECORDED_SINCE = '2026-10-15T00:00:00Z';
function brokerOwed(controlDir, id, record, assignment) {
  let closed = null;
  try {
    closed = JSON.parse(fs.readFileSync(path.join(controlDir, brokerClosedPath(id)), 'utf8'));
  } catch {
    closed = null;
  }
  // REOPENED SINCE THE CLOSE (2026-10-16). Moving the deadline out of the past
  // publishes, which switches the broker on and puts its key back
  // (frontend/src/lib/publish.js `deadlineReopens`), while the record of the
  // earlier close still says closed - so nothing closed it at the new deadline
  // and the key stayed on a public repository. A close from before the
  // deadline in force now was a close for another deadline; where no close was
  // recorded, the lock stands in for it. Asked of the times alone, so a
  // reopen made any way at all is caught; closing an already closed broker
  // again is harmless (close-acceptance always acts and records).
  const deadlineAt = Date.parse(assignment?.deadline_at || '');
  const recordedClose = Date.parse(closed?.at || '');
  const lastClose = Number.isFinite(recordedClose) ? recordedClose : Date.parse(record?.locked_at || record?.executed_at || '');
  if (Number.isFinite(deadlineAt) && Number.isFinite(lastClose) && lastClose < deadlineAt) {
    return `broker-reopened (last closed ${new Date(lastClose).toISOString()}, before the deadline now in force)`;
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
  if (dueDeferred.length > 0) {
    return `extension-expired (${dueDeferred.length} student(s) deferred past their extension)`;
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
      ((r.snapshot_sha && !isPreserved(controlDir, id, r.github_login)) || (!r.snapshot_sha && r.snapshot_unread))
  );
  if (pending.length === 0) return brokerOwed(controlDir, id, record, assignment);

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
          if (!mayHaveStudents(assignment, controlDir, id)) continue;

          const deadline = new Date(assignment.deadline_at).getTime();
          const now = Date.now();

          if (deadline <= now) {
            const reason = finalizeReason(controlDir, lockdownsDir, id, assignment);
            if (reason) {
              console.error(`${id}: queueing finalize - ${reason}`);
              finalizable.push({ org, assignment_id: id });
            }
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
