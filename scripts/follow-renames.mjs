#!/usr/bin/env node
// A student changed their GitHub username: move their records to the new one
// (lib/login-rename.mjs), so the Teams tab, Progress, Grading and every lecturer
// action name somebody who exists.
//
// Runs inside the nightly, in the job that already holds the organization's
// records and already commits, and asks GitHub one question per account: who
// does this id go by now? A failed read moves nothing and is asked again the next
// night. The Accept button does not wait for this: acceptance/reserve.mjs follows
// the rename as soon as the student presses it.
//
// Writes to the working tree and leaves the commit to the workflow. Exits 0
// whatever it found: nothing here may fail the organization's collect.
//
// Usage: follow-renames.mjs --data-dir control [--dry-run]
// Env:   GITHUB_TOKEN (any token; the lookup is public), GITHUB_OUTPUT

import { appendFileSync } from "node:fs";
import { GITHUB_API_VERSION } from "../lib/github-api-version.mjs";
import { sameLogin } from "../lib/github-login.mjs";
import { accountsOnRecord, currentLogin, inMoveOrder, moveLogin, renamesFor } from "../lib/login-rename.mjs";

function arg(name, fallback = "") {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const dataDir = arg("data-dir", "control");
const dryRun = process.argv.includes("--dry-run");

// Lookups at once, and how long one may take. A collect has taken up to 5m42s of
// the job's ten, so this stops itself well inside what is left: whoever it did
// not reach tonight is asked tomorrow.
const AT_ONCE = 8;
const PER_TRY_MS = 15_000;
const BUDGET_MS = 90_000;

async function request(method, path) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    signal: AbortSignal.timeout(PER_TRY_MS),
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": GITHUB_API_VERSION,
      ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
    },
  });
  return { ok: res.ok, status: res.status, data: res.ok ? await res.json() : null };
}

function setOutput(name, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  const end = "PXL_END_OF_OUTPUT";
  appendFileSync(process.env.GITHUB_OUTPUT, `${name}<<${end}\n${value}\n${end}\n`);
}

const accounts = [...accountsOnRecord(dataDir)];
const stopAt = Date.now() + BUDGET_MS;
const renames = [];
let unread = 0;
let next = 0;
await Promise.all(
  Array.from({ length: AT_ONCE }, async () => {
    while (next < accounts.length && Date.now() < stopAt) {
      const [id, held] = accounts[next++];
      const login = await currentLogin(request, id);
      if (login === null) unread++;
      else renames.push(...renamesFor(held, login).map((r) => ({ ...r, githubId: id })));
    }
  }),
);
const notReached = accounts.length - next;
console.log(`[ok] follow-renames - ${accounts.length} account(s) on record, ${unread} unread, ${notReached} not reached in time, ${renames.length} renamed`);

const lines = [];
let changedAny = false;
let conflicted = false;
const moved = [];
for (const { from, to, githubId } of inMoveOrder(renames)) {
  if (dryRun) {
    console.log(`[dry-run] would move @${from} to @${to}`);
    continue;
  }
  const { changed, conflicts } = moveLogin(dataDir, { from, to, githubId });
  changedAny ||= changed.length > 0;
  // A name already followed, with nothing left under it, is said once and not
  // every night after. A change of case is the same name to everyone who reads
  // it, and no news to a lecturer.
  if (changed.length === 0 && conflicts.length === 0) continue;
  console.log(`[ok] follow-renames - @${from} is now @${to}: ${changed.length} path(s)`);
  if (sameLogin(from, to)) continue;
  moved.push(to);
  lines.push(`- \`${from}\` is now \`${to}\``);
  for (const c of conflicts) {
    conflicted = true;
    console.log(`::warning::${c.detail}. Left as it is: which record is the real one is a lecturer's call.`);
    lines.push(`  - ${c.detail}. Nothing was moved there: delete the records of the name that does not hold their work.`);
  }
}
setOutput("changed", changedAny ? "true" : "false");
if (lines.length) {
  // Their first sentence is what the Organization page lists (noticeLines).
  setOutput("details", [
    `${moved.length} GitHub account(s) changed username. Their access and repositories are unchanged, and their records now use the new name.`,
    "",
    ...lines,
  ].join("\n"));
  setOutput("event_type", conflicted ? "renamed-accounts-conflict" : "renamed-accounts");
  setOutput("dedup_key", `renames-${moved.sort().join("-").slice(0, 120)}`);
}
