# UX_PLAN.md

Implementation plan for the six recommendations in the UX review (23 Aug 2026).

> **This file is temporary.** CLAUDE.md forbids standing planning documents. When a
> workstream lands, its durable rules move into `DESIGN.md` (UI vocabulary and
> placement) or `ARCHITECTURE.md` (semantics and data), and its section here is
> deleted. When the last section goes, so does this file.

---

## 1. What we are actually fixing

The review found 25 issues, but they are symptoms of three causes. Every change
below traces to one of them, and anything that does not trace to one of them is
out of scope.

| # | Cause | Rule that follows |
|---|---|---|
| C1 | **The UI is organised by data model, not by task.** The editor is every field in `assignment.schema.json`, in schema order, gated by checkboxes. | A control exists because a lecturer has a decision to make, not because a field exists. A decision with one possible answer is not a control. |
| C2 | **Operations live in the editor.** Extensions, retries and the invitation link are cohort-running actions sitting in the assignment-defining form — two of them duplicated on the tracking view. | Defining an assignment and running a cohort are different jobs on different screens. An action has exactly one home, next to the object it acts on. |
| C3 | **Empty states replace the page.** The state you are in most often on day one is the state with the fewest available actions. | An empty state replaces the *panel* that has no data, never the page around it. It names what has not happened yet, not the workflow file that would make it happen. |

A fourth rule falls out of the findings rather than the causes, and it is the one
that matters most:

> **C4 — The UI must not describe behaviour the system does not have.**
> `late_policy: block` promised to refuse late pushes and did nothing.
> `roster_mode` defaulted to the opposite of the backend's own default. Both
> shipped as defaults. This is worse than a missing feature: it is a tool you
> have to verify.

---

## 2. Decisions taken

Confirmed before planning:

| Question | Decision |
|---|---|
| Late policy | **Implement `block` properly.** Settled in discussion as *enforcement at the deadline* rather than reconstruction afterwards — a ruleset flipped by a converging sentinel, stop-first. §3.2. |
| Template wall | **Link out only.** No repository creation on the lecturer's behalf. |
| Autograding | **Dedicated modal**, entered from a one-line summary in the form. |
| Published assignment | **Cohort-first**, settings behind a disclosure. Routing unchanged. |

Two constraints came out of the same discussion and shape §3.2 throughout:

* **Stopping access is the only time-critical step.** Everything else — recording,
  preserving, reporting — happens after, when nothing can change any more.
* **Students must keep their Actions, secrets and runners.** That is the course's
  subject matter, so removing push access must not remove it.

---

## 3. WS1 — Stop the UI claiming things that are not true

**Fixes:** UX2 (roster default), UX9 (draft count), UX11 (python mismatch),
UX13 (late policy), UX14 (acceptance mode).

It splits into two halves that share a theme but not a commit:

* ~~**The mechanical half** — §3.1, §3.3–§3.5.~~ **Shipped.** The roster default
  is `enforced`, the one-value `acceptance_mode` select is gone, a `python`
  autograde test means `script` on every runner (and the schema requires it),
  and the draft count reads each assignment's `state` instead of counting files.
  CLAUDE.md and ARCHITECTURE §5.4, §10.3 and §11.6 carry the durable rules.
* **The enforcement half** — §3.2. The largest change in the plan. It restructures
  `lockdown.mjs`, adds a new trigger mechanism, and has its own five-step sequence
  (§3.2.9). Steps 1–4 are shipped; step 5 is blocked on an App permission
  rollout, not on code. Nothing else in the plan waits on it.

§3.2.5 also contained a **live bug found while planning it** — deadline
extensions did not work — which shipped first, as WS0.

### 3.2 `late_policy: block` — enforced at the deadline, not reconstructed after it

**This is the largest single change in the plan and it restructures
`lockdown.mjs` rather than patching it.** The reasoning below is the design
conversation that produced it, kept because every discarded option was discarded
for a reason someone will otherwise re-litigate.

The goal is not a report that says a student was late. It is that at a review the
next morning, the code on screen is the code that existed at the deadline, and
there is nothing to argue about.

#### 3.2.1 Stop first, record afterwards

Today `lockdown.mjs` loops over students and, **per student**, reads the repo,
reads `HEAD`, writes an observation, and *then* demotes. For a 200-student cohort
that means student 1 is frozen at T+0s and student 200 minutes later, because the
demotion is a write against an ~80/min secondary limit. Two consequences nobody
would choose: **students at the end of the list get extra time**, and the snapshot
is not a consistent cut — student 1's `HEAD` is read minutes before student 200's.

The order inverts:

| Phase | What | When | Cost |
|---|---|---|---|
| **1 — STOP** | Flip one ruleset to `active` | At the deadline, to the second | 1 API call, sub-second, whole cohort at once |
| **2 — RECORD** | Repo object, `pushed_at`, `HEAD`, commit count, tags, observations | After. Unhurried. | N calls, no longer racing anything |
| **3 — PRESERVE** | Push to `pxl-classroom-archive` | After | existing `preserve.mjs` |
| **4 — DEMOTE** *(optional)* | Collaborator → `pull` | After | off by default, see 3.2.2 |

