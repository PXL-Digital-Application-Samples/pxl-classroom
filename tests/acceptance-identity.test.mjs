// WHO accepted is one fact, and it was read from three different fields.
//
// The signature binds an acceptance to an account: the payload names a
// `github_id`, and the broker refuses it unless that matches the account that
// authored the issue. That is the entire anti-replay property - a signature
// lifted out of the permanent public event archive is useless to anyone else,
// because replaying it means authoring an issue as yourself.
//
// It only holds if the account we VERIFIED is the account we then act for. The
// broker verified `github.event.issue.user.id`, validated `github.actor` and
// `github.event.sender.id`, and dispatched the second pair to the hub - so the
// check and the provisioning read different fields of the same event.
//
// For a freshly opened issue those agree, which is exactly what makes the split
// dangerous: it is invisible until it is not. An issue opened through a GitHub
// App on a user's behalf reports the App as `sender` and the user as
// `issue.user`, and the broker also computed the verified id as a step output
// and then threw it away.
//
// There is no unit test that can prove GitHub's webhook shape, so this pins the
// thing that is ours: one field, referenced everywhere the identity is needed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const PATH = join(root, "acceptance", "broker-workflow.yml");
const RAW = readFileSync(PATH, "utf8");
const DOC = parse(RAW);

/** The workflow text with comments stripped - they quote the old fields. */
const CODE = RAW.replace(/(^|\s)#.*$/gm, "$1");

const dispatchJob = () => DOC.jobs.dispatch;
const step = (name) => dispatchJob().steps.find((s) => (s.name || "").includes(name));

test("the accepting account is read from the issue author, everywhere", () => {
  const validate = step("Validate actor");
  assert.ok(validate, "the validate step must exist");
  assert.equal(validate.env.ACTOR, "${{ github.event.issue.user.login }}");
  assert.equal(validate.env.ACTOR_ID, "${{ github.event.issue.user.id }}");

  const verify = step("Verify invitation");
  assert.ok(verify, "the verify step must exist");
  assert.equal(verify.env.ISSUE_AUTHOR_ID, "${{ github.event.issue.user.id }}");

  assert.equal(
    verify.env.ISSUE_AUTHOR_ID,
    validate.env.ACTOR_ID,
    "the account whose signature is checked must be the account that gets provisioned",
  );
});

test("no other reading of the same fact survives in the workflow", () => {
  // `github.event.sender` is the account that triggered the delivery and
  // `github.actor` is the account the run is attributed to. Both are usually
  // the issue author here, and neither is what the signature names.
  assert.ok(
    !/github\.event\.sender/.test(CODE),
    "github.event.sender is back - it is a second reading of the accepting account",
  );
  assert.ok(
    !/github\.actor(?![A-Za-z_])/.test(CODE),
    "github.actor is back - it is a third reading of the accepting account",
  );
});

test("the concurrency key is the same field", () => {
  // Per-account serialisation. Keying it on a different field than the one that
  // identifies the acceptance would serialise against the wrong thing, which is
  // the shape of the team-hint bug (§5.6) one level down.
  assert.equal(DOC.concurrency.group, "accept-${{ github.event.issue.user.login }}");
});

test("the dispatch forwards the validated pair and nothing else", () => {
  const dispatch = step("Dispatch to central");
  assert.ok(dispatch, "the dispatch step must exist");
  assert.equal(dispatch.env.ACTOR, "${{ steps.validate.outputs.actor }}");
  assert.equal(dispatch.env.ACTOR_ID, "${{ steps.validate.outputs.actor_id }}");

  // And through env, never composed into the script text.
  assert.ok(
    /client_payload\[github_login\]=\$ACTOR"/.test(dispatch.run),
    "the login must reach the API call as a shell variable",
  );
  assert.ok(
    /client_payload\[github_id\]=\$ACTOR_ID"/.test(dispatch.run),
    "the id must reach the API call as a shell variable",
  );
});

test("the login and the id are both validated before use", () => {
  // They come from a webhook, so the broker treats them as input even though
  // GitHub sets them. A non-numeric id would reach accept.mjs and be recorded.
  const validate = step("Validate actor");
  assert.match(validate.run, /\^\[A-Za-z0-9\]\[A-Za-z0-9-\]\{0,38\}\$/, "login shape must be checked");
  assert.match(validate.run, /\^\[0-9\]\+\$/, "id must be checked as numeric");
});

test("the verified id is not computed and then discarded", () => {
  // scripts/verify-invite-token.mjs emits `github_id` from the SIGNED payload.
  // Either the dispatch uses it, or it is equal by construction to what the
  // dispatch does use - anything else is a second source of truth wearing the
  // first one's name.
  const verify = step("Verify invitation");
  const dispatch = step("Dispatch to central");
  const usesVerified = /steps\.verify\.outputs\.github_id/.test(JSON.stringify(dispatch.env));
  const equalByConstruction =
    verify.env.ISSUE_AUTHOR_ID === step("Validate actor").env.ACTOR_ID &&
    dispatch.env.ACTOR_ID === "${{ steps.validate.outputs.actor_id }}";

  assert.ok(
    usesVerified || equalByConstruction,
    "the dispatched account id must be the one the signature was checked against",
  );
});
