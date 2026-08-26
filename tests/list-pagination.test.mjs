// A GitHub list endpoint answers with ONE page. Reading it and then making a
// statement about the whole collection is a confident claim off a truncated
// list - the same shape as `listOrgTemplates` searching without `fork:true`,
// or `listOrgRepos` returning [] after a failed page. The call succeeds, so no
// error path fires and no fallback runs; it simply answers a narrower question
// than the caller asked.
//
// Two of those shipped, and both are pinned here.

import { test } from "node:test";
import assert from "node:assert/strict";

import { runInvitationChecks } from "../lib/diagnostics.mjs";

// --- Tier 4 invitation exposure ---------------------------------------------

const ORG = "PXL-CSMobile";
const ASSIGNMENT = "hw-paged";
const BROKER = `broker-${ASSIGNMENT}`;

/** `count` closed acceptance issues, the oldest of which carries the token. */
function brokerIssues({ total, exposedAt }) {
  return Array.from({ length: total }, (_, i) => ({
    number: i + 1,
    title: i === exposedAt ? "pxl-accept:AQGU7LHwSOMETOKEN" : `chore: housekeeping ${i + 1}`,
  }));
}

/** A request stub that pages `/issues` the way GitHub does. */
function makeReq(issues, { seen } = {}) {
  return async (method, path) => {
    const issuesMatch = path.match(
      new RegExp(`^/repos/${ORG}/${BROKER}/issues\\?state=all&per_page=100(?:&page=(\\d+))?$`)
    );
    if (issuesMatch) {
      const page = Number(issuesMatch[1] ?? 1);
      seen?.push(page);
      const start = (page - 1) * 100;
      return { status: 200, ok: true, data: issues.slice(start, start + 100) };
    }
    return { status: 404, ok: false, data: { message: "Not Found" } };
  };
}

// The same shape `lib/diagnostics.mjs` builds internally. Driving
// runInvitationChecks rather than the whole engine keeps the stub to the one
// endpoint under test - a full runDiagnostics needs the control repo, the
// assignment YAML and a live broker before Tier 4 is even reached.
const checkFactory = (id, tierId, label, severity, message, detail = null, fixAction = null) =>
  ({ id, tierId, label, severity, message, detail, fixAction });

async function exposureCheck(issues, opts) {
  const collected = [];
  await runInvitationChecks({
    req: makeReq(issues, opts),
    addCheck: (_tier, c) => collected.push(c),
    check: checkFactory,
    // No invite_token, and not from the editor: the sweep runs regardless of
    // what the assignment currently holds, because a leftover issue is a
    // published credential either way.
    doc: {},
    org: ORG,
    brokerName: BROKER,
    assignmentId: ASSIGNMENT,
    fromEditor: false,
  });
  return collected.find((c) => c.id === "invite-exposure") || null;
}

