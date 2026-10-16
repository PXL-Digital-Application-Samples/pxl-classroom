// The assignment as the control repository holds it NOW.
//
// A job that waits and then acts reads its checkout minutes, or hours, before
// it acts - and a lecturer who moves a deadline does it in exactly those
// minutes. The finalize runs 5 to 10 minutes after the deadline with the
// sentinel on, so a deadline moved later after the stop was locked against and
// the broker switched off a minute after the save switched it on (review
// 2026-10-16, R7-1). Whatever acts on the deadline asks GitHub at the moment it
// acts, through this, and decides from the answer.
//
// Three answers, because they mean different things: `read` (here it is),
// `absent` (every spelling 404s - deleted, or never there) and `unread` (asked,
// and GitHub did not say). An unread answer is not "nothing changed".

import { parseYaml } from "./yaml.mjs";
import { assignmentPathsRead } from "./control-layout.mjs";
import { contentsText } from "./contents-text.mjs";

/**
 * @param {object} p
 * @param {(method: string, path: string) => Promise<{ok: boolean, status: number, data?: any}>} p.request
 *   lib/gh.mjs `gh`, or anything shaped like it
 * @param {string} p.org
 * @param {string} p.controlRepo
 * @param {string} p.assignmentId
 * @returns {Promise<{status: "read", assignment: any, path: string} | {status: "absent"} | {status: "unread", why: string}>}
 */
export async function readAssignmentNow({ request, org, controlRepo, assignmentId }) {
  for (const path of assignmentPathsRead(assignmentId)) {
    let res;
    try {
      res = await request("GET", `/repos/${org}/${controlRepo}/contents/${path}`);
    } catch (e) {
      return { status: "unread", why: e?.message || String(e) };
    }
    if (res?.status === 404) continue;
    if (!res?.ok || typeof res.data?.content !== "string") {
      return { status: "unread", why: `HTTP ${res?.status ?? "no answer"} for ${path}` };
    }
    try {
      const text = contentsText(res.data.content);
      const assignment = path.endsWith(".json") ? JSON.parse(text) : parseYaml(text);
      if (!assignment || typeof assignment !== "object") return { status: "unread", why: `${path} is not a document` };
      return { status: "read", assignment, path };
    } catch (e) {
      return { status: "unread", why: `${path} does not parse: ${e?.message || e}` };
    }
  }
  return { status: "absent" };
}

/**
 * Whether the assignment's own deadline is still ahead at `now`: what the hub's
 * acceptance window reads (acceptance/accept.mjs step 4), so what decides
 * whether acceptance may be switched off. No deadline, or one that does not
 * parse, is not ahead.
 */
export function deadlineAhead(assignment, now = Date.now()) {
  const at = Date.parse(assignment?.deadline_at ?? "");
  return Number.isFinite(at) && at > now;
}
