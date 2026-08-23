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
| Late policy | **Implement `block` properly** — see §3 for what that can and cannot mean. |
| Template wall | **Link out only.** No repository creation on the lecturer's behalf. |
| Autograding | **Dedicated modal**, entered from a one-line summary in the form. |
| Published assignment | **Cohort-first**, settings behind a disclosure. Routing unchanged. |

---

## 3. WS1 — Stop the UI claiming things that are not true

**Fixes:** UX2 (roster default), UX9 (draft count), UX11 (python mismatch),
UX13 (late policy), UX14 (acceptance mode).

This lands first. It is small, it is mechanical, and until it is done every other
improvement sits on top of a form whose defaults are wrong.

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

### 3.2 `late_policy: block` — implemented, and honestly labelled

**This is the one that needs the most care, because the literal reading is not
achievable and shipping a half-version would repeat the original mistake.**

Blocking a push *as it happens* needs something running at the deadline instant.
The options are a per-assignment scheduled workflow (control repos hold no
workflows — ARCHITECTURE §2), a push-triggered workflow in every student repo
(event-driven triggers, removed in Wave 8), or a tighter cron on the hub.

**The objection to the tighter cron is not cost.** The hub is a public
repository, so standard-runner Actions there are free with no minute cap —
ARCHITECTURE §6.5 already says exactly this, and the minimal-minutes constraint
in §6 is about the *per-org* minutes that `execution_environment: github_actions`
autograding consumes inside private student repositories. An hourly
`daily-activity.yml` would bill **zero** additional minutes, in the hub and in
every org.

The objection is that GitHub's `schedule` event cannot carry an enforcement
promise. Its documented behaviour:

| Limit | Consequence for "blocking" |
|---|---|
| Shortest interval is **5 minutes** | The window can only narrow, never close. |
| Delayed under load — *"High load times include the start of every hour"* | 5–30 min routinely, longer at peak. Deadlines are set on the hour. |
| **"If the load is sufficiently high, some queued jobs may be dropped"** | On a busy evening the deadline job does not run at all. |
| Public-repo scheduled workflows auto-disable after 60 days without repository activity | A dormant term silently switches enforcement off. |

The third row is disqualifying. A control named *block* that silently does not
run on a busy evening is the same class of defect this workstream exists to
remove (C4) — it would just fail rarely, which is worse, because nobody would
notice until a dispute.

A tighter cron therefore stays available as a way to **narrow the read-only
window** if that is wanted later — at no cost, and with no promise attached to
it. It is not a way to implement `block`.

#### 3.2.1 The full option set, including the ones that change the project

Nothing above is fixed by architecture; the constraint is GitHub. Refusing a push
needs the org-level App to demote the student, because a student holds **admin**
on their own repository (ARCHITECTURE §4.1) and can undo anything set at repo
level. So the only real question is *what fires the demotion, and when*.

GitHub offers exactly two ways to make something happen at a time: `schedule`, or
a caller. That gives five candidates, and two are dead:

| | Approach | Verdict |
|---|---|---|
| **A** | **Deadline-anchored submission SHA.** No trigger at all — lockdown picks the last commit ≤ deadline. | **Take.** Always correct, zero minutes, cannot fail to run. Does not refuse the push. |
| **B** | **A "Lock down now" action the lecturer presses.** Precise to the second, free, reliable, and honest about who decides — ARCHITECTURE §12 already argues for exactly this over a scheduled trigger. | **Take.** See below: the primitive is 80 % built and does not currently work. |
| **C** | **Tighter hub cron.** Free (public repo). Narrows the automatic window from ≤24 h to ≤1 h + drift. | **Optional.** Composes with A. Carries no promise, so it must never be described as blocking. |
| **D** | **Enforcement inside the student repository** — branch protection, a `push` workflow, a required check. | **Dead.** The student has admin and can remove it. A `push` workflow also cannot refuse a push, only react to one, and reverting a student's commit is not something to build. |
| **E** | **Take admin away from students** so repo-level protection holds. | **Dead for this course.** Admin is deliberate — it is what lets the course teach Actions, secrets, environments and runners (ARCHITECTURE §4.1). This is a curriculum decision, not a technical one, and it still needs a trigger. |

An external scheduler calling `workflow_dispatch` is not listed: it means hosting
something and storing a hub credential in it, which is out on both counts.

**B is a smaller change than it looks, and the gap is real.** *Freeze & Preserve
Now* (`AssignmentDetailView.vue:1238`) dispatches `daily-activity.yml` for the
org — and `find-finalizable.mjs` only queues assignments whose deadline has
**already passed**. So pressing it before the deadline does nothing for that
assignment, and *Close (stop accepting)* only changes `state`. **There is no way
to lock repositories right now.** That is the missing primitive, and it is what a
lecturer running a timed exam actually needs.

What B requires: a `finalize-now.yml` (or a `force` input on the existing path)
that runs `collect → lockdown → preserve → report` for **one named assignment**,
ignoring the deadline check, behind the same `provisioning` environment and
`[bot]`-actor guard as the other admin workflows. The button already exists; it
needs a target and a confirmation naming the consequence.

