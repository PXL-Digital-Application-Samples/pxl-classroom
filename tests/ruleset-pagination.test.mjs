// One page of rulesets is not the list.
//
// Every read of a rulesets list in lib/submission-lock.mjs asked once, with no
// `per_page`, and GitHub answers the first 30. Each assignment locked at
// organization scope adds an organization ruleset, and some organizations
// carry Classroom50's beside them, so past 30 `findOrgSubmissionLock` would
// miss a lock that exists. The ensure then POSTs a duplicate, GitHub refuses it
// 422 because the name is taken, and lockdown falls back to repository rulesets
// or demotion for the cohort - the very scope a student can lift.
//
// Driven over a fake that pages the way GitHub does (30 by default, 100 at
// most), with ours on page 2. A fake that returned the whole list on every call
// is exactly how this went unnoticed.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SUBMISSION_LOCK_NAME,
  ensureOrgSubmissionLock,
  findOrgSubmissionLock,
  findSubmissionLock,
  isSubmissionLockName,
  listRulesets,
  orgSubmissionLockName,
  orgSubmissionLockRuleset,
  releaseSubmissionLock,
} from "../lib/submission-lock.mjs";
import { frozenFromRulesets } from "../lib/existing-repo.mjs";
import { pageOf, splitQuery } from "./fixtures/github-pages.mjs";

const ORG = "PXL-Systems-Expert";
const REPO = "lab-9-ada";
const ASSIGNMENT = "lab-9";
const APP_ID = 42;
const REF = "refs/heads/main";
const COHORT = [11, 22];

/** Somebody else's rulesets: Classroom50's and other assignments' locks. */
const others = (n, source_type = "Organization") =>
  Array.from({ length: n }, (_, i) => ({
    id: 5000 + i,
    name: i % 2 ? `classroom50-protect-${i}` : orgSubmissionLockName(`other-${i}`),
    enforcement: "active",
    source_type,
  }));

/** Ours, as GitHub stores it after a create. */
const ourOrgLock = () => ({
  id: 900,
  source_type: "Organization",
  ...orgSubmissionLockRuleset({
    assignmentId: ASSIGNMENT, submissionRef: REF, appId: APP_ID, repositoryIds: COHORT, enforcement: "active",
  }),
});

/**
 * A GitHub that pages. The list endpoints return summaries (no `conditions`),
 * the single-ruleset read returns the whole thing, and a create reusing a name
 * is refused 422 - so a lookup that misses ours fails loudly here, as it did
 * live, instead of quietly making a second one.
 */
function fakeGitHub({ orgRulesets = [], repoRulesets = [], failAt = null } = {}) {
  const calls = [];
  const summary = ({ id, name, enforcement, source_type }) => ({ id, name, enforcement, source_type });
  const request = async (method, path, body) => {
    calls.push({ method, path, body });
    const { pathname, params } = splitQuery(path);
    const page = Number(params.get("page")) || 1;
    const failed = failAt && failAt.path === pathname && failAt.page === page;

    if (method === "GET" && pathname === `/orgs/${ORG}/rulesets`) {
      if (failed) return { ok: false, status: failAt.status, data: { message: "boom" } };
      return { ok: true, status: 200, data: pageOf(path, orgRulesets.map(summary)) };
    }
    if (method === "GET" && pathname.startsWith(`/orgs/${ORG}/rulesets/`)) {
      const hit = orgRulesets.find((r) => r.id === Number(pathname.split("/").pop()));
      return hit ? { ok: true, status: 200, data: hit } : { ok: false, status: 404, data: {} };
    }
    if (method === "POST" && pathname === `/orgs/${ORG}/rulesets`) {
      if (orgRulesets.some((r) => r.name === body.name)) {
        return { ok: false, status: 422, data: { message: "Validation Failed", errors: ["Name must be unique"] } };
      }
      const made = { ...body, id: 901, source_type: "Organization" };
      orgRulesets.push(made);
      return { ok: true, status: 201, data: made };
    }
    if (method === "GET" && pathname === `/repos/${ORG}/${REPO}/rulesets`) {
      if (failed) return { ok: false, status: failAt.status, data: { message: "boom" } };
      return { ok: true, status: 200, data: pageOf(path, repoRulesets.map(summary)) };
    }
    if (method === "PUT" && pathname.startsWith(`/repos/${ORG}/${REPO}/rulesets/`)) {
      const hit = repoRulesets.find((r) => r.id === Number(pathname.split("/").pop()));
      if (!hit) return { ok: false, status: 404, data: {} };
      hit.enforcement = body.enforcement;
      return { ok: true, status: 200, data: hit };
    }
    return { ok: false, status: 599, data: { message: `unexpected ${method} ${path}` } };
  };
  return { request, calls, orgRulesets, repoRulesets };
}

