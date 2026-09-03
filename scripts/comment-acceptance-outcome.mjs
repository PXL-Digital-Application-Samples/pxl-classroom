#!/usr/bin/env node
// Tell the student, on their own acceptance issue, what happened.
//
// WHAT THIS FIXES: a rejected student watched "Setting up your repository..."
// for two minutes and was then handed a list of guesses - "the assignment
// registration cap has been reached", "GitHub is experiencing high load" -
// while the real answer, `rejected:no-claim`, had been decided within a second.
// The page guessed because the outcome existed nowhere it could read: the
// notifications issue and the claim-attempt record are both in the PRIVATE
// control repository, which a student has no access to. Observed on
// PXL-Automation-II/test-pe3, 2026-09-03.
//
// The broker issue is the one surface both sides already share. The student's
// browser opened it and still holds its number; the hub reads it to get the
// team payload. Writing the outcome back closes the loop with no new channel.
//
// It carries the SUCCESS half too, for the same reason. `provisioned:invited`
// says the collaborator grant returned 201, which is the only evidence anywhere
// that GitHub sent an invitation: the student's own token gets `200 []` from
// /user/repository_invitations and 403 from /user/memberships/orgs/{org}, both
// measured 2026-09-03. Without this the page can only offer a guessed link
// after a minute of waiting while admitting it cannot tell what happened.
//
// AND IT NEVER WORKED UNTIL 2026-09-03. `BROKER_REPO` is a full `owner/repo`,
// this composed `/repos/${ORG}/${BROKER_REPO}/...`, and every request 404'd -
// printed as `[ok]`, under a `continue-on-error` step, so nothing was red for
// as long as the feature existed. Both the parse and the "the owner must be the
// dispatched org" authorisation now live in lib/broker-issue-target.mjs.
//
// ONLY THE CATEGORY IS PUBLISHED, never the reason text.
//
// That is not tidiness. The broker repository is PUBLIC, and the rejection
// notes carry the address the student typed - "<email> has already been claimed
// by another GitHub account", "<email> is not on the roster for this course".
// The claim is sealed so that address reaches nobody but the hub; republishing
// it in a public comment would undo that on the student's behalf. The category
// is a closed set of slugs decided by this system, and the page turns it into a
// sentence locally.

import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { gh } from "../lib/gh.mjs";
import { resolveBrokerIssue } from "../lib/broker-issue-target.mjs";

const env = (k, d) => process.env[k] ?? d;

/** The machine-readable half. The page looks for exactly this. */
const MARKER = "pxl-acceptance-outcome";

/**
 * Categories that may be published. An unlisted one is written as the generic
 * `rejected` rather than passed through: this is the boundary between a private
 * system and a public repository, and a category invented later must not reach
 * it just because somebody added a string somewhere else.
 */
const PUBLISHABLE = new Set([
  "rejected:no-claim",
  "rejected:no-claim-match",
  "rejected:claim-taken",
  "rejected:claim-blocked",
  "rejected:claim-domain",
  "rejected:not-on-roster",
  "rejected:not-in-class-group",
  "rejected:no-roster",
  "rejected:cap-reached",
  "rejected:past-deadline",
  "rejected:not-open",
  "rejected:not-published",
  "rejected:no-assignment",
  "rejected:no-team",
  "rejected:team-full",
  "rejected:no-assigned-team",
  "rejected:team-not-assigned",
  "rejected:team-creation-disabled",
  "rejected:invalid-team-slug",
]);

/**
 * The one thing this system publishes about a SUCCESSFUL acceptance.
 *
 * `provisioned:invited` means the collaborator grant returned 201 - GitHub sent
 * an invitation and the student has to accept it before the repository is
 * visible to them. It is here because the browser cannot find that out:
 * measured 2026-09-03, `GET /user/repository_invitations` returns `200 []` to
 * the account the invitation is addressed to.
 *
 * There is deliberately no `provisioned:direct` counterpart. A 204 grant means
 * the student is already a collaborator or an org member, and this comment
 * lands on a PUBLIC repository - publishing it would put "this account is an
 * org member" where anyone can read it, for no benefit, because a directly
 * granted repository is readable at once and the page reaches `provisioned` by
 * itself. Silence is the existing "unknown", which the page already handles.
 *
 * The category carries NO repository URL and NO invitation id. The page builds
 * the invitation URL from the assignment's own naming pattern, so nothing from
 * this public comment is rendered or dereferenced - which is what keeps a
 * forged comment (the issue lock is `|| true`, so it is not a guarantee) from
 * being worth writing.
 */
