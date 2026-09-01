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
