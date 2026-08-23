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

* **The mechanical half** — §3.1, §3.3–§3.5. Small, reviewable in one pass, and
  it lands first because every other workstream sits on top of a form whose
  defaults are currently wrong.
* **The enforcement half** — §3.2. The largest change in the plan. It restructures
  `lockdown.mjs`, adds a new trigger mechanism, and has its own five-step sequence
  (§3.2.9). Nothing else in the plan waits on it.

§3.2.5 also contains a **live bug found while planning it** — deadline extensions
do not work — which should ship before either half.

### 3.1 `roster_mode` defaults to `enforced`

`AdminView.vue:1350` writes `roster_mode: 'open'` into every new assignment.
`accept.mjs` fails closed to `enforced` for any unrecognised value, so the form
is the only thing choosing the permissive setting — and the hint underneath it
already says *"Anyone with the link can claim a repo."*

* `emptyForm()` → `roster_mode: 'enforced'`.
* `max_acceptances` stays at its current default and stays optional under
  `enforced`; the `open`-requires-a-cap rule in `fieldErrors` is unchanged.
* Existing assignments are untouched. This changes the default for new ones only.

**Test:** `tests/admin-lifecycle-ui.test.mjs` — a new assignment's `buildDoc()`
carries `roster_mode: 'enforced'`; the `open` path still requires a cap.

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

##### Open decision: organization-level or repository-level

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

#### 3.2.3 The trigger: a converging sentinel

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

#### 3.2.4 When the sentinel did not run: the `until` fallback

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

1. **It filters on a date the student controls.** GitHub's REST docs say only
   *"Only commits before this date will be returned"* and never state whether that
   is the author or the committer date; `git log --until` uses the committer date
   and the API appears to match, but **this must be confirmed against a real
   repository before shipping**, because a rebased commit carries both and the
   choice decides which commit is picked. Either way it is client-supplied, so the
   fallback is *not* tamper-proof and must never be described as such.
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

#### 3.2.7 The control, and what it now honestly says

The `<select>` moves out of *Advanced* into *Guardrails*, beside lockdown, because
it is a policy decision rather than a tuning knob:

> **Late work**
> ( ) **Counts** — the repository stays open after the deadline. Late commits are
>     part of the submission and flagged in the report.
> (•) **Does not count** — the submission branch is locked at the deadline.
>     Students keep their repository, their Actions and their secrets; they
>     cannot push to the submission branch.
>
> Locking happens at the deadline itself when the system is running, and within a
> few hours otherwise. Where it was late, the submission falls back to the last
> commit dated before the deadline.

**Schema:** unchanged; the enum already has both values.

**Default:** `report`. `emptyForm()` currently writes `'block'` — the form has
been defaulting to the value that did nothing — so it changes to `'report'` and a
lecturer opts *in* to discarding work.

#### 3.2.8 What this means for `lockdown.mjs`

The file is restructured, not patched. Today one loop does snapshot-and-demote per
student; it becomes:

* `applySubmissionLock({ org, assignmentId, scope })` — Phase 1, idempotent, one
  call, callable from the sentinel and from a lecturer-pressed button
* `recordCohortState(...)` — Phase 2, the existing snapshot logic minus the
  demotion, now reading `pushed_at` from the repo object it **already fetches**
  (`lockdown.mjs:158`) at no extra cost
* the demotion becomes Phase 4 behind a per-assignment switch

The lockdown record gains `locked_at` (when Phase 1 actually fired), `pushed_at`
per student, and `lock_method` (`ruleset` | `demotion` | `none`), so the report
can say which guarantee applied.

**Tests:**

* `tests/effective-deadline.test.mjs` (new) — the extracted function against
  assignment-only, per-student override, group-latest-member, and malformed
  override records. **Ships first, on its own.**
* `tests/lockdown-phases.test.mjs` (new) — Phase 1 precedes any read; a failed
  Phase 2 is safely re-runnable; the lock is one call regardless of cohort size;
  an extended student is excluded from the target list.
* `tests/lockdown-late-policy.test.mjs` (new) — the `until` fallback picks the
  pre-deadline commit; an only-late repo yields no submission; an extension moves
  the window; freeze-on-retry still wins.
* `tests/lockdown-retry.test.mjs` — unchanged, must stay green.
* `tests/e2e/32-deadline-lock.spec.mjs` (new) — the lecturer-facing half: the
  control's wording, the "lock now" action, and the report showing `lock_method`.

