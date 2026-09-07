// PXL Classroom - what a lecturer should know BEFORE students can accept.
//
// Publishing is the moment an assignment stops being a form and becomes a
// thing students act on, and it is the first surface holding the credential
// that can answer these questions: the App installation token for the course
// org, which is exactly what provisioning and lockdown will use.
//
// Two questions, and they fail differently on purpose.
//
// 1. CAN THE TEMPLATE PROVISION AT ALL? Refuses the publish.
//
//    Measured on the live testbed 2026-09-07 by running the real chain: a
//    PUBLIC template in another organization works (a stranger's, even - the
//    token does not authenticate as the lecturer, so ownership is irrelevant),
//    while a PRIVATE one is HTTP 404 even when the App is installed on that
//    other org, because the token is minted per installation.
//
//    The Admin Panel asks the same question of lib/template-source.mjs while
//    the lecturer types, but on the LECTURER'S token - and they can see their
//    own private repository perfectly well, so the form's green badge is not
//    evidence. Before this check existed, nothing looked at the template
//    between save and the first acceptance: it failed inside provisioning,
//    after a student had accepted and spent a slot of max_acceptances, and
//    what the lecturer got was `HTTP 404` naming a repository they were
//    looking at in another tab.
//
// 2. WILL THE DEADLINE DO WHAT THE FORM PROMISED? Warns, never refuses.
//
//    On a free organization, rulesets and protected branches do not apply to
//    private repositories, so the freeze degrades to demoting each student to
//    `pull` - which works, and takes their Actions, secrets and environments
//    with it. Nothing is broken, so refusing to publish would block a course
//    that runs perfectly well.
//
//    READ LIVE, STORED NOWHERE. GitHub Team is free for verified educators and
//    the lecturer may upgrade tomorrow, at which point none of it applies. A
//    verdict recorded on the assignment would outlive the fact by a year and
//    be believed.
//
// Usage: node scripts/check-publish-preflight.mjs <assignment.yml>
// Env:   GITHUB_TOKEN - App installation token for the assignment's org
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { templateUsable, templateSourceMessage } from "../lib/template-source.mjs";
import { assignmentFreezePlanFinding, FREE_PLAN } from "../lib/audit.mjs";

const API = process.env.GITHUB_API_URL || "https://api.github.com";

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

function warn(message) {
  console.log(`::warning::${message}`);
}

async function gh(token, path) {
  return fetch(`${API}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
}

async function main() {
  const path = process.argv[2];
  if (!path) fail("usage: check-publish-preflight.mjs <assignment.yml>");

  const token = process.env.GITHUB_TOKEN;
  if (!token) fail("GITHUB_TOKEN is required (App installation token for the org)");

  const doc = parse(readFileSync(path, "utf8"));
  const org = doc?.organization;
  const owner = doc?.template?.owner;
  const repo = doc?.template?.repository;
  if (!org || !owner || !repo) {
    fail(`${path} has no organization/template.owner/template.repository to check`);
  }
  const full = `${owner}/${repo}`;

  // --- 1. the template -----------------------------------------------------
  const tpl = await gh(token, `/repos/${owner}/${repo}`);

  // A FAILED READ IS NOT "NO TEMPLATE" AND IT IS NOT A PASS. 404 is the
  // measured answer for a private repository in another organization, so it
  // gets the sentence that says so rather than "not found" - which is what
  // sent a lecturer looking for a repository that was sitting right there.
  if (!tpl.ok) {
    fail(
      tpl.status === 404
        ? `${full} could not be read by PXL Classroom. If it is private and outside ${org}, that is ` +
          `expected: student repositories are created by an app installed on ${org}, which cannot read ` +
          `a private repository elsewhere - even one you own. Make it public, or copy it into ${org}.`
        : `${full} could not be read (HTTP ${tpl.status}).`,
    );
  }

  const data = await tpl.json();
  const finding = templateUsable({
    templateOwner: owner,
    org,
    isPrivate: data?.private,
    isTemplate: data?.is_template,
  });
  if (!finding.ok) {
    fail(templateSourceMessage(finding, { templateOwner: owner, templateRepo: repo, org }));
  }
  console.log(`[template] ok - ${full} private=${data.private} is_template=${data.is_template}`);

  // --- 2. the plan, against what this assignment asked for -----------------
  //
  // An unreadable plan produces NO finding rather than a reassuring one, and
  // must not fail the publish: this half is advisory, and a course whose org
  // read is refused still publishes fine.
  const orgRes = await gh(token, `/orgs/${org}`);
  if (!orgRes.ok) {
    console.log(`[plan] not checked - GET /orgs/${org} HTTP ${orgRes.status}`);
    return;
  }
  const orgData = await orgRes.json();
  const plan = orgData?.plan?.name;
  const freeze = assignmentFreezePlanFinding({ plan, assignment: doc, org });
  if (freeze) {
    warn(freeze.message);
    return;
  }

  // SAY WHAT WAS ESTABLISHED, not "ok". A free organization with a
  // non-freezing assignment used to print `[plan] ok - ... is on "free"`,
  // which reads as "free is fine" and contradicts what System Health says
  // about the very same organization. What is actually true is narrower:
  // this assignment does not ask for anything the plan would blunt.
  const isFree = String(plan ?? "").toLowerCase() === FREE_PLAN;
  const freezes = doc?.lock_down_enabled ?? true;
  if (isFree) {
    console.log(
      `[plan] ${org} is on "free", which blunts the deadline freeze and Feedback PR baseline ` +
        `protection - neither of which this assignment uses ` +
        `(lock_down_enabled=${freezes}, feedback_pr=${doc?.feedback_pr === true})`,
    );
    return;
  }
  console.log(`[plan] ok - ${org} is on "${plan}", where rulesets apply to private repositories`);
}

await main();
