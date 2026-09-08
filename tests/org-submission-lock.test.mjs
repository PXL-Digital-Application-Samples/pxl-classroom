// The organization-scoped half of lib/submission-lock.mjs.
//
// Driven over a fake `request` that behaves the way the LIVE API was measured
// to behave on 2026-09-08 against a Team organization - not the way it would be
// convenient for it to behave. A mock that accepts anything tests nothing, and
// the two facts that shape this code are both asymmetries a friendly mock would
// smooth away:
//
//   CREATE carrying an id that no longer exists -> 422
//   UPDATE carrying an id that no longer exists -> accepted
//   PUT conditions REPLACES, it does not merge
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  orgSubmissionLockName,
  orgSubmissionLockRuleset,
  findOrgSubmissionLock,
  targetedRepositoryIds,
  ensureOrgSubmissionLock,
  removeRepoFromOrgLock,
  liveRepositoryIds,
} from "../lib/submission-lock.mjs";

const APP_ID = 42;
const ORG = "PXLAutomation";
const ASSIGNMENT = "lab-1";
const REF = "refs/heads/main";

/**
 * A GitHub that behaves as measured.
 *
 * `live` is the set of repository ids the organization still has; anything else
 * is treated as deleted, which is what the 422 on create is about.
 */
function fakeGitHub({ rulesets = [], live = new Set(), failList = false } = {}) {
  const calls = [];
  let nextId = 1000;
  const request = async (method, path, body) => {
    calls.push({ method, path, body });
    const orgRules = `/orgs/${ORG}/rulesets`;

    if (method === "GET" && path === orgRules) {
      if (failList) return { ok: false, status: 500, data: {} };
      return { ok: true, status: 200, data: rulesets.map((r) => ({ id: r.id, name: r.name })) };
    }
    if (method === "GET" && path.startsWith(`${orgRules}/`)) {
      const id = Number(path.split("/").pop());
      const hit = rulesets.find((r) => r.id === id);
      return hit ? { ok: true, status: 200, data: hit } : { ok: false, status: 404, data: {} };
    }
    if (method === "POST" && path === orgRules) {
      const ids = body.conditions.repository_id.repository_ids;
      const dead = ids.filter((i) => !live.has(i));
      if (dead.length) {
        return { ok: false, status: 422, data: {
          message: "Validation Failed",
          errors: ["Invalid parameter repository_ids: repository selected does not exist or is not in this organization"],
        } };
      }
      const made = { ...body, id: ++nextId };
      rulesets.push(made);
      return { ok: true, status: 201, data: made };
    }
    if (method === "PUT" && path.startsWith(`${orgRules}/`)) {
      const id = Number(path.split("/").pop());
      const hit = rulesets.find((r) => r.id === id);
      if (!hit) return { ok: false, status: 404, data: {} };
      // REPLACE, not merge - measured.
      if (body.conditions) hit.conditions = body.conditions;
      if (body.enforcement) hit.enforcement = body.enforcement;
      return { ok: true, status: 200, data: hit };
    }
    if (method === "GET" && path.startsWith("/repositories/")) {
      const id = Number(path.split("/").pop());
      return live.has(id)
        ? { ok: true, status: 200, data: { id, owner: { login: ORG } } }
        : { ok: false, status: 404, data: {} };
    }
    return { ok: false, status: 599, data: {} };
  };
  return { request, calls, rulesets };
}

const base = { org: ORG, assignmentId: ASSIGNMENT, submissionRef: REF, appId: APP_ID };

test("the ruleset names the assignment, and stays inside the measured length", () => {
  assert.equal(orgSubmissionLockName("lab-1"), "pxl-classroom-deadline-lab-1");
  // Assignment ids are capped at 100 by the schema pattern, and the API refused
  // a name at 262 characters while accepting 252 - so the longest possible name
  // has room to spare and needs no truncation, unlike archiveRepoName.
  const longest = orgSubmissionLockName("a".repeat(100));
  assert.ok(longest.length < 252, `name would be ${longest.length} characters`);
});

