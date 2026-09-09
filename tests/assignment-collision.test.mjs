import test from "node:test";
import assert from "node:assert/strict";

import {
  repoNameMatcher,
  patternSpecificity,
  collidingRepoNames,
  patternProblem,
  clashingAssignments,
  assignmentCollisions,
  describeCollisions,
  blockingFindings,
  noteFindings,
  collisionRemedies,
  reposInRetiredReport,
  COLLISION_LEAD,
  COLLISION_WARNING_LEAD,
} from "../lib/assignment-collision.mjs";

// ---------------------------------------------------------------- the matcher

test("a pattern matches the names it would produce", () => {
  const re = repoNameMatcher("lab-3-{github_login}");
  assert.ok(re.test("lab-3-alice"));
  assert.ok(re.test("lab-3-bob-dev"));
  assert.ok(!re.test("lab-4-alice"));
  assert.ok(!re.test("lab-3-"));
  assert.ok(!re.test("prefix-lab-3-alice"));
  // Deliberately a match: a GitHub login may contain hyphens, so there is no
  // string-level way to tell `lab-3-` + `alice-dev` from a longer prefix. The
  // ambiguity is real, and patternSpecificity is how it gets attributed.
  assert.ok(re.test("lab-3-alice-dev-2"));
});

test("matching is case-insensitive, because GitHub repository names are", () => {
  // `Lab-3-Alice` and `lab-3-alice` cannot both exist, so a case-sensitive
  // check would report "free" for a name that cannot be created.
  const re = repoNameMatcher("lab-3-{github_login}");
  assert.ok(re.test("Lab-3-Alice"));
  assert.ok(re.test("LAB-3-ALICE"));
});

test("a team_slug placeholder matches too, and so does a pattern with both", () => {
  assert.ok(repoNameMatcher("lab-3-{team_slug}").test("lab-3-team-alpha"));
  const both = repoNameMatcher("{team_slug}-lab-3-{github_login}");
  assert.ok(both.test("alpha-lab-3-alice"));
  assert.ok(!both.test("lab-3-alice"));
});

test("a placeholder at the start is fine - there is no prefix requirement", () => {
  const re = repoNameMatcher("{github_login}-lab-3");
  assert.ok(re.test("alice-lab-3"));
  assert.ok(!re.test("alice-lab-4"));
});

test("regex metacharacters in the literal half are escaped, not interpreted", () => {
  // A pattern is not a regex. `.` must mean a dot.
  const re = repoNameMatcher("c++.lab(1)-{github_login}");
  assert.ok(re.test("c++.lab(1)-alice"));
  assert.ok(!re.test("cxx-lab-1--alice"));
  assert.ok(!re.test("c++Xlab(1)-alice"), "the dot must not match an arbitrary character");
});

test("a pattern with no placeholder yields no matcher", () => {
  // The form already refuses it. Turning it into an exact-match rule here would
  // quietly give it a meaning it must not have - one repository for everyone.
  assert.equal(repoNameMatcher("lab-3"), null);
  assert.equal(repoNameMatcher(""), null);
  assert.equal(repoNameMatcher("   "), null);
  assert.equal(repoNameMatcher(null), null);
  assert.equal(repoNameMatcher(undefined), null);
  assert.equal(repoNameMatcher(42), null);
});

test("an unknown placeholder is literal text, not a wildcard", () => {
  // `{student}` is not a placeholder this system defines. Treating it as one
  // would silently widen the match to every repository.
  const re = repoNameMatcher("lab-3-{student}-{github_login}");
  assert.ok(re.test("lab-3-{student}-alice"));
  assert.ok(!re.test("lab-3-anything-alice"));
});

// ------------------------------------------------------------- specificity

test("specificity counts literal characters, so the longer prefix wins", () => {
  assert.ok(patternSpecificity("lab-3-2-{github_login}") > patternSpecificity("lab-3-{github_login}"));
  assert.equal(patternSpecificity("{github_login}"), 0);
  assert.equal(patternSpecificity(null), 0);
});

// ------------------------------------------------------- colliding repo names