const lists = (calls, pathname) =>
  calls.filter((c) => c.method === "GET" && splitQuery(c.path).pathname === pathname);

test("the fake pages like GitHub: without per_page, ours is not on the first page", () => {
  // The precondition every test below depends on. Were the fixture to hand the
  // whole list to a bare read, the defect this file is about would pass here.
  const list = [...others(130), ourOrgLock()];
  assert.equal(pageOf(`/orgs/${ORG}/rulesets`, list).length, 30);
  assert.ok(!pageOf(`/orgs/${ORG}/rulesets`, list).some((r) => r.id === 900));
  assert.ok(!pageOf(`/orgs/${ORG}/rulesets?per_page=100&page=1`, list).some((r) => r.id === 900));
  assert.ok(pageOf(`/orgs/${ORG}/rulesets?per_page=100&page=2`, list).some((r) => r.id === 900));
});

test("an organization lock on page 2 is found", async () => {
  const gh = fakeGitHub({ orgRulesets: [...others(130), ourOrgLock()] });
  const found = await findOrgSubmissionLock(gh.request, { org: ORG, assignmentId: ASSIGNMENT });
  assert.equal(found.ok, true, found.reason);
  assert.equal(found.ruleset?.id, 900);
  assert.deepEqual(found.ruleset.conditions.repository_id.repository_ids, COHORT,
    "the full ruleset, not the list summary");
  assert.deepEqual(
    lists(gh.calls, `/orgs/${ORG}/rulesets`).map((c) => c.path),
    [`/orgs/${ORG}/rulesets?per_page=100&page=1`, `/orgs/${ORG}/rulesets?per_page=100&page=2`],
  );
});

test("A LOCK ON PAGE 2 IS NOT CREATED A SECOND TIME", async () => {
  // The failure: a missed lookup, a duplicate POST, a 422, and the cohort
  // degraded to a scope the student can reach.
  const gh = fakeGitHub({ orgRulesets: [...others(130), ourOrgLock()] });
  const res = await ensureOrgSubmissionLock(gh.request, {
    org: ORG, assignmentId: ASSIGNMENT, submissionRef: REF, appId: APP_ID,
    repositoryIds: COHORT, enforcement: "active",
  });
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.action, "unchanged");
  assert.equal(res.rulesetId, 900);
  assert.deepEqual(gh.calls.filter((c) => c.method === "POST"), []);
});

test("a repository lock on page 2 is found and released, not reported absent", async () => {
  // The repository list includes the organization's rulesets that apply to it,
  // so a repository can outgrow a page without owning many rulesets itself.
  const ours = { id: 77, name: SUBMISSION_LOCK_NAME, enforcement: "active", source_type: "Repository" };
  const gh = fakeGitHub({ repoRulesets: [...others(100), ours] });

  const found = await findSubmissionLock(gh.request, { org: ORG, repo: REPO });
  assert.equal(found.ok, true, found.reason);
  assert.equal(found.ruleset?.id, 77);

  const released = await releaseSubmissionLock(gh.request, { org: ORG, repo: REPO });
  assert.equal(released.action, "released", released.reason);
  assert.equal(gh.repoRulesets.at(-1).enforcement, "disabled");
});