Phase 1 is the only time-critical step, and it is one call.

Four things fall out for free:

* **The snapshot is a consistent cut.** Every `HEAD` is read after all writes
  stopped.
* **`until` demotes to a fallback.** If access stopped *at* the deadline, `HEAD`
  **is** the deadline state — no commit-date filtering, so the forgeability
  question disappears in the normal case (§3.2.4).
* **Freeze-on-retry stops being load-bearing.** CLAUDE.md documents it as
  critical — *"re-reading `HEAD` would swap an on-time submission for a late
  commit"*. With stop-first that hazard is gone by construction. The freeze stays
  as belt-and-braces, not as the thing holding the design together.
* **A failed recording pass is safely re-runnable**, because the repositories are
  frozen and produce the same answer.

#### 3.2.2 A ruleset, not a demotion

Demoting to `pull` does not just remove push. It removes **everything**: Actions,
secrets, environments, runners, settings. On a course whose subject *is* those
things, it confiscates the subject matter at the deadline.

A repository ruleset takes only what is needed:

| Rule | Blocks |
|---|---|
| `update` | pushing to the submission ref |
| `non_fast_forward` | force-push — closes the history-rewriting hole |
| `deletion` | deleting the branch |

with the Provisioner App in `bypass_actors` so preservation still works.

| | Demote to `pull` (today) | Ruleset (proposed) |
|---|---|---|
| Blocks pushes | yes | yes |
| Student keeps Actions / secrets / runners | **no** | **yes** |
| Blocks force-push before lockdown | no | yes |
| API calls to lock a cohort | one per student | **one** |
| Deadline extension for one student | impossible today (§3.2.5) | remove one repo from the target list |
| Student can delete the repository | no | **yes** — see below |

The last row is the trade. A ruleset leaves them admin, so they could delete the
repository outright. Phase ordering answers it: by the time that matters,
Phase 3 has pushed a copy to `pxl-classroom-archive`, which they cannot touch.
Phase 4 remains available as a per-assignment switch for anyone who wants admin
gone as well, at the cost of the Actions access this whole change exists to keep.

**Rulesets have no time conditions.** `enforcement` is `disabled` / `active` /
`evaluate` and nothing is date-aware, so the ruleset is created **disabled** at
provisioning and flipped at the deadline. That is what Phase 1 is.

**Verified live (§10 risk 2).** The App pushes through an active ruleset when it
is in `bypass_actors` as `actor_type: "Integration"`; an org owner reading the
same ruleset gets `current_user_can_bypass: "never"` and is rejected with
`GH013`. The flip is one `PUT` with a partial body:

```
PUT /repos/{org}/{repo}/rulesets/{id}   -f enforcement=active
```

##### Open decision: organization-level or repository-level — **measured**

The organization half was tested live on 23 Aug 2026, with an org owner's token
rather than the App's, because the only thing the App permission changes is *who
may make the call*:

* One ruleset with `conditions.repository_name.include: ["exam2026-*"]` blocked
  pushes to `exam2026-alice` and `exam2026-bob` and left `other-repo` alone.
  **One object, one call, whole cohort** — the row in the table below is real,
  and it is a property of organization scope only.
* `PUT /orgs/{org}/rulesets/{id} -f enforcement=disabled` released all of them in
  one call, and the next push succeeded immediately. So Phase 1 at org scope is
  genuinely a single request regardless of cohort size.
* The ruleset shows up in each **repository's** own `GET .../rulesets` listing
  carrying `source_type: "Organization"`. That is exactly why
  `findSubmissionLock` filters it out: a student's repo lists it, and neither
  they nor the repo can manage it.

What remains is not a design question but a rollout: the App declares
`organization_administration: read` and the call needs `write`. See §3.2.9 step 5.

| | Permission needed | Student (repo admin) can remove it? |
|---|---|---|
| **Repository** ruleset | `administration: write` — **the App already has this** | **Yes** |
| **Organization** ruleset | `organization_administration: write` — the App has **read** (`lib/audit.mjs:40`) | **No** |

Organization-level is the version that actually holds, and it also targets
repositories by **name pattern**, so `<assignment-id>-*` covers a cohort in one
object. Its cost is an App permission bump: change the declaration in the App's
settings, then **every installed org must approve** the new permission, and until
they do the feature has to degrade to today's behaviour there. System Health
already has the machinery to surface exactly this kind of drift (Tier 1).

Repository-level works today with no permission change and a student *can* delete
it — but deleting a ruleset is a deliberate, visible act in their own repository
settings. *"You committed at 22:31"* is arguable; *"you disabled the deadline
enforcement on your repository"* is not.

