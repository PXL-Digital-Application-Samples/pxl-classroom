# Org-scoped lockdown — build plan

> **TEMPORARY. DELETE THIS FILE WHEN THE WORK CLOSES.**
>
> CLAUDE.md says this repository does not keep top-level planning documents, and
> that rule is not being revised — this is a deliberate, temporary exception
> agreed on 2026-09-08 for one piece of work. When org-scoped lockdown ships (or
> is declined), the outcome goes to `ARCHITECTURE.md` §11.2.1 and `OPEN-ITEMS.md`
> §3 and **this file is removed in the same commit**. Nothing may come to depend
> on it: no code comment, no test, no other document may cite it.

## Why

`late_policy: block` stops late pushes with a repository ruleset and leaves
Actions, secrets, environments and runners alone. That is the configuration this
course needs — an exam that demotes the student to `pull` takes away the subject
matter — and it is the configuration nobody had used until now.

The ruleset lives in the student's own repository and the student is its admin,
so they can delete it. That hole is only worth closing **because** we are moving
to `block`: today's exams demote instead, and a demoted student cannot restore
themselves.

An organization ruleset lives above the repository. `source_type: "Organization"`
— visible to the student, manageable only by an org owner.

Secondary gain: one `PUT` freezes the whole cohort instead of two calls per
repository, which matters at the deadline instant, where the sentinel fires.

## Measured, 2026-09-08, against `PXLAutomation` (Team plan)

Everything below was measured with `enforcement: "disabled"`, so no repository
was ever affected. GitHub documents none of it.

| Question | Answer |
|---|---|
| Max entries in `conditions.repository_id.repository_ids` | **≥ 301** — 301 real ids accepted and read back. Above the 250-student design target, so **no chunking** |
| Does `PUT` replace or merge `conditions`? | **Replace.** `[a,b]` then `[a]` reads back `[a]`, so removing one repository works |
| Ruleset `name` length | accepted at 252 chars, rejected at 262. Assignment ids are capped at 100 by the schema, so `pxl-classroom-deadline-<id>` ≤ 123 — **no truncation needed**, unlike `archiveRepoName` |
| **CREATE** with an id that no longer exists | **REJECTED 422** — `"repository selected does not exist or is not in this organization"` |
| **UPDATE** keeping an id that no longer exists | **ACCEPTED** — an existing ruleset tolerates a stale id |
| A targeted repository being deleted | The ruleset survives and keeps the dead id; a later `PUT` that drops it is accepted |

That last asymmetry is the one to design around: **the dead-id hazard is on
create, not on update.**

## The object

One organization ruleset per assignment, created at Phase 1 — the same moment
the per-repository one is created today.

```
name:          pxl-classroom-deadline-<assignment-id>
target:        branch
enforcement:   active
bypass_actors: [{ actor_id: <App id>, actor_type: "Integration", bypass_mode: "always" }]
conditions:
  repository_id: { repository_ids: [ ...cohort repo ids... ] }
  ref_name:      { include: [<submission_ref>], exclude: [] }
rules: [ update, non_fast_forward, deletion ]
```

**Targeted by `repository_id`, never by name pattern.** Name globs collide in
real data: `test-groepsopdracht-{team_slug}`, `test-groepsopdracht-2-{team_slug}`
and `test-groepsopdracht-vervolg-{team_slug}` all live in
`PXL-2TIN-CloudEssentials-2627`, all on `late_policy: block`, and
`test-groepsopdracht-*` matches all three cohorts. Ids also survive a rename,
which is why §13 already calls the id the primary external identifier.

**Looked up by NAME, not by a stored id.** The sentinel's `STOP_ONLY` path
deliberately writes no lockdown record, so at the moment it fires there is no
stored id to read. `org_ruleset_id` on the record is a convenience only. This is
the rule `findSubmissionLock` already follows.

## The load-bearing rule: the id list is derived, never stored

`repository_ids` is rebuilt on every run from `planTargets`' output —
`targets.map(t => t.rec.repo_id)`. Not from a stored list, not from a directory
listing.

Both existing exclusions then work by construction:

* a student with a **live extension** is in `deferrals`, so their id is absent;
* a repository a lecturer **reopened** is in `reopenedTargets`, so its id is
  absent, and `find-finalizable`'s re-queue cannot silently re-lock it.

Today both are honoured by *not making a call*. Here they are honoured by *not
being in a list*, which is stronger: there is no call to forget.

## Where it plugs in

| File | Gains |
|---|---|
| `lib/submission-lock.mjs` | `orgSubmissionLockRuleset()`, `findOrgSubmissionLock()` (by name), `ensureOrgSubmissionLock()`, `removeRepoFromOrgLock()` |
| `lockdown/lockdown.mjs` | `applySubmissionLock` gains method `"org-ruleset"`, first choice, degrading to `"ruleset"` then `"demotion"` |
| `lib/repo-unlock.mjs` | an `org-ruleset` branch in `applyUnlock` |
| `schemas/lockdown-record.schema.json` | **write it first — it does not exist** |

## Edge cases

### Must be handled

1. **Dead id on create → 422 for the whole cohort.** A student can delete their
   own repository; the control repo's `repositories/<id>/<login>.json` survives,
   so the derived id list still carries it. Verifying every repository first
   would be N reads before the time-critical call — which destroys the point.
   So: **attempt the create, and on a 422 naming invalid ids, drop the
   unresolvable ones and retry once**, recording which students were dropped.
   A student with no repository has nothing to lock; dropping is correct, but it
   must be *recorded*, never silent. Updates need none of this.

