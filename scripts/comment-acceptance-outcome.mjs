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

/** @param {string} raw */
export function publishableCategory(raw) {
  const v = String(raw || "").trim();
  if (!v.startsWith("rejected:")) return null;
  return PUBLISHABLE.has(v) ? v : "rejected";
}

async function main() {
  const org = env("ORG");
  const brokerRepo = env("BROKER_REPO");
  const issueNumber = env("ISSUE_NUMBER");
  const outcome = env("OUTCOME");

  const category = publishableCategory(outcome);
  if (!category) {
    console.log(`[ok] outcome "${outcome}" is not a rejection - nothing to post`);
    return;
  }
  if (!org || !brokerRepo || !issueNumber) {
    console.log("[ok] no broker issue to comment on - skipping");
    return;
  }

  const body =
    `<!-- ${MARKER}:${category} -->\n` +
    `Your acceptance was not completed: \`${category}\`.\n\n` +
    `Your assignment page explains what this means and what to do next. ` +
    `If it is not clear, contact your lecturer - they can see the details.`;

  const res = await gh("POST", `/repos/${org}/${brokerRepo}/issues/${issueNumber}/comments`, { body });
  if (!res.ok) {
    // Never fatal. The rejection is the outcome that matters and it is already
    // recorded for the lecturer; failing the run because a courtesy comment did
    // not post would turn a handled rejection into a red run, which is exactly
    // what accept.mjs exits 0 to avoid.
    console.log(`[ok] could not comment on the broker issue (HTTP ${res.status}) - the rejection stands`);
    return;
  }
  console.log(`[ok] posted ${category} to ${org}/${brokerRepo}#${issueNumber}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `Told the student: \`${category}\`\n`);
  }
}

// pathToFileURL, not a hand-built `file://` string - the hand-built one is
// short a slash on Windows, so the guard is false forever and the script exits
// having done nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.log(`[ok] comment step failed (${e.message}) - the rejection stands`);
  });
}