**Recommendation:** build against repository rulesets first, because it ships
without a permission rollout and is testable immediately; structure the code so
the scope is one function (`applySubmissionLock(scope)`), and move to
organization rulesets once the permission is approved.

**Shipped, with one deviation.** `lib/submission-lock.mjs` owns the ruleset and
`applySubmissionLock({ method: "ruleset" })` applies it. The deviation is *when*:
the plan said create it **disabled at provisioning** and flip it at the deadline,
and it is instead created-or-flipped at lockdown. At repository scope that is the
same number of calls at the deadline either way — the "one call" row in the table
above is an **organization** ruleset property, not a repository one — and every
repo provisioned before this shipped needs the create path regardless, so
pre-creating would have been a second code path in the burst-sensitive
provisioning flow for no saving. It becomes one call at step 5, where the object
is created once for the whole org.

Two failure paths, both degrading to demotion rather than to no lock: an
unresolvable App id (a ruleset the App cannot bypass locks the system out with no
way back) and a per-repository ruleset call that fails. `lock_method` on each
result says which actually applied.

`late_policy` turned out to have a sibling: **`lock_down_enabled` was dead in
exactly the same way** — a Guardrails checkbox promising "demote admin -> pull at
the deadline" that no code read, on a system that demoted everyone regardless. It
is Phase 4's switch now, and it defaults to `true` when the field is absent,
because every assignment created before this shipped *was* demoted and inferring
"no lock" from a missing field would silently stop freezing live cohorts.

#### 3.2.3 The trigger: a converging sentinel — **shipped disabled**

> Landed as `deadline-sentinel.yml` + `scripts/find-armable.mjs` +
> `scripts/deadline-sentinel.mjs`, with `STOP_ONLY=1` on `lockdown.mjs` as the
> stop. Three departures from the sketch below, each for a reason:
>
> * **The arm window is 4.5h, not 6h.** It only has to exceed the 4-hourly cron
>   interval; the rest is margin against the job limit.
> * **The sentinel does not flip the ruleset itself.** It waits and records; the
>   workflow then runs lockdown's Phase 1. One implementation of "stop writes",
>   which the sentinel cannot drift from.
> * **It re-reads the assignment deadline, not the overrides.** A per-student
>   extension is handled where it already is — `planTargets` excludes anyone
>   still extended at the moment of the flip — so re-reading `overrides/` every
>   poll would buy nothing and cost a call per student.
>
> `STOP_ONLY` writes **no** lockdown record. `find-finalizable.mjs` reads that
> record's existence as evidence a finalize happened, and one with empty
> `results` would strand the assignment forever.

Phase 1 must happen *at* the deadline. GitHub offers no date-aware primitive, so
something has to be running. The shape that works, and the limits that decide it:

* **A job can run 6 hours** (GitHub-hosted). So a sentinel must start within 6h of
  the deadline.
* **Team plan allows 60 concurrent jobs.** A sentinel holds a slot while it waits.
* The hub is **public**, so runner time is **free regardless of duration**
  (ARCHITECTURE §6.5).

`cron` cannot be rescheduled dynamically, and it does not need to be. A fixed
**4-hourly** outer cron gives at least two chances to arm a sentinel before any
deadline, with margin inside the 6h job limit, plus a fallback pass afterwards.

**Cron drift stops affecting precision.** It decides only whether the sentinel
*arms in time*, never when it acts. A firing scheduled for 16:00 that lands at
16:25 still sees a 20:00 deadline 3h35m out, still arms, and still acts at
20:00:00.

**The sentinel polls; it does not sleep.** A job idling for four hours is
defensible-but-grey under GitHub's acceptable use, and the useful work happens to
be exactly what the design was missing:

```
every 5 minutes until the deadline:
  GET /orgs/{org}/repos?sort=pushed&direction=desc&per_page=100
  → pushed_at for 100 student repos, one call
  record it; re-read the assignment so a live extension moves the target
at the deadline:
  PUT the ruleset to enforcement: active      ← Phase 1
  dispatch the finalize path                  ← Phases 2-4
```

* ~36 iterations × ~3 calls ≈ **108 calls** for a 200-student cohort over three
  hours. Polling each repo individually would be 200 × 36 = 7,200 against a
  5,000/hr limit — that is the trap, and `sort=pushed` avoids it.
* `pushed_at` is **GitHub's own server-side timestamp**, which a student cannot
  set. A five-minute push timeline through the critical window is what ends the
  *"I committed before the deadline"* conversation: *"at 21:55 your last push was
  21:12; at 22:05 it was 22:31."*
* Re-reading the assignment each iteration means an extension granted at 21:00 is
  honoured at 22:00 without anything being restarted.

**Concurrency:** one sentinel per `(org, deadline instant)`, not per assignment,
so three assignments sharing a 22:00 deadline share one job. Cap the number armed
per firing and let the rest fall through to the ordinary pass.

**Every failure degrades to today's behaviour:**

