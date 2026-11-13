#!/usr/bin/env node
// Retry: say how it ended, where the lecturer's page can read it.
//
// One notice annotation on this job, written by lib/retry-outcome.mjs and read
// back by it. A refusal on a Retry is persisted nowhere and the run is green
// either way, so without this the page can only guess - and it guessed "is on
// the assignment's list in a minute or two" over a Retry the hub had refused.
//
// Names no student and no address: the hub's run log is public, and the page
// that reads this already knows who it asked about.
//
// Env: ACCEPT_OUTCOME, PROVISION_OUTCOME, RECORD_OUTCOME

import { RETRY_OUTCOME_TITLE, retryOutcomeLine } from "../lib/retry-outcome.mjs";

const line = retryOutcomeLine({
  accept: process.env.ACCEPT_OUTCOME || "",
  provision: process.env.PROVISION_OUTCOME || "",
  record: process.env.RECORD_OUTCOME || "",
});
// Nothing decided (the run died before the acceptance): say nothing, and the
// page reads a failed run with no answer as exactly that.
if (line) console.log(`::notice title=${RETRY_OUTCOME_TITLE}::${line}`);