test("only the names this pattern would produce are collisions", () => {
  const found = collidingRepoNames("lab-3-{github_login}", [
    "lab-3-alice",
    "lab-3-bob",
    "lab-4-alice",
    "pxl-classroom-control",
    "starter-template",
  ]);
  assert.deepEqual(found, ["lab-3-alice", "lab-3-bob"]);
});

test("a name another assignment explains BETTER is not our collision", () => {
  // `lab-3-2-alice` matches `lab-3-{github_login}` too, because a login may
  // contain hyphens. Attributing it to lab-3 would block that id forever
  // merely because lab-3-2 exists.
  const found = collidingRepoNames(
    "lab-3-{github_login}",
    ["lab-3-alice", "lab-3-2-alice", "lab-3-2-bob"],
    [{ id: "lab-3-2", repository_name_pattern: "lab-3-2-{github_login}" }],
  );
  assert.deepEqual(found, ["lab-3-alice"]);
});

test("a name an EQUALLY specific other also matches is still reported", () => {
  // Two patterns of the same specificity matching one name is the ambiguity
  // itself. Silently handing it to the other one would hide the clash.
  const found = collidingRepoNames(
    "lab-3-{github_login}",
    ["lab-3-alice"],
    [{ id: "other", repository_name_pattern: "lab-3-{team_slug}" }],
  );
  assert.deepEqual(found, ["lab-3-alice"]);
});

test("a LESS specific other never steals a name from us", () => {
  const found = collidingRepoNames(
    "lab-3-2-{github_login}",
    ["lab-3-2-alice"],
    [{ id: "lab-3", repository_name_pattern: "lab-3-{github_login}" }],
  );
  assert.deepEqual(found, ["lab-3-2-alice"]);
});

test("an empty org, a missing list and junk entries all yield no collisions", () => {
  assert.deepEqual(collidingRepoNames("lab-3-{github_login}", []), []);
  assert.deepEqual(collidingRepoNames("lab-3-{github_login}", null), []);
  assert.deepEqual(collidingRepoNames("lab-3-{github_login}", [null, "", "   ", 7]), []);
  assert.deepEqual(collidingRepoNames("", ["lab-3-alice"]), []);
});

test("a rival with an unusable pattern is ignored rather than throwing", () => {
  const found = collidingRepoNames(
    "lab-3-{github_login}",
    ["lab-3-alice"],
    [{ id: "broken" }, { id: "alsobroken", repository_name_pattern: "no-placeholder" }, null],
  );
  assert.deepEqual(found, ["lab-3-alice"]);
});

// --------------------------------------------------------- clashing patterns

test("an identical pattern on another assignment is a clash", () => {
  const clashes = clashingAssignments("lab-3-{github_login}", [
    { id: "lab-3", repository_name_pattern: "lab-3-{github_login}" },
  ]);
  assert.deepEqual(clashes.map((c) => c.id), ["lab-3"]);
});

test("the same names from a different placeholder is also a clash", () => {
  // `lab-3-{team_slug}` and `lab-3-{github_login}` produce the same namespace.
  const clashes = clashingAssignments("lab-3-{github_login}", [
    { id: "lab-3-groups", repository_name_pattern: "lab-3-{team_slug}" },
  ]);
  assert.deepEqual(clashes.map((c) => c.id), ["lab-3-groups"]);
});

test("a genuinely different pattern is not a clash", () => {
  const clashes = clashingAssignments("lab-4-{github_login}", [
    { id: "lab-3", repository_name_pattern: "lab-3-{github_login}" },
    { id: "exam", repository_name_pattern: "exam-2026-{github_login}" },
  ]);
  assert.deepEqual(clashes, []);
});

test("an assignment never clashes with itself", () => {
  // Editing a published assignment re-runs this check. Its own pattern is not
  // a reason to refuse its own save.
  const clashes = clashingAssignments(
    "lab-3-{github_login}",
    [{ id: "lab-3", repository_name_pattern: "lab-3-{github_login}" }],
    "lab-3",
  );
  assert.deepEqual(clashes, []);
});

