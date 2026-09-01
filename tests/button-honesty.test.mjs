// Does every button do what it says?
//
// The device-flow copy button reported "Copied" over an empty clipboard and
// stopped people signing in. That bug has a shape - a control announcing an
// outcome it never verified - and this file sweeps the SPA for the shape rather
// than waiting for the next report.
//
// The sweep found one more, and it wore a disguise:
//
//     await addCollaborator(token, org, repo, m, 'admin').catch((e) =>
//       console.warn(`Failed to add collaborator ${m}:`, e)
//     )
//     ...
//     toast.success(`Team "${name}" updated successfully.`)
//
// `addCollaborator` returns `ghApi(...)`, which RESOLVES `{ ok: false, status }`
// on an HTTP failure. It does not throw. So that `.catch()` could never fire
// for a 403 or a 404, the returned value was dropped, and a student whose
// access could not be granted was written into the manifest while the lecturer
// was told it worked. Removal was worse: a student who could not be removed
// kept admin on a repository they are no longer part of.
//
// `.catch()` on a function that resolves is not error handling, it is the
// appearance of it - which is why a reviewer reading the line sees a guard.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(root, "frontend", "src");

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (e.endsWith(".vue") || e.endsWith(".js")) out.push(p);
  }
  return out;
}

const files = walk(SRC).map((f) => [relative(root, f).replace(/\\/g, "/"), readFileSync(f, "utf8")]);

/**
 * Helpers in frontend/src/lib/api.js that return a ghApi result. They RESOLVE
 * `{ ok, status, data }` and never reject on an HTTP error, so `.catch()` on
 * one of them is dead code and `await`ing one without reading `.ok` throws the
 * answer away.
 */
const RESOLVING_API = [
  "ghApi", "addCollaborator", "removeCollaborator", "getRepo", "commitFile",
  "deleteFile", "triggerWorkflow", "acceptInvitation", "getInvitations",
  "getUserRepos", "getInstallations",
];