2. **A record with no `repo_id`.** The schema requires it, so this means a
   hand-edited file. That student **degrades to a per-repository ruleset
   individually** and is recorded `lock_method: "ruleset"`. Omitting them from
   the id list is the dangerous failure: an unlocked student nothing reports.
   Mixed methods within one assignment already work — `lock_method` is per row.

3. **Assignment deleted.** §11.3.2's delete removes the broker and the working
   data and deliberately never touches student repositories, so today's
   per-repository rulesets die with the repositories. An organization ruleset
   lives in the org and would be orphaned. **Delete must remove it**, and
   `retired/<id>/manifest.json` should record its id.

4. **Reopening one student** = re-read the ruleset, filter one id, `PUT`.
   **Re-read immediately before writing**, never a cached copy. Concurrent
   unlocks are vanishingly rare on cohorts of six; a fresh read costs one call
   and removes the question entirely.

5. **Coexistence during migration.** Two active rulesets both block, which is
   harmless. But `applyUnlock` for `org-ruleset` must **also release any
   per-repository ruleset it finds**, or a reopened student stays blocked by the
   leftover.

6. **Three-level degradation.** org ruleset → per-repository ruleset →
   demotion. Free organizations land on demotion, which the publish preflight
   now warns about (`assignmentFreezePlanFinding`, fixed 2026-09-08). An
   unresolvable App id still means *never create a ruleset at all*.

7. **A repository provisioned after the lock** — `retry-acceptance` after the
   deadline, or a late acceptance. The id list is a snapshot and will not
   contain it. **This gap exists today too** (nothing locks at provisioning) and
   a re-run rebuilds the list, but one call *looks* more atomic than it is.
   Write it down rather than let the next reader assume otherwise.

### Already fine, no work

* **Group repositories** — one repository, one id, many members. Reopening for
  one member reopens the repository, which is already the semantics
  (`planTargets` matches reopened over `teamMembers`).
* **Renames** — the id is the point.
* **A student who is an organization owner** — a ruleset stops them
  (`current_user_can_bypass: "never"`, `GH013`, §11.2.1) where demotion cannot.
* **The org ruleset deleted by an owner** — `findOrgSubmissionLock` returns null,
  the next finalize recreates it, and unlock reports "absent" exactly as the
  repository path does today.

## Build order

0. **`schemas/lockdown-record.schema.json`.** The record has no schema, so
   adding `org_ruleset_id` and a third `lock_method` would be adding fields to a
   document no test can reject.
1. `lib/submission-lock.mjs` — the four org-scoped functions, with the
   create-retry-on-422 rule in `ensureOrgSubmissionLock`.
2. `lockdown/lockdown.mjs` — the third method and the degradation ladder.
3. `lib/repo-unlock.mjs` — the inverse, including the leftover-ruleset release.
4. Delete path — remove the org ruleset, record it in the retired manifest.
5. Migration workflow (below).

## Migration

One hub workflow, per org, per assignment whose lockdown record shows
`lock_method: ruleset`:

1. build the id list from the record;
2. create the organization ruleset **active**;
3. **verify it reads back active**;
4. only then delete the per-repository rulesets.

Never the reverse — deleting first leaves a window with no lock. Same ordering
rule as the broker-secret migration, where publish pushes the new workflow
*before* removing the old secret.

Runnable from the hub with the App token, so nobody needs owner access to each
org. Order: `pxl-classroom-testbed` first (it is on **free**, so it proves the
degradation path and nothing else), then two Team orgs.

## Parked for the end: the two locks are presented as orthogonal and are not

**Do this discussion after the build, not during it.** Raised 2026-09-08.

The form offers two independent switches — `late_policy` (`report` / `block`)
and a `lock_down_enabled` checkbox — and logically they are not independent at
all. Demotion to `pull` *includes* stopping pushes; it is a branch lock plus
the confiscation of Actions, secrets, environments and runners. So the four
combinations are really three rungs of one ladder:

| What the lecturer means | Today's spelling |
|---|---|
| Record late work, stop nothing | `report` + no demotion |
| Stop pushes at the deadline | `block` + no demotion |
| Stop pushes *and* take the toolchain | either policy + demotion |

`report` + demotion is the odd one: it says *late work counts* and then removes
the student's ability to produce any. That is the configuration the 2026 exams
ran on, and it is the one that hurt — the lecturer got no deadline enforcement
and lost Actions and secrets anyway.

The code already half-admits this: `onLatePolicyChange` unticks the demotion
box when a lecturer chooses `block`, with a comment saying demoting on top
takes exactly what the branch lock exists to preserve. That is a single control
wearing two checkboxes.

**The question to answer later**, once org-scoped lockdown exists and the
choices are stable: should this be one three-way control — *nothing / stop
pushes / stop everything* — with `late_policy` and `lock_down_enabled` derived
from it? It would make the impossible combination unrepresentable rather than
merely discouraged, and it is the shape a lecturer actually reasons in.

Not now, because the answer changes if org scope lands: "stop pushes" gains a
second implementation and the form should not learn a distinction that turns
out to be an implementation detail. The stored fields need not change either
way — this is about what the screen asks, not about the document.

## Tests that have to exist

Derived, never restated — the rule this repository keeps paying for.

* The id list equals `planTargets`' targets: a deferred student and a reopened
  repository are **absent**, proved by running the planner rather than by
  asserting a literal.
* A dead id on create is retried once and the dropped students are named.
* `PUT` removal actually removes: `[a,b]` → `[a]` reads back `[a]`.
* `lock_method: "org-ruleset"` has an inverse, and `applyUnlock` refuses a
  method it does not know (the existing rule).
* The ruleset name is derived from the assignment id and stays under the
  measured length.
* Degradation: no App id → demotion, never a ruleset.