const PROVISIONED_INVITED = "provisioned:invited";

/** @param {string} raw */
export function publishableCategory(raw) {
  const v = String(raw || "").trim();
  if (v === PROVISIONED_INVITED) return v;
  if (!v.startsWith("rejected:")) return null;
  return PUBLISHABLE.has(v) ? v : "rejected";
}

/**
 * What the student reads under the marker. Fixed text per category - never the
 * reason note, which carries the address they typed.
 * @param {string} category
 */
function bodyFor(category) {
  if (category === PROVISIONED_INVITED) {
    return (
      `Your repository has been created, and GitHub has invited you to it.\n\n` +
      `**You need to accept that invitation before you can see it.** ` +
      `It is on your assignment page, in your GitHub notifications, and in the email GitHub sent you.`
    );
  }
  return (
    `Your acceptance was not completed: \`${category}\`.\n\n` +
    `Your assignment page explains what this means and what to do next. ` +
    `If it is not clear, contact your lecturer - they can see the details.`
  );
}

async function main() {
  const org = env("ORG");
  const brokerRepo = env("BROKER_REPO");
  const issueNumber = env("ISSUE_NUMBER");
  const outcome = env("OUTCOME");

  const category = publishableCategory(outcome);
  if (!category) {
    console.log(`[ok] outcome "${outcome}" is not publishable - nothing to post`);
    return;
  }
  if (!org || !brokerRepo || !issueNumber) {
    console.log("[ok] no broker issue to comment on - skipping");
    return;
  }

  // BROKER_REPO is a full name, and the owner has to be the org the dispatch
  // claims. Composing `/repos/${org}/${brokerRepo}/...` produced a doubled
  // owner and a 404 on every run since this script shipped; skipping the owner
  // check would let a forged dispatch aim the hub's token at another org. Both
  // live in lib/broker-issue-target.mjs.
  const target = resolveBrokerIssue({ brokerRepo, issueNumber, org });
  if (!target.ok) {
    console.log(
      `::warning::Cannot tell the student "${category}": ${target.reason}. ` +
        `The acceptance outcome itself is unaffected.`,
    );
    return;
  }

  const body = `<!-- ${MARKER}:${category} -->\n${bodyFor(category)}`;

  const res = await gh(
    "POST",
    `/repos/${target.owner}/${target.name}/issues/${target.issue}/comments`,
    { body },
  );
  if (!res.ok) {
    // Never fatal. The rejection is the outcome that matters and it is already
    // recorded for the lecturer; failing the run because a courtesy comment did
    // not post would turn a handled rejection into a red run, which is exactly
    // what accept.mjs exits 0 to avoid.
    //
    // But NOT `[ok]` either. That is how this went unnoticed: a 404 on every
    // acceptance, printed as if it were the expected path, under a step that is
    // `continue-on-error` by design. A warning is visible in the run's
    // annotations without turning a handled rejection red - which is the whole
    // point of the distinction.
    // WITH GitHub's own message. The status alone was not enough: the first
    // live run after the 404 fix answered 403, and "403" does not distinguish a
    // locked conversation from a missing permission from a suspended account -
    // which is the whole question when deciding what to do about it. One word
    // from the API ("Issue is locked") settles in a log line what otherwise
    // costs an afternoon.
    const why = res.data?.message ? `: ${res.data.message}` : "";
    console.log(
      `::warning::Could not comment on ${target.fullName}#${target.issue} (HTTP ${res.status}${why}) - ` +
        `the student will not be told "${category}". The acceptance outcome itself is unaffected.`,
    );
    return;
  }
  console.log(`[ok] posted ${category} to ${target.fullName}#${target.issue}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `Told the student: \`${category}\`\n`);
  }
}

// Same failure shape as above, one level out: an exception here used to print
// `[ok] comment step failed`, which reads as a handled path in a log nobody
// scrolls.
function reportUnexpected(e) {
  console.log(
    `::warning::Could not tell the student (${e.message}) - the acceptance outcome is unaffected.`,
  );
}

// pathToFileURL, not a hand-built `file://` string - the hand-built one is
// short a slash on Windows, so the guard is false forever and the script exits
// having done nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(reportUnexpected);
}