#### 3.2.9 Sequencing within WS1

1. ~~`lib/effective-deadline.mjs` + the three consumers.~~ **Shipped** — see
   §3.2.5.
2. `lockdown.mjs` phase split, still demoting. No behaviour change, all tests green.
3. Repository rulesets behind `late_policy: block`, demotion as the fallback.
4. The sentinel, arming from the existing cron at 4-hourly.
5. Organization rulesets, once the App permission is approved.

Each step is useful on its own and none of them requires the next.
### 3.3 `acceptance_mode` — control removed, field kept

One enum value, so no decision to make (C1). Remove the `<select>` from
*Advanced*; leave the schema field and `pages/generate.mjs` alone so existing
YAMLs keep validating and the public card is unchanged.

### 3.4 Python autograde tests work on both runners, or on neither

`provisioning/provision.mjs:183` ignores `t.script` and emits
`t.command || "pytest"` plus a `setup_command` that is not a schema field. The
CLI runners (`runner-host.mjs:62`, `runner-docker.mjs:88`) write `t.script` to
`t.py` and run it. So the same test definition means two different things.

**Fix:** the GitHub Actions generator writes the script to a file and runs it, the
way the CLI runners do — one step that `cat > t.py <<'EOF'`-equivalents the script
via `actions/github-script` or a heredoc-free `run:` with the script in `env:`,
then invokes it. `setup_command` is either added to the schema or dropped; dropped
is preferable until someone asks for it.

**Test:** `tests/sweep-correctness.test.mjs` gains a case asserting a `python`
test's `script` survives into the generated workflow, and that the two runners
agree on which field is authoritative.

### 3.5 The draft count reads `state`

`DashboardView.vue:863` sets `draftCount = ymls.length` when `dashboard.json` is
absent — every assignment, whatever its state — and the copy says *"publish to
track them here"* to someone who published two minutes ago.

**Fix:** parse each YAML's `state` (the files are already fetched) and count only
`draft`. When the count is zero but files exist, the message becomes *"Published
assignments appear here once the first report is generated"* — which is C3's rule
applied to a sentence.

---

## 4. WS2 — Make "hand this to students" a place

**Fixes:** UX6 (link as a blob), UX7 (no distribute step), UX8 (empty state eats
the page), UX21 (regenerate undiscoverable), UX23 (link in three places).

### 4.1 One component: `InvitationShare.vue`

Used by more than one view, so per DESIGN.md §7 its classes live in `style.css`.

```
┌─ Share with students ─────────────────────────────────────┐
│  pxl.../PXLAutomation/i/AQGU7LHwUF…VODw     [Copy] [Open] │
│                                                            │
│  ● Live — students can accept now                          │
│  Anyone with this link can accept until 30 Aug, 19:02.     │
│  Link expires 27 Sep 2027.            Regenerate link →    │
└────────────────────────────────────────────────────────────┘
```

* **Truncated, not hidden.** Enough to recognise it, never the full 122
  characters. Full value on hover/`title` and in the clipboard.
* **Copy** is the primary action of the block. **Open** opens the student page in
  a new tab, which is the only way a lecturer can see what students see.
* The status line is the *student-facing* truth: accepting, not yet open, closed,
  or cap reached — the same conditions `AssignmentView` gates on.
* **Regenerate link →** is a text button that opens the existing republish modal
  with the checkbox pre-ticked. It is the only mention of rotation in the app and
  it belongs here, not buried under *Lifecycle → Republish broker*.

**Props:** `org`, `assignment` (needs `id`, `invite_token`, `state`, `deadline_at`,
`accepted_count`, `max_acceptances`), `variant: 'banner' | 'inline' | 'compact'`.

### 4.2 Where it goes

| Surface | Variant | Replaces |
|---|---|---|
| Post-publish banner, `AdminView` | `banner` | the current link box inside `.published-info-card` |
| `AssignmentDetailView` header | `inline` | the lone *Copy invitation link* primary button |
| Assignment card in the admin list | `compact` | nothing — this is the gap |
| Assignment card on `DashboardView` | `compact` | nothing — this is the gap |

The compact variant is a single icon-button that copies and toasts. It exists so
that a lecturer returning a week later does not have to open the editor to find
the link.

