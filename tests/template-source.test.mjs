// The rule: a template outside the assignment's org must be public.
//
// Every case below was measured on the live testbed on 2026-09-07 by running
// the real acceptance + provisioning chain, not inferred from documentation -
// the docs were ambiguous enough that the prediction went the wrong way once
// already.
//
//   public, another org                  -> created the student repository
//   private, another org, App INSTALLED  -> HTTP 404
//
// The second one is the load-bearing measurement: the App IS installed on
// PXL-Automation-II, and a token minted for a DIFFERENT org still could not
// read its private repository. So this is not about permissions or ownership,
// it is about which installation minted the token - which no amount of
// granting on the other org can change.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  templateUsable,
  templateSourceMessage,
  isForeignTemplate,
  resolveTemplatePin,
  templatePinMessage,
  FOREIGN_PRIVATE,
  NOT_A_TEMPLATE,
  TEMPLATE_REPLACED,
  UNKNOWN,
} from "../lib/template-source.mjs";

const ORG = "pxl-classroom-testbed";
const ok = (over = {}) => ({ templateOwner: ORG, org: ORG, isPrivate: true, isTemplate: true, ...over });

test("the ordinary case: a private template in the assignment's own org", () => {
  // Unchanged, and the overwhelming majority of assignments. The App is
  // installed here, so private is fine.
  assert.deepEqual(templateUsable(ok()), { ok: true });
});

test("a public template in another org is allowed", () => {
  // MEASURED: contains-studio/agents generated into a private student
  // repository on the testbed. A stranger's repository, which is the least
  // privileged case there is - the token does not authenticate as the
  // lecturer, so ownership changes nothing about whether it works.
  assert.deepEqual(
    templateUsable(ok({ templateOwner: "contains-studio", isPrivate: false })),
    { ok: true },
  );
});

test("a private template in another org is refused", () => {
  // MEASURED: fail:template-missing - HTTP 404, on an org the App is
  // installed on. This is the whole point of the module.
  const finding = templateUsable(ok({ templateOwner: "colleague-org" }));
  assert.equal(finding.ok, false);
  assert.equal(finding.code, FOREIGN_PRIVATE);
});

test("being installed on the other org does not help, and neither does owning it", () => {
  // The failure was not a permission the lecturer could grant. Two orgs, two
  // installations, two tokens - and `generate` is ONE call. There is no input
  // here for "but I own it", deliberately: it would be a field that cannot
  // change the answer.
  const finding = templateUsable(ok({ templateOwner: "PXL-Automation-II" }));
  assert.equal(finding.code, FOREIGN_PRIVATE);
});

test("owners are compared lowercased, not with a raw !==", () => {
  // lib/github-login.mjs exists because a hand-written comparison already
  // split one student into two rows. GitHub hands back whichever casing the
  // surface stored, so `PXL-Classroom-Testbed` and `pxl-classroom-testbed`
  // are one owner - and treating them as two would refuse an org's own
  // private template.
  assert.equal(isForeignTemplate("PXL-Classroom-Testbed", "pxl-classroom-testbed"), false);
  assert.deepEqual(
    templateUsable(ok({ templateOwner: "PXL-Classroom-Testbed", org: "pxl-classroom-testbed" })),
    { ok: true },
  );
  assert.equal(isForeignTemplate("Contains-Studio", ORG), true);
});

test("a missing owner is not 'foreign'", () => {
  // An absent template field is the required-field check's job. Reading it as
  // foreign would refuse it with a sentence about organizations, which is not
  // what is wrong with it.
  assert.equal(isForeignTemplate("", ORG), false);
  assert.equal(isForeignTemplate(undefined, ORG), false);
  assert.equal(isForeignTemplate(ORG, ""), false);
});

test("a repository that is not ticked as a template is refused", () => {
  const finding = templateUsable(ok({ isTemplate: false }));
  assert.equal(finding.code, NOT_A_TEMPLATE);
});

test("visibility is reported before templateness", () => {
  // A foreign private repository that is ALSO not a template gets the
  // visibility message, because that is the fact the lecturer must act on -
  // and `is_template` read through the lecturer's own token says nothing
  // about what the App can see.
  const finding = templateUsable(ok({ templateOwner: "colleague-org", isTemplate: false }));
  assert.equal(finding.code, FOREIGN_PRIVATE);
});

test("UNREADABLE IS NOT EVIDENCE: a non-boolean fact is refused, not assumed", () => {
  // The failure mode this guards is a caller that did not manage to read the
  // repository and passes `undefined` through. `undefined` is falsy, so a
  // truthiness check would have read it as "not private" and let a foreign
  // private template straight past the one gate that exists to stop it.
  for (const bad of [undefined, null, "false", 0, "", "true"]) {
    assert.equal(templateUsable(ok({ isPrivate: bad })).code, UNKNOWN, `isPrivate: ${JSON.stringify(bad)}`);
    assert.equal(templateUsable(ok({ isTemplate: bad })).code, UNKNOWN, `isTemplate: ${JSON.stringify(bad)}`);
  }
  assert.equal(templateUsable().code, UNKNOWN, "no input at all");
});

test("the message names the repository, the org, and both ways out", () => {
  const finding = templateUsable(ok({ templateOwner: "colleague-org" }));
  const msg = templateSourceMessage(finding, {
    templateOwner: "colleague-org",
    templateRepo: "python-starter",
    org: ORG,
  });
  assert.match(msg, /colleague-org\/python-starter/);
  assert.match(msg, new RegExp(ORG));
  assert.match(msg, /public/i, "the fix");
  assert.match(msg, /copy it into/i, "the other fix");
  // "even one you own" - the objection the lecturer is about to raise, since
  // they can see the repository perfectly well in another tab.
  assert.match(msg, /even one you own/i);
});