| Failure | Result |
|---|---|
| Cron delayed 30 min | Sentinel arms with less margin. Accuracy unaffected. |
| Cron firing dropped | Next firing (≤4h) catches it; if that is after the deadline, an immediate lock. |
| Sentinel job killed mid-poll | Same — the next firing locks immediately. |
| Two sentinels overlap | Both flip the ruleset. Idempotent. |

Nothing gets *worse* than the current nightly, which is the property that makes
this safe to ship incrementally.

#### 3.2.4 When the sentinel did not run: the `until` fallback — **shipped**

If Phase 1 happened at the deadline, `HEAD` **is** the submission and nothing
further is needed. When it did not — a dropped run, an assignment published after
the last firing, a sentinel that died — lockdown falls back to reconstructing the
deadline state:

```
GET /repos/{org}/{repo}/commits?sha={branch}&until={effective_deadline}&per_page=1
```

taking `[0].sha`, and `null` when the list is empty (see 3.2.7).

Two things to know about this path, and they belong in the UI rather than only in
the code:

1. **It filters on a date the student controls.** Confirmed live (§10 risk 3):
   `until` is the **committer date** alone — a commit authored before the deadline
   but committed after it is *excluded*, and one authored after but committed
   before is *returned*. That matches `git log --until`. But `GIT_COMMITTER_DATE`
   is client-supplied, so the fallback is *not* tamper-proof and must never be
   described as such.
2. **The nightly observation record does not rescue it.** Observations are ~20
   hours apart, so *"this commit was not in the last pre-deadline observation"*
   flags every commit made on the final day. It cannot distinguish 21:50 from a
   backdated 22:30. Only the sentinel's five-minute `pushed_at` timeline can, and
   only when the sentinel ran.

So the fallback gets the right code in the ordinary case and carries an honest
caveat in the adversarial one. The sentinel is what makes the adversarial case
answerable.

#### 3.2.5 The *effective* deadline — **shipped (WS0)**

Every deadline comparison above has to be the deadline **for that student**, or
the change discards exactly the work an extension was granted to allow.

`lib/effective-deadline.mjs` now exists and is what §3.2 builds on:
`effectiveDeadlineFor(assignment, login, { overrides, team })`, plus
`latestEffectiveDeadline(assignment, overrides)` for the cohort-wide question.
`report.mjs`, `lockdown.mjs` and `find-finalizable.mjs` all read it. The sentinel
(§3.2.3) uses it for the instant to wake for, re-read each poll; the ruleset
(§3.2.2) uses it to leave an extended student off the target list, which
`lockdown.mjs` already does by deferring them.

The plan said *extracted verbatim*. It could not be: the calculation in
`report.mjs` read `override.deadline_at`, and the Admin Panel has written the
append-only `overrides[]` array since 2026-06-17 — so extensions worked in no
consumer at all, not merely in two of the three. Extracting it verbatim would
have spread dead code. See ARCHITECTURE §6.2.2 for what shipped instead.

#### 3.2.6 "No submission" is an outcome, not an error

Under `block`, a student who only pushed after the deadline has **no**
`snapshot_sha`. `preserve.mjs:225` treats that as `errorCount++`, so the run's
outcome becomes `partial` — one slacker turns the nightly amber for the whole
cohort. That is CLAUDE.md's *"an empty population is not a failure"* at the wrong
granularity: it covers zero *records*, not zero *submissions*.

`preserve` gains a third bucket — preserved / **no submission** / failed — and only
the last counts toward `errorCount`. The report already distinguishes them; the
workflow outcome does not.

**Shipped.** `lockdown.mjs` marks the result `no_submission: true` when the
`until` query comes back empty, `preserve.mjs` skips it as an outcome, and a
missing `snapshot_sha` *without* that flag is still an error — the exemption must
not widen into "no submission is always fine". `no_submission_count` is an output
of both actions. There is a fourth bucket beside it now, **deferred**, for a
student whose extension is still running (§3.2.5).

#### 3.2.7 The control, and what it now honestly says — **shipped**

The `<select>` moved out of *Advanced* into *Guardrails*, beside lockdown, because
it is a policy decision rather than a tuning knob. What shipped, with the copy
corrected to what the system actually does today — there is no sentinel yet, so
claiming the lock fires "at the deadline itself" would have re-created C4:

> **Late work**
> (•) **Counts** — late commits are part of the submission and flagged in the
>     report. The submission branch is not locked.
> ( ) **Does not count** — the submission branch is locked at the deadline.
>     Students keep their repository, their Actions, their secrets and their
>     runners; they simply cannot push to it.
>
> *(under "Does not count")* Locking happens on the first nightly run after the
> deadline. Anything pushed in between is filtered out — the submission falls back
> to the last commit *committed* before the deadline. That date comes from the
> student's own machine, so treat it as the ordinary case rather than as proof.
>
> ☐ **Also take admin away at the deadline (demote to read-only)**
> *Not needed to stop late pushes — the branch lock above already does that, and
> leaves students their Actions, secrets and runners. Tick this only if they
> should lose those too.*

