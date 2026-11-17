// Has GitHub Actions EVER run on this broker?
//
// With Actions switched off for a broker or its organization, GitHub writes each
// acceptance issue and starts nothing at all - not even a skipped run - so the
// broker's run list stays empty for good. PXL-Digital-SNE-Werkplekleren's broker
// was published on 2026-09-09 and had run nothing by 2026-11-17, through 47
// requests from 30 students, while their page said GitHub was busy and offered
// to send it again (one student did, six times).
//
// Asked of the broker's own run list, which is public: any viewer can read it.
// Only a list read WHOLE that holds nothing is "never": a GitHub that is merely
// slow has run this broker before (measured on 600 acceptances since
// 2026-09-15: started in 15 s at the median, 99% within 35 s, and the three
// slower than three minutes were on a broker that had run before). A broker
// that ran once and then had Actions switched off is not this answer's to
// find; the settings checks find it (lib/audit.mjs `actionsAllowedFinding`).
//
// Pure, and isomorphic: the student page, System Health and the nightly ask it.

/** The broker's whole run list, any event, newest first, one entry is enough. */
export const brokerAllRunsPath = (org, broker) => `/repos/${org}/${broker}/actions/runs?per_page=1`;

/**
 * True when the broker's run list was read and is empty, false when it holds a
 * run, null when it could not be read (unread is not evidence).
 *
 * @param {{ status?: number, data?: { workflow_runs?: unknown, total_count?: unknown } }|null|undefined} res the answer to `brokerAllRunsPath`
 * @returns {boolean|null}
 */
export function brokerNeverRan(res) {
  if (!res || res.status !== 200) return null;
  const runs = res.data?.workflow_runs;
  const total = Number(res.data?.total_count);
  if (!Array.isArray(runs) || !Number.isFinite(total)) return null;
  return total === 0 && runs.length === 0;
}

/** How long a request waits before "never ran" is said about it. */
export const NEVER_RAN_AFTER_MS = 3 * 60_000;
