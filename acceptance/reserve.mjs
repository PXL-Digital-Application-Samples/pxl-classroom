#!/usr/bin/env node
// Decide an acceptance and save the decision - deciding again whenever another
// run saved something the decision depended on first.
//
// This replaces the GitHub concurrency group that used to serialise joins to a
// team. Why that had to go, and why this is safe without it, is in
// lib/acceptance-reservation.mjs. In short: the save is a push WITHOUT a
// rebase, GitHub refuses it when somebody pushed in between, and then:
//
//   * if what they pushed touched an input of this decision (the team's
//     manifest, this student's record, the roster or claims, the assignment),
//     the checkout is reset to theirs and accept.mjs runs again from scratch -
//     so a team that filled up in the meantime is now a refusal;
//   * otherwise this commit is replayed on top of theirs and pushed again.
//
// The decision is saved BEFORE provisioning, not after it with the repository
// record as it used to be. Saved after, a decision is only as good as the
// queue that kept a second run from making the same one - which is the queue
// this replaces. Provisioning then acts on a membership nobody can take back.
//
// Every output and summary line is forwarded from the LAST decision only. An
// earlier decision that was never saved must not leak a single output into the
// steps that provision: if the saves run out, the outcome is `fail:reserve`,
// whatever accept.mjs said.
//
// Inputs via env: everything accept.mjs reads, plus
//   SET_ASIDE         "true" on a lecturer's Retry: copy this student's
//                     acceptance record to PRIOR_ACCEPTANCE_FILE and remove it
//                     from the checkout before every decision, so the gates
//                     run again rather than the already-accepted shortcut.
//                     Never committed on a refusal (pathsToCommit), so a
//                     refused Retry changes nothing.
//   PERSIST_REFUSALS  "false" on a Retry, whose refusals were never counted
//                     against the student.

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { claimConcerns, decisionInputsChanged, pathsToCommit, teamConcerns } from "../lib/acceptance-reservation.mjs";
import { acceptancePath } from "../lib/control-layout.mjs";
import { claimPath } from "../lib/claim.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || ".";
const assignmentId = process.env.ASSIGNMENT_ID || "";
const login = process.env.GITHUB_LOGIN || "";
const setAside = process.env.SET_ASIDE === "true";
const persistRefusals = process.env.PERSIST_REFUSALS !== "false";
// Each attempt is a fetch, maybe a decision, and a push - seconds. Twenty-five
// with the backoff below is about three minutes at worst, well inside the job's
// ten, and enough for a lecture hall accepting in the same minute.
const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS || 25);
const githubId = /^[0-9]{1,20}$/.test(process.env.GITHUB_ID || "") ? process.env.GITHUB_ID : null;

// The same shapes accept.mjs validates. Checked here too because this file
// builds a path from them BEFORE accept.mjs runs (the set-aside below).
const SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const namesValid = SLUG.test(assignmentId) && LOGIN.test(login);

const scratch = mkdtempSync(join(tmpdir(), "pxl-reserve-"));