**Schema:** unchanged; the enum already has both values.

**Default:** `report`, and picking "Does not count" unticks the demotion — it
takes exactly what the branch lock exists to preserve. Ticking it back on is a
deliberate choice.

That last sentence of the hint is the one to keep when this section is deleted:
the fallback is committer-date based and the committer date is client-supplied
(§10 risk 3 confirmed both halves live). Saying so in the form is the difference
between a tool and a tool you have to verify.

#### 3.2.8 What this means for `lockdown.mjs` — **phase split shipped**

The file is restructured, not patched, and the restructure has landed:

* `planTargets(...)` — Phase 0, splits the cohort into targets and deferrals so
  "excluded from the target list" means the same thing to the stop as to the
  recording
* `applySubmissionLock({ targets, method, priorByLogin })` — Phase 1, idempotent,
  the only thing that knows *how* writes stop. `method` is `"demotion"` today;
  step 3 adds `"ruleset"` beside it and nothing else in the file changes
* `recordCohortState(...)` — Phase 2, the snapshot logic minus the demotion,
  reading `pushed_at` off the repo object it already fetches
* the demotion becomes Phase 4 once Phase 1 stops it another way

The lockdown record carries `locked_at`, `lock_method` and per-student
`pushed_at`. What is still open is the `scope` argument: Phase 1 takes a target
list, not an org/assignment pair, so the sentinel and a lecturer-pressed button
cannot call it yet without a control-repo checkout. That is step 3's problem.

**Tests:**

* ~~`tests/effective-deadline.test.mjs`~~ — **shipped** (19 tests).
* ~~`tests/lockdown-phases.test.mjs`~~ — **shipped**: every stop precedes any
  read, and any repository fetch; `locked_at`/`lock_method`/`pushed_at`; a failed
  Phase 2 leaves the cohort stopped and re-runs clean; an empty cohort stops
  nothing. *"The lock is one call regardless of cohort size"* is not assertable
  until rulesets — demotion is N calls by construction — so it belongs to step 3.
* ~~an extended student is excluded from the target list~~ — **shipped** in
  `tests/lockdown-extension.test.mjs` (no API call is spent on them at all).
* `tests/lockdown-late-policy.test.mjs` (new) — the `until` fallback picks the
  pre-deadline commit; an only-late repo yields no submission; an extension moves
  the window; freeze-on-retry still wins.
* `tests/lockdown-retry.test.mjs` — unchanged, still green.
* `tests/e2e/32-deadline-lock.spec.mjs` (new) — the lecturer-facing half: the
  control's wording, the "lock now" action, and the report showing `lock_method`.

#### 3.2.9 Sequencing within WS1

1. ~~`lib/effective-deadline.mjs` + the three consumers.~~ **Shipped** — see
   §3.2.5.
2. ~~`lockdown.mjs` phase split, still demoting.~~ **Shipped** — see §3.2.8.
3. ~~Repository rulesets behind `late_policy: block`, demotion as the fallback.~~
   **Shipped** — §3.2.2, §3.2.4, §3.2.6 and §3.2.7 together, because `block`
   without the `until` fallback would record post-deadline work as the
   submission, and without the honest control it would re-create C4.
4. ~~The sentinel, arming from the existing cron at 4-hourly.~~ **Shipped
   disabled** — §3.2.3. It has its own 4-hourly cron rather than riding
   `daily-activity.yml`'s (which is `0 0 * * *` and disables itself when idle),
   and `publish-assignment.yml` enables it beside the nightly. Turn it on with
   `gh workflow enable deadline-sentinel.yml`; RUNBOOK §7.1.
5. Organization rulesets, once the App permission is approved. **Blocked on a
   human, and the block is not a code problem.** The mechanism is measured and
   works (§3.2.2 above); what is missing is that the App declares
   `organization_administration: **read**` and the call needs `write`. That
   permission lives on the **App**, not the installation, so it takes:

   1. the App owner changing *Organization permissions → Administration* to
      **Read and write** at
      `https://github.com/settings/apps/pxl-classroom-provisioner/permissions`;
   2. **every installed org approving** the new request (RUNBOOK §10.6);
   3. only then, `applySubmissionLock` gaining an `"org-ruleset"` method beside
      the two it has, with the repository ruleset staying as the fallback for
      orgs that have not approved.

   Until then `late_policy: block` works through repository rulesets, which need
   no permission change. What org scope buys is one call instead of N, and a lock
   a repo-admin student cannot delete — worth doing, not worth blocking on.

Steps 1–4 are shipped. Step 4 is shipped **disabled** (RUNBOOK §7.1).
Each step is useful on its own and none of them requires the next.

---

## 4. WS2 — Make "hand this to students" a place — **shipped**

**Fixed:** UX6 (link as a blob), UX7 (no distribute step), UX8 (empty state eats
the page), UX21 (regenerate undiscoverable), UX23 (link in three places).