**Recommended combination: A + B.** A makes late work not count, automatically and
without depending on anything firing. B lets a lecturer close a cohort at a chosen
instant with real enforcement. Together they cover both readings of "block", and
neither of them promises something the system cannot deliver. C stays on the shelf.

---

What *is* available, at zero additional Actions minutes and with no dependence on
a cron firing on time, is the thing a lecturer almost always means by "late work
is blocked": **late work does not count.**

| | `report` (today's behaviour) | `block` (new) |
|---|---|---|
| Submission SHA | `HEAD` of the branch at lockdown | last commit **at or before `deadline_at`** |
| A commit pushed after the deadline | becomes part of the submission, flagged late | recorded as `first_late_sha`, excluded from the submission |
| Student pushed *only* after the deadline | that commit is the submission | no submission |
| Repo access after the deadline | read-only at the next nightly run (`lock_down_enabled`) | unchanged |

**Change:** `lockdown/lockdown.mjs:179`. Today:

```js
const commitRes = await gh("GET", `/repos/${cfg.org}/${repoName}/commits/${branch}`);
snapshotSha = commitRes.ok ? commitRes.data.sha : null;
```

Under `block`, ask for the last commit within the window instead:

```
GET /repos/{org}/{repo}/commits?sha={branch}&until={deadline_at}&per_page=1
```

taking `[0].sha`, and `null` when the list is empty. Everything downstream —
freezing on retry, preservation, reporting — is unchanged, because it all keys off
`snapshot_sha`.

**Two caveats that must be written into the UI, not just the code:**

1. **`until` filters on committer date, which a student can forge.** This is the
   same forgeability CLAUDE.md already calls out for live status checks. The
   mitigation is that `collect` observes nightly, so a commit that *appeared*
   after the deadline is visible in the observation record regardless of the date
   it claims. The report already carries both; `block` must not be described as
   tamper-proof.
2. **A per-student deadline extension moves the window.** `until` uses the
   effective deadline for that student, from `overrides/`, not the assignment's.
   Getting this wrong silently voids every extension granted.

**Control:** the `<select>` moves out of *Advanced* and into *Guardrails*, beside
lockdown, because it is a policy decision and not a tuning knob. Reworded away
from mechanism:

> **Late work**
> ( ) Counts — the submission is whatever is in the repo at lockdown; late
>     commits are flagged in the report.
> (•) Does not count — the submission is the last commit before the deadline.
>     Later commits are recorded but ignored.
>
> Either way the repository goes read-only at the next nightly run after the
> deadline. Neither setting refuses a push as it happens.

**Schema:** unchanged — the enum already has both values.

**Default:** stays `report` in the schema. `emptyForm()` currently writes
`'block'`, i.e. the form has been defaulting to the value that did nothing; it
changes to `'report'` so the default is the conservative one and a lecturer
opts *in* to discarding work.

**Tests:**
* `tests/lockdown-late-policy.test.mjs` (new) — a repo with an on-time commit and
  a later one: `report` snapshots the late SHA, `block` snapshots the earlier one;
  a repo whose only commit is late yields no submission under `block`; an
  extension moves the window; the frozen-on-retry rule still wins over both.
* `tests/lockdown-retry.test.mjs` — unchanged and must stay green.

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
WS1  truthful controls        ─────────►  (independent, lands first)
WS3  first-run wall            ────────►  (independent)
WS2  share surface             ────────────────►  (WS5 consumes the component)
WS4  autograde modal           ────────────────►  (WS5 shows its summary line)
WS5  cohort-first published                    ─────────►  (needs WS2 + WS4)
WS6  orphan routes             ────────►  (independent)
```

**WS1 first, and separately.** It is the only workstream that changes what the
system *does* rather than where a control sits, and it should be reviewable on its
own. It also has to precede WS5, because the cohort panel reads `roster_mode` and
`late_policy` to describe the assignment accurately.

**WS2 and WS4 before WS5.** WS5's layout is mostly composition of things those two
produce; doing it first would mean building the same blocks twice.

**WS3 and WS6 any time.** Neither touches shared components.

Each workstream is one commit, with its tests, per the repo's convention.

---

## 10. Risks and things to check live

1. **`until` and forged committer dates (WS1).** `block` can be side-stepped by a
   student who back-dates a commit. The nightly observation record still shows when
   it appeared, so the evidence exists — but the UI must not describe `block` as
   tamper-proof, and the report should surface the discrepancy where it has both
   facts. Worth deciding whether that becomes a flag in the report before `block`
   ships.
2. **Deadline extensions and `block` (WS1).** The `until` window must come from the
   student's effective deadline. This is the one way the change could silently void
   every extension already granted, and it needs a test before anything else.
3. **`AdminView.vue` is 2,900 lines and this plan touches most of it.** WS2, WS4
   and WS5 should each extract as they go — `InvitationShare.vue`, `AutogradeModal.vue`,
   and a `PublishedCohortPanel.vue` — rather than growing the file further. Extracted
   classes used by more than one component go to `style.css` (DESIGN.md §7).
4. **The undeclared-class backlog** (`tests/fixtures/undeclared-classes.backlog.json`,
   98 entries) overlaps several of the components being touched. Any class a
   rewritten component stops using must leave that file, or the guard fails.
5. **Nothing here has been tried against a live org.** The template-empty state, the
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
