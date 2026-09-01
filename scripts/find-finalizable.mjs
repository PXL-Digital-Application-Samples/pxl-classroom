import fs from 'node:fs';
import path from 'node:path';
import { loadYaml } from '../lib/yaml.mjs';
import { latestEffectiveDeadline } from '../lib/effective-deadline.mjs';

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
function finalizeReason(controlDir, lockdownsDir, id) {
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

  // Only students with a captured SHA can be preserved; a result without one
  // was already an error at lockdown time and retrying cannot fix it here.
  const pending = (record.results || []).filter(
    (r) => r.snapshot_sha && r.github_login && !isPreserved(controlDir, id, r.github_login)
  );
  if (pending.length === 0) return null;

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
          // A draft with a past deadline - a template someone started and left,
          // or one reverted after the fact - has no repositories, no lockdown
          // record, and therefore looked "not-finalized" forever. It queued a
          // four-step finalize matrix leg on a system whose whole point is
          // billing zero minutes when idle.
          if (assignment.state !== 'published' && assignment.state !== 'closed') continue;

          const deadline = new Date(assignment.deadline_at).getTime();
          const now = Date.now();

          if (deadline <= now) {
            const reason = finalizeReason(controlDir, lockdownsDir, id);
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
          if (assignment && (assignment.state === 'published' || assignment.state === 'closed')) {
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
  
  fs.writeFileSync(`active-${org}.json`, JSON.stringify({ active: activeCount }));
  console.log(JSON.stringify(finalizable));
}
main();