Deviations, all deliberate:

* **Copy is `.btn-primary` only in the `inline` variant.** §4.1 called it the
  primary action of the block, but DESIGN.md §1.2 is enforced across the whole
  *view* and the editor's primary is Save. On the detail page Copy replaces the
  primary that was already there; in the banner it is secondary and
  `Track Roster & Progress` was demoted with it, so that block adds no solid
  button of its own.
* **`:resolve="false"`** had to be added: the component reads the token from the
  control repo when a caller does not have it, and that resurrected a link the
  panel had deliberately cleared on rotation.
* The test file is `34-share-surface.spec.mjs`; `29` was taken.

Two things found while building it: the More-actions dropdown was anchored
`left: 0` and stayed on screen only because another button sat to its right —
removing that button put the menu's own centre outside the window; and the
`22-design-conformity` suite had never visited the admin editor with an
assignment open, so the whole publish banner was uncounted.

Rules are in CLAUDE.md, ARCHITECTURE §10.3 and §11.3, RUNBOOK §4.4 and §1.3.1.

`tests/e2e/34-share-surface.spec.mjs`.

---

## 5. WS3 — The first-run wall — **shipped**

**Fixed:** UX1 (template dead end), UX3 (roster prerequisite), UX4 (seed control
that cannot work), UX5 (AJV errors).

One deviation, recorded because it was deliberate: §5.1 said the empty state
replaces the combobox. It sits **underneath** it instead — typing `owner/repo`
is the only way to name a template in another organization, and an org with none
of its own is exactly when someone reaches for one.

Two things the plan got wrong about the code, found while building it: the
roster count is *not* already in hand from `validateStudentLogin` (which fetches
per call and caches nothing) — it comes from `RosterTab`, which has already read
the file; and a roster that **fails to read** must not be reported as an empty
one, which the plan did not distinguish.

Two bugs the edge-case tests found afterwards, both the same shape: a failed
request rendering as a confident zero. `listOrgRepos` swallowed a failed page,
so a 500 on both template routes claimed the organization had no templates; and
`github_login` is optional in the roster CSV and is the only field `accept.mjs`
matches on, so a roster imported before anyone handed in a username let nobody
accept while the form said *"200 students on the roster"* in green.

Rules are in CLAUDE.md, ARCHITECTURE §10.4 and RUNBOOK §4.1.
`tests/e2e/32-first-run-wall.spec.mjs`, `tests/assignment-validation-messages.test.mjs`.

---

## 6. WS4 — Autograding becomes a task — **shipped**

**Fixed:** UX10 (checkbox opens a config language), UX12 (zero-test states),
UX15 (visibility named after its mechanism).

Deviations and additions:

* **`autograde_enabled` had to be handled on load, not only in the form.** The
  plan says the configuration's existence is the flag; an assignment YAML with
  `enabled: true` and zero checks then loads as a state the summary calls "Off"
  while Save fails on `tests.minItems`. It loads as *off* instead, so the next
  save repairs it.
* **Duplicate check ids are refused**, which §6.2 did not mention: two checks
  with one id collide as workflow step ids.
* §6.3's "closing the modal with zero checks sets Off" is stronger here — the
  modal cannot save an empty configuration at all, and *Turn off automated
  checks* is the explicit way out.
* The zero-checks `npm test` path is not deleted but **replaced with a failing
  step**. `visibility: private` with no checks still reaches the same generator
  branch, and returning nothing there produces a workflow with no jobs.
* The spec is `35-autograding.spec.mjs`; `30` was taken.

Two more found by the edge cases afterwards, both a control deciding something
on the lecturer's behalf: Escape did not close the modal (every other modal in
the app closes on it), and a blank points field was `Number('') === 0`, so a row
nobody filled in was saved with a score the system chose.

Rules are in CLAUDE.md, ARCHITECTURE §11.6 and RUNBOOK §4.1 and §12.9.
`tests/autograde-modal.test.mjs`, `tests/e2e/35-autograding.spec.mjs`,
`tests/e2e/36-autograding-edges.spec.mjs`.

---

## 7. WS5 — A published assignment opens on the cohort — **shipped**

**Fixed:** UX22 (operations duplicated), UX24 (Lifecycle is a flat row),
UX25 (published editor is the draft editor).

The editor pane branches on state: `published`/`closed` lead with the share
block, a cohort card and a link to the tracking page, with the six fieldsets
behind an `Edit settings` disclosure; a draft opens on the form. *Grant deadline
extension* and *Retry a failed acceptance* are deleted from `AdminView` along
with `validateStudentLogin` and `startRetryWatch`; Lifecycle groups **Repair**
above the state transitions.

What deviated from the plan, and why:

* **The cohort numbers cost one request.** §7.1 said they come from "the same
  `dashboard.json` the list already reads" — the list does not read it; that is
  `DashboardView`. It is one Contents API call per page load, shared by every
  assignment in the pane, and the card says *"no cohort report yet"* /
  *"couldn't read the cohort report"* rather than rendering a zero nobody
  counted.