test("self-exclusion is case-insensitive, like every other login-ish comparison here", () => {
  const clashes = clashingAssignments(
    "lab-3-{github_login}",
    [{ id: "Lab-3", repository_name_pattern: "lab-3-{github_login}" }],
    "lab-3",
  );
  assert.deepEqual(clashes, []);
});

test("a nested pattern clashes in the direction that matters", () => {
  // `lab-3-2-{github_login}` renders `lab-3-2-probe`, which `lab-3-{...}`
  // matches - so creating lab-3 while lab-3-2 exists is flagged. Real: a
  // student called `2-alice` is not required for the hazard, only possible.
  const clashes = clashingAssignments("lab-3-{github_login}", [
    { id: "lab-3-2", repository_name_pattern: "lab-3-2-{github_login}" },
  ]);
  assert.deepEqual(clashes.map((c) => c.id), ["lab-3-2"]);
});

test("assignments without a pattern, and a junk list, are skipped", () => {
  assert.deepEqual(clashingAssignments("lab-3-{github_login}", [{ id: "x" }, null, {}]), []);
  assert.deepEqual(clashingAssignments("lab-3-{github_login}", null), []);
  assert.deepEqual(clashingAssignments("no-placeholder", [{ id: "lab-3", repository_name_pattern: "lab-3-{github_login}" }]), []);
});

// -------------------------------------------------------------- the verdict

test("nothing found is clear, and produces no sentence", () => {
  const v = assignmentCollisions({});
  assert.equal(v.clear, true);
  assert.deepEqual(v.findings, []);
  assert.equal(describeCollisions(v), null);
});

test("THE CASE THAT MUST WORK: deleted before anybody joined, recreated by the same name", () => {
  // The delete writes retired/<id>/manifest.json unconditionally, so a record
  // exists. Nothing else does: no repositories were ever created, no archive.
  // Refusing this would refuse "I changed my mind and started over", which is
  // an ordinary Tuesday.
  const v = assignmentCollisions({
    manifest: { assignment_id: "lab-3", deleted_at: "2026-09-04T10:00:00Z", preserved_submissions: 0 },
    existingRepos: [],
    clashes: [],
    archiveExists: false,
  });
  assert.equal(v.clear, true, "an id whose leftovers are only a record of nothing must be reusable");
  assert.equal(describeCollisions(v), null, "a warning must not be rendered as a refusal");
  assert.deepEqual(v.findings.map((f) => f.kind), ["retired-record"]);
  assert.equal(v.findings[0].blocking, false);
});

