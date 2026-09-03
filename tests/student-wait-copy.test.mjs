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

test("the guessed invitation link is gated on nothing having been proven", () => {
  // The rule used to be "only when the invitations read FAILED", on the
  // premise that a read which answered told us the truth. It does not: live on
  // 3 Sep 2026 `GET /user/repository_invitations` answered 200 without a
  // pending invitation that provably existed, so the page concluded there was
  // none and said so. tests/invitation-evidence.test.mjs holds the measurement.
  //
  // What replaced it: a MATCH is the only proof, and it puts the page in
  // `invited` with a real in-app Accept button. Everything else is unknown, and
  // the link is offered precisely because the page cannot tell.
  for (const [file, label] of STUDENT_SURFACES) {
    const src = view(file);
    assert.match(
      src,
      /const showInvitationGuess = computed\(\(\) =>\s*mayOfferInvitationLink\(invitationProven\.value, invitationUrl\.value\),?\s*\)/,
      `${label}: the guess must be gated on nothing having been PROVEN`,
    );
    assert.match(
      src,
      /invitationProven\.value = evidence\.proven/,
      `${label}: the poll must record proof, not readability`,
    );
    assert.ok(
      !/invitationsReadable/.test(src),
      `${label}: "the read answered" is not knowledge about invitations - that is the bug`,
    );
    assert.ok(
      !/v-if="pollCount >= 5 && invitationUrl"/.test(src),
      `${label}: a timer is not evidence of an invitation - that is the older bug`,
    );
  }
});

test("no student surface claims there is no invitation waiting", () => {
  // The sentence that was on screen beside a repository that existed and an
  // invitation with the student's name on it. Nothing may assert the negative,
  // in any wording, because nothing can check it.
  for (const [file, label] of STUDENT_SURFACES) {
    const text = rendered(file);
    assert.ok(
      !/no invitation waiting/i.test(text),
      `${label}: the page cannot see pending invitations, so it may not rule one out`,
    );
    // And it must say why it is offering a link rather than an answer. Without
    // this the copy could drift back to asserting one of the two possibilities
    // while still passing the sweep above.
    assert.match(
      text,
      /cannot tell which/,
      `${label}: name both possibilities and admit the page cannot choose`,
    );
  }
});

test("the guessed link is held back past the ordinary provisioning window", () => {
  // It is now shown to everyone still waiting, not only the blind - so the
  // threshold is the whole protection against handing a worry to every student
  // on the happy path. pollCount 20 is ~60s at the 3s cadence, past the 20-40s
  // ordinary case, and past the window where the URL would 404.
  for (const [file, label] of STUDENT_SURFACES) {
    assert.match(
      view(file),
      /v-if="pollCount >= 20 && showInvitationGuess"/,
      `${label}: not before ~60s`,
    );
  }
});

test("nothing accuses the student of not having accepted something", () => {
  // "GitHub may be waiting for you to accept an invitation" was asserted from
  // a timer, and for an org member it is never true.
  //
  // What this forbids is naming it as THE cause. Offering it as one of two
  // possibilities the page says it cannot choose between is a different claim,
  // and is what the timeout state does now - so the copy there is worded as
  // "either there is an invitation you still need to accept, or setup did not
  // finish", which is not this sentence and does not accuse anyone.
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

test("timing out names both possibilities and picks neither", () => {
  // Three copies have stood here. The first told EVERY timed-out student their
  // repository "has almost certainly been created" and handed them the guessed
  // link - a 404 and no idea why, for the ones whose provisioning failed. The
  // second split on whether the invitations read answered, and its negative
  // branch stated "GitHub has no repository for you and no invitation waiting"
  // as fact; that is the sentence a student read on 3 Sep 2026 while holding
  // an unaccepted invitation.
  //
  // This one says there are two possibilities, says the page cannot tell them
  // apart, and hands over the one check the student CAN run - where a 404 is
  // itself the answer.
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
  assert.match(timeout, /<h2>Your repository has not appeared<\/h2>/);
  assert.ok(
    !/<h2 v-if=/.test(timeout),
    "one headline: the page has no evidence on which to choose between two",
  );
  assert.match(
    timeout,
    /cannot tell which/,
    "the page must say it cannot tell, rather than pick the answer it renders best",
  );
  assert.match(timeout, /404/, "and a 404 on that link is the student's own way to settle it");
  assert.ok(
    !/almost certainly been created/.test(timeout),
    "a claim the page cannot support, made to the students it is least true for",
  );

  const group = view("components/GroupAcceptanceCard.vue");
  assert.match(group, /<h2>Your team repository has not appeared<\/h2>/);
  assert.ok(
    !/no invitation waiting/.test(group),
    "the group card carried the same sentence and the same false premise",
  );
});

test("a 404 on the guessed link is explained wherever it is offered", () => {
  // The one thing nobody said: what it MEANS when that page 404s.
  for (const [file, label] of STUDENT_SURFACES) {
    assert.match(view(file), /404/, `${label}: say what a 404 there means`);
  }
});

test("the diagnostics modal reports the invitation check as unrunnable, not as clear", () => {
  // It said "Repository Collaboration Invitation: Clear - No blocked
  // invitations detected" under "All diagnostic checks look healthy", to a
  // student whose repository was sitting behind an unaccepted invitation. The
  // modal has no way to check this: it reads the same `pendingInvitation` the
  // acceptance page holds, which is set only when a match was FOUND. A green
  // tick on an unasked question is worse than no check.
  const src = view("components/StudentDiagnosticsModal.vue");
  const text = rendered("components/StudentDiagnosticsModal.vue");

  assert.ok(!/'Clear'/.test(src), "'Clear' is a verdict this check cannot reach");
  assert.ok(
    !/No blocked invitations detected/.test(text),
    "nor is 'none detected' - nothing detected them because nothing could look",
  );
  assert.ok(
    !/All diagnostic checks look healthy/.test(text),
    "one of them cannot be run, so 'all healthy' is false on its face",
  );
  assert.match(
    text,
    /Cannot be checked from here/,
    "say that it cannot be checked, which is the true answer",
  );

  // The copyable report is what a student pastes to their lecturer, and
  // silence there reads as "no invitation" to the person who can actually fix
  // it. It must carry the unknown explicitly.
  const from = src.indexOf("async function copyReport");
  assert.ok(from > 0, "copyReport must still exist");
  const report = src.slice(from, from + 1600);
  assert.match(report, /Pending invitation/, "the report names the check");
  assert.match(report, /unknown/, "and says it is unknown rather than leaving it out");
});