test("it targets repository IDS, never a name pattern", () => {
  const rs = orgSubmissionLockRuleset({ ...base, assignmentId: ASSIGNMENT, repositoryIds: [1, 2, 3] });
  assert.deepEqual(rs.conditions.repository_id.repository_ids, [1, 2, 3]);
  assert.ok(!("repository_name" in rs.conditions), "a name glob would match neighbouring cohorts");
  assert.deepEqual(rs.conditions.ref_name.include, [REF]);
  assert.deepEqual(rs.rules.map((r) => r.type), ["update", "non_fast_forward", "deletion"]);
  assert.deepEqual(rs.bypass_actors, [{ actor_id: APP_ID, actor_type: "Integration", bypass_mode: "always" }]);
});

test("no App id means no ruleset at all", async () => {
  const gh = fakeGitHub({ live: new Set([1]) });
  const res = await ensureOrgSubmissionLock(gh.request, { ...base, appId: null, repositoryIds: [1], enforcement: "active" });
  assert.equal(res.ok, false);
  assert.match(res.reason, /lock the system out/);
  assert.equal(gh.calls.length, 0, "it must not even look - a ruleset the App cannot bypass is unrecoverable");
});

test("it creates the lock over the cohort", async () => {
  const gh = fakeGitHub({ live: new Set([11, 22]) });
  const res = await ensureOrgSubmissionLock(gh.request, { ...base, repositoryIds: [11, 22], enforcement: "active" });
  assert.equal(res.ok, true);
  assert.equal(res.action, "created");
  assert.deepEqual(res.dropped, []);
  assert.deepEqual(targetedRepositoryIds(gh.rulesets[0]), [11, 22]);
  assert.equal(gh.rulesets[0].enforcement, "active");
});

test("A DEAD ID ON CREATE IS RECOVERED, and the dropped student is named", async () => {
  // The measured asymmetry. A student deleted their repository; the control
  // repo's record survives, so the derived id list still carries it, and GitHub
  // refuses the whole create rather than the one id.
  const gh = fakeGitHub({ live: new Set([11, 33]) });
  const res = await ensureOrgSubmissionLock(gh.request, { ...base, repositoryIds: [11, 22, 33], enforcement: "active" });
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.action, "created");
  assert.deepEqual(res.dropped, [22], "the cohort is locked and the missing repository is reported, not hidden");
  assert.deepEqual(targetedRepositoryIds(gh.rulesets[0]), [11, 33]);
});

test("recovery does not depend on GitHub's WORDING", async () => {
  // The first version only recovered when the 422's message matched
  // /repository_ids/. A live probe then produced a 422 whose body the harness
  // did not surface, the recovery silently did not run, and the whole cohort
  // failed to lock - which is what every guard in this repository that checked
  // nothing looks like from the outside. A 422 on create is unprocessable
  // however it is worded, so the recovery is unconditional on the status.
  const gh = fakeGitHub({ live: new Set([11]) });
  const request = async (m, p, b) => {
    if (m === "POST" && p === `/orgs/${ORG}/rulesets`) {
      const ids = b.conditions.repository_id.repository_ids;
      if (ids.some((i) => !gh.rulesets && false)) { /* unreachable */ }
      if (ids.includes(22)) return { ok: false, status: 422, data: { message: "something GitHub has not said before" } };
    }
    return gh.request(m, p, b);
  };
  const res = await ensureOrgSubmissionLock(request, { ...base, repositoryIds: [11, 22], enforcement: "active" });
  assert.equal(res.ok, true, res.reason);
  assert.deepEqual(res.dropped, [22]);
});

test("a 422 that is NOT about a dead repository is reported, not retried blindly", async () => {
  // Every id is live, so re-deriving them changes nothing and a retry would
  // fail identically. Report what GitHub actually said.
  const gh = fakeGitHub({ live: new Set([11, 22]) });
  let posts = 0;
  const request = async (m, p, b) => {
    if (m === "POST" && p === `/orgs/${ORG}/rulesets`) {
      posts++;
      return { ok: false, status: 422, data: { message: "Rule type not supported on this plan" } };
    }
    return gh.request(m, p, b);
  };
  const res = await ensureOrgSubmissionLock(request, { ...base, repositoryIds: [11, 22], enforcement: "active" });
  assert.equal(res.ok, false);
  assert.match(res.reason, /not supported on this plan/);
  assert.equal(posts, 1, "no second attempt when nothing would differ");
});

