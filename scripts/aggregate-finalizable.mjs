// PXL Classroom - fold every organization's finalizable scan into one plan.
//
// Each `find-finalizable` leg of daily-activity.yml writes two files for its
// organization: `finalizable-<org>.json` (a list of { org, assignment_id }) and
// `active-<org>.json` ({ active: n }). This reads whatever arrived and says two
// different things about it.
//
//   finalizable  every assignment ANY leg reported. An organization whose scan
//                failed is simply absent tonight and retried tomorrow; it does
//                not hold back every other organization's finalize.
//   complete     true only when the scan succeeded AND every expected
//                organization reported a readable count. `active_count` is a
//                statement about the whole hub only when this is true, and it
//                is the only thing allowed to switch the nightly off.
//
// It used to be one inline jq step behind `needs: find-finalizable` with no
// `if:`, and on 2026-09-16 and 2026-09-17 one organization's collect failure
// skipped it - and with it finalize and check-idle - for every organization,
// because a failed job skips everything downstream of it through the whole
// needs chain. `labo-api` and `test-pe-2` sat unfinalized, their broker keys on
// public repositories. Running it anyway is the fix; a failed leg counting as
// "nothing active" and disabling the nightly is the trap beside it, and
// `complete` is what closes the trap.
//
// Usage:
//   FIND_RESULT=<needs.find-finalizable.result> EXPECTED_ORGS='<json array>' \
//     node scripts/aggregate-finalizable.mjs <directory the artifacts were downloaded into>
// Writes finalizable, active_count and complete to $GITHUB_OUTPUT.
import { readdirSync, readFileSync, appendFileSync } from "node:fs";

/**
 * @param {object} input
 * @param {string} input.findResult the find-finalizable job result
 * @param {string[]} input.expectedOrgs the organizations this run covered
 * @param {Record<string, unknown>} input.finalizable parsed finalizable-<org>.json by org (undefined when unreadable)
 * @param {Record<string, unknown>} input.active parsed active-<org>.json by org (undefined when unreadable)
 */
export function aggregateFinalizable({ findResult, expectedOrgs, finalizable, active }) {
  const plan = [];
  for (const org of Object.keys(finalizable).sort()) {
    const list = finalizable[org];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (item && typeof item.org === "string" && typeof item.assignment_id === "string") plan.push(item);
    }
  }

  let activeCount = 0;
  const missing = [];
  for (const org of expectedOrgs) {
    const n = active[org]?.active;
    if (Number.isInteger(n) && n >= 0) activeCount += n;
    else missing.push(org);
  }

  const complete = findResult === "success" && Array.isArray(expectedOrgs) && expectedOrgs.length > 0 && missing.length === 0;
  return { finalizable: plan, activeCount, complete, missing };
}

/** `{ org: parsed | undefined }` for every `<prefix><org>.json` in dir. */
function readByOrg(dir, prefix) {
  const out = {};
  for (const name of readdirSync(dir)) {
    if (!name.startsWith(prefix) || !name.endsWith(".json")) continue;
    const org = name.slice(prefix.length, -".json".length);
    try {
      out[org] = JSON.parse(readFileSync(`${dir}/${name}`, "utf8"));
    } catch {
      out[org] = undefined; // unreadable is not evidence
    }
  }
  return out;
}

function main() {
  const dir = process.argv[2] || ".";
  let expectedOrgs = [];
  try {
    expectedOrgs = JSON.parse(process.env.EXPECTED_ORGS || "[]");
  } catch {
    expectedOrgs = [];
  }
  const result = aggregateFinalizable({
    findResult: process.env.FIND_RESULT || "",
    expectedOrgs: Array.isArray(expectedOrgs) ? expectedOrgs : [],
    finalizable: readByOrg(dir, "finalizable-"),
    active: readByOrg(dir, "active-"),
  });

  console.log(`finalizable: ${result.finalizable.length} assignment(s)`);
  console.log(`active_count: ${result.activeCount}`);
  if (!result.complete) {
    console.log(
      `::warning::The finalizable scan is incomplete (find-finalizable: ${process.env.FIND_RESULT || "unknown"}` +
        `${result.missing.length ? `; no count from ${result.missing.join(", ")}` : ""}). ` +
        `Every organization that reported still finalizes; the nightly will not switch itself off on this run.`,
    );
  }

  const out = process.env.GITHUB_OUTPUT;
  if (out) {
    appendFileSync(out, `finalizable=${JSON.stringify(result.finalizable)}\n`);
    appendFileSync(out, `active_count=${result.activeCount}\n`);
    appendFileSync(out, `complete=${result.complete}\n`);
  }
}

if (process.argv[1] && process.argv[1].endsWith("aggregate-finalizable.mjs")) main();
