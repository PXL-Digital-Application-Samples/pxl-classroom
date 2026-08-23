#!/usr/bin/env node
// PXL Classroom - fetch and validate a group-acceptance payload from a broker issue.
//
// Runs in the HUB, not on the broker. The broker is a public repository holding
// App credentials; it forwards only the issue number, and the untrusted body is
// read and validated here. See lib/team-payload.mjs for why.
//
// Inputs via env: BROKER_REPO (owner/repo), ISSUE_NUMBER, ORG, EXPECTED_LOGIN, GH_TOKEN
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
import { parseTeamPayload } from "../lib/team-payload.mjs";

const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const ORG_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;

// GraphQL node ids are base64-ish. Anything else must not reach a mutation, and
// an empty one is how the caller knows there is nothing to delete.
const NODE_ID = /^[A-Za-z0-9_=-]{1,200}$/;

async function setOutputs({ team_slug, team_name, team_action, issue_node_id = "" }) {
  if (!process.env.GITHUB_OUTPUT) return;
  await appendFile(
    process.env.GITHUB_OUTPUT,
    `team_slug=${team_slug}\nteam_name=${team_name}\nteam_action=${team_action}\n` +
      `issue_node_id=${issue_node_id}\n`
  );
}

const EMPTY = { team_slug: "", team_name: "", team_action: "", issue_node_id: "" };

async function main() {
  const brokerRepo = (process.env.BROKER_REPO || "").trim();
  const issueNumber = (process.env.ISSUE_NUMBER || "").trim();
  const org = (process.env.ORG || "").trim();
  const expectedLogin = (process.env.EXPECTED_LOGIN || "").trim();

  if (!issueNumber) {
    // A star-triggered acceptance carries no issue. Nothing to read.
    await setOutputs(EMPTY);
    return;
  }

  if (!/^[1-9][0-9]{0,9}$/.test(issueNumber)) {
    console.error(`[warn] issue_number="${issueNumber}" is not a positive integer - ignoring payload`);
    await setOutputs(EMPTY);
    return;
  }

  const [owner, name] = brokerRepo.split("/");
  if (!owner || !name || !ORG_NAME.test(owner) || !REPO_NAME.test(name)) {
    console.error(`[warn] broker_repo="${brokerRepo}" is not a valid owner/repo - ignoring payload`);
    await setOutputs(EMPTY);
    return;
  }

  // The broker must belong to the org the dispatch claims to be for, or a
  // forged dispatch could make the hub read an issue from anywhere.
  if (!ORG_NAME.test(org) || owner.toLowerCase() !== org.toLowerCase()) {
    console.error(`[warn] broker_repo="${brokerRepo}" is not owned by org="${org}" - ignoring payload`);
    await setOutputs(EMPTY);
    return;
  }

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
  console.log(
    `[ok] ${brokerRepo}#${issueNumber} -> team_slug="${parsed.team_slug}" team_action="${parsed.team_action}"`
  );
  await setOutputs({ ...parsed, issue_node_id: deletable });
}

main().catch(async (err) => {
  // Never take the acceptance run down over a team payload.
  console.error(`[warn] read-team-payload failed: ${err.message} - ignoring payload`);
  await setOutputs(EMPTY);
});