* **Nothing forces the disclosure open.** The plan wanted `fieldErrors` to force
  it; a `<details>` that refuses to close is a dead control, and every field
  that can carry an error is *inside* it, so no problem can appear while it is
  shut. It opens on **load** when the assignment arrives broken, and the
  **count on the summary** is what keeps the problem stated afterwards. A
  watcher for the unreachable case was written, then deleted — it was a test
  that could only pass against nothing.
* **Archived keeps the form.** §7.1 named `published` and `closed`; archived
  falls to the draft behaviour, because what is left to look at there is what
  the assignment was configured to be.
* **The transitions already confirmed.** §7.1 said *Stop accepting* and *Revert
  to draft* had no confirmation. They did, and both already named the
  consequence; the tests now pin that rather than adding a second one.
* **Two more §1.2 primaries went with it.** The backlog `tests/e2e/22` recorded
  was five: the two accordions, plus the form repeating `Save & publish` top and
  bottom, plus `New assignment`. The duplicated bottom action row is deleted
  (the header bar is the form's action bar) and `New assignment` is solid only
  while nothing is open. `22-design-conformity` now checks the whole admin
  editor, collapsed and expanded, instead of just `.published-info-card`.
* **A fourth countdown copy was about to be written**, so
  `frontend/src/lib/countdown.js` is now the only one and
  `tests/deadline-countdown.test.mjs` fails if anything forks it again.
* The new spec is `tests/e2e/37-published-cohort.spec.mjs` — the plan said 31,
  which WS1 had taken.

Rules are in CLAUDE.md, ARCHITECTURE §10.1.1, DESIGN.md §1.2 and §7, and
RUNBOOK §4.3, §6.2 and §6.3.

---

## 8. WS6 — Link what exists, or remove it

**Fixes:** UX17 (`/usage`), UX18 (`/setup`), UX19 (`/sandbox`), UX20 (feedback list).

| Route / feature | Now | Change |
|---|---|---|
| `/usage` (all orgs) | 0 inbound links | Link from the org switcher rail, beside the health pulse: **Usage & limits**. It is the only cross-org view in the app and it is currently unreachable. |
| `/dashboard/:org/usage` | 1 inbound link; duplicates the embedded `UsagePanel` | Keep both — the panel is the glance, the view is the detail. The panel's header becomes a link to it. |
| `/setup` | 0 inbound links | Link from the `DashboardView` "no organizations" state and from the System Health *Tier 1* check when the App is missing or misconfigured. That is where someone discovers they need it. |
| `/sandbox` | 0 inbound links, shipped in production | Guard the route on `import.meta.env.DEV`. It renders mock cohort data at a public URL. |
| `pxl-classroom feedback list` | No UI | The *Open Feedback PRs* result panel gains a per-student column: PR number, state, and open review-comment count — the question the CLI command answers. Same data, already fetched by `open-feedback-prs.mjs`. |

**Tests:** `tests/vue-route-safety.test.mjs` gains an assertion that every named
route except `not-found` has at least one inbound link or is dev-gated — the check
that would have caught all three of these.

---

## 9. Sequencing

```
WS0  effective deadline       ──►               (a live bug; ships alone, first)
WS1  truthful controls         ────────►        (small half: 3.1, 3.3-3.5)
WS1b deadline enforcement      ───────────────────────►  (3.2; five steps of its own)
WS3  first-run wall            ────────►        (independent)
WS2  share surface             ────────────────►  (WS5 consumes the component)
WS4  autograde modal           ────────────────►  (WS5 shows its summary line)
WS5  cohort-first published                    ─────────►  (needs WS2 + WS4)
WS6  orphan routes             ────────►        (independent)
```

**WS0 — `lib/effective-deadline.mjs` — first, and entirely on its own.** It is not
a UX change at all: deadline extensions do not currently work (§3.2.5), and the
report claims they do. Everything in §3.2 depends on it, but it is worth shipping
before any of this for its own sake.

**WS1 splits.** The mechanical half — roster default, acceptance mode, python
runners, draft count — is small and reviewable in one pass. The deadline
enforcement half (§3.2) is the largest change in the plan, restructures
`lockdown.mjs`, and has its own five-step sequence in §3.2.9. They share a theme,
not a commit.

~~**WS1's small half must precede WS5**~~ — **shipped**, so WS5 can read
`roster_mode` and `late_policy` and describe the assignment accurately. The
enforcement half does not block anything else.

~~**WS2 and WS4 before WS5.**~~ ~~**Both shipped.**~~ **WS5 shipped too.**

~~**WS3 and WS6 any time.**~~ **WS3 shipped**; WS6 still any time — and is now
the last section left. Neither touches shared components.

Each workstream is one commit, with its tests, per the repo's convention.

---

## 10. Risks and things to check live

1. ~~**Deadline extensions are already broken (WS0, §3.2.5).**~~ **Fixed.** It was
   worse than the plan recorded: `report.mjs` read a field no override document
   has carried since 2026-06-17, so extensions worked in no consumer at all.
   `lib/effective-deadline.mjs` is now the single implementation and
   `lockdown.mjs` defers an extended student instead of demoting them.
   ARCHITECTURE §6.2.2.
2. ~~**Whether a GitHub App can manage rulesets at all (§3.2.2).**~~ **Confirmed
   live, 23 Aug 2026** — throwaway repo in `PXL-Systems-Expert`, run
   [32659354771](https://github.com/PXL-Digital-Application-Samples/pxl-classroom/actions/runs/32659354771).
   Four answers, all the way the plan needs them:

   * **The App pushes through an active ruleset.** `bypass_actors` with
     `actor_id: 4051936, actor_type: "Integration", bypass_mode: "always"` is
     accepted and honoured: `remote: Bypassed rule violations for
     refs/heads/main` and the ref updated, against `update` +
     `non_fast_forward` + `deletion` at `enforcement: active`. **Phase 3 does
     not have to precede Phase 1; the stop-first ordering in §3.2.1 holds.**
   * **Nobody else does.** Reading the same ruleset as an **org owner** returns
     `current_user_can_bypass: "never"`; reading it as the App returns
     `"always"`. A push as that org owner was rejected with `GH013 ... Cannot
     update this protected ref`. A student is repo admin, strictly weaker than
     an org owner, so §3.2.2's central claim stands.
   * **The App flips enforcement itself**, `disabled` ↔ `active`, in one
     `PUT /repos/{o}/{r}/rulesets/{id}` taking ~0.5 s. That call *is* Phase 1.
   * **The update accepts a partial body** — `-f enforcement=active` alone, no
     need to resend rules or bypass actors. So the flip cannot accidentally
     rewrite the lock's definition.
3. ~~**`until` filters on a date GitHub does not document (§3.2.4).**~~
   **Confirmed live, 23 Aug 2026** — throwaway repo, three commits with author
   and committer dates deliberately split around a 22:00 deadline:

   | commit | author | committer | `?until=22:00` |
   |---|---|---|---|
   | B | 21:00 (before) | 23:30 (after) | **excluded** |
   | D | 23:50 (after) | 21:30 (before) | **returned** |

   So `until` is the **committer date** alone, matching `git log --until`. `[0]`
   of the filtered list is the newest ancestor of the tip passing the filter,
   which is exactly the commit §3.2.4 wants.

   The spike also *is* the demonstration that this path is not tamper-proof: both
   dates were set with `GIT_AUTHOR_DATE` / `GIT_COMMITTER_DATE`, which any student
   can do. The fallback picks the right commit in the ordinary case and must never
   be described as a guarantee.
4. **A long-lived sentinel job is new operational surface (§3.2.3).** It holds a
   runner slot for hours, and while a *polling* job is doing real work — unlike an
   idle `sleep` — nothing like it exists in this system today. Watch the
   concurrency budget on Team (60 jobs) the first term it runs, and cap how many
   arm per firing. **Still open, deliberately:** it shipped **disabled**, the cap
   is in (`MAX_SENTINELS`, default 8, and what it drops is logged), and
   `publish-assignment.yml` enables it — so the first time it runs for real is a
   decision, not a side effect. RUNBOOK §7.1.
5. **`AdminView.vue` is 2,900 lines and this plan touches most of it.** WS2, WS4
   and WS5 should each extract as they go — `InvitationShare.vue`, `AutogradeModal.vue`,
   and a `PublishedCohortPanel.vue` — rather than growing the file further. Extracted
   classes used by more than one component go to `style.css` (DESIGN.md §7).
   **WS2 and WS4 extracted; WS5 did not.** Its cohort card is ~25 lines of
   template over one computed, used by one view — a component for that buys
   indirection, not reuse, and DESIGN.md §7's rule (a class used by two
   components lives in `style.css`) has nothing to bite on. The file still
   shrank: WS5 deleted ~260 lines of extension/retry handling. It is 2,994
   lines and the next workstream to touch it should still extract.
6. **The undeclared-class backlog** (`tests/fixtures/undeclared-classes.backlog.json`,
   98 entries) overlaps several of the components being touched. Any class a
   rewritten component stops using must leave that file, or the guard fails.
7. **Nothing here has been tried against a live org.** The template-empty state, the
   roster count and the cohort numbers all assume responses I have only seen from
   fixtures.

---

## 11. Out of scope

* Visual design — palette, spacing, typography, the DESIGN.md token system.
* The student group flow (`GroupAcceptanceCard`), which was not reviewed at the
  same depth. The individual student page is the closest thing in the app to a
  screen designed for its user rather than its data, and is the reference the
  lecturer surfaces should be moving toward.
* The CLI. Its surface is coherent; the gaps found were in the app not exposing
  what the CLI already does (WS6).