test("a full last page costs one more read, and then absent is an answer", async () => {
  const gh = fakeGitHub({ orgRulesets: others(100) });
  const found = await findOrgSubmissionLock(gh.request, { org: ORG, assignmentId: ASSIGNMENT });
  assert.equal(found.ok, true);
  assert.equal(found.ruleset, null);
  assert.equal(lists(gh.calls, `/orgs/${ORG}/rulesets`).length, 2);
});

test("a later page that fails is unreadable, and nothing is created over it", async () => {
  const gh = fakeGitHub({
    orgRulesets: [...others(130), ourOrgLock()],
    failAt: { path: `/orgs/${ORG}/rulesets`, page: 2, status: 502 },
  });
  const found = await findOrgSubmissionLock(gh.request, { org: ORG, assignmentId: ASSIGNMENT });
  assert.equal(found.ok, false);
  assert.match(found.reason, /page 2 HTTP 502/);

  const res = await ensureOrgSubmissionLock(gh.request, {
    org: ORG, assignmentId: ASSIGNMENT, submissionRef: REF, appId: APP_ID,
    repositoryIds: COHORT, enforcement: "active",
  });
  assert.equal(res.ok, false);
  assert.deepEqual(gh.calls.filter((c) => c.method === "POST"), []);
});

test("a walk that hits its cap does not report ok", async () => {
  // An organization whose every page is full. The cap is what stops the walk;
  // what it may not do is turn "not all read" into "not there".
  const calls = [];
  const request = async (method, path) => {
    calls.push(path);
    return { ok: true, status: 200, data: others(100) };
  };
  const listed = await listRulesets(request, `/orgs/${ORG}/rulesets`);
  assert.equal(listed.ok, false);
  assert.equal(listed.data, null, "a truncated list is never handed back as the list");
  assert.match(listed.reason, /not all read/);
  assert.ok(calls.length > 1 && calls.length <= 20, `bounded, and more than one page: ${calls.length}`);

  const found = await findOrgSubmissionLock(request, { org: ORG, assignmentId: ASSIGNMENT });
  assert.equal(found.ok, false);
});

test("a 200 that is not a list is unreadable, not empty", async () => {
  // Read as empty, it is the same duplicate create a missed page is.
  const request = async () => ({ ok: true, status: 200, data: { message: "surprise" } });
  const found = await findOrgSubmissionLock(request, { org: ORG, assignmentId: ASSIGNMENT });
  assert.equal(found.ok, false);
});

test("acceptance's freeze read: a lock on page 2 freezes, and only page 1 can be the plan gate", async () => {
  const lock = { id: 900, name: orgSubmissionLockName(ASSIGNMENT), enforcement: "active", source_type: "Organization" };
  const path = `/repos/${ORG}/${REPO}/rulesets`;

  // Not ours by any spelling, so a match can only be the lock on page 2.
  const branchRules = others(100, "Repository").map((r) => ({ ...r, name: `branch-rule-${r.id}` }));

  const onPage2 = fakeGitHub({ repoRulesets: [...branchRules, lock] });
  assert.equal(frozenFromRulesets(await listRulesets(onPage2.request, path), isSubmissionLockName), lock.name);

  // A free organization's private repository: 403 on the first read, which
  // lib/existing-repo.mjs reads as "no ruleset can be enforcing".
  const planGate = fakeGitHub({ failAt: { path, page: 1, status: 403 } });
  assert.equal(frozenFromRulesets(await listRulesets(planGate.request, path), isSubmissionLockName), false);

  // Page 1 was a 200, so the feature is there; a 403 after it is a failed read.
  const later = fakeGitHub({
    repoRulesets: [...branchRules, lock],
    failAt: { path, page: 2, status: 403 },
  });
  assert.equal(frozenFromRulesets(await listRulesets(later.request, path), isSubmissionLockName), null);
});