test("the message never points a lecturer at this repository's docs", () => {
  // DESIGN.md §1.6. The runbooks are for whoever operates a deployment.
  for (const owner of ["colleague-org", ORG]) {
    for (const isTemplate of [true, false]) {
      const finding = templateUsable(ok({ templateOwner: owner, isTemplate }));
      const msg = templateSourceMessage(finding, { templateOwner: owner, templateRepo: "t", org: ORG });
      assert.doesNotMatch(msg, /RUNBOOK|ARCHITECTURE|LESSONS|§|\.md\b/);
    }
  }
});

// --------------------------------------------------------------------------
// The pin
// --------------------------------------------------------------------------

const tpl = (over = {}) => ({ owner: "colleague-org", repository: "python-starter", ...over });

test("first use takes the pin", () => {
  const r = resolveTemplatePin({
    storedTemplate: tpl(),
    owner: "colleague-org",
    repo: "python-starter",
    probedId: 42,
  });
  assert.deepEqual(r, { ok: true, repositoryId: 42, pinned: false });
});

test("an unchanged repository keeps its pin", () => {
  const r = resolveTemplatePin({
    storedTemplate: tpl({ repository_id: 42 }),
    owner: "colleague-org",
    repo: "python-starter",
    probedId: 42,
  });
  assert.deepEqual(r, { ok: true, repositoryId: 42, pinned: true });
});

test("THE ALARM: same name, different repository", () => {
  // Deleted and recreated, or transferred away and the name taken. Students
  // who accepted yesterday started from a different repository than students
  // accepting today, and nothing else in the system would ever notice.
  const r = resolveTemplatePin({
    storedTemplate: tpl({ repository_id: 42 }),
    owner: "colleague-org",
    repo: "python-starter",
    probedId: 99,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, TEMPLATE_REPLACED);
  assert.equal(r.storedId, 42);
  assert.equal(r.probedId, 99);
});

test("A RENAME IS NOT A REPLACEMENT, and must not be reported as one", () => {
  // GitHub redirects a renamed repository, so the old path keeps resolving to
  // it with the SAME id. Renaming a template is an ordinary thing to do and
  // must not break a live assignment - which is exactly what pinning the NAME
  // instead of the id would have done.
  const r = resolveTemplatePin({
    storedTemplate: tpl({ repository_id: 42 }),
    owner: "colleague-org",
    repo: "python-starter",
    probedId: 42,
  });
  assert.equal(r.ok, true);
});

test("pointing the assignment at a DIFFERENT template is a new pin, not a mismatch", () => {
  // The pin belongs to the name it sits beside. Comparing it against a
  // template the lecturer has just deliberately changed to would refuse every
  // edit of that field - the opposite of the feature.
  const r = resolveTemplatePin({
    storedTemplate: tpl({ repository_id: 42 }),
    owner: "other-org",
    repo: "different-starter",
    probedId: 99,
  });
  assert.deepEqual(r, { ok: true, repositoryId: 99, pinned: false });

  // Same owner, different repository - also a different template.
  const sameOwner = resolveTemplatePin({
    storedTemplate: tpl({ repository_id: 42 }),
    owner: "colleague-org",
    repo: "another-starter",
    probedId: 7,
  });
  assert.equal(sameOwner.ok, true);
  assert.equal(sameOwner.repositoryId, 7);
});

test("the owner casing does not make it a different template", () => {
  const r = resolveTemplatePin({
    storedTemplate: tpl({ owner: "Colleague-Org", repository_id: 42 }),
    owner: "colleague-org",
    repo: "python-starter",
    probedId: 99,
  });
  assert.equal(r.code, TEMPLATE_REPLACED, "same template, so the mismatch must still be caught");
});

test("an unreadable id neither pins nor accuses", () => {
  // No id from the probe means we did not learn anything. Keep what is stored
  // and say nothing: inventing a pin, or reporting a mismatch against
  // `undefined`, are both facts nobody established.
  for (const bad of [undefined, null, "42", NaN, 4.2]) {
    const r = resolveTemplatePin({
      storedTemplate: tpl({ repository_id: 42 }),
      owner: "colleague-org",
      repo: "python-starter",
      probedId: bad,
    });
    assert.equal(r.ok, true, JSON.stringify(bad));
    assert.equal(r.repositoryId, 42, "the stored pin survives an unreadable probe");
  }
});

test("an assignment with no stored template pins whatever it is given", () => {
  const r = resolveTemplatePin({ owner: "o", repo: "r", probedId: 5 });
  assert.deepEqual(r, { ok: true, repositoryId: 5, pinned: false });
});

test("the mismatch message says what changed, what it cost, and whose call it is", () => {
  const finding = resolveTemplatePin({
    storedTemplate: tpl({ repository_id: 42 }),
    owner: "colleague-org",
    repo: "python-starter",
    probedId: 99,
  });
  const msg = templatePinMessage(finding, {
    templateOwner: "colleague-org",
    templateRepo: "python-starter",
  });
  assert.match(msg, /colleague-org\/python-starter/);
  assert.match(msg, /42/);
  assert.match(msg, /99/);
  assert.match(msg, /accepted earlier/, "what it means for students already provisioned");
  assert.doesNotMatch(msg, /RUNBOOK|ARCHITECTURE|LESSONS|§/);
  assert.equal(templatePinMessage({ ok: true }), "");
});

test("a passing finding has no message", () => {
  assert.equal(templateSourceMessage(templateUsable(ok()), { org: ORG }), "");
  assert.equal(templateSourceMessage(null, { org: ORG }), "");
});
