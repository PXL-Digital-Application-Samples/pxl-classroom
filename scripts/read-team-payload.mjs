#!/usr/bin/env node
// PXL Classroom - fetch and validate a group-acceptance payload from a broker issue.
//
// Runs in the HUB, not on the broker. The broker is a public repository holding
// App credentials; it forwards only the issue number, and the untrusted body is
// read and validated here. See lib/team-payload.mjs for why.
//
// Inputs via env: BROKER_REPO (owner/repo), ISSUE_NUMBER, ORG, EXPECTED_LOGIN,
//                 TEAM_HINT, GH_TOKEN
// Outputs via GITHUB_OUTPUT: team_slug, team_name, team_action, issue_node_id
//
// issue_node_id is emitted so the caller can DELETE the issue once the body has
// been read. The issue's title carries the assignment's signed invitation and
// the broker is public, so closing it hides nothing (ARCHITECTURE §4.3.2). This
// is the first moment deletion is safe: delete it on the broker and this read
// races it, taking every group acceptance down with it.
//
// A malformed or mismatched payload is not a failure: it degrades to empty
// outputs, and accept.mjs rejects it as `rejected:no-team` with a real reason.

import { appendFile } from "node:fs/promises";
import { gh } from "../lib/gh.mjs";
import { parseTeamPayload, teamHintMatches } from "../lib/team-payload.mjs";
import { parseClaimFields } from "../lib/claim.mjs";
import { resolveBrokerIssue } from "../lib/broker-issue-target.mjs";

// GraphQL node ids are base64-ish. Anything else must not reach a mutation, and
// an empty one is how the caller knows there is nothing to delete.
const NODE_ID = /^[A-Za-z0-9_=-]{1,200}$/;

async function setOutputs({ team_slug, team_name, team_action, issue_node_id = "", claim_payload = "", claim_verified = false }) {
  if (!process.env.GITHUB_OUTPUT) return;
  await appendFile(
    process.env.GITHUB_OUTPUT,
    `team_slug=${team_slug}\nteam_name=${team_name}\nteam_action=${team_action}\n` +
      `issue_node_id=${issue_node_id}\n` +
      `claim_payload=${claim_payload}\nclaim_verified=${claim_verified ? "true" : "false"}\n`
  );
}

const EMPTY = {
  team_slug: "", team_name: "", team_action: "", issue_node_id: "",
  claim_payload: "", claim_verified: false,
};

async function main() {
  const brokerRepo = (process.env.BROKER_REPO || "").trim();
  const issueNumber = (process.env.ISSUE_NUMBER || "").trim();
  const org = (process.env.ORG || "").trim();
  const expectedLogin = (process.env.EXPECTED_LOGIN || "").trim();
  const teamHint = (process.env.TEAM_HINT || "").trim().toLowerCase();

  if (!issueNumber) {
    // A star-triggered acceptance carries no issue. Nothing to read.
    await setOutputs(EMPTY);
    return;
  }

  // Shape and authorisation together - lib/broker-issue-target.mjs. This is
  // where the "the broker must belong to the org the dispatch claims to be for,
  // or a forged dispatch could make the hub read an issue from anywhere" rule
  // was written, correctly; the sibling script that WRITES to the same issue
  // had neither half, so the pair now share one implementation.
  const target = resolveBrokerIssue({ brokerRepo, issueNumber, org });
  if (!target.ok) {
    console.error(`[warn] ${target.reason} - ignoring payload`);
    await setOutputs(EMPTY);
    return;
  }
  const { owner, name } = target;

  const res = await gh("GET", `/repos/${owner}/${name}/issues/${issueNumber}`, null, {
    token: process.env.GH_TOKEN,
  });
  if (!res.ok) {
    console.error(`[warn] could not read ${brokerRepo}#${issueNumber}: HTTP ${res.status} - ignoring payload`);
    await setOutputs(EMPTY);
    return;
  }

  // The dispatch reported github.actor; the issue reports its author. They are
  // the same person on the happy path, and a mismatch means the dispatch did
  // not come from the star/issue it claims to.
  const nodeId = String(res.data?.node_id || "");
  const deletable = NODE_ID.test(nodeId) ? nodeId : "";

  const author = res.data?.user?.login || "";
  if (expectedLogin && author.toLowerCase() !== expectedLogin.toLowerCase()) {
    console.error(
      `[warn] ${brokerRepo}#${issueNumber} was opened by @${author}, not @${expectedLogin} - ignoring payload`
    );
    // The payload is ignored, but the issue is real and its title carried an
    // invitation on a public repository. Still hand back the id so it goes.
    await setOutputs({ ...EMPTY, issue_node_id: deletable });
    return;
  }

  const parsed = parseTeamPayload({ body: res.data?.body, title: res.data?.title });
  // The same body carries the claim, and this is the one place the hub reads an
  // untrusted issue body - so the claim is validated here beside the team
  // fields rather than anywhere the broker can reach. The ciphertext is not
  // secret: it is already sitting on a public issue, which is the whole design
  // (only sealed bytes travel over the public channel).
  const claim = parseClaimFields({ body: res.data?.body });

  // The team hint came from the issue TITLE and is what the hub's concurrency
  // group was keyed on, before this body could be read - and that per-team
  // serialization is the only thing guarding max_team_size, since there is no
  // distributed lock (ARCHITECTURE 5.8). Nothing compared the two, so a title
  // saying `team:decoy` with a body saying `team_slug: popular-team` serialized
  // against one team while writing to another: two of those in parallel both
  // read the target at n-1 members and both appended. The SPA always sends them
  // in agreement; a hand-written issue need not.
  if (!teamHintMatches(parsed.team_slug, teamHint)) {
    console.error(
      `[warn] ${brokerRepo}#${issueNumber} declares team "${parsed.team_slug}" in its body but ` +
        `"${teamHint}" in its title. The title is what the concurrency key was built from, so ` +
        `honouring the body would bypass per-team serialization - ignoring the payload.`
    );
    await setOutputs({ ...EMPTY, issue_node_id: deletable });
    return;
  }

  console.log(
    `[ok] ${brokerRepo}#${issueNumber} -> team_slug="${parsed.team_slug}" team_action="${parsed.team_action}" ` +
      `claim=${claim.claim_payload ? "present" : "absent"} claim_verified=${claim.claim_verified}`
  );
  await setOutputs({ ...parsed, ...claim, issue_node_id: deletable });
}

main().catch(async (err) => {
  // Never take the acceptance run down over a team payload.
  console.error(`[warn] read-team-payload failed: ${err.message} - ignoring payload`);
  await setOutputs(EMPTY);
});