`AdminView`'s *Lifecycle → Copy invitation link* is **removed** — copying is not a
lifecycle transition (UX24), and the banner and the list card both carry it.

### 4.3 The tracking page stops collapsing

`AssignmentDetailView.vue:53` renders a full-page `No report yet` state that
removes the header, the share block, Teams, Export, Sync Starter Code, Feedback
PRs and Freeze along with the table.

**Fix:** the page always renders header → share block → summary → actions bar. Only
the *table* swaps for an empty state, and it says what has not happened:

> **No one has accepted yet.**
> Students appear here as they accept. Share the link above, or
> [check the invitation](#) if you expected someone by now.
>
> <sub>Reports refresh automatically after each acceptance and nightly.
> [Refresh now](#)</sub>

*Run daily activity now* keeps its function and loses its name — it becomes
**Refresh now**, demoted to a text button in the small print. Workflow file names
do not appear in an empty state.

**Tests:** `tests/e2e/29-share-surface.spec.mjs` (new) — the link is reachable
from the list card, the dashboard card and the detail header without opening the
editor; the detail page with zero students still shows the share block and the
actions bar; Regenerate opens the modal with the box ticked.

---

## 5. WS3 — The first-run wall

**Fixes:** UX1 (template dead end), UX3 (roster prerequisite), UX4 (seed control
that cannot work), UX5 (AJV errors).

### 5.1 Template repository — link out, with the answer

Decision: no repository creation. So the empty state has to do the whole job in
words and one link.

Current: *"No template repositories found in <org>. Create one and mark it as a
template in repo Settings."*

Replacement, shown in place of the combobox when the org has zero templates:

> **This organization has no template repositories yet.**
> A template is an ordinary repository — starter code, a README, whatever each
> student should begin from. Every student gets their own copy of it.
>
> **[Create one on GitHub →]**   *(opens `github.com/organizations/<org>/repositories/new`)*
>
> Then open its **Settings** and tick **Template repository**. Come back and press
> refresh — it will appear in the list.
>
> Already have one? Tick *Template repository* in its settings and it will show up
> here.

Two things this fixes beyond wording: it says what a template *is* (the current
text assumes you know), and it names the one non-obvious step (the checkbox in
Settings) that is the actual reason the list is empty for most people.

The refresh button beside the combobox already exists; it gets a tooltip and stays.

### 5.2 Roster — show the count, link the tab

`enforced` makes `students/roster.yml` load-bearing. The form mentions it in a
`<small>` and points at "the Roster tab", which is not a link.

Under the *Who may accept* select, when `enforced` is selected:

* **0 students** → `⚠ No students imported yet — nobody can accept. [Import roster →]`
* **n students** → `✓ 213 students on the roster. [Manage →]`

Both link to the Roster tab (`setTab('roster')`). The count comes from the roster
the view already loads for `validateStudentLogin`; no new request on the common
path.

### 5.3 Remove *Seed teams from…* from the create form

It is permanently disabled with *"Save this assignment first"*. A control that can
never work on the screen it is on should not be on that screen (C1). It stays on
the editor for a **saved** assignment, which is where it works.

### 5.4 Validation speaks to lecturers

`AdminView.validate()` renders raw AJV: `/autograde/tests/0/id must match pattern
"^[a-z0-9][a-z0-9-]{0,63}$"`. The roster importer already solves exactly this with
`formatRosterValidationError`.

**Fix:** a sibling `formatAssignmentValidationError(err)` in the same style, mapping
the paths that can actually be reached from the form:

| AJV path | Message |
|---|---|
| `/autograde/tests/N/id` | `Check ${n}: the ID must be lowercase letters, numbers and dashes.` |
| `/autograde/tests` (minItems) | `Autograding is on but no checks are defined. Add one, or turn it off.` |
| `/group_config/max_team_size` | `Maximum team size must be at least ${min}.` |
| `/repository_name_pattern` | (already handled in `fieldErrors`) |

Anything unmapped falls through to the raw string rather than being swallowed —
an unfamiliar error must still be visible.

---

## 6. WS4 — Autograding becomes a task

**Fixes:** UX10 (checkbox opens a config language), UX12 (zero-test states),
UX15 (visibility named after its mechanism).

### 6.1 In the form: one line

The *Guardrails* fieldset shows a summary row, never the configuration:

```
Automated checks    Off                                      [ Set up ]
Automated checks    3 checks · run on your machine           [ Edit ]  [Remove]
Automated checks    2 checks · run in student repos, hidden  [ Edit ]  [Remove]
```

That is the entire footprint in the form. `autograde_enabled` stops being a
checkbox — the configuration's existence *is* the flag.

### 6.2 `AutogradeModal.vue`

A modal, so DESIGN.md §1.2 applies: it is its own view and gets exactly one
primary (`Save checks`). Three sections in order, all visible at once — this is a
form, not a wizard, and the order is what carries the teaching.

**① What this does** — one sentence, always visible:
> Run the same checks against every submission and record a score per student.
> Results appear in the assignment's report and in the CSV export.

**② Where do they run?** Two radio cards, not a `<select>`, because the trade-off
is the decision:

| | **On your machine** | **In each student's repo** |
|---|---|---|
| | You run `pxl-classroom grade` after the deadline. | GitHub Actions runs them on every push. |
| Cost | No Actions minutes. | Uses the organization's Actions minutes. |
| Students see | Results when you publish them. | A pass/fail on every push. |
| Tests are | Never in the student repo. | In the repo, unless hidden. |

**③ Can students read the tests?** — only when ② is *in each student's repo*.
Currently *Test Visibility → Private (Hidden via reusable workflow)*; becomes:

> ( ) **Yes** — the checks are committed to each student's repository. Simplest,
>     and students can run them locally.
> (•) **No** — the checks stay in the control repository and run from there.

The mechanism ("reusable workflow") is true but is not the decision.

**④ The checks** — a real table with headers, which the current row editor lacks
entirely:

| ID | What it does | Command | Points | |
|---|---|---|---|---|
| `compiles` | Command must succeed | `make` | 20 | ✕ |
| `greets` | Input → expected output | `./greet` | 10 | ✕ |

* **Add a check** offers the three types as named starting points, each
  pre-filled with a working example, rather than an empty row and a type
  dropdown:
  * *A command that must succeed* → `run`, command `make test`
  * *Compare output for given input* → `io`, with stdin and expected stdout
  * *A Python script* → `python`, with a two-line script
* Type-specific fields (stdin/expected stdout, script) appear under the row they
  belong to, labelled.
* Total points are summed and shown, because that is the number a lecturer
  actually cares about and nothing displays it today.

### 6.3 Zero checks is refused before the schema sees it

`tests.minItems: 1` means enabling autograding with no checks fails on save with an
AJV path, and `cleanTests()` emits `id: ''` for an unfilled row so it fails on the
*pattern* instead. Both are WS3.4's problem, but the modal must not produce that
state at all:

* `Save checks` is disabled while any row is incomplete, with the reason on the row.
* Closing the modal with zero checks sets `Automated checks: Off` rather than
  saving an enabled-but-empty configuration.
* The `visibility: public` + zero-tests path in `provision.mjs` that emits a
  hardcoded `npm test` is deleted — it can no longer be reached from the UI, and
  it was never a defensible default for a hand-written YAML either.

**Tests:**
* `tests/autograde-modal.test.mjs` (new) — presets produce schema-valid tests;
  an incomplete row blocks save; closing with zero checks disables autograding;
  the summary line matches the configuration.
* `tests/e2e/30-autograding.spec.mjs` (new) — set up from the form, add two
  checks, save, reopen and see them; the summary line reads correctly; DESIGN.md
  §1.2 (one primary in the modal).

---

## 7. WS5 — A published assignment opens on the cohort

**Fixes:** UX22 (operations duplicated), UX24 (Lifecycle is a flat row),
UX25 (published editor is the draft editor).

Routing is unchanged — `/dashboard/:org/admin` still edits, `/dashboard/:org/:id`
still tracks. What changes is what the editor pane leads with when
`form.state === 'published'`.

### 7.1 The editor pane, published

```
Edit: linux-processes-2026  [published]        [Troubleshoot] [Save]

┌─ InvitationShare (banner) ──────────────────────────────┐
└─────────────────────────────────────────────────────────┘

┌─ Cohort ────────────────────────────────────────────────┐
│  47 / 150 accepted     Deadline in 6d 23h               │
│  [ Track roster & progress → ]                          │
└─────────────────────────────────────────────────────────┘

▸ Edit settings          (collapsed: the six fieldsets, unchanged)

┌─ Lifecycle ─────────────────────────────────────────────┐
│  Repair:  [Republish broker]                            │
│  ─────────────────────────────────────────────────────  │
│  [Stop accepting]  [Revert to draft]  [Archive]         │
└─────────────────────────────────────────────────────────┘
```

* **A draft is unchanged** — it opens on the form, because defining it *is* the
  job. Only `published` and `closed` lead with the cohort.
* **Edit settings** is a `<details>`. It opens automatically if `fieldErrors` is
  non-empty, so a validation problem can never hide behind a disclosure.
* **Cohort** numbers come from the same `dashboard.json` the list already reads;
  no new request.
* **Lifecycle** is grouped: repair above the rule, state transitions below.
  *Copy invitation link* leaves (WS2). *Stop accepting* and *Revert to draft*
  each get a confirmation naming the consequence — both stop every student
  mid-assignment today with no confirmation at all.

### 7.2 Extensions and retries leave the editor

`AdminView`'s *Grant deadline extension* and *Retry a failed acceptance*
`<details>` blocks are deleted. Both already exist on `AssignmentDetailView` in the
per-row action modal (`AssignmentDetailView.vue:734`), reached from the student
they concern — which is the correct home (C2), because both need a student login
and the editor makes you type it from memory.

`validateStudentLogin` and the extension/retry handlers move with them; the detail
view's copies are already the more capable ones.

**Risk:** a lecturer who knows the editor accordions will look for them there. The
Lifecycle block gets a line — *"Per-student extensions and retries are on the
[roster & progress](#) page."* — for one release.

**Tests:**
* `tests/admin-lifecycle-ui.test.mjs` — a draft opens on the form; a published
  assignment opens with settings collapsed; `fieldErrors` forces them open.
* `tests/e2e/31-published-cohort.spec.mjs` (new) — the published editor leads with
  share + cohort; extensions/retries are absent from the editor and present on
  the student row; state transitions confirm.

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

**WS1's small half must precede WS5**, because the cohort panel reads
`roster_mode` and `late_policy` to describe the assignment accurately. The
enforcement half does not block anything else.

**WS2 and WS4 before WS5.** WS5's layout is mostly composition of things those two
produce; doing it first would mean building the same blocks twice.

**WS3 and WS6 any time.** Neither touches shared components.

Each workstream is one commit, with its tests, per the repo's convention.

---

## 10. Risks and things to check live

1. ~~**Deadline extensions are already broken (WS0, §3.2.5).**~~ **Fixed.** It was
   worse than the plan recorded: `report.mjs` read a field no override document
   has carried since 2026-06-17, so extensions worked in no consumer at all.
   `lib/effective-deadline.mjs` is now the single implementation and
   `lockdown.mjs` defers an extended student instead of demoting them.
   ARCHITECTURE §6.2.2.
2. **Whether a GitHub App can manage rulesets at all (§3.2.2).** Repository
   rulesets need `administration: write`, which the App has — but that has not
   been exercised against a real repository. Confirm before building on it, and
   confirm that a ruleset with the App in `bypass_actors` still lets preservation
   push. If it does not, Phase 3 has to run before Phase 1, which unpicks the
   whole ordering.
3. **`until` filters on a date GitHub does not document (§3.2.4).** The REST docs
   say only *"Only commits before this date will be returned"* and never state
   whether that is the author or the committer date. `git log --until` uses the
   committer date and the API appears to match, but a rebased commit carries both
   and the choice decides which one is picked, so it needs confirming against a
   real repository. Both are client-supplied, so it changes nothing about
   forgeability — this is the fallback path, not the guarantee.
4. **A long-lived sentinel job is new operational surface (§3.2.3).** It holds a
   runner slot for hours, and while a *polling* job is doing real work — unlike an
   idle `sleep` — nothing like it exists in this system today. Watch the
   concurrency budget on Team (60 jobs) the first term it runs, and cap how many
   arm per firing.
5. **`AdminView.vue` is 2,900 lines and this plan touches most of it.** WS2, WS4
   and WS5 should each extract as they go — `InvitationShare.vue`, `AutogradeModal.vue`,
   and a `PublishedCohortPanel.vue` — rather than growing the file further. Extracted
   classes used by more than one component go to `style.css` (DESIGN.md §7).
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