test("an unreadable repository is NOT treated as gone", async () => {
  // Dropping one we merely could not read would leave that student unlocked.
  const gh = fakeGitHub({ live: new Set([11]) });
  const request = async (m, p, b) => (p === "/repositories/22" ? { ok: false, status: 500, data: {} } : gh.request(m, p, b));
  const res = await ensureOrgSubmissionLock(request, { ...base, repositoryIds: [11, 22], enforcement: "active" });
  assert.equal(res.ok, false);
  assert.match(res.reason, /HTTP 500/);
});

test("a repository transferred out of the organization counts as gone", async () => {
  const gh = fakeGitHub({ live: new Set([11]) });
  const request = async (m, p, b) =>
    p === "/repositories/22" ? { ok: true, status: 200, data: { id: 22, owner: { login: "SomewhereElse" } } } : gh.request(m, p, b);
  const res = await ensureOrgSubmissionLock(request, { ...base, repositoryIds: [11, 22], enforcement: "active" });
  assert.equal(res.ok, true, res.reason);
  assert.deepEqual(res.dropped, [22], "an org ruleset cannot cover a repository in another org");
});

test("an existing lock is UPDATED, and a dead id there is tolerated", async () => {
  // Measured: an update carrying an id that no longer exists is accepted, so
  // the recovery path must not run on this branch and cost N reads.
  const existing = {
    id: 500, name: orgSubmissionLockName(ASSIGNMENT), enforcement: "disabled",
    conditions: { repository_id: { repository_ids: [11] }, ref_name: { include: [REF], exclude: [] } },
  };
  const gh = fakeGitHub({ rulesets: [existing], live: new Set([11]) });
  const res = await ensureOrgSubmissionLock(gh.request, { ...base, repositoryIds: [11, 99], enforcement: "active" });
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.action, "updated");
  assert.deepEqual(targetedRepositoryIds(existing), [11, 99]);
  assert.equal(existing.enforcement, "active");
  assert.ok(!gh.calls.some((c) => c.path.startsWith("/repositories/")), "no per-repository reads on the ordinary path");
});

test("an unchanged lock is not rewritten", async () => {
  const existing = {
    id: 501, name: orgSubmissionLockName(ASSIGNMENT), enforcement: "active",
    conditions: { repository_id: { repository_ids: [11, 22] }, ref_name: { include: [REF], exclude: [] } },
  };
  const gh = fakeGitHub({ rulesets: [existing], live: new Set([11, 22]) });
  const res = await ensureOrgSubmissionLock(gh.request, { ...base, repositoryIds: [22, 11], enforcement: "active" });
  assert.equal(res.action, "unchanged", "order is not a difference");
  assert.ok(!gh.calls.some((c) => c.method === "PUT"));
});

test("an empty cohort is refused rather than locked over nothing", async () => {
  const gh = fakeGitHub({ live: new Set() });
  const res = await ensureOrgSubmissionLock(gh.request, { ...base, repositoryIds: [], enforcement: "active" });
  assert.equal(res.ok, false);
  assert.match(res.reason, /no repository ids/);
});

test("it is found by NAME, because the sentinel writes no record to hold an id", async () => {
  const mine = {
    id: 700, name: orgSubmissionLockName(ASSIGNMENT), enforcement: "active",
    conditions: { repository_id: { repository_ids: [1] }, ref_name: { include: [REF], exclude: [] } },
  };
  const other = { id: 701, name: "someone-elses-org-rule", enforcement: "active", conditions: {} };
  const gh = fakeGitHub({ rulesets: [other, mine], live: new Set([1]) });
  const found = await findOrgSubmissionLock(gh.request, { org: ORG, assignmentId: ASSIGNMENT });
  assert.equal(found.ok, true);
  assert.equal(found.ruleset.id, 700);

  const none = await findOrgSubmissionLock(gh.request, { org: ORG, assignmentId: "other-lab" });
  assert.equal(none.ok, true);
  assert.equal(none.ruleset, null, "another assignment's lock is not ours");
});