function git(args) {
  const r = spawnSync("git", ["-C", dataDir, ...args], { encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Grows with the attempt so a burst spreads out rather than colliding again in
// lockstep; random so two runs that collided once do not collide every time.
const backoff = (attempt) => Math.min(attempt, 5) * 800 + Math.floor(Math.random() * 2000);

/** The last `name=` accept.mjs wrote, which is the one that stands. */
function outputIn(file, name) {
  if (!existsSync(file)) return "";
  let value = "";
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.startsWith(`${name}=`)) value = line.slice(name.length + 1).trim();
  }
  return value;
}
const outcomeIn = (file) => outputIn(file, "outcome");

/** A file's content at a commit, or null when it does not exist there. */
function blobAt(ref, path) {
  const r = git(["show", `${ref}:${path}`]);
  return r.ok ? r.out : null;
}

/**
 * Does this version of a team manifest or claim binding concern THIS decision?
 * Asked of the version our decision read and of the one that beat it: a team
 * that listed the student before, or lists them now, concerns them either way.
 */
function concernsUs(decided, readRef = "HEAD~1") {
  const teamSlug = outputIn(decided.out, "team_slug") || null;
  const ownClaim = githubId ? blobAt("HEAD", claimPath(Number(githubId))) : null;
  let ownEmail = null;
  try {
    ownEmail = ownClaim ? JSON.parse(ownClaim)?.email ?? null : null;
  } catch {
    ownEmail = null;
  }
  return (path, kind) =>
    [readRef, "FETCH_HEAD"].some((ref) => {
      const text = blobAt(ref, path);
      return kind === "team" ? teamConcerns(text, { login, teamSlug, path }) : claimConcerns(text, ownEmail);
    });
}

function forward({ out, sum }) {
  if (process.env.GITHUB_OUTPUT && existsSync(out)) appendFileSync(process.env.GITHUB_OUTPUT, readFileSync(out, "utf8"));
  if (process.env.GITHUB_STEP_SUMMARY && existsSync(sum)) appendFileSync(process.env.GITHUB_STEP_SUMMARY, readFileSync(sum, "utf8"));
}

function finish(code) {
  rmSync(scratch, { recursive: true, force: true });
  process.exit(code);
}

// Where a Retry's set-aside record is copied for accept.mjs to read its
// `accepted_at` and `issue_number` from. TAKEN HERE, BEFORE EVERY DECISION, from
// the checkout that decision reads - never once before the first. A copy taken
// when the job started is stale the moment the student's own attempt saves in
// between, and a Retry that then decided again read the old copy and dropped
// the attempt number the student's newer decision had stamped (found by
// tests/acceptance-race.test.mjs).
const priorFile = process.env.PRIOR_ACCEPTANCE_FILE || join(scratch, "prior-acceptance.json");

/** Run accept.mjs once against the checkout as it is now. */
function decide(n) {
  if (setAside && namesValid) {
    const own = join(dataDir, acceptancePath(assignmentId, login));
    if (existsSync(own)) {
      writeFileSync(priorFile, readFileSync(own));
      rmSync(own);
    } else {
      // The record this attempt reads is absent, so there is nothing prior -
      // whatever an earlier attempt copied describes a state that is gone.
      rmSync(priorFile, { force: true });
    }
  }
  const out = join(scratch, `output-${n}`);
  const sum = join(scratch, `summary-${n}`);
  writeFileSync(out, "");
  writeFileSync(sum, "");
  const r = spawnSync(process.execPath, [join(here, "accept.mjs")], {
    stdio: "inherit",
    env: { ...process.env, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: sum, ...(setAside ? { PRIOR_ACCEPTANCE_FILE: priorFile } : {}) },
  });
  return { out, sum, status: r.status ?? 1, outcome: outcomeIn(out) };
}

/** Throw away everything since the remote's state, including our own commit. */
function resetTo(ref) {
  git(["rebase", "--abort"]);
  git(["reset", "-q", "--hard", ref]);
  // Only the directories a decision writes. This checkout is the control
  // repository, but a caller could point DATA_DIR anywhere, and `clean -fd`
  // over a whole workspace is not a thing to do on a guess.
  git(["clean", "-fdq", "--", "acceptances", "teams", "students"]);
}

async function main() {
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]).out;
  if (!branch || branch === "HEAD") {
    console.log(`::error::The control checkout at ${dataDir} is not on a branch, so a decision cannot be saved.`);
    finish(1);
  }

  let decided = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (!decided) {
      decided = decide(attempt);
      if (decided.status !== 0) {
        // fail:* - accept.mjs already said why. Nothing it wrote is committed.
        forward(decided);
        finish(decided.status);
      }
      const paths = pathsToCommit(decided.outcome, { persistRefusals });
      if (paths === null) {
        console.log(`::error::accept.mjs reported outcome "${decided.outcome}", which lib/acceptance-reservation.mjs does not classify - nothing was saved.`);
        writeFileSync(decided.out, "outcome=fail:reserve\n");
        forward(decided);
        finish(1);
      }
      const present = paths.filter((p) => existsSync(join(dataDir, p)));
      if (present.length) git(["add", "--", ...present]);
      if (git(["diff", "--cached", "--quiet"]).ok) {
        // Nothing to save: a superseded attempt, an idempotent confirmation, a
        // refusal that counted nothing.
        //
        // NOTHING SAVED IS NOTHING PUSHED, so the refused push below - the one
        // place a decision is checked against what other runs saved since this
        // checkout - never happens for it. And a decision that writes nothing
        // still READ the checkout: two students creating one new team at once,
        // the second checked out before the first saved, saw the first one's
        // repository on GitHub but not the decision that made it, and was
        // refused as "a previous team's repository" - finally, because nothing
        // ever looked again (tests/acceptance-race.test.mjs, 1 run in 4 under
        // load). So ask the branch once: if it moved, and what moved is
        // something this decision read, decide again on the newer state.
        // A fetch GitHub fails is tried again a few times; one that never
        // succeeds leaves the decision as it was, which is what it was before
        // this check existed.
        let fetched = false;
        for (let tries = 0; tries < 3 && !fetched; tries++) {
          if (tries) await sleep(backoff(tries));
          fetched = git(["fetch", "-q", "origin", branch]).ok;
        }
        if (attempt < MAX_ATTEMPTS && fetched && !git(["merge-base", "--is-ancestor", "FETCH_HEAD", "HEAD"]).ok) {
          const moved = git(["diff", "--name-only", "HEAD", "FETCH_HEAD"]);
          const stale =
            !moved.ok ||
            decisionInputsChanged(moved.out.split("\n"), { assignmentId, login, githubId }, { concerns: concernsUs(decided, "HEAD") });
          if (stale) {
            console.log(`[ok] reserve - another run saved what this decision read; deciding again (attempt ${attempt + 1})`);
            resetTo("FETCH_HEAD");
            decided = null;
            continue;
          }
        }
        forward(decided);
        finish(0);
      }
      const commit = git([
        "-c", "user.name=pxl-classroom[bot]",
        "-c", "user.email=pxl-classroom[bot]@users.noreply.github.com",
        "commit", "-q", "-m", `Decide ${decided.outcome} for ${login} on ${assignmentId}`,
      ]);
      if (!commit.ok) {
        console.log(`::error::Could not commit the decision for ${login}: ${commit.err}`);
        writeFileSync(decided.out, "outcome=fail:reserve\n");
        forward(decided);
        finish(1);
      }
    }

    const push = git(["push", "-q", "origin", `HEAD:refs/heads/${branch}`]);
    if (push.ok) {
      if (attempt > 1) console.log(`[ok] reserve - saved on attempt ${attempt}`);
      forward(decided);
      finish(0);
    }

    // Somebody pushed first - or GitHub failed the push, or took it and lost
    // the answer on the way back.
    await sleep(backoff(attempt));
    if (!git(["fetch", "-q", "origin", branch]).ok) continue;
    // THE PUSH LANDED AFTER ALL. A connection that drops after GitHub updated
    // the branch reports a failure for a commit that is there; deciding again
    // would only rediscover our own decision.
    if (git(["merge-base", "--is-ancestor", "HEAD", "FETCH_HEAD"]).ok) {
      console.log(`[ok] reserve - the push reported a failure but the decision is on the branch (attempt ${attempt})`);
      forward(decided);
      finish(0);
    }
    const changed = git(["diff", "--name-only", "HEAD~1", "FETCH_HEAD"]);
    const inputs =
      !changed.ok ||
      decisionInputsChanged(changed.out.split("\n"), { assignmentId, login, githubId }, { concerns: concernsUs(decided) });
    if (inputs) {
      console.log(`[ok] reserve - another run changed what this decision read; deciding again (attempt ${attempt + 1})`);
      resetTo("FETCH_HEAD");
      decided = null;
      continue;
    }
    if (!git(["rebase", "-q", "FETCH_HEAD"]).ok) {
      // Cannot happen when the inputs are untouched - our commit writes only
      // inputs - but a failed replay is answered by deciding again, never by
      // pushing something half-applied.
      console.log(`[ok] reserve - could not replay the decision; deciding again (attempt ${attempt + 1})`);
      resetTo("FETCH_HEAD");
      decided = null;
    }
  }

  console.log(
    `::error::The acceptance of ${login} for ${assignmentId} was decided but could not be saved after ${MAX_ATTEMPTS} attempts - ` +
      `nothing was provisioned. They can accept again from their link, or press Retry for them.`,
  );
  const failed = join(scratch, "output-failed");
  writeFileSync(failed, `assignment_id=${assignmentId}\ngithub_login=${login}\noutcome=fail:reserve\n`);
  forward({ out: failed, sum: join(scratch, "none") });
  finish(1);
}

main().catch((e) => {
  console.log(`::error::reserve failed: ${e.message}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, "outcome=fail:reserve\n");
  finish(1);
});
