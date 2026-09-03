#!/usr/bin/env node
// Tell the student what happened, on the one surface both sides can read - and
// without emailing them about it.
//
// WHAT THIS FIXES: a rejected student watched "Setting up your repository..."
// for two minutes and was then handed a list of guesses - "the assignment
// registration cap has been reached", "GitHub is experiencing high load" -
// while the real answer had been decided within a second. The page guessed
// because the outcome existed only in the PRIVATE control repository. Observed
// on PXL-Automation-II/test-pe3, 2026-09-03.
//
// A LABEL, NOT A COMMENT, and that decision is the whole design.
//
// The student authored the acceptance issue, so GitHub subscribes them to it.
// Every comment then emails them, and so does closing it - which is what
// produced "Re: Acceptance (processed) - Closed #1 has been completed" in a
// student's inbox, an email about internal plumbing they never asked for.
// Metadata is silent: the broker has been editing the title of that same issue
// for months and nobody has ever been mailed about it.
//
// Three more things fall out of it, all measured on 2026-09-03:
//
//   * A LOCKED conversation still accepts labels. `POST .../labels` on a
//     locked issue returned 200, while `POST .../comments` had been returning
//     403 - so this sidesteps a blocker whose cause is still unidentified.
//   * A label CANNOT BE FORGED by a student. Applying one needs triage or write
//     access; they have neither, and org base permission is `none`. Anyone can
//     comment on a public issue, which is why the comment version needed a rule
//     making a rejection outrank a success. Not needed here.
//   * Labels are auto-created on first use, so publishing provisions nothing.
//
// ONLY TWO LABELS EVER, and the coarseness is deliberate.
//
// Labels are filterable in one click, so `outcome:rejected-not-on-roster` would
// be a public, sortable list of named students who are not enrolled - enrolment
// data about people who never chose to publish it. The generic label says WHO
// was refused, which their own public acceptance issue already said, and never
// WHY. The specific reason stays in the private control repository where the
// lecturer reads it.
//
// Nothing here carries free text. The rejection notes hold the address the
// student typed - "<email> has already been claimed by another GitHub account"
// - and the claim is sealed precisely so that address reaches nobody but the
// hub.

import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { gh } from "../lib/gh.mjs";
import { resolveBrokerIssue } from "../lib/broker-issue-target.mjs";
import { INVITED_LABEL, REJECTED_LABEL } from "../lib/acceptance-labels.mjs";

const env = (k, d) => process.env[k] ?? d;

/**
 * The label an acceptance outcome earns, or null for one that earns none.
 *
 * `provisioned:invited` is the collaborator grant returning 201 - GitHub sent
 * an invitation the student must accept before the repository is visible to
 * them, and the hub is the only party that knows: measured the same day, the
 * student's own token gets `200 []` from /user/repository_invitations and 403
 * from /user/memberships/orgs/{org}.
 *
 * A 204 grant earns nothing. It means the student is already a collaborator or
 * an org member, the repository is readable at once, and the page reaches
 * `provisioned` by itself - so there is nothing to say, and "this account is an
 * org member" is not ours to publish on a public repository.
 *
 * @param {string} raw
 */
export function outcomeLabel(raw) {
  const v = String(raw || "").trim();
  if (v === "provisioned:invited") return INVITED_LABEL;
  if (v.startsWith("rejected:")) return REJECTED_LABEL;
  return null;
}

async function main() {
  const org = env("ORG");
  const brokerRepo = env("BROKER_REPO");
  const issueNumber = env("ISSUE_NUMBER");
  const outcome = env("OUTCOME");

  const label = outcomeLabel(outcome);
  if (!label) {
    console.log(`[ok] outcome "${outcome}" earns no label - nothing to publish`);
    return;
  }
  if (!org || !brokerRepo || !issueNumber) {
    console.log("[ok] no broker issue to label - skipping");
    return;
  }

  // BROKER_REPO is a full name, and the owner has to be the org the dispatch
  // claims. Composing `/repos/${org}/${brokerRepo}/...` produced a doubled
  // owner and a 404 on every run for as long as this script existed; skipping
  // the owner check would let a forged dispatch aim the hub's token at another
  // org. Both live in lib/broker-issue-target.mjs.
  const target = resolveBrokerIssue({ brokerRepo, issueNumber, org });
  if (!target.ok) {
    console.log(
      `::warning::Cannot publish "${label}": ${target.reason}. ` +
        `The acceptance outcome itself is unaffected.`,
    );
    return;
  }

  const res = await gh(
    "POST",
    `/repos/${target.owner}/${target.name}/issues/${target.issue}/labels`,
    { labels: [label] },
  );
  if (!res.ok) {
    // Never fatal. The outcome that matters is already recorded for the
    // lecturer, and failing the run because a courtesy label did not stick
    // would turn a handled rejection into a red run - exactly what accept.mjs
    // exits 0 to avoid.
    //
    // But NOT `[ok]`. That is how the 404 above went unnoticed on every
    // acceptance for as long as the feature existed: printed as the expected
    // path, under a step that is `continue-on-error` by design. A warning is
    // visible in the run's annotations without turning anything red - and it
    // carries GITHUB'S OWN MESSAGE, because "403" alone cost two wrong
    // inferences before one word from the API would have settled it.
    const why = res.data?.message ? `: ${res.data.message}` : "";
    console.log(
      `::warning::Could not label ${target.fullName}#${target.issue} (HTTP ${res.status}${why}) - ` +
        `the student will not be told "${label}". The acceptance outcome itself is unaffected.`,
    );
    return;
  }
  console.log(`[ok] labelled ${target.fullName}#${target.issue} ${label}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `Told the student: \`${label}\`\n`);
  }
}

// Same failure shape one level out: an exception here used to print
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