test("an unreadable ruleset list is a failure, never 'there is no lock'", async () => {
  const gh = fakeGitHub({ failList: true });
  const found = await findOrgSubmissionLock(gh.request, { org: ORG, assignmentId: ASSIGNMENT });
  assert.equal(found.ok, false);
  assert.equal(found.ruleset, null);
});

// --------------------------------------------------------- reopening one repo

test("reopening one student removes one id and leaves the cohort locked", async () => {
  const existing = {
    id: 800, name: orgSubmissionLockName(ASSIGNMENT), enforcement: "active",
    conditions: { repository_id: { repository_ids: [11, 22, 33] }, ref_name: { include: [REF], exclude: [] } },
  };
  const gh = fakeGitHub({ rulesets: [existing], live: new Set([11, 22, 33]) });
  const res = await removeRepoFromOrgLock(gh.request, { org: ORG, assignmentId: ASSIGNMENT, repositoryId: 22 });
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.action, "removed");
  assert.deepEqual(targetedRepositoryIds(existing), [11, 33]);
  assert.equal(existing.enforcement, "active", "the rest of the cohort stays locked");
});

test("removing the LAST repository disables the ruleset instead of emptying it", async () => {
  // GitHub refuses an empty repository_ids, and a ruleset targeting nothing is
  // not a lock anyway. Disabling says the same thing in a way the API accepts.
  const existing = {
    id: 801, name: orgSubmissionLockName(ASSIGNMENT), enforcement: "active",
    conditions: { repository_id: { repository_ids: [11] }, ref_name: { include: [REF], exclude: [] } },
  };
  const gh = fakeGitHub({ rulesets: [existing], live: new Set([11]) });
  const res = await removeRepoFromOrgLock(gh.request, { org: ORG, assignmentId: ASSIGNMENT, repositoryId: 11 });
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.action, "disabled");
  assert.equal(existing.enforcement, "disabled");
});

test("reopening a repository the lock never covered is already done, not an error", async () => {
  const existing = {
    id: 802, name: orgSubmissionLockName(ASSIGNMENT), enforcement: "active",
    conditions: { repository_id: { repository_ids: [11] }, ref_name: { include: [REF], exclude: [] } },
  };
  const gh = fakeGitHub({ rulesets: [existing], live: new Set([11]) });
  const res = await removeRepoFromOrgLock(gh.request, { org: ORG, assignmentId: ASSIGNMENT, repositoryId: 99 });
  assert.equal(res.ok, true);
  assert.equal(res.action, "already");
});

test("no ruleset to reopen from is ABSENT, not success", async () => {
  // Same rule as releaseSubmissionLock: the record says this was locked and
  // there is nothing there, so something removed it and the lecturer is told.
  const gh = fakeGitHub({ live: new Set([11]) });
  const res = await removeRepoFromOrgLock(gh.request, { org: ORG, assignmentId: ASSIGNMENT, repositoryId: 11 });
  assert.equal(res.ok, false);
  assert.equal(res.action, "absent");
});

test("it re-reads before writing rather than trusting a caller's copy", async () => {
  const existing = {
    id: 803, name: orgSubmissionLockName(ASSIGNMENT), enforcement: "active",
    conditions: { repository_id: { repository_ids: [11, 22] }, ref_name: { include: [REF], exclude: [] } },
  };
  const gh = fakeGitHub({ rulesets: [existing], live: new Set([11, 22]) });
  await removeRepoFromOrgLock(gh.request, { org: ORG, assignmentId: ASSIGNMENT, repositoryId: 22 });
  const firstWrite = gh.calls.findIndex((c) => c.method === "PUT");
  const reads = gh.calls.slice(0, firstWrite).filter((c) => c.method === "GET");
  assert.ok(reads.length >= 2, "the list and the full ruleset must both be read before the write");
});

test("liveRepositoryIds keeps only what this organization still has", async () => {
  const gh = fakeGitHub({ live: new Set([1, 3]) });
  const res = await liveRepositoryIds(gh.request, { org: ORG, ids: [1, 2, 3] });
  assert.equal(res.ok, true);
  assert.deepEqual(res.ids, [1, 3]);
});