test("an exposed invitation past the first page is still found", async () => {
  // The one that matters. A 200-student cohort opens 200 acceptance issues,
  // and this check exists precisely for the runs where the handler could not
  // delete them - so "more than a hundred" is the shape of a REAL finding, and
  // reading one page reported a clean broker.
  const seen = [];
  const found = await exposureCheck(brokerIssues({ total: 250, exposedAt: 240 }), { seen });

  assert.ok(found, "Tier 4 must run the exposure sweep");
  assert.equal(found.severity, "fail", "an invitation on a public repo is a fail, wherever it sits in the list");
  assert.match(found.message, /still carry this assignment's invitation token/);
  assert.ok(seen.length >= 3, `every page must be read, saw pages ${seen.join(", ")}`);
});

test("a genuinely clean broker still reports ok, and stops as soon as a page is short", async () => {
  // The pagination must not turn every clean broker into a warning, and must
  // not keep asking for pages that are not there.
  const seen = [];
  const found = await exposureCheck(brokerIssues({ total: 42, exposedAt: -1 }), { seen });

  assert.equal(found.severity, "ok");
  assert.deepEqual(seen, [1], "one short page is the whole list - do not ask for a second");
});

test("an exact multiple of the page size does not stop one page early", async () => {
  // 100 issues means page 1 is full, so the walk cannot conclude from its
  // length alone that there is nothing after it.
  const seen = [];
  const found = await exposureCheck(brokerIssues({ total: 200, exposedAt: 150 }), { seen });

  assert.equal(found.severity, "fail");
  assert.ok(seen.includes(2), "a full page must be followed by the next one");
});

// --- instructor notification dedup -------------------------------------------

const { notifyEvent } = await import("../notify/notify.mjs");

/**
 * Stand in for GitHub over `fetch`, which is what lib/gh.mjs uses. Comments
 * page OLDEST first, as GitHub returns them, and a Link header advertises the
 * next page - the thing `ghAll` follows.
 */
function stubGitHub({ comments, posts = [], patches = [] }) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || "GET";
    const json = (data, headers = {}) =>
      new Response(JSON.stringify(data), {
        status: 200,
        headers: { "content-type": "application/json", ...headers },
      });

    if (u.pathname.endsWith("/issues") && method === "GET") {
      return json([{ number: 7 }]);
    }
    if (u.pathname.endsWith("/issues/7/comments") && method === "GET") {
      const page = Number(u.searchParams.get("page") || 1);
      const start = (page - 1) * 100;
      const slice = comments.slice(start, start + 100);
      const more = start + 100 < comments.length;
      const next = new URL(u);
      next.searchParams.set("page", String(page + 1));
      return json(slice, more ? { link: `<${next}>; rel="next"` } : {});
    }
    if (u.pathname.includes("/issues/comments/") && method === "PATCH") {
      patches.push(u.pathname);
      return json({ ok: true });
    }
    if (u.pathname.endsWith("/issues/7/comments") && method === "POST") {
      posts.push(JSON.parse(init.body));
      return json({ id: 999 });
    }
    return json({});
  };
  return () => { globalThis.fetch = original; };
}

const marked = (key) => ({ id: 42, body: `<!-- pxl-dedup:${key}-->\nolder text` });
const filler = (n) => Array.from({ length: n }, (_, i) => ({ id: i, body: `chatter ${i}` }));

test("a dedup marker past the first page is still found", async () => {
  // The tracking issue collects a comment per event, so it passes a hundred
  // within a term - and GitHub returns comments OLDEST first, so the marker
  // for a recent condition is exactly what falls outside page one. Dedup then
  // stopped deduplicating anything at all and every repeat posted afresh.
  const posts = [], patches = [];
  const restore = stubGitHub({ comments: [...filler(150), marked("late-activity-alice")], posts, patches });
  try {
    const outcome = await notifyEvent({
      org: "PXL-CSMobile", controlRepo: "pxl-classroom-control",
      eventType: "late-activity", assignmentId: "hw-1",
      details: "alice pushed late", dedupKey: "late-activity-alice",
    });
    assert.equal(outcome, "deduplicated");
    assert.equal(patches.length, 1, "the existing comment is updated");
    assert.equal(posts.length, 0, "and no duplicate is posted");
  } finally {
    restore();
  }
});

test("a genuinely new condition still posts, rather than matching something else", async () => {
  const posts = [], patches = [];
  const restore = stubGitHub({ comments: [...filler(150), marked("late-activity-alice")], posts, patches });
  try {
    const outcome = await notifyEvent({
      org: "PXL-CSMobile", controlRepo: "pxl-classroom-control",
      eventType: "late-activity", assignmentId: "hw-1",
      details: "bob pushed late", dedupKey: "late-activity-bob",
    });
    assert.equal(outcome, "notified");
    assert.equal(posts.length, 1);
    assert.equal(patches.length, 0);
  } finally {
    restore();
  }
});

