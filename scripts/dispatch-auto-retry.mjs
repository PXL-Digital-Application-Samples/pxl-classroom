#!/usr/bin/env node
// Press Retry for the students the nightly found with a repository and no
// record, where their own acceptance attempt is on record
// (lib/unrecorded-repos.mjs `autoRetryable`, chosen by
// scripts/find-unrecorded-repos.mjs as its `retry` output).
//
// It dispatches retry-acceptance.yml on `main`, exactly what the Organization
// page's Retry button dispatches, so every gate runs again and a refusal
// changes nothing. With the hub's own GITHUB_TOKEN, which is why that
// workflow's bot guard lets `github-actions[bot]` through and nothing else.
//
// Env: GITHUB_TOKEN      the hub workflow's token, `actions: write`
//      GITHUB_REPOSITORY the hub (`owner/name`)
//      ORG               the organization the findings are in
//      RETRY             JSON: [{ assignment_id, login }]
//
// Advisory: exits 0 whatever happens, and says what it pressed and what it
// could not. A dispatch that failed is pressed again by the next nightly.

import { pathToFileURL } from "node:url";
import { gh } from "../lib/gh.mjs";
import { AUTO_RETRY_MAX } from "../lib/unrecorded-repos.mjs";

const LOGIN = /^[A-Za-z0-9](?:-?[A-Za-z0-9]){0,38}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/;
const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

/**
 * The dispatches to make, from the finder's output. Anything not the shape the
 * Retry workflow validates is dropped here, loudly, rather than sent to be
 * refused there; never more than one night's cap.
 *
 * @returns {{ valid: Array<{assignment_id: string, login: string}>, dropped: number }}
 */
export function retriesToDispatch(raw, org) {
  let list;
  try {
    list = JSON.parse(raw || "[]");
  } catch {
    return { valid: [], dropped: 1 };
  }
  if (!Array.isArray(list) || !LOGIN.test(String(org || ""))) return { valid: [], dropped: Array.isArray(list) ? list.length : 1 };
  const valid = list.filter((r) => LOGIN.test(String(r?.login ?? "")) && SLUG.test(String(r?.assignment_id ?? ""))).slice(0, AUTO_RETRY_MAX);
  return { valid, dropped: list.length - valid.length };
}

async function main() {
  const org = process.env.ORG || "";
  const hub = process.env.GITHUB_REPOSITORY || "";
  const { valid, dropped } = retriesToDispatch(process.env.RETRY, org);
  if (dropped) console.log(`::warning::${dropped} Retry request(s) for ${org} were not in the expected shape and were not pressed.`);
  if (!valid.length) return;
  if (!REPO.test(hub)) {
    console.log(`::warning::GITHUB_REPOSITORY "${hub}" is not owner/name; no Retry was pressed.`);
    return;
  }
  for (const r of valid) {
    const res = await gh("POST", `/repos/${hub}/actions/workflows/retry-acceptance.yml/dispatches`, {
      ref: "main",
      inputs: { org, assignment_id: r.assignment_id, github_login: r.login },
    });
    if (res.ok) console.log(`[ok] auto-retry - pressed Retry for ${r.login} on ${r.assignment_id} in ${org}`);
    else console.log(`::warning::Could not press Retry for ${r.login} on ${r.assignment_id} in ${org} (HTTP ${res.status}); the next nightly tries again.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => console.log(`::warning::auto-retry did not run: ${e.message}`));
}
