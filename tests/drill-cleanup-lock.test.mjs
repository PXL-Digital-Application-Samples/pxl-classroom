// One drill cleanup at a time per organization - tests/live/cleanup-lock.mjs.
//
// Two sessions ran `drill.mjs cleanup --all` against the testbed nine seconds
// apart and retired one drill twice; the second commit rewrote a record nothing
// regenerates. The lock is a git ref in the control repository, taken with ONE
// create, because that create is the only atomic step GitHub offers.
//
// The fake below behaves as the testbed was measured to on 2026-09-17: a
// second create is 422 "Reference already exists", deleting a missing ref is
// 422 "Reference does not exist" (not 404), and every call yields to the event
// loop, so two runs started together genuinely interleave.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CLEANUP_LOCK_REF,
  acquireCleanupLock,
  breakCleanupLock,
  releaseCleanupLock,
} from "./live/cleanup-lock.mjs";

const ORG = "pxl-classroom-testbed";
const REPO = "pxl-classroom-control";
const LOCK = `refs/${CLEANUP_LOCK_REF}`;

function github({ failCreate = null, failMain = false, failCommitRead = false } = {}) {
  const refs = new Map([["refs/heads/main", "main-commit"]]);
  const commits = new Map([["main-commit", { message: "init", tree: { sha: "main-tree" }, committer: { date: "2026-09-17T08:00:00Z" } }]]);
  const calls = [];
  let n = 0;
  let clock = Date.parse("2026-09-17T18:00:00Z");

  const res = (status, data = {}) => ({ ok: status >= 200 && status < 300, status, data });

  const request = async (method, path, body) => {
    calls.push(`${method} ${path}`);
    await new Promise((r) => setImmediate(r));
    const base = `/repos/${ORG}/${REPO}/git`;

    if (method === "GET" && path.startsWith(`${base}/ref/`)) {
      const name = `refs/${path.slice(`${base}/ref/`.length)}`;
      if (name === "refs/heads/main" && failMain) return res(500, { message: "boom" });
      return refs.has(name) ? res(200, { ref: name, object: { sha: refs.get(name), type: "commit" } }) : res(404, { message: "Not Found" });
    }
    if (method === "GET" && path.startsWith(`${base}/commits/`)) {
      const sha = path.slice(`${base}/commits/`.length);
      if (failCommitRead && sha !== "main-commit") return res(500, { message: "boom" });
      return commits.has(sha) ? res(200, { sha, ...commits.get(sha) }) : res(404, { message: "Not Found" });
    }
    if (method === "POST" && path === `${base}/commits`) {
      const sha = `lock-commit-${++n}`;
      clock += 60_000;
      commits.set(sha, { message: body.message, tree: { sha: body.tree }, parents: body.parents, committer: { date: new Date(clock).toISOString() } });
      return res(201, { sha });
    }
    if (method === "POST" && path === `${base}/refs`) {
      if (failCreate) return res(failCreate.status, { message: failCreate.message });
      // THE atomic step: check-and-set inside one request, as the server does.
      if (refs.has(body.ref)) return res(422, { message: "Reference already exists" });
      refs.set(body.ref, body.sha);
      return res(201, { ref: body.ref, object: { sha: body.sha } });
    }
    if (method === "DELETE" && path.startsWith(`${base}/refs/`)) {
      const name = `refs/${path.slice(`${base}/refs/`.length)}`;
      if (!refs.has(name)) return res(422, { message: "Reference does not exist" });
      refs.delete(name);
      return res(204);
    }
    return res(599, { message: `not stubbed: ${method} ${path}` });
  };
  return { request, refs, calls };
}

const take = (gh, holder) => acquireCleanupLock(gh.request, { org: ORG, repo: REPO, holder });

test("the first cleanup takes the lock; a second is refused and told who and since when", async () => {
  const gh = github();
  const a = await take(gh, "lecturer1 on DESKTOP (pid 1, session-a)");
  assert.equal(a.ok, true, a.reason);
  assert.equal(gh.refs.get(LOCK), a.sha);

  const b = await take(gh, "lecturer1 on DESKTOP (pid 2, session-b)");
  assert.equal(b.ok, false);
  assert.equal(b.held, true);
  assert.equal(b.holder, "lecturer1 on DESKTOP (pid 1, session-a)");
  assert.match(b.since, /^2026-09-17T/);
  assert.equal(gh.refs.get(LOCK), a.sha, "the refused run did not touch the holder's lock");
});