test("an unreadable comment list posts rather than dropping the alert", async () => {
  // A duplicate notification is noise. A swallowed one is a lecturer never
  // hearing that provisioning failed.
  const posts = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || "GET";
    if (u.pathname.endsWith("/issues") && method === "GET") {
      return new Response(JSON.stringify([{ number: 7 }]), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (u.pathname.endsWith("/issues/7/comments") && method === "GET") {
      return new Response(JSON.stringify({ message: "boom" }), { status: 500, headers: { "content-type": "application/json" } });
    }
    if (u.pathname.endsWith("/issues/7/comments") && method === "POST") {
      posts.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ id: 1 }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const outcome = await notifyEvent({
      org: "PXL-CSMobile", controlRepo: "pxl-classroom-control",
      eventType: "provisioning-failed", assignmentId: "hw-1",
      details: "boom", dedupKey: "provisioning-failed-alice",
    });
    assert.equal(outcome, "notified");
    assert.equal(posts.length, 1);
  } finally {
    globalThis.fetch = original;
  }
});

// --- a failed lookup is not evidence the issue does not exist ----------------
//
// `if (search.ok && search.data.length > 0) … else create` sent a 403, a rate
// limit and a 5xx down the same branch as "none found", so every transient
// failure created another `[NOTICE] PXL Classroom - Instructor Notifications`
// issue. The duplicates are the visible cost; the dedup history splitting across
// them is the worse one, because every alert already posted to the old issue
// gets posted again to the new one.

/** Stub where the tracking-issue LOOKUP answers with `status`. */
function stubLookup(status, { creates = [] } = {}) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || "GET";
    const json = (data, code = 200) =>
      new Response(JSON.stringify(data), {
        status: code,
        headers: { "content-type": "application/json" },
      });

    if (u.pathname.endsWith("/issues") && method === "GET") {
      if (status !== 200) return json({ message: "Forbidden" }, status);
      return json([]);
    }
    if (u.pathname.endsWith("/issues") && method === "POST") {
      creates.push(JSON.parse(init.body).title);
      return json({ number: 99 });
    }
    if (u.pathname.endsWith("/issues/99/comments")) return json(method === "POST" ? { id: 1 } : []);
    return json({});
  };
  return () => { globalThis.fetch = original; };
}

for (const status of [403, 404, 500, 502]) {
  test(`a tracking-issue lookup that answers ${status} does not create a duplicate`, async () => {
    const creates = [];
    const restore = stubLookup(status, { creates });
    try {
      await assert.rejects(
        () => notifyEvent({
          org: "TestOrg",
          controlRepo: "pxl-classroom-control",
          eventType: "late-activity",
          assignmentId: "exam",
          details: "x",
          dedupKey: "late-exam-alice",
        }),
        /not evidence/,
        "it must say why it refused rather than quietly carrying on",
      );
      assert.deepEqual(creates, [], "nothing may be created off a failed lookup");
    } finally {
      restore();
    }
  });
}

test("a genuinely empty result still creates the tracking issue once", async () => {
  // The other half: refusing on failure must not turn into refusing always.
  const creates = [];
  const restore = stubLookup(200, { creates });
  try {
    const outcome = await notifyEvent({
      org: "TestOrg",
      controlRepo: "pxl-classroom-control",
      eventType: "late-activity",
      assignmentId: "exam",
      details: "x",
      dedupKey: "late-exam-alice",
    });
    assert.equal(outcome, "notified");
    assert.equal(creates.length, 1);
    assert.match(creates[0], /Instructor Notifications/);
  } finally {
    restore();
  }
});

test("hitting the page cap warns rather than claiming an all-clear", async () => {
  // The cap exists so a pathological broker cannot spin forever. What it must
  // never do is come back saying "no invitation is exposed" - it did not look
  // at all of them, and this check's ok IS a statement about all of them.
  const found = await exposureCheck(brokerIssues({ total: 2100, exposedAt: 2050 }));
  assert.equal(found.severity, "warn");
  assert.match(found.message, /not all read/i);
  assert.ok(
    !/^No acceptance issue/.test(found.message),
    "an all-clear over a list that was not finished is the bug this replaces",
  );
});
