// "What the system did for this assignment", in plain words, for the
// Organization page's Course activity (BETA-UX.md, 2026-10-02).
//
// Built from the course's own records, never from GitHub run lists: most hub
// runs cannot be tied to one organization, and a lecturer asking "did it work
// for my course" is asking about students, not runs. The inputs are what the
// SPA already reads elsewhere - the dashboard entry (reports/dashboard.json), the
// deadline's lock record (lockdowns/<id>/lockdown-record.json) and the count of
// students turned away (lib/rejection-notice.mjs).
//
// Pure and isomorphic.

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * @param {object} args
 * @param {{title?: string, state?: string, total_students?: number, accepted?: number,
 *          on_time?: number, late?: number, no_submission?: number,
 *          deadline_at?: string, generated_at?: string}|null} args.entry
 * @param {{locked_at?: string, executed_at?: string, locked_count?: number,
 *          error_count?: number}|null} [args.lock] the lock record, if the deadline's lock has run
 * @param {number} [args.refused] distinct students turned away
 * @param {Date} [args.now]
 * @returns {{phrases: string[], checkedAt: string|null, attention: boolean}}
 */
export function activitySummary({ entry, lock = null, refused = 0, now = new Date() }) {
  const phrases = [];
  if (!entry) return { phrases: ["no report yet"], checkedAt: null, attention: false };
  if (entry.state === "draft") return { phrases: ["draft - students cannot accept yet"], checkedAt: null, attention: false };

  const accepted = entry.accepted ?? 0;
  const total = entry.total_students ?? 0;
  phrases.push(total > accepted ? `${accepted} of ${total} accepted` : plural(accepted, "accepted", "accepted"));
  if (refused > 0) phrases.push(plural(refused, "student turned away", "students turned away"));

  const deadline = Date.parse(entry.deadline_at ?? "");
  const past = Number.isFinite(deadline) && deadline <= now.getTime();
  let attention = false;
  if (past) {
    if (lock) {
      const locked = lock.locked_count ?? 0;
      phrases.push(`locked at the deadline (${plural(locked, "repository", "repositories")})`);
      if ((lock.error_count ?? 0) > 0) {
        phrases.push(`${plural(lock.error_count, "repository", "repositories")} could not be locked`);
        attention = true;
      }
    } else {
      phrases.push("deadline passed, not locked yet - tonight's run does it");
    }
    phrases.push(`${entry.on_time ?? 0} on time, ${entry.late ?? 0} late, ${entry.no_submission ?? 0} without a submission`);
  } else if ((entry.on_time ?? 0) + (entry.late ?? 0) > 0) {
    phrases.push(`${plural(entry.on_time ?? 0, "has", "have")} handed in work`);
  }

  return { phrases, checkedAt: entry.generated_at ?? null, attention };
}