test("TWO CLEANUPS STARTED TOGETHER: exactly one gets the lock", async () => {
  // What happened on the testbed, nine seconds apart. Here they interleave on
  // every call, so a read-then-create would let both through.
  for (let round = 0; round < 10; round++) {
    const gh = github();
    const [a, b] = await Promise.all([take(gh, "session-a"), take(gh, "session-b")]);
    assert.equal([a, b].filter((x) => x.ok).length, 1, `round ${round}: ${JSON.stringify([a, b])}`);
    const loser = a.ok ? b : a;
    assert.equal(loser.held, true);
    assert.equal(loser.holder, a.ok ? "session-a" : "session-b");
  }
});

test("acquiring never reads the lock before creating it - the create IS the check", async () => {
  const gh = github();
  await take(gh, "session-a");
  const lockCalls = gh.calls.filter((c) => c.includes(CLEANUP_LOCK_REF) || c.endsWith("/git/refs"));
  assert.deepEqual(lockCalls, [`POST /repos/${ORG}/${REPO}/git/refs`]);
});

test("releasing frees it for the next run", async () => {
  const gh = github();
  const a = await take(gh, "session-a");
  const released = await releaseCleanupLock(gh.request, { org: ORG, repo: REPO, sha: a.sha });
  assert.deepEqual(released, { ok: true, action: "released" });
  assert.equal(gh.refs.has(LOCK), false);
  assert.equal((await take(gh, "session-b")).ok, true);
});

test("a run never releases a lock somebody else holds now", async () => {
  // A's lock was broken while A was still going, and B took it. A finishing
  // must not delete B's, or a third run gets in beside B.
  const gh = github();
  const a = await take(gh, "session-a");
  await breakCleanupLock(gh.request, { org: ORG, repo: REPO });
  const b = await take(gh, "session-b");
  const res = await releaseCleanupLock(gh.request, { org: ORG, repo: REPO, sha: a.sha });
  assert.equal(res.ok, false);
  assert.equal(res.action, "not-ours");
  assert.match(res.reason, /session-b/);
  assert.equal(gh.refs.get(LOCK), b.sha, "B still holds it");
});

test("releasing a lock that is already gone is not a failure", async () => {
  const gh = github();
  const res = await releaseCleanupLock(gh.request, { org: ORG, repo: REPO, sha: "whatever" });
  assert.deepEqual(res, { ok: true, action: "absent" });
});

test("a create refused for any other reason is NOT permission to run", async () => {
  // Unreadable is not evidence: a 403 or a 500 means no lock was taken, and a
  // cleanup without one is the thing this exists to stop.
  for (const failCreate of [{ status: 403, message: "Resource not accessible by integration" }, { status: 500, message: "boom" }]) {
    const gh = github({ failCreate });
    const res = await take(gh, "session-a");
    assert.equal(res.ok, false, JSON.stringify(failCreate));
    assert.equal(res.held, false, "and it is not reported as somebody else's lock");
    assert.match(res.reason, new RegExp(String(failCreate.status)));
  }
});

test("a 422 that is not 'already exists' is not reported as held", async () => {
  const gh = github({ failCreate: { status: 422, message: "Reference name is invalid" } });
  const res = await take(gh, "session-a");
  assert.equal(res.ok, false);
  assert.equal(res.held, false);
  assert.match(res.reason, /invalid/);
});

test("an unreadable main takes no lock and writes nothing", async () => {
  const gh = github({ failMain: true });
  const res = await take(gh, "session-a");
  assert.equal(res.ok, false);
  assert.equal(gh.calls.some((c) => c.startsWith("POST")), false);
});

test("a held lock whose holder cannot be read still refuses", async () => {
  const gh = github();
  await take(gh, "session-a");
  const unreadable = github({ failCommitRead: true });
  unreadable.refs.set(LOCK, gh.refs.get(LOCK));
  const res = await take(unreadable, "session-b");
  assert.equal(res.ok, false);
  assert.equal(res.held, true);
  assert.equal(res.holder, null);
});

test("--break-lock removes it whoever holds it, and says whose it was", async () => {
  const gh = github();
  await take(gh, "lecturer1 on DESKTOP (pid 1, died)");
  const res = await breakCleanupLock(gh.request, { org: ORG, repo: REPO });
  assert.equal(res.ok, true);
  assert.equal(res.action, "released");
  assert.equal(res.holder, "lecturer1 on DESKTOP (pid 1, died)");
  assert.equal(gh.refs.has(LOCK), false);

  const again = await breakCleanupLock(gh.request, { org: ORG, repo: REPO });
  assert.equal(again.ok, true, "breaking a lock nobody holds is measured as 422, and is not a failure");
  assert.equal(again.action, "absent");
});
