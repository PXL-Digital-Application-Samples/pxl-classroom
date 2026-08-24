// What the student acceptance page is allowed to say while it does not know.
//
// Reported live on 24 Aug 2026: fifteen seconds after accepting, the page said
// GitHub might be waiting for the student to accept a repository invitation
// and offered a link. The link 404'd, and there was no invitation - the tester
// owns the org, so provisioning adds them as a direct collaborator and GitHub
// never sends one. The repository appeared at twenty to thirty seconds.
//
// The timeout states take ~2.7 minutes of real polling to reach, so those are
// pinned here by reading the markup rather than by driving a browser for three
// minutes per case. tests/e2e/40-provisioning-wait.spec.mjs covers the waiting
// state for real.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const view = (p) => readFileSync(join(root, "frontend", "src", p), "utf8");

// What the student can actually READ. Comments explaining the old copy quote
// it verbatim, so a scan that includes them fails against its own explanation
// - the same trap tests/theme-tokens.test.mjs documents for `var(--token` in
// prose. Both comment syntaxes, because these are .vue files.
const rendered = (p) =>
  view(p)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const STUDENT_SURFACES = [
  ["views/AssignmentView.vue", "the individual student page"],
  ["components/GroupAcceptanceCard.vue", "the group student card"],
];

test("the guessed invitation link is gated on not being able to see the real one", () => {
  // The rule, and the reason it is this and not "wait longer": the page polls
  // /user/repository_invitations every tick. If that answers, we already know
  // - a match puts us in `invited` with an in-app Accept button, and no match
  // means there is nothing to accept. Either way the guess is wrong. Only a
  // FAILED read leaves us blind enough for a guess to beat silence.
  for (const [file, label] of STUDENT_SURFACES) {
    const src = view(file);
    assert.match(
      src,
      /const showInvitationGuess = computed\(\s*\(\) => invitationsReadable\.value === false/,
      `${label}: the guess must be gated on the invitations read having FAILED`,
    );
    assert.match(
      src,
      /invitationsReadable\.value = invites\.ok && Array\.isArray\(invites\.data\)/,
      `${label}: the poll must record whether the read answered`,
    );
    assert.ok(
      !/v-if="pollCount >= 5 && invitationUrl"/.test(src),
      `${label}: a timer is not evidence of an invitation - that is the bug`,
    );
  }
});

test("nothing accuses the student of not having accepted something", () => {
  // "GitHub may be waiting for you to accept an invitation" was asserted from
  // a timer, and for an org member it is never true.
  for (const [file, label] of STUDENT_SURFACES) {
    assert.ok(
      !/waiting for you to accept an\s+invitation/i.test(rendered(file)),
      `${label}: must not name a cause it has no evidence for`,
    );
  }
});

test("the wait sets an expectation, and counts the wait rather than the poll", () => {
  for (const [file, label] of STUDENT_SURFACES) {
    const src = view(file);
    assert.match(src, /20 to 40 seconds/, `${label}: say roughly how long provisioning takes`);
    assert.match(src, /Waiting \{\{ waitedSeconds \}\}s/, `${label}: elapsed time, in the student's terms`);
    assert.ok(
      !/attempt \{\{ pollCount \}\}/.test(src),
      `${label}: "attempt 7" is this page's telemetry, not the student's question`,
    );
  }
  assert.ok(
    !/less than a minute/.test(rendered("views/AssignmentView.vue")),
    "ten seconds was never the expectation this set, and a student who believes it concludes the tool is broken",
  );
});

test("polling stays at 3s", () => {
  // Slowing it only adds dead time after the repository appears. The wait felt
  // long because the copy was wrong, not because it checked too often - and
  // each student polls with their own token against their own 5,000/hr limit,
  // so a thirty-second wait is about ten requests.
  for (const [file, label] of STUDENT_SURFACES) {
    assert.match(view(file), /const pollInterval = ref\(3000\)/, `${label}: 3s`);
  }
});

test("the first poll fires immediately, not at +3s", () => {
  // Re-opening the link after the repository already exists is a normal way to
  // arrive here, and three seconds of "Setting up your repository…" for
  // something already set up is three seconds of the page being wrong.
  for (const [file, label] of STUDENT_SURFACES) {
    const src = view(file);
    const start = src.indexOf("function startPolling");
    assert.ok(start > 0, `${label}: startPolling must exist`);
    const body = src.slice(start, src.indexOf("\n}", start));
    // `^\s*tick\(\)\s*$` rather than `\n  tick()\n`: these files are CRLF, so
    // an \n-anchored match never fires and the assertion would be checking
    // nothing at all.
    assert.match(body, /^\s*tick\(\)\s*$/m, `${label}: startPolling must run one tick synchronously`);
  }
});

test("timing out distinguishes 'accept your invitation' from 'it was never created'", () => {
  // The old copy told EVERY timed-out student their repository "has almost
  // certainly been created" and handed them the guessed link. For a student
  // whose provisioning genuinely failed that is a 404 and no idea why.
  const src = view("views/AssignmentView.vue");
  // `blocked-account` is rendered BEFORE `timeout`, so slicing between them
  // in template order gives an empty string - and every assertion below would
  // have passed against nothing.
  const from = src.indexOf(`acceptState === 'timeout'`);
  assert.ok(from > 0, "the timeout branch must still exist");
  const rest = src.slice(from);
  const next = rest.indexOf(`v-else-if="acceptState`, 10);
  const timeout = next === -1 ? rest.slice(0, 4000) : rest.slice(0, next);
  assert.ok(timeout.length > 200, "the timeout branch must still have content");
  assert.match(timeout, /<h2 v-if="showInvitationGuess">One more step - accept your invitation<\/h2>/);
  assert.match(timeout, /<h2 v-else>Your repository has not appeared<\/h2>/);
  assert.ok(
    !/almost certainly been created/.test(timeout),
    "a claim the page cannot support, made to the students it is least true for",
  );

  const group = view("components/GroupAcceptanceCard.vue");
  assert.match(group, /<h2 v-else>Your team repository has not appeared<\/h2>/);
});

test("a 404 on the guessed link is explained wherever it is offered", () => {
  // The one thing nobody said: what it MEANS when that page 404s.
  for (const [file, label] of STUDENT_SURFACES) {
    assert.match(view(file), /404/, `${label}: say what a 404 there means`);
  }
});