test("the warning says what recreating would cost, and nothing more", () => {
  const v = assignmentCollisions({ manifest: { assignment_id: "lab-3", deleted_at: "2026-09-04T10:00:00Z" } });
  assert.match(v.findings[0].detail, /retired\/lab-3\//);
  assert.match(v.findings[0].detail, /2026-09-04/);
  assert.match(v.findings[0].detail, /overwrite/i);
});

test("an existing repository NOTES and is named - it does not block", () => {
  // It blocked until 2026-09-09. The question "would a student in this cohort
  // be handed one" cannot be answered on this screen - who accepts is not known
  // here - so 300 repositories from previous years refused a name over perhaps
  // two that mattered. The judgement is acceptance/accept.mjs step 7 now, where
  // both halves are known, and this is a note.
  const v = assignmentCollisions({ existingRepos: ["lab-3-alice", "lab-3-bob"] });
  assert.equal(v.clear, true);
  assert.equal(blockingFindings(v).length, 0);
  assert.equal(describeCollisions(v), null, "a note must not render as a refusal");

  const note = noteFindings(v).find((f) => f.kind === "existing-repos");
  assert.ok(note, "the fact is still reported");
  assert.match(note.detail, /lab-3-alice, lab-3-bob/);
});

test("the note says these are the ORGANIZATION's matches, not this cohort's", () => {
  // The number is what the whole org holds. A lecturer reading "300" has to be
  // able to tell it is 300 of everybody's rather than 300 of theirs, because
  // that difference is the entire reason this stopped blocking.
  const v = assignmentCollisions({ existingRepos: ["lab-3-alice", "lab-3-bob"] });
  const note = noteFindings(v).find((f) => f.kind === "existing-repos");
  assert.match(note.detail, /in this organization already match this pattern/);
  // And it carries NO consequence clause: what happens to a student who owns
  // one is asked by the control directly beneath it.
  assert.doesNotMatch(note.detail, /would get|handed|starter code/);
});

test("one existing repository is not pluralised", () => {
  const v = assignmentCollisions({ existingRepos: ["lab-3-alice"] });
  assert.match(v.findings[0].detail, /^1 repository in this organization already matches this pattern: lab-3-alice/);
});

test("a long list is truncated with an ellipsis rather than printed whole", () => {
  const v = assignmentCollisions({
    existingRepos: Array.from({ length: 200 }, (_, i) => `lab-3-s${i}`),
  });
  assert.match(v.findings[0].detail, /^200 repositories/);
  assert.match(v.findings[0].detail, /lab-3-s0, lab-3-s1, lab-3-s2, …/);
});

test("a pattern clash blocks and names the other assignment", () => {
  const v = assignmentCollisions({
    clashes: [{ id: "lab-3", pattern: "lab-3-{github_login}" }],
  });
  assert.equal(v.clear, false);
  assert.match(describeCollisions(v), /"lab-3" already uses this repository name pattern/);
});

test("a surviving archive blocks even when every student repository is gone", () => {
  // This is the one that fails weeks later, at the deadline, and it is
  // invisible until then: preserve.mjs pushes without --force onto a ref the
  // archive still holds.
  const v = assignmentCollisions({
    manifest: { assignment_id: "lab-3", preserved_submissions: 6 },
    existingRepos: [],
    archiveExists: true,
  });
  assert.equal(v.clear, false);
  assert.match(describeCollisions(v), /6 preserved submissions/);
  // Silent until the deadline, so the consequence is worth its words here.
  assert.match(describeCollisions(v), /preservation would fail at the new deadline/);
});

test("one preserved submission is not pluralised", () => {
  const v = assignmentCollisions({ manifest: { preserved_submissions: 1 }, archiveExists: true });
  assert.match(v.findings[0].detail, /1 preserved submission\b/);
  assert.doesNotMatch(v.findings[0].detail, /submissions/);
});

test("an archive with nothing recorded is still named", () => {
  const v = assignmentCollisions({ manifest: { preserved_submissions: 0 }, archiveExists: true });
  assert.equal(v.clear, false);
  assert.match(v.findings[0].detail, /^the archive still exists -/);
});

test("an archive with no record at all still blocks", () => {
  // retired/<id>/ is an ordinary file in a repository a lecturer can write to.
  // Its absence is not proof the run never happened.
  const v = assignmentCollisions({ manifest: null, archiveExists: true });
  assert.equal(v.clear, false);
  assert.deepEqual(v.findings.map((f) => f.kind), ["archive"]);
});

test("THE CLEANUP CASE: archive and repositories deleted by hand frees the name", () => {
  // The check asks what EXISTS. A lecturer who did the cleanup is believed.
  const v = assignmentCollisions({
    manifest: { assignment_id: "lab-3", deleted_at: "2026-09-04T10:00:00Z", preserved_submissions: 6 },
    existingRepos: [],
    clashes: [],
    archiveExists: false,
  });
  assert.equal(v.clear, true);
  assert.deepEqual(v.findings.map((f) => f.blocking), [false]);
});

test("everything at once is ordered blockers first, record last", () => {
  const v = assignmentCollisions({
    existingRepos: ["lab-3-alice"],
    clashes: [{ id: "other", pattern: "lab-3-{team_slug}" }],
    archiveExists: true,
    manifest: { assignment_id: "lab-3", preserved_submissions: 6 },
  });
  assert.deepEqual(v.findings.map((f) => f.kind), [
    "existing-repos",
    "pattern-clash",
    "archive",
    "retired-record",
  ]);
  // Two of the four block. `existing-repos` is answered at acceptance instead
  // and `retired-record` never blocked; what is left are the two questions this
  // screen can answer and nothing downstream re-asks.
  assert.deepEqual(v.findings.map((f) => f.blocking), [false, true, true, false]);
  assert.deepEqual(blockingFindings(v).map((f) => f.kind), ["pattern-clash", "archive"]);
  assert.deepEqual(noteFindings(v).map((f) => f.kind), ["existing-repos", "retired-record"]);
});

test("a refusal lists only what stops the save, never the record", () => {
  // The consequence line says "delete what is listed above". The retired
  // record is not something anyone has to delete - listing it there would tell
  // a lecturer to destroy the evidence of the previous run.
  const msg = describeCollisions(
    assignmentCollisions({
      archiveExists: true,
      existingRepos: ["lab-3-alice"],
      manifest: { assignment_id: "lab-3" },
    }),
  );
  assert.match(msg, /archive still exists/);
  assert.doesNotMatch(msg, /retired\//);
  // Nor the repositories, now that they are a note: the remedies say "delete
  // the archive", and a refusal that also listed 300 student repositories reads
  // as an instruction to delete those too. That reading is what this change
  // exists to have ended.
  assert.doesNotMatch(msg, /lab-3-alice/);
});

test("blockingFindings and noteFindings tolerate junk", () => {
  assert.deepEqual(blockingFindings(null), []);
  assert.deepEqual(noteFindings(undefined), []);
  assert.deepEqual(blockingFindings({}), []);
});

test("the refusal never points a lecturer at the repository's own documentation", () => {
  // DESIGN.md 1.6 / tests/doc-refs.test.mjs.
  const msg = describeCollisions(
    assignmentCollisions({ existingRepos: ["lab-3-alice"], archiveExists: true, manifest: { assignment_id: "lab-3" } }),
  );
  assert.doesNotMatch(msg, /RUNBOOK|ARCHITECTURE|LESSONS|DESIGN\.md|§/);
});

test("the refusal says how to proceed, not only that it refused", () => {
  // A refusal that only says no gets routed around.
  const msg = describeCollisions(assignmentCollisions({ archiveExists: true }));
  assert.match(msg, /What to do:/);
  assert.match(msg, /has to be different/);
  assert.match(msg, /Delete the archive repository/);
});

// ---------------------------------------------------------------- remedies

test("distinguishing the name is offered first and is the recommended one", () => {
  const ways = collisionRemedies({
    verdict: assignmentCollisions({ archiveExists: true }),
    yearLabel: "2627",
  });
  assert.equal(ways[0].key, "distinguish");
  assert.equal(ways[0].recommended, true);
  assert.equal(ways.filter((w) => w.recommended).length, 1, "at most one recommendation");
  assert.ok(ways.length > 1, "and only when there is a choice to make");
});

test("IT NAMES NO REPLACEMENT AT ALL - not a composed one, not a year", () => {
  // Two goes at this, both wrong in the same direction. "2627-lab-3" is a name
  // nothing checked. "Add the academic year - 2627" is the same defect one step
  // back: nothing here knows THAT name is free either, and nothing here knows
  // the organization does not already encode the year some other way.
  const label = collisionRemedies({
    verdict: assignmentCollisions({ existingRepos: ["lab-3-alice"] }),
  })[0].label;
  assert.doesNotMatch(label, /\d/, "no year, no number, nothing to copy blindly");
  assert.doesNotMatch(label, /academic/i);
  // What is actually true, and all of it.
  assert.match(label, /has to be different/);
  assert.match(label, /in front of it/);
  // NOT "a prefix or suffix", which it said until 2026-09-09 and which is
  // wrong for a pattern clash - a placeholder expands to `[A-Za-z0-9-]+`, so a
  // suffixed pattern is still inside the original's namespace and is refused
  // again. Advice that does not work is worse than no advice: the lecturer
  // takes it and hits the same wall.
  assert.doesNotMatch(label, /suffix/);
});

// ------------------------------------------------------- what a pattern may be

test("AN UNKNOWN PLACEHOLDER IS REFUSED, because it would be copied through", () => {
  // `deriveRepoName` does two literal replacements and leaves everything else
  // alone, so `{slug}-{github_login}` produces `{slug}-alice` - not even a legal
  // GitHub repository name. It was reachable and it SAVED: the form seeded that
  // exact string, and touching the field before naming the assignment set the
  // manual flag so both auto-writers stood down (measured 2026-09-09).
  const said = patternProblem("{slug}-{github_login}");
  assert.match(said, /\{slug\} is not a placeholder/);
  assert.match(said, /exactly as written/);

  // `{login}` is the same hole with a real history: tests/accept.test.mjs pins
  // that it does NOT substitute, which is behaviour nothing was preventing.
  assert.match(patternProblem("hw-{login}"), /\{login\} is not a placeholder/);
  assert.match(patternProblem("hw-{githublogin}"), /not a placeholder/);
});

test("a pattern that is ONLY a placeholder is refused", () => {
  // It names nothing of its own, so two assignments using it share one
  // namespace and the second cohort is handed the first one's repositories.
  assert.match(patternProblem("{team_slug}", { assignmentType: "group" }), /something of its own/);
  assert.match(patternProblem("{github_login}"), /something of its own/);
});

test("and every pattern in live use passes", () => {
  // Measured across 13 participating organizations on 2026-09-09: all 20 live
  // assignments carry their id. This refuses nothing that exists.
  for (const p of [
    "2526-examen-aut2-ek2-{github_login}",
    "test-groepsopdracht-{team_slug}",
    "groepsindeling-{team_slug}",
    "live-smoke-group-{team_slug}",
    "net-advanced-guts-2627-{github_login}",
  ]) {
    assert.equal(patternProblem(p, { assignmentType: p.includes("{team_slug}") ? "group" : "individual" }), null, p);
  }
});

test("the placeholder each assignment type needs is still required", () => {
  assert.match(patternProblem("lab-3", { assignmentType: "individual" }), /must contain "\{github_login\}"/);
  assert.match(patternProblem("lab-3", { assignmentType: "group" }), /must contain "\{team_slug\}"/);
  // A team assignment may use either - a per-student repository inside a team
  // assignment is a real configuration.
  assert.equal(patternProblem("lab-3-{github_login}", { assignmentType: "group" }), null);
  assert.match(patternProblem("", {}), /required/);
});

test("a suffix genuinely does not clear a pattern clash", () => {
  // The measurement the remedy's wording rests on, run rather than described.
  const rival = [{ id: "lab-3", repository_name_pattern: "lab-3-{github_login}" }];
  assert.equal(clashingAssignments("lab-3-2026-{github_login}", rival).length, 1, "a suffix still clashes");
  assert.equal(clashingAssignments("2026-lab-3-{github_login}", rival).length, 0, "a prefix does not");
});

test("IT NEVER PROMISES THE NEW NAME IS FREE", () => {
  // "It never collides" is not something any wording can promise. A message
  // no branch computed is a guess, and it will eventually be a lie.
  const label = collisionRemedies({
    verdict: assignmentCollisions({ existingRepos: ["lab-3-alice"] }),
  })[0].label;
  assert.doesNotMatch(label, /never collides?/i);
  assert.doesNotMatch(label, /guarantee|always works|cannot collide/i);
});

test("both ends are offered, not one", () => {
  // Which end, and what it says, is the lecturer's call over a listing they
  // can see and this module cannot.
  const label = collisionRemedies({
    verdict: assignmentCollisions({ archiveExists: true }),
  })[0].label;
  assert.match(label, /in front of it/);
});

test("deleting is offered ONLY when there is something to delete", () => {
  // Nothing to delete must not read as an invitation to delete something, and
  // deleting repositories is not a remedy for a shared pattern.
  const clashOnly = collisionRemedies({
    verdict: assignmentCollisions({ clashes: [{ id: "other", pattern: "p-{github_login}" }] }),
  });
  assert.deepEqual(clashOnly.map((w) => w.key), ["distinguish"]);
  // And it is not marked Recommended: a label that exists to distinguish has
  // nothing to distinguish it from when it is the only one.
  assert.equal(clashOnly[0].recommended, false);

  // EXISTING REPOSITORIES ARE NO LONGER ONE OF THEM. They stopped blocking, so
  // they cannot reach this list - and that is the point rather than a side
  // effect: "delete 300 students' repositories" was one of exactly two things
  // this screen suggested to a lecturer whose only mistake was reusing a name.
  const withRepos = collisionRemedies({
    verdict: assignmentCollisions({ existingRepos: ["lab-3-alice"] }),
  });
  assert.deepEqual(withRepos.map((w) => w.key), ["distinguish"]);
  assert.ok(!withRepos.some((w) => /[Dd]elete/.test(w.label)));

  const withArchive = collisionRemedies({ verdict: assignmentCollisions({ archiveExists: true }) });
  assert.ok(withArchive.some((w) => w.key === "delete"));
});

test("the delete option says what it costs, in the same breath", () => {
  const del = collisionRemedies({
    verdict: assignmentCollisions({ existingRepos: ["lab-3-alice"], archiveExists: true }),
  }).find((w) => w.key === "delete");
  // What it destroys is now the preserved submissions, because the archive is
  // the only thing left that this option deletes.
  assert.match(del.label, /destroys the preserved submissions/);
  assert.equal(del.recommended, false);
});

test("IT STAYS SHORT - this is red text under a form field", () => {
  // The first cut ran to about 200 words: three findings each carrying its own
  // consequence clause, then three remedies of forty. A wall of red is read as
  // "something went wrong", not as three specific things and what to do. The
  // long version is RUNBOOK 5.1, and the UI never sends anyone there.
  const worst = assignmentCollisions({
    existingRepos: ["lab-3-alice", "lab-3-bob", "lab-3-ella-dev", "lab-3-x"],
    clashes: [{ id: "lab-3-old", pattern: "lab-3-{github_login}" }],
    archiveExists: true,
    manifest: { assignment_id: "lab-3", deleted_at: "2026-09-04T10:00:00Z", preserved_submissions: 6 },
  });
  const words = (t) => t.trim().split(/\s+/).length;

  for (const f of worst.findings) {
    assert.ok(words(f.detail) <= 18, `finding too long (${words(f.detail)} words): ${f.detail}`);
  }
  for (const w of collisionRemedies({ verdict: worst })) {
    assert.ok(words(w.label) <= 14, `remedy too long (${words(w.label)} words): ${w.label}`);
  }
  // The whole refusal, lead and remedies included.
  const msg = describeCollisions(worst);
  assert.ok(words(msg) <= 90, `the refusal is ${words(msg)} words`);
});

test("describeCollisions tolerates junk rather than throwing into a computed", () => {
  assert.equal(describeCollisions(null), null);
  assert.equal(describeCollisions(undefined), null);
  assert.equal(describeCollisions({ clear: true }), null);
});

test("the two leads are different sentences - a warning must not read as a refusal", () => {
  assert.notEqual(COLLISION_LEAD, COLLISION_WARNING_LEAD);
  assert.match(COLLISION_WARNING_LEAD, /Nothing is in the way/);
});

// -------------------------------------------------- names from a kept report

test("reposInRetiredReport returns the distinct names that were provisioned", () => {
  assert.deepEqual(reposInRetiredReport(null), []);
  assert.deepEqual(reposInRetiredReport({}), []);
  assert.deepEqual(reposInRetiredReport({ students: "nope" }), []);
  assert.deepEqual(
    reposInRetiredReport({
      students: [
        { github_login: "a", repo_name: "lab-3-a" },
        { github_login: "b", repo_name: "" },
        { github_login: "c" },
        { github_login: "d", repo_name: "lab-3-d" },
        null,
      ],
    }),
    ["lab-3-a", "lab-3-d"],
  );
});

test("a group assignment's shared repository is listed once, not once per member", () => {
  assert.deepEqual(
    reposInRetiredReport({
      students: [
        { github_login: "a", repo_name: "lab-3-team-alpha" },
        { github_login: "b", repo_name: "lab-3-team-alpha" },
        { github_login: "c", repo_name: "lab-3-team-beta" },
      ],
    }),
    ["lab-3-team-alpha", "lab-3-team-beta"],
  );
});
