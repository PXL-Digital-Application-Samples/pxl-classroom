#!/usr/bin/env node
// Close acceptance on an assignment's broker once its deadline has been
// finalized.
//
// `publish-assignment.yml` sets `INVITE_ENABLED=true` on the broker, and until
// now NOTHING ever set it back. Measured 2026-09-03 on PXL-Automation-II:
// `broker-2526-examen-aut2-ek2` was still `true` five days after that exam's
// deadline, alongside every other broker the org has ever published.
//
// TWO THINGS THAT LEAVES OPEN, and the second is the one that matters.
//
// The pre-runner `if:` on the broker skips anything that is not a
// `pxl-accept:` title, but a title that IS one boots a runner - free, on a
// public repository, and confined to one at a time per accepting login, so the
// cost is not money. What it is, is a door with nothing behind it: after the
// deadline the hub refuses every one of these as `rejected:past-deadline`, so
// each boot is guaranteed waste. And the set of open doors only ever grows -
// one per assignment, for the life of the organization.
//
// Setting the variable to `false` moves the refusal into the pre-runner
// condition, where it costs no runner at all, and shrinks the surface to the
// assignments that are actually accepting.
//
// NOT A LOCK, and not security. Anyone with the invitation link can still
// accept an OPEN assignment; that is what the signature and the roster gates
// are for. This closes the ones that finished.
//
// Idempotent, and never fatal: it runs after the finalisation it accompanies,
// and a variable that would not set must not undo a lockdown that did.
//
// Env: ORG, ASSIGNMENT_ID, DATA_DIR (default "."), GITHUB_TOKEN

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";
import { gh } from "../lib/gh.mjs";
import { brokerRepoName } from "../lib/broker-repo.mjs";
import { assignmentPath } from "../lib/control-layout.mjs";

const env = (k, d) => process.env[k] ?? d;

/** The variable the broker's own `if:` reads, before it allocates a runner. */
const VARIABLE = "INVITE_ENABLED";

async function main() {
  const org = env("ORG");
  const assignmentId = env("ASSIGNMENT_ID");
  const dataDir = env("DATA_DIR", ".");
  if (!org || !assignmentId) {
    console.log("[ok] no org or assignment - nothing to close");
    return;
  }

  // The broker's name is DECIDED, never composed: an assignment carrying a
  // custom `broker_repo` is why lib/broker-repo.mjs exists.
  let assignment = null;
  try {
    assignment = parse(await readFile(join(dataDir, assignmentPath(assignmentId)), "utf8"));
  } catch (e) {
    console.log(`::warning::Could not read ${assignmentId} to find its broker (${e.message}) - acceptance stays open.`);
    return;
  }
  const broker = brokerRepoName({ assignment, assignmentId });

  // PATCH updates an existing variable; a broker that somehow has none is not
  // a broker this should be creating variables on, so an absent one is
  // reported rather than invented.
  const res = await gh("PATCH", `/repos/${org}/${broker}/actions/variables/${VARIABLE}`, {
    name: VARIABLE,
    value: "false",
  });
  if (!res.ok) {
    const why = res.data?.message ? `: ${res.data.message}` : "";
    console.log(
      `::warning::Could not close acceptance on ${org}/${broker} (HTTP ${res.status}${why}) - ` +
        `the assignment is finalized, but its broker still boots a runner for acceptance attempts.`,
    );
    return;
  }
  console.log(`[ok] acceptance closed on ${org}/${broker} (${VARIABLE}=false)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.log(`::warning::Could not close acceptance (${e.message}) - the finalisation itself is unaffected.`);
  });
}

export { main };
