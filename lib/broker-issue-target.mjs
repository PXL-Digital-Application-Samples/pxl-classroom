// PXL Classroom - where a dispatched broker issue actually is, and whether the
// hub is allowed to touch it.
//
// `client_payload.broker_repo` is a FULL NAME - `owner/repo` - because that is
// what `acceptance/broker-workflow.yml` puts on the wire. Two hub scripts read
// it, and until 2026-09-03 only one of them knew that.
//
// WHAT WENT WRONG. `comment-acceptance-outcome.mjs` composed
// `/repos/${ORG}/${BROKER_REPO}/issues/${N}/comments`, which resolves to
// `/repos/PXL-Automation-II/PXL-Automation-II/broker-test-pe3/issues/2/comments`
// and 404s. Every single time. The whole point of that script - telling a
// rejected student WHY, on the one surface both sides can read - had therefore
// never worked once, and because the failure logged `[ok] could not comment`
// and exited 0 under `continue-on-error`, nothing anywhere was red. Found by
// reading the run log of a rejection that had already been diagnosed by hand.
//
// AND THE HALF THAT MATTERS MORE. `read-team-payload.mjs` had the parse right
// and carried a second check beside it - "the broker must belong to the org the
// dispatch claims to be for, or a forged dispatch could make the hub read an
// issue from anywhere". The comment script had neither. It runs with the hub's
// App token, which holds `issues: write` on EVERY participating org, so a
// dispatch naming `broker_repo: other-org/some-repo` would have had the hub
// post into a repository that has nothing to do with the acceptance. The read
// side was guarded and the write side was not, which is the wrong way round.
//
// So both live here, together, and neither script spells them out again.
//
// Pure and dependency-free: no fetch, no fs, no Node builtins.

const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const ORG_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const ISSUE_NUMBER = /^[1-9][0-9]{0,9}$/;

/**
 * Resolve and authorise a dispatched broker issue.
 *
 * @param {{brokerRepo?: string, issueNumber?: string|number, org?: string}} payload
 * @returns {{ok: true, owner: string, name: string, issue: string, fullName: string}
 *          | {ok: false, reason: string}}
 *   `reason` is a sentence naming the offending value, ready to log. Callers
 *   decide whether that is fatal - for the team read it degrades to an empty
 *   payload, for the courtesy comment it is a warning - but NONE of them may
 *   proceed to an API call on a rejected target.
 */
export function resolveBrokerIssue({ brokerRepo, issueNumber, org } = {}) {
  const repo = String(brokerRepo ?? "").trim();
  const issue = String(issueNumber ?? "").trim();
  const owner0 = String(org ?? "").trim();

  if (!repo) return { ok: false, reason: "broker_repo is empty" };
  if (!issue) return { ok: false, reason: "issue_number is empty" };
  if (!ISSUE_NUMBER.test(issue)) {
    return { ok: false, reason: `issue_number="${issue}" is not a positive integer` };
  }

  // Exactly two segments. "a/b/c" must not parse as owner "a" and name "b/c",
  // and a bare "broker-x" must not parse as owner "broker-x" and name
  // undefined - both would send a request somewhere nobody asked for.
  const parts = repo.split("/");
  if (parts.length !== 2) {
    return { ok: false, reason: `broker_repo="${repo}" is not owner/repo` };
  }
  const [owner, name] = parts;
  if (!ORG_NAME.test(owner) || !REPO_NAME.test(name)) {
    return { ok: false, reason: `broker_repo="${repo}" is not a valid owner/repo` };
  }

  // The authorisation, not a formatting check. A dispatch is attacker-shaped
  // input: the hub's token can write to every participating org, and this is
  // what confines it to the one the dispatch is actually about.
  if (!ORG_NAME.test(owner0)) return { ok: false, reason: `org="${owner0}" is not a valid login` };
  if (owner.toLowerCase() !== owner0.toLowerCase()) {
    return { ok: false, reason: `broker_repo="${repo}" is not owned by org="${owner0}"` };
  }

  return { ok: true, owner, name, issue, fullName: `${owner}/${name}` };
}
