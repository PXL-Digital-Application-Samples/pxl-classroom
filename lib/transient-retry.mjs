// PXL Classroom - asking GitHub again when it answered "not now".
//
// 2026-10-06, during a GitHub incident: one 504 for one organization's
// assignment index failed the Pages deploy for EVERY organization
// (scripts/fetch-pages-data.mjs fails whole, on purpose, rather than publish
// with an organization missing), and a lecturer who had just published watched
// "Publishing…" spin for half an hour. A gateway timeout is GitHub saying try
// again; the next deploy succeeded a quarter of an hour later. So a request
// that met one is asked again, twice, before the failure stands.
//
// Only answers that mean "not now": 502, 503, 504, and a connection that
// dropped (fetch rejects with a TypeError and no status). A 404, a 401, a 500
// or a 422 is an answer, and asking again would only delay the failure that
// should be read.

export const TRANSIENT_STATUSES = Object.freeze(new Set([502, 503, 504]));

/** Is this error GitHub (or the network) saying "not now"? */
export function isTransient(error) {
  if (TRANSIENT_STATUSES.has(error?.status)) return true;
  return error?.status === undefined && error?.name === "TypeError";
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `attempt` and, while it fails transiently, wait and run it again - once
 * per entry in `delays`. Any other failure, or the last one, is thrown as is.
 *
 * @template T
 * @param {() => Promise<T>} attempt
 * @param {{delays?: number[], sleep?: (ms: number) => Promise<void>, onRetry?: (error: any, waitMs: number) => void}} [opts]
 * @returns {Promise<T>}
 */
export async function withTransientRetry(attempt, { delays = [2000, 5000], sleep = wait, onRetry = () => {} } = {}) {
  for (let i = 0; ; i++) {
    try {
      return await attempt();
    } catch (error) {
      if (!isTransient(error) || i >= delays.length) throw error;
      onRetry(error, delays[i]);
      await sleep(delays[i]);
    }
  }
}
