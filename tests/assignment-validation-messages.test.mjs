// ARCHITECTURE §10.4 - the assignment form's validation speaks to lecturers.
//
// `AdminView.validate()` rendered AJV verbatim, so a lecturer who typed
// `Task 1` as a test id was told
//
//     /autograde/tests/0/id must match pattern "^[a-z0-9][a-z0-9-]{0,63}$"
//
// - a JSON Pointer, a keyword and a regex, none of which is on their screen.
//
// These run the REAL schema through the REAL validator and hand the REAL error
// objects to the formatter. A test that hand-built an AJV error would pass
// while the schema drifted underneath it, which is the whole failure mode this
// file exists to catch: `lib/validate.mjs` and the SPA read the same files in
// `schemas/` (vite serves `/schemas/*` straight from there), so if a keyword or
// an instancePath changes shape, this goes red rather than the panel quietly
// falling back to raw text.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

import { validateAgainst } from "../lib/validate.mjs";
import {
  formatAssignmentValidationError,
  rawValidationError,
} from "../frontend/src/lib/validation-messages.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const base = () => parse(readFileSync(join(root, "tests", "fixtures", "valid-assignment.yml"), "utf8"));

/** Validate for real, and return every error rendered through the formatter. */
function messagesFor(doc) {
  const { valid, errors } = validateAgainst("assignment", doc);
  assert.equal(valid, false, "the fixture must actually be invalid, or this test proves nothing");
  return errors.map((e) => formatAssignmentValidationError(e, doc));
}

const withAutograde = (tests, over = {}) => ({
  ...base(),
  ...over,
  autograde: { enabled: true, tests },
});

/** Assert at least one message matches, and that none is still raw AJV. */
function says(messages, needle) {
  assert.ok(
    messages.some((m) => m.includes(needle)),
    `expected a message containing ${JSON.stringify(needle)}; got ${JSON.stringify(messages)}`
  );
}

// --------------------------------------------------------------- autograding

test("autograding on with no tests explains the two ways out", () => {
  const messages = messagesFor(withAutograde([]));
  says(messages, "Autograding is on but no tests are defined");
  says(messages, "turn autograding off");
});

test("a test id that is not a slug says what a slug is, and quotes what they typed", () => {
  const messages = messagesFor(withAutograde([{ id: "Task 1", type: "run", command: "make", points: 1 }]));
  says(messages, 'Test "Task 1"');
  says(messages, "lowercase letters, numbers and dashes");
  says(messages, "no spaces, capitals or underscores");
  // The regex, the keyword and the JSON Pointer are gone.
  assert.ok(
    !messages.some((m) => m.includes("must match pattern") || m.includes("/autograde/tests/0/id")),
    `raw AJV leaked: ${JSON.stringify(messages)}`
  );
});

test("a blank test id is asked for by position, not quoted as an empty name", () => {
  const messages = messagesFor(withAutograde([{ id: "", type: "run", command: "make", points: 1 }]));
  says(messages, "Test 1: give it an ID");
  assert.ok(!messages.some((m) => m.includes('Test ""')), `an empty name is not a name: ${JSON.stringify(messages)}`);
});

test("a python test with no script gets the sentence, not the required-property keyword", () => {
  const messages = messagesFor(withAutograde([{ id: "validator", type: "python", points: 1 }]));
  says(messages, 'Test "validator": a python test needs a script');
  assert.ok(
    !messages.some((m) => m.includes("must have required property")),
    `raw AJV leaked: ${JSON.stringify(messages)}`
  );
});

test("a test missing its points is named by its own id", () => {
  const messages = messagesFor(withAutograde([{ id: "compile", type: "run", command: "make" }]));
  says(messages, 'Test "compile": give it a points value');
});

test("negative points and an impossible timeout are refused in lecturer words", () => {
  says(
    messagesFor(withAutograde([{ id: "compile", type: "run", command: "make", points: -5 }])),
    'Test "compile": points must be a number and cannot be negative'
  );
  says(
    messagesFor(withAutograde([{ id: "compile", type: "run", command: "make", points: 1, timeout_s: 0 }])),
    'Test "compile": the timeout must be a whole number of seconds between 1 and 600'
  );
});

test("a field a test cannot have is named, since additionalProperties is where hand-edits land", () => {
  const messages = messagesFor(
    withAutograde([{ id: "validator", type: "python", script: "assert True", points: 1, setup_command: "pip install pytest" }])
  );
  says(messages, 'Test "validator": "setup_command" is not a field a test can have');
});

// ---------------------------------------------------------------- group size

test("team size limits are quoted from the schema rather than hard-coded", () => {
  const doc = {
    ...base(),
    assignment_type: "group",
    repository_name_pattern: "test-valid-{team_slug}",
    group_config: { max_team_size: 1 },
  };
  says(messagesFor(doc), "Maximum team size must be at least 2.");

  const minDoc = { ...doc, group_config: { max_team_size: 3, min_team_size: 0 } };
  says(messagesFor(minDoc), "Minimum team size must be at least 1.");
});

// ---------------------------------------------------------------- guardrails

test("open enrollment without a cap says why the cap exists", () => {
  const doc = { ...base(), roster_mode: "open" };
  delete doc.max_acceptances;
  const messages = messagesFor(doc);
  says(messages, "Open enrollment requires a maximum number of acceptances");
  says(messages, "the only limit on who can claim a repo");
});

test("a zero cap points at the field that means no cap", () => {
  says(messagesFor({ ...base(), max_acceptances: 0 }), "leave the field empty for no cap");
});

// ------------------------------------------------------------- the fallback

test("an error nobody mapped is still shown, verbatim", () => {
  // The rule the roster formatter follows too: swallowing an unfamiliar error
  // leaves a Save button that does nothing and no reason for it.
  const doc = { ...base(), state: "nonsense" };
  const { errors } = validateAgainst("assignment", doc);
  const stateErr = errors.find((e) => e.instancePath === "/state");
  assert.ok(stateErr, "the fixture must produce a /state error");

  const formatted = formatAssignmentValidationError(stateErr, doc);
  assert.equal(formatted, rawValidationError(stateErr));
  assert.ok(formatted.includes("/state"), "the path is part of what makes an unmapped error actionable");
});

test("the formatter never throws on an error it has no document for", () => {
  // validate() maps every error it is given; a crash there would take the Save
  // handler with it and leave the form frozen rather than merely unhelpful.
  const { errors } = validateAgainst("assignment", withAutograde([{ id: "Task 1", type: "run", points: 1 }]));
  for (const e of errors) {
    assert.equal(typeof formatAssignmentValidationError(e, undefined), "string");
    assert.equal(typeof formatAssignmentValidationError(e, null), "string");
    assert.equal(typeof formatAssignmentValidationError(e, {}), "string");
  }
});
