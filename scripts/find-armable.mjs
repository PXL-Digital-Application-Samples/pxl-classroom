// PXL Classroom - which deadlines are close enough to watch.
//
// A repository ruleset has no time conditions (ARCHITECTURE §11.2.1), so
// stopping writes *at* the deadline needs something running at that instant.
// GitHub offers no date-aware primitive and `cron` cannot be rescheduled
// dynamically, so a fixed outer cron arms a sentinel for every deadline close
// enough to reach - and the sentinel waits.
//
// Two numbers decide the shape:
//
//   * a GitHub-hosted job runs for at most 6 hours, so a sentinel must start
//     within 6h of the deadline;
//   * the outer cron fires every 4 hours.
//
// The window is 4.5h: wider than the cron interval, so every deadline gets a
// firing that can reach it, and narrower than the job limit with margin to
// spare. Cron drift therefore decides only whether a sentinel *arms in time*,
// never when it acts - a 16:00 firing that lands at 16:25 still sees a 20:00
// deadline 3h35m out, still arms, and still acts at 20:00:00.
//
// Sentinels are keyed on (org, deadline instant), not on assignment: three
// assignments sharing a 22:00 deadline share one job.
//
// Nothing here can make things worse than the nightly. A dropped firing, a
// killed job or an overrun cap all fall through to the ordinary pass, which
// locks on the first nightly run after the deadline and reconstructs the
// submission with ?until= (ARCHITECTURE §11.2.2).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadYaml } from '../lib/yaml.mjs';

const ARM_WINDOW_MS = Number(process.env.ARM_WINDOW_MS ?? 4.5 * 3600_000);

// PER ORG, not per firing. This script runs once per org (the workflow's `arm`
// job is a matrix over orgs), so this bounds one org's list and nothing more -
// `aggregate-armable` then flattens all of them into a single `watch` matrix.
// With 22 participating orgs the ceiling here is 22 x 8, which is well past
// the 60 concurrent jobs a Team plan allows.
//
// The global bound is therefore `max-parallel` on the `watch` matrix, not this
// number. This one stays as a per-org sanity limit: one org with dozens of
// deadlines in a single 4.5h window is a mistake worth not amplifying, and
// what it drops is logged rather than applied silently.
const MAX_SENTINELS = Number(process.env.MAX_SENTINELS ?? 8);

/** `2026-09-10T22:00:00.000Z` -> `20260910T220000Z`, safe in a concurrency group. */
export function sentinelKey(iso) {
  return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

export function planSentinels(assignments, { now = Date.now(), window = ARM_WINDOW_MS, max = MAX_SENTINELS, org } = {}) {
  const byInstant = new Map();

  for (const { id, doc } of assignments) {
    // Only an assignment students could have accepted into. A draft has no
    // repositories to lock.
    if (doc?.state !== 'published' && doc?.state !== 'closed') continue;
    const at = doc?.deadline_at ? new Date(doc.deadline_at) : null;
    if (!at || Number.isNaN(at.getTime())) continue;

    const ms = at.getTime();
    // Already past: the nightly finalize owns it, and a sentinel would only
    // duplicate work that is no longer time-critical.
    if (ms <= now || ms > now + window) continue;

    const iso = at.toISOString();
    if (!byInstant.has(iso)) byInstant.set(iso, []);
    byInstant.get(iso).push(id);
  }

  const all = [...byInstant.entries()]
    .map(([deadline_at, ids]) => ({
      org,
      key: sentinelKey(deadline_at),
      deadline_at,
      assignment_ids: ids.sort(),
    }))
    .sort((a, b) => new Date(a.deadline_at) - new Date(b.deadline_at));

  return { armed: all.slice(0, max), dropped: all.slice(max) };
}

async function readAssignments(controlDir) {
  const dir = path.join(controlDir, 'assignments');
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const file of fs.readdirSync(dir)) {
    if (!/\.(ya?ml|json)$/.test(file)) continue;
    const id = file.replace(/\.(ya?ml|json)$/, '');
    try {
      out.push({ id, doc: await loadYaml(path.join(dir, file)) });
    } catch (e) {
      console.error(`Unreadable assignment ${file}: ${e.message}`);
    }
  }
  return out;
}

async function main() {
  const controlDir = process.argv[2] || '.';
  const org = process.argv[3];

  const { armed, dropped } = planSentinels(await readAssignments(controlDir), { org });

  for (const d of dropped) {
    console.error(
      `${org}: NOT arming a sentinel for ${d.deadline_at} (${d.assignment_ids.join(', ')}) - ` +
      `cap of ${MAX_SENTINELS} reached. The nightly finalize will handle it.`
    );
  }
  for (const a of armed) {
    console.error(`${org}: arming a sentinel for ${a.deadline_at} (${a.assignment_ids.join(', ')})`);
  }
  console.log(JSON.stringify(armed));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();
