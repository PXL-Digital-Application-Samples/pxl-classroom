import fs from 'node:fs';
import path from 'node:path';
import { loadYaml } from '../lib/yaml.mjs';

// A finalize is only done when every locked-down student's submission is also
// preserved. Lockdown alone used to be the idempotency key, so a run that
// locked down successfully and then failed in preserve was recorded as
// finished and never retried - the submissions were silently never archived.
//
// Retries are capped: a repo that can never be preserved (deleted, for
// instance) must not re-run a matrix leg every night forever. Past the ceiling
// the assignment is left alone and shows up in the report for a human.
const MAX_FINALIZE_ATTEMPTS = 3;

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
  
  // Find all active assignments (deadline in the future, or no deadline, and published)
  let activeCount = 0;
  if (fs.existsSync(assignmentsDir)) {
    const files = fs.readdirSync(assignmentsDir);
    for (const file of files) {
      if (file.endsWith('.yml') || file.endsWith('.yaml') || file.endsWith('.json')) {
        try {
          const assignment = await loadYaml(path.join(assignmentsDir, file));
          if (assignment && (assignment.state === 'published' || assignment.state === 'closed')) {
            if (!assignment.deadline_at || new Date(assignment.deadline_at).getTime() > Date.now()) {
              activeCount++;
            }
          }
        } catch(e) {}
      }
    }
  }
  
  fs.writeFileSync(`active-${org}.json`, JSON.stringify({ active: activeCount }));
  console.log(JSON.stringify(finalizable));
}
main();
