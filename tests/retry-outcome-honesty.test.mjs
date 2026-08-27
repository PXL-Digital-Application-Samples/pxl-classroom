// A green retry run is not a repository.
//
// `accept.mjs` splits reject() (exit 0, `rejected:*`) from fail() (exit 1,
// `fail:*`) deliberately: a student who is not on the roster, or arrives after
// the deadline, is the system working, and painting the hub's Actions tab red
// for that teaches people to ignore red runs.
//
// The consequence is that retry-acceptance.yml concludes `success` when it
// REFUSED, and none of its follow-up steps fire either - so the run is green
// and says nothing. The SPA read that conclusion and told the lecturer
//
//     "Retry succeeded: repository is live."
//
// with a link to a repository that does not exist. And the most likely reason a
// lecturer retries an acceptance in the first place is a student the roster
// rejects, which is exactly the case that produced the false success.
//
// The fix is the rule this repo already applies to publish liveness: verify the
// claim being made (does the repository exist?) rather than the run that was
// asked to make it. acceptanceCardIsLive fetches the card instead of trusting
// the assignments index, for the same reason.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const VIEW = join(root, "frontend", "src", "views", "AssignmentDetailView.vue");

function retryWatchBody() {
  const src = readFileSync(VIEW, "utf8");
  const fn = src.slice(src.indexOf("function startRetryWatch"));
  return fn.slice(0, fn.indexOf("\nasync function "));
}

test("accept.mjs still exits 0 for a rejection - the premise of this test", () => {
  // If this ever changes, the SPA's handling can be simplified; until then a
  // successful conclusion genuinely carries no information about the outcome.
  const src = readFileSync(join(root, "acceptance", "accept.mjs"), "utf8");
  const fn = src.slice(src.indexOf("async function reject("));
  const body = fn.slice(0, fn.indexOf("\n}") + 2);
  assert.match(body, /exit\(0\)/, "reject() must exit 0, or the rejection paints the hub red");
});

test("the retry does not announce success on a green run alone", () => {
  const body = retryWatchBody();

  const successAt = body.indexOf("Retry succeeded");
  assert.ok(successAt > 0, "the success toast should still exist");

  // A repository check must sit between the conclusion test and the claim.
  const conclusionAt = body.indexOf("conclusion === 'success'");
  const verifyAt = body.indexOf("getRepo(");
  assert.ok(conclusionAt > 0, "it should still read the run conclusion");
  assert.ok(verifyAt > conclusionAt, "the repository must be checked after the conclusion");
  assert.ok(
    verifyAt < successAt,
    "the repository must be verified BEFORE claiming it is live - a green run is not a repository",
  );
});

test("a refused retry is reported as refused, and does not guess which rejection", () => {
  const body = retryWatchBody();
  assert.match(
    body,
    /still has no repository/,
    "a run that created nothing must say so rather than claiming success",
  );
  assert.match(
    body,
    /html_url/,
    "and must link the run, because the reason lives in its log",
  );

  // Naming a specific cause would be a guess: the outcome string is not
  // available from the run summary, and naming the wrong one is worse than
  // naming none - the same rule the provisioning wait screen follows.
  for (const guess of ["not on the roster", "deadline", "cap reached"]) {
    assert.ok(
      !body.includes(guess),
      `the toast must not guess the rejection reason ("${guess}") - it cannot know it`,
    );
  }
});

test("the success path still links the repository it verified", () => {
  const body = retryWatchBody();
  const successAt = body.indexOf("Retry succeeded");
  const after = body.slice(successAt, successAt + 300);
  assert.match(after, /repoName/, "the success toast should still link the repository");
});
