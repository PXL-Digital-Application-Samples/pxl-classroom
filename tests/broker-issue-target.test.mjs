// The hub is told where a broker issue is by the dispatch itself, which is
// attacker-shaped input, and it both READS from and WRITES to that address.
//
// Two live defects, found 2026-09-03 in the run log of an acceptance that had
// already been diagnosed by hand:
//
//   BROKER_REPO: PXL-Automation-II/broker-test-pe3
//   [ok] could not comment on the broker issue (HTTP 404)
//
// `publish-acceptance-outcome.mjs` (then named comment-…) composed `/repos/${ORG}/${BROKER_REPO}/...`
// against a value that is ALREADY `owner/repo`, so every request went to
// `/repos/PXL-Automation-II/PXL-Automation-II/broker-test-pe3/...`. The feature
// - telling a rejected student why, on the one surface both sides can read -
// had never worked once, and printed `[ok]` while failing.
//
// The second is the one that matters. `read-team-payload.mjs` carried a check
// its sibling did not: the broker must belong to the org the dispatch claims,
// "or a forged dispatch could make the hub read an issue from anywhere". The
// comment script runs with the hub's App token, which holds `issues: write` on
// every participating org - so the READ side was guarded and the WRITE side was
// not.
//
// Both halves are one function now, and these pin it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBrokerIssue } from "../lib/broker-issue-target.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ORG = "PXL-Automation-II";

// What the file EXECUTES. These scans forbid the shapes that caused the bug,
// and each fix carries a comment quoting the shape it removed - so a scan over
// the raw text fails against its own explanation. Line-leading `//` only,
// because `https://` is not a comment.
const code = (relPath) =>
  readFileSync(join(root, relPath), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const ok = (over = {}) =>
  resolveBrokerIssue({ brokerRepo: `${ORG}/broker-test-pe3`, issueNumber: "2", org: ORG, ...over });

test("a well-formed dispatch resolves to a single owner and name", () => {
  const t = ok();
  assert.equal(t.ok, true);
  assert.equal(t.owner, ORG);
  assert.equal(t.name, "broker-test-pe3");
  assert.equal(t.issue, "2");
  assert.equal(t.fullName, `${ORG}/broker-test-pe3`);
});

test("THE 404: the owner is never doubled", () => {
  // The exact live values. A caller that builds `/repos/${org}/${fullName}`
  // gets a three-segment path; a caller using owner+name cannot.
  const t = ok();
  const path = `/repos/${t.owner}/${t.name}/issues/${t.issue}/comments`;
  assert.equal(path, `/repos/${ORG}/broker-test-pe3/issues/2/comments`);
  assert.ok(
    !/\/repos\/[^/]+\/[^/]+\/[^/]+\/issues/.test(path),
    "the path must have exactly owner/repo before /issues",
  );
});

test("THE SECURITY ONE: a broker in another org is refused", () => {
  // The hub's token can write to every participating org. This is the only
  // thing confining it to the org the acceptance is actually about.
  const t = resolveBrokerIssue({
    brokerRepo: "some-other-org/victim-repo",
    issueNumber: "2",
    org: ORG,
  });
  assert.equal(t.ok, false);
  assert.match(t.reason, /not owned by org/);
});

test("the org comparison is case-insensitive, because logins are", () => {
  assert.equal(ok({ brokerRepo: `pxl-automation-ii/broker-test-pe3` }).ok, true);
  assert.equal(ok({ org: "pxl-AUTOMATION-ii" }).ok, true);
});

test("a path with more than two segments is refused, not truncated", () => {
  // "a/b/c" must not parse as owner "a", name "b/c" - that reaches a repo
  // nobody named. Splitting with a limit, or destructuring the first two, both
  // do exactly that.
  for (const repo of [`${ORG}/broker/extra`, `${ORG}/a/b/c`, `evil/../../x`]) {
    const t = resolveBrokerIssue({ brokerRepo: repo, issueNumber: "2", org: ORG });
    assert.equal(t.ok, false, `${repo} must be refused`);
  }
});

test("a bare repo name is refused rather than read as an owner", () => {
  // `broker-test-pe3` alone would destructure to owner "broker-test-pe3" and
  // name undefined, and `/repos/broker-test-pe3/undefined` is a request to
  // somewhere real.
  const t = resolveBrokerIssue({ brokerRepo: "broker-test-pe3", issueNumber: "2", org: ORG });
  assert.equal(t.ok, false);
  assert.match(t.reason, /not owner\/repo/);
});

test("the issue number must be a positive integer", () => {
  for (const n of ["0", "-1", "1.5", "2; DROP", "", "abc", "01"]) {
    assert.equal(ok({ issueNumber: n }).ok, false, `issue_number="${n}" must be refused`);
  }
  assert.equal(ok({ issueNumber: "1" }).ok, true);
  assert.equal(ok({ issueNumber: 2 }).ok, true, "a number, not only a string");
});

test("missing pieces are refused with a reason, never with a guess", () => {
  for (const over of [{ brokerRepo: "" }, { issueNumber: "" }, { org: "" }]) {
    const t = ok(over);
    assert.equal(t.ok, false);
    assert.ok(t.reason.length > 5, "the reason has to be loggable");
  }
  assert.equal(resolveBrokerIssue().ok, false, "no payload at all");
  assert.equal(resolveBrokerIssue({}).ok, false);
});

test("neither hub script composes the broker path by hand any more", () => {
  // The fork this module exists to end. A second implementation is how the
  // read side stayed guarded while the write side did not.
  for (const f of ["scripts/publish-acceptance-outcome.mjs", "scripts/read-team-payload.mjs"]) {
    const src = code(f);
    assert.match(src, /resolveBrokerIssue/, `${f}: must go through the shared resolver`);
    assert.ok(
      !/\$\{org\}\/\$\{brokerRepo\}|\$\{ORG\}\/\$\{BROKER_REPO\}/.test(src),
      `${f}: composing org + a full name is the 404`,
    );
    assert.ok(
      !/brokerRepo\.split\(/.test(src),
      `${f}: splitting it here is the second copy of the authorisation check`,
    );
  }
});

test("a failure to publish the outcome is a warning, never printed as [ok]", () => {
  // The 404 ran on every acceptance for as long as the feature existed and was
  // logged as if it were the expected path, under a step that is
  // continue-on-error by design. The step must stay non-fatal AND be visible;
  // those are not the same requirement.
  const src = code("scripts/publish-acceptance-outcome.mjs");
  const bad = src.match(/console\.log\(\s*`\[ok\][^`]*(could not|failed)[^`]*`/g);
  assert.equal(bad, null, `a failure printed as [ok]: ${bad}`);
  assert.match(src, /::warning::Could not label/, "the HTTP failure is annotated");
  assert.match(src, /::warning::Could not tell the student/, "and so is an unexpected throw");

  // WITH GitHub's own message. "403" alone cost two wrong inferences - a
  // locked conversation, a missing permission and a suspended account all look
  // identical - before one word from the API would have settled it.
  assert.match(src, /res\.data\?\.message/, "the API's message must travel with the status");
});
