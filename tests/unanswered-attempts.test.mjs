// lib/unanswered-attempts.mjs: which acceptance attempts the nightly reports
// to the lecturer as having got no answer at all.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { UNANSWERED_SETTLE_MS, UNANSWERED_WINDOW_MS, unansweredAttempts } from "../lib/unanswered-attempts.mjs";

const script = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "find-unanswered-attempts.mjs");

/** The script against a stub API: `brokers` maps a broker name to how its issues answer. */
async function runScript(assignments, brokers) {
  const server = createServer((req, res) => {
    const send = (code, body) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const [url] = req.url.split("?");
    const m = url.match(/^\/repos\/Org\/([^/]+)(\/issues)?$/);
    const b = m && brokers[m[1]];
    if (!b || b === "gone") return send(404, { message: "Not Found" });
    // 403, not a 5xx: a 5xx is retried with backoff, which only slows the test.
    if (m[2]) return b === "unreadable" ? send(403, { message: "no" }) : send(200, []);
    return send(200, { name: m[1] });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const dir = mkdtempSync(join(tmpdir(), "pxl-unanswered-"));
  mkdirSync(join(dir, "assignments"));
  for (const [id, state] of Object.entries(assignments)) writeFileSync(join(dir, "assignments", `${id}.yml`), `state: ${state}\n`);
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn("node", [script, dir, "Org"], { env: { ...process.env, GITHUB_TOKEN: "stub", GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`, GITHUB_OUTPUT: join(dir, "out.env") } });
      let log = "";
      child.stdout.on("data", (d) => (log += d));
      child.stderr.on("data", (d) => (log += d));
      child.on("error", reject);
      child.on("close", (status) => resolve({ status, log }));
    });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test("a closed assignment whose broker was deleted has no attempts to check, and says so without a warning", async () => {
  // PXL-2TIN-CloudEssentials-2627, 2026-10-23: a closed test assignment whose
  // broker the lecturer deleted warned every night that it could not be read.
  const res = await runScript({ "old-test": "closed", live: "published" }, { "old-test": "gone", "broker-live": "ok" });
  assert.equal(res.status, 0, res.log);
  assert.doesNotMatch(res.log, /::warning::/, res.log);
  assert.match(res.log, /Org\/old-test: closed, and its broker broker-old-test no longer exists/);
  assert.doesNotMatch(res.log, /could not be read/);
});

test("a published assignment with no broker is the finding: nobody can accept it", async () => {
  const res = await runScript({ live: "published" }, {});
  assert.match(res.log, /::warning::Org\/live is published but its broker broker-live does not exist, so nobody can accept it/, res.log);
});

test("a broker that exists and cannot be read is still a failed read", async () => {
  const res = await runScript({ live: "published" }, { "broker-live": "unreadable" });
  assert.match(res.log, /::warning::Could not read the attempts on Org\/broker-live/, res.log);
  assert.match(res.log, /1 broker\(s\) could not be read/);
});

const now = new Date("2026-10-03T02:00:00Z");
const ago = (min) => new Date(now.getTime() - min * 60_000).toISOString();
const issue = (number, login, title, minutesAgo, labels = []) => ({
  number,
  title,
  created_at: ago(minutesAgo),
  user: { login },
  labels: labels.map((name) => ({ name })),
});
const none = () => null;

test("an attempt handed over and never answered is reported", () => {
  const out = unansweredAttempts({ issues: [issue(66, "Sabri", "Acceptance (processed)", 600)], acceptanceOf: none, now });
  assert.deepEqual(out, [{ login: "Sabri", number: 66, created_at: ago(600), stage: "no-answer", purpose: "accept" }]);
});

test("where it stopped is read off the title", () => {
  const out = unansweredAttempts({
    issues: [
      issue(1, "a", "pxl-accept:k1.AAAA.BBBB team:x", 600),
      issue(2, "b", "Acceptance (not delivered)", 600),
      issue(3, "c", "Acceptance (processed)", 600),
    ],
    acceptanceOf: none,
    now,
  });
  assert.deepEqual(out.map((o) => o.stage), ["not-started", "not-delivered", "no-answer"]);
});

test("an answer of any kind is an answer", () => {
  const out = unansweredAttempts({
    issues: [
      issue(10, "invited", "Acceptance (processed)", 600, ["outcome:invited"]),
      issue(11, "refused", "Acceptance (processed)", 600, ["outcome:rejected"]),
      issue(12, "brokerRefused", "Acceptance attempt (rejected)", 600),
      issue(13, "decided", "Acceptance (processed)", 600),
      issue(14, "legacy", "Acceptance (processed)", 600),
    ],
    acceptanceOf: (login) =>
      login === "decided" ? { issue_number: 13 } : login === "legacy" ? { status: "provisioned" } : null,
    now,
  });
  assert.deepEqual(out, []);
});

test("a decision for an OLDER attempt does not answer a newer one", () => {
  // A team switch GitHub dropped: the record still names the first join.
  const out = unansweredAttempts({
    issues: [issue(20, "s", "Acceptance (processed)", 600)],
    acceptanceOf: () => ({ issue_number: 12 }),
    now,
  });
  assert.equal(out.length, 1);
});

test("only the newest attempt per student is judged", () => {
  const out = unansweredAttempts({
    issues: [
      issue(61, "Sabri", "Acceptance (processed)", 700),
      issue(64, "Sabri", "Acceptance (processed)", 690),
      issue(68, "Sabri", "Acceptance (processed)", 680),
    ],
    acceptanceOf: () => ({ issue_number: 68 }),
    now,
  });
  assert.deepEqual(out, [], "the newest was decided; the older ones were overtaken");
});

test("too recent may still be running, too old was reported already", () => {
  const settle = UNANSWERED_SETTLE_MS / 60_000;
  const windowMin = UNANSWERED_WINDOW_MS / 60_000;
  const out = unansweredAttempts({
    issues: [
      issue(1, "fresh", "Acceptance (processed)", settle - 1),
      issue(2, "old", "Acceptance (processed)", windowMin + 1),
      issue(3, "inside", "Acceptance (processed)", settle + 1),
    ],
    acceptanceOf: none,
    now,
  });
  assert.deepEqual(out.map((o) => o.login), ["inside"]);
});

test("R7-6: an address confirmation is reported where its issue shows it went nowhere - never once handed over", () => {
  // A confirmation's answer is in the private control repository, and the hub
  // labels its issue only on a refusal: handed over, answered and unanswered
  // read the same. One the broker never ran on (switched off) or could not
  // pass on is evidence; an issue written by hand is nothing.
  const out = unansweredAttempts({
    issues: [
      issue(1, "a", "pxl-confirm:k1.AAAA.BBBB", 600),
      issue(2, "b", "Email confirmation (processed)", 600),
      issue(3, "c", "Email confirmation (not delivered)", 600),
      issue(4, "d", "Please help", 600),
    ],
    acceptanceOf: none,
    now,
  });
  assert.deepEqual(out.map((o) => [o.login, o.stage, o.purpose]), [["a", "not-started", "confirm"], ["c", "not-delivered", "confirm"]]);
});

test("R7-6: an acceptance and a confirmation by one student are separate questions", () => {
  const out = unansweredAttempts({
    issues: [issue(7, "ann", "pxl-accept:k1.AAAA.BBBB", 600), issue(8, "ann", "pxl-confirm:k1.AAAA.BBBB", 500)],
    acceptanceOf: none,
    now,
  });
  assert.deepEqual(out.map((o) => [o.number, o.purpose]), [[7, "accept"], [8, "confirm"]]);
});

test("a later issue that is not an acceptance does not hide the unanswered one before it", () => {
  // Review 2026-10-06: the newest issue per student was picked BEFORE the
  // title filter, so a complaint written on the broker after an unanswered
  // attempt replaced it and was then skipped - the student who said something
  // was the one dropped.
  for (const later of ["I clicked accept and nothing happened", "Email confirmation (processed)", "Acceptance attempt (rejected)"]) {
    const out = unansweredAttempts({
      issues: [issue(5, "ann", "Acceptance (processed)", 600), issue(6, "ann", later, 500)],
      acceptanceOf: none,
      now,
    });
    assert.deepEqual(out.map((o) => o.number), [5], later);
  }
});