test("api.js helpers resolve rather than reject, which is what makes .catch on them dead", () => {
  // The premise the sweep below rests on. If these ever start throwing, the
  // rule changes and this test is where that gets noticed.
  const api = files.find(([f]) => f.endsWith("frontend/src/lib/api.js"))[1];
  const ghApiBody = api.slice(api.indexOf("export async function ghApi"));
  const body = ghApiBody.slice(0, ghApiBody.indexOf("\n}\n") + 3);
  assert.match(body, /return \{ status: res\.status, ok: res\.ok/, "ghApi must return a result object");
  assert.doesNotMatch(body, /throw new Error\(`\$\{res\.status\}/, "and must not throw on a non-2xx");
});

/**
 * Index just past the `)` that closes the call starting at `open`.
 *
 * Balanced-paren matching rather than a regex: `ghApi(a, b)\n  .catch(...)` and
 * `res.json().catch(...)` are three lines apart in the same function, and a
 * lazy `[^;]*?` happily spans from one to the other - which reported the
 * `res.json()` handler, a promise that genuinely DOES reject, as a dead catch.
 */
function endOfCall(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")") { depth--; if (!depth) return i + 1; }
  }
  return -1;
}

test("no .catch() is attached to a call that cannot reject", () => {
  const offenders = [];
  for (const [file, src] of files) {
    if (file.endsWith("frontend/src/lib/api.js")) continue; // the definitions themselves
    for (const fn of RESOLVING_API) {
      const re = new RegExp(`\\b${fn}\\(`, "g");
      for (const m of src.matchAll(re)) {
        const close = endOfCall(src, m.index + fn.length);
        if (close === -1) continue;
        // Only what is chained DIRECTLY onto this call counts.
        if (!/^\s*\.catch\(/.test(src.slice(close, close + 40))) continue;
        const line = src.slice(0, m.index).split("\n").length;
        offenders.push(`${file}:${line} — .catch() on ${fn}(), which resolves rather than rejects`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "These read as error handling and are dead code - the helper resolves " +
      "`{ ok: false }` instead of throwing, so the handler never runs and the " +
      "failure is invisible. Check `.ok` on the returned value:\n  " +
      offenders.join("\n  "),
  );
});

/**
 * Every helper in api.js that hands back a ghApi result. Wider than
 * RESOLVING_API above, which lists the ones a `.catch()` had been attached to.
 */
const RESULT_RETURNING = [
  "ghApi", "addCollaborator", "removeCollaborator", "getRepo", "getInvitations",
  "getUserRepos", "acceptInvitation", "getInstallations", "getRepoContent",
  "listRepoDir", "commitFile", "commitFiles", "deleteFile", "triggerWorkflow",
  "getWorkflowRuns", "getWorkflowRunByRequestId", "listOrgRepos",
  "listOrgTemplates", "validateTemplateRepository",
];

test("no awaited call throws its result away", () => {
  // The other half of the same bug. `.catch()` on a resolving helper is one way
  // to discard the answer; `await f(...)` as a bare statement is the other, and
  // it reads even more like success:
  //
  //     await deleteFile(token, org, repo, `students/claims/${id}.json`, msg)
  //     await deleteFile(token, org, repo, `students/claim-attempts/${id}.json`, msg)
  //     toast.success(`Unlinked @${login}. They can claim again.`)
  //
  // deleteFile resolves `{ ok: false, status }`. A 403 or a conflict left the
  // claim in place, the catch never fired, and the lecturer was told the
  // student could claim again while they stayed bound to the old address.
  //
  // Bare `f(...)` without `await` is NOT flagged: that shape is a Promise.all
  // array element here, where the array collects every result.
  const offenders = [];
  const re = new RegExp(`^\\s*await\\s+(${RESULT_RETURNING.join("|")})\\(`);
  for (const [file, src] of files) {
    if (file.endsWith("frontend/src/lib/api.js")) continue; // composes its own calls
    src.split("\n").forEach((line, i) => {
      const m = line.match(re);
      if (m) offenders.push(`${file}:${i + 1} — result of ${m[1]}() discarded`);
    });
  }
  assert.deepEqual(
    offenders,
    [],
    "These helpers RESOLVE `{ ok, status }` on an HTTP failure rather than " +
      "throwing, so awaiting one without reading the result means the failure " +
      "is invisible and whatever is announced next is announced regardless:\n  " +
      offenders.join("\n  "),
  );
});

test("unlinking a claim reports whether the claim was actually removed", () => {
  const src = files.find(([f]) => f.endsWith("components/RosterTab.vue"))[1];
  const fn = src.slice(src.indexOf("async function confirmUnlink"));
  const body = fn.slice(0, fn.indexOf("\n}\n") + 3);
  assert.match(body, /const claimRes = await deleteFile/, "the claim delete must be read");
  assert.match(body, /if \(!claimRes\.ok\)/, "and must gate the success message");
  // The attempt counter is usually absent - the student never exhausted it -
  // so a 404 there is the end state we wanted, not a failure to report.
  assert.match(body, /attemptsRes\.status !== 404/, "an absent attempt counter is not a failure");
});

test("removing a collaborator also withdraws an invitation they never accepted", () => {
  // A pending invitation survives the collaborator DELETE. Reporting `ok` while
  // one is still standing means the student can accept it afterwards and walk
  // back onto the repository they were removed from.
  const api = files.find(([f]) => f.endsWith("frontend/src/lib/api.js"))[1];
  const fn = api.slice(api.indexOf("export async function removeCollaborator"));
  const body = fn.slice(0, fn.indexOf("\n}\n") + 3);
  assert.match(body, /invitationCleared/, "the cancel outcome must be tracked");
  assert.match(body, /invitationPending: true/, "and must reach the caller as a non-ok result");
  assert.doesNotMatch(
    body,
    /catch \{\s*\n\s*\/\/ non-critical/,
    "a swallowed invitation read reports 'there was none' from a read that failed",
  );
});

test("changing repository access reports what actually happened", () => {
  // The specific case, pinned: saveTeamMembers grants and revokes collaborator
  // access, and a lecturer who is told "updated successfully" over a failed
  // grant finds out from the student.
  const src = files.find(([f]) => f.endsWith("components/TeamsTable.vue"))[1];
  const fn = src.slice(src.indexOf("async function saveTeamMembers"));
  const body = fn.slice(0, fn.indexOf("\n}\n") + 3);
  assert.ok(body.includes("addCollaborator"), "saveTeamMembers must still sync access");

  assert.match(body, /accessFailures/, "failures must be collected");
  assert.match(
    body,
    /if \(accessFailures\.length\)/,
    "and must gate the success message - the manifest saving is not the same " +
      "thing as the access changing",
  );
  // 404 on a removal means they were not a collaborator: the end state is the
  // one we wanted, so it is not a failure to report.
  assert.match(body, /status !== 404/, "a removal that was already absent is not a failure");
});
