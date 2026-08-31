# PXL Classroom - Runbook

**Audience: a lecturer running assignments.** Everything here is something you do yourself, in the Admin Panel or the CLI, for your own course.

> [!IMPORTANT]
> **Not what you are looking for?**
> - **Adding a course or academic-year organization** (e.g. `PXL-2TIN-DevOps-2627`) → [ADMIN.md §1](ADMIN.md#1-onboarding-a-new-organization-per-org). You do **not** need a new frontend or a new GitHub App: PXL Classroom is multi-tenant, and one hub serves every organization.
> - **Standing up the whole system from scratch**, once, for the institution → [INSTALL.md](INSTALL.md).
> - **Budgets, usage thresholds, App permissions, security incidents** → [ADMIN.md](ADMIN.md).

What the system *is* → [ARCHITECTURE.md](ARCHITECTURE.md). Why a rule exists → [LESSONS.md](LESSONS.md). Known infrastructure gaps → [OPEN-ITEMS.md](OPEN-ITEMS.md).

## What do you want to do?

**Setting up an assignment**

| | |
|---|---|
| Create the template repository | [§1.1](#11-create-the-template-repository) |
| Define the assignment | [§1.2](#12-define-the-assignment-in-the-admin-panel) |
| Reuse the groups from an earlier group assignment | [§1.3](#13-reuse-the-groups-from-an-earlier-group-assignment) |
| Publish it, and share the link | [§1.4](#14-publish), [§1.5](#15-share-the-link) |
| Import a roster, or run without one | [§6.4](#64-importing-a-roster) |
| Set up autograding | [§6.12](#612-autograding) |

**While it runs**

| | |
|---|---|
| Watch for problems | [§2.1](#21-the-instructor-notifications-issue), [§2.2](#22-the-dashboard) |
| A student says "I clicked Accept and nothing happened" | [§3.6](#36-student-says-i-clicked-accept-but-nothing-happened) |
| A student deleted their repository | [§3.1](#31-student-deleted-their-repository) |
| **Fix a mistake in the assignment after students accepted** | [§6.13](#613-correcting-an-assignment-after-students-have-accepted) |
| Run System Health / one-click fixes | [§6.14](#614-pre-flight-diagnostics-system-health--1-click-auto-fixes) |

**Around the deadline**

| | |
|---|---|
| Grant one student an extension | [§3.2](#32-grant-an-extension) |
| Decide whether late work counts | [§3.4](#34-deciding-what-happens-to-late-work) |
| **Before an exam: check nobody in the cohort is an org owner** | [§3.5](#35-before-an-exam-deadline-nobody-in-the-cohort-may-be-an-organization-owner) |
| Lock deadlines at the instant rather than overnight | [§4.1](#41-the-deadline-sentinel) |
| The nightly finalize failed | [§3.7](#37-nightly-finalize-failed) |

**Afterwards**

| | |
|---|---|
| Read the autograder scores | [§6.12](#612-autograding) |
| Open and review the Feedback PRs | [§6.10](#610-feedback-prs) |
| Download every submission | [§6.11](#611-bulk-submission-download--preservation-status) |
| Promote the students who accepted onto the roster | [§6.5](#65-promoting-accepted-students-onto-the-roster) |
| Retire a finished assignment | [§5](#5-retiring-a-finished-assignment) |

---


---

## 1. Creating and publishing an assignment

Done by a lecturer.

### 1.1 Create the template repository

1. In your organization, create a new repository whose name starts with `template-` (e.g., `template-automation-pe-1`).
2. Settings -> General -> tick **Template repository**.
3. Add starter code, `.github/workflows/` for the student's own CI, and assignment instructions. Anything you commit here becomes the student's starting point.

**A fork can be a template.** GitHub's repository search omits forks unless the query says `fork:true`, which the picker's query carries. If a template still does not appear, the other cause is **search indexing lag** on a brand-new repository - type `owner/repo` into the box directly, which probes the repository via the REST API instead and works immediately.

Step 2 is the one people miss, and it is the most common reason the Admin Panel's template list is empty: a repository that is not ticked as a **Template repository** does not appear in `is:template` search results, whatever it contains. The form says so in place now - an organization with no templates gets the explanation and a link to `https://github.com/organizations/<org>/repositories/new` rather than one line assuming you know what a template is. The text box stays usable in that state on purpose: typing `owner/repo` by hand is the only way to name a template in another organization, and the panel probes it live and reports back.

### 1.2 Define the assignment in the Admin Panel

1. Open the dashboard: `https://<pages-host>/pxl-classroom/dashboard/<org>`.
2. Sign in with device flow.
3. Click **Admin Panel**.
4. Click **New assignment** and fill the form:

| Field | Note |
|---|---|
| Title | shown to students |
| Slug (URL identifier) | URL-safe, auto-derived from the title, e.g. `linux-processes-2026`. The Admin Panel checks for duplicate slugs in the local list and queries the control repo's Contents API to block silent overwrites. |
| Template repository | pick from template repositories in your org (repositories marked as templates on GitHub) |
| Repository name pattern | must contain `{github_login}` (individual) or `{team_slug}` (group), e.g. `linux-processes-{github_login}` or `group-project-{team_slug}` |
| Collaboration Model | **Individual** (1 student per repository) or **Group** (multi-student collaboration per repository with `max_team_size`, optional `min_team_size` under-capacity warning, and self-service team creation toggles) |
| Opens at / Deadline | local time, automatically converted to UTC for storage. The deadline must be after the open date; a deadline in the past shows a warning (the next nightly run would finalize immediately) |
| Who may accept | **`open` by default** - anyone with the invitation link may accept, up to the cap. This is safe because the link itself is the gate: the broker verifies the student's signed acceptance at the edge, so someone without the link gets nothing whatever this says (ARCHITECTURE §4.3.2). Choose **`enforced`** to additionally require the login to be in `students/roster.yml`. The form then shows the live roster count and links to the **Roster** tab: `No students imported yet - nobody can accept`, `213 students on the roster`, or - when the `github_login` column is still empty - `213 students on the roster, but none has a GitHub username yet - nobody can accept`. That last one is the trap: `github_login` is optional in the CSV and is the only field acceptance matches on, so a roster imported before students hand in their usernames blocks everybody. |
| Max acceptances | guardrail: cap on accepted students (default **50**; leave empty for **no cap at all** - nothing substitutes a number for you; 0 is rejected). Mandatory under `open`, which is the default (§6.4). |
| Late work | **Counts** by default. *Does not count* locks the submission branch at the deadline with a repository ruleset — students keep their repository, Actions, secrets and runners, they simply cannot push to that branch. The two deadline settings are independent; §3.4 is the whole picture. |
| Lock down student repos at the deadline | **Off by default**, and opt-in on purpose: demoting to `pull` takes Actions, secrets, environments and runners away, which on these courses is the subject being taught. Preservation happens either way (§3.4). |
| Open a draft Feedback PR for each student | optional - creates a protected `pxl-baseline` branch at provisioning (see §6.10) |
| Automated checks | optional - one line showing what is configured (`Off`, `3 checks · run on your machine`, `2 checks · run in student repos, hidden`) with **Set up** / **Edit** / **Remove** beside it. Everything else is in the modal behind it (see §6.12). |

5. The Admin Panel validates against `assignment.schema.json` and commits `assignments/<id>.yml` to your control repo via the Contents API with your own lecturer token. **Save as draft** keeps it invisible to students.

### 1.3 Reuse the groups from an earlier group assignment

Students should not have to re-form the same teams for every group assignment. Seeding copies an existing grouping into the new assignment; each student then confirms their group with one click instead of picking a team.

1. Create and **save** the new group assignment first - teams are stored under its ID, and the seed reads its team size and repository pattern, so the button stays disabled while the form has unsaved edits.
2. Open the assignment's **Teams** tab (or the group section of the editor) and click **Seed teams**.
3. Pick a source:
   - **A previous group assignment** - the normal choice. It carries the *final* membership, including switches and dropouts, so always seed from the most recent grouping rather than from the first one.
   - **The roster's team columns** - for the first group assignment of a course, when you already have the groups elsewhere. Fill `team_slug` / `team_name` via the Roster tab's CSV import (§6.4) first.
4. Review the plan. It lists every team and its members before anything is written, and refuses outright if:
   - a team is larger than the new assignment's maximum team size (raise the maximum or split the team - members are never dropped silently);
   - the new assignment shares a repository name pattern with the source. **Fix this one before anything else**: both assignments would resolve to the same repository names, and provisioning would hand students the previous assignment's locked-down repository instead of a fresh one;
   - the pattern has no `{team_slug}`.
5. Warnings do not block. Expect them for students who left the roster, teams below the minimum size, and teams students have already formed in the new assignment (those are kept untouched - seeding never overwrites real membership).
6. Applying writes every team in one commit and dispatches `regenerate-dashboard.yml`, which is what makes the teams visible to students. Nothing is published while the assignment is still a draft, so seed, review in the Teams tab, adjust, and publish.

Afterwards the Teams tab shows a "carried over from …" line, a standing "N students on the roster have no team" line naming who is left to place by hand, and - once the assignment is published - dimmed members with a per-team "N not accepted yet" count.

**Seeded the wrong source?** The Teams tab's **Undo seed (N)** button (or `pxl-classroom teams unseed --assignment <id>`) deletes the carried-over teams in one commit. It only ever removes teams that came from a seed, have no repository, and have no member who has accepted; anything a student has already joined is kept and reported in the confirmation. On a draft that is all of them, which is why reviewing before publishing is the cheap moment to change your mind. **Seeding is not enrolment**: the repository is created when the first member accepts, and each other member only gets access once they accept too.

Headless equivalent:

```bash
pxl-classroom teams seed --org <org> --from <previous-assignment-id> --to <new-assignment-id> --dry-run
```

Drop `--dry-run` to apply. `--from-roster` uses the roster columns instead; `--yes` skips the confirmation prompt when the plan has warnings; `--no-publish` skips the dashboard regeneration (the teams then stay invisible to students until it runs).

**Students with no carried-over group** - late enrollers, Erasmus arrivals, anyone whose partners all dropped out - depend on the assignment's formation mode:

| Formation mode | Unassigned student sees |
|---|---|
| Self-service (default) | The normal join/create tabs. Nothing to configure. |
| Pre-assigned, "Let students with no assigned team form their own" **off** | "No Pre-Assigned Team - contact your instructor". You add them from the Teams tab. |
| Pre-assigned, that box **on** | The join/create tabs, exactly like self-service. |

Under self-service, a carried-over group is a strong default rather than a lock: the student can still use **Choose a different group**. Under pre-assigned, they cannot, and a request naming another team is rejected server-side.

### 1.4 Publish

In the editor -> click **Save & publish** in the header bar (on an existing draft, *Lifecycle -> State -> **Publish (create broker, enable nightly)*** does the same). The panel watches for the broker repo and confirms when the accept link is live.

Once it is published, opening it again leads with the invitation link, an accepted/deadline summary and a link to the tracking page; the six fieldsets move behind **Edit settings** and *Lifecycle* separates **Repair** (Republish broker) from the state transitions below it.

If the workflow dispatch fails (typically 403 - you're not a hub collaborator, see ADMIN.md §1.4), the panel automatically reverts the assignment to **draft** so the YAML never claims "published" while no broker exists. Fix hub access, then publish again.

This dispatches `publish-assignment.yml`, which:

- Mints the invitation (a P-256 keypair and a nonce) and writes it to the assignment in the control repo. Republishing reuses both, so links already handed out keep working.
- Creates `<org>/broker-<id>` (public).
- Pushes the broker's `acceptance-trigger.yml` workflow.
- Sets five variables on the broker: `ASSIGNMENT_ID`, `CONTROL_ORG`, `INVITE_PUBKEY`, `INVITE_NONCE`, `INVITE_ENABLED`.
- Flips `state` from `draft` -> `published` in the control repo.
- **Enables the nightly workflow and the deadline sentinel** (`gh workflow enable daily-activity.yml`, then `deadline-sentinel.yml`). From here on the nightly cycle is active for your org, and deadlines lock at the instant rather than on the next nightly (§4.1).

### 1.5 Share the link

The student-facing URL is the invitation link: `https://<pages-host>/pxl-classroom/<org>/i/<invite-token>`. It cannot be constructed from the assignment id - the token is minted at publish time and recorded in the control repo (ARCHITECTURE §4.3.2).

**Where to find it.** The **Share with students** block appears in four places, and you never have to open the editor to reach it:

| Where | What you get |
|---|---|
| The banner after publishing, in the Admin Panel | The link, **Copy**, **Open** (the page a student sees), and **Regenerate link →** |
| The assignment's detail page, under the header | The same block, with the live accepted count feeding its status |
| Each published row in the Admin Panel's assignment list | A copy button |
| Each published card on the dashboard | A copy button |

The link is shown truncated - hover it for the whole thing, and Copy always puts the full URL on the clipboard. The status line underneath is what a **student** would see if they opened it right now: `Live`, `Opens <date>`, `Closed`, or `Cap reached`. If it says `Published, but no link`, the invitation was never minted - republish (§6.8).

That's the only URL students need. They open it, sign in, click Accept, wait ~30 seconds, get a repo link.

---

## 2. Day-to-day monitoring

### 2.1 The Instructor Notifications issue

Each org's control repo has an open issue titled **PXL Classroom - Instructor Notifications**. The system posts (or updates) a comment for each significant event:

| Event | Meaning |
|---|---|
| `provisioning-failed` | A student accepted but the repo wasn't created. Most often: GitHub rate limit during a burst. The student retries by opening their invitation link again. |
| `acceptance-rejected` | A student was turned away - not on the roster, outside the window, or the cap is full. The reason is in the comment. Deduped per assignment+login+reason, so a student retrying the same closed door updates one comment rather than adding another. |
| `collection-failed` | The nightly collect step couldn't reach a student's repo. Usually transient. |
| `deadline-gap` | An observation gap straddles a deadline. Reduces evidence quality; mention in grading. |
| `missing-access` | The reconcile step found a repo where the student's admin grant has been revoked. |
| `unexpected-deletion` | A managed repo was deleted. See §3 (Student deleted their repo). |
| `late-activity` | Activity observed after the deadline. Reports include details. |
| `preservation-failed` | The archive copy of the deadline SHA didn't succeed. |

Make this issue your daily checklist.

### 2.2 The dashboard

Same Pages URL: `/dashboard/<org>`. Per-assignment overview, per-student table, search and filter by status, CSV/JSON export.

The dashboard reads the **aggregate** `reports/dashboard.json` from your control repo in one fetch with your lecturer token. It refreshes when the nightly run completes or when a student accepts (both trigger `regenerate-dashboard.yml`).

---

## 3. Edge cases

### 3.1 Student deleted their repository

The reconcile step posts `unexpected-deletion` in Instructor Notifications.

To restore:

1. In the control repo, delete `repositories/<id>/<login>.json`.
2. (Optional) delete `acceptances/<id>/<login>.json` if you want them to re-confirm acceptance.
3. Ask the student to open their invitation link and accept again. The acceptance handler re-provisions because the registry no longer shows them.

### 3.2 Grant an extension

1. Open the assignment's **roster & progress** page (`/dashboard/<org>/<assignment-id>`) and click the **···** action on the student's row.
2. Fill: new deadline, reason. The login comes from the row, so there is nothing to type from memory - the Admin Panel's own copy of this form was deleted for that reason (ARCHITECTURE §10.1.1). The Lifecycle block in the editor links here.
3. The modal shows any extension already in force, then commits `overrides/<id>/<login>.json` (validated against `override.schema.json`), appending to the existing history rather than replacing it.
4. The next nightly run recomputes `effective_deadline_at` for this student, or the lecturer can trigger a Refresh in the assignment detail view to reclassify and commit the updated status immediately; the dashboard updates after `regenerate-dashboard.yml` runs.

**Grant it before the deadline passes.** While the extension runs, the nightly finalize leaves that student's repository open and records them as `deferred` in `lockdowns/<id>/lockdown-record.json` - everyone else is locked at the deadline as normal - and the assignment stays "active" so `daily-activity.yml` keeps observing their work. Once the extension expires, the assignment is re-queued automatically and that student is locked down, preserved and reported (ARCHITECTURE §6.2.2).

On a **group** assignment an extension granted to one member applies to the whole team, because they share one repository.

To see who is deferred, open `lockdowns/<id>/lockdown-record.json` in the control repo: deferred students carry `deferred_until` and a null `snapshot_sha`, and `deferred_count` sits beside `locked_count`.

## 3.3 An extension granted after lock-down does not reopen the repository

Lock-down is a permission change (student -> `pull`) and nothing currently reverses it. If a student has already been locked down and you grant an extension anyway, the override is recorded and `report.mjs` will use it to classify their submission, but they cannot push. Restore write access manually:

```bash
gh api -X PUT repos/<org>/<repo>/collaborators/<login> -f permission=push
```

Then delete `lockdowns/<id>/lockdown-record.json`'s entry for that student, or the next finalize will re-lock them at the frozen snapshot. Grant extensions before the deadline wherever possible.

## 3.4 Deciding what happens to late work

Two independent switches in **Guardrails**, and until August 2026 neither did anything - `late_policy: block` never refused a push and `lock_down_enabled` never decided anything, because lockdown demoted every student on every assignment.

| Setting | At the deadline |
|---|---|
| **Late work: Counts** (default for new assignments) | Nothing is blocked. Late commits are part of the submission and flagged in the report. |
| **Late work: Does not count** | The submission branch is locked with a repository ruleset. Students keep their repository, Actions, secrets and runners - they simply cannot push, force-push or delete that branch. |
| **Also take admin away** | The student is demoted to read-only, losing Actions and secrets too. Defaults **on** for assignments that predate this change, and comes **off** when you pick "Does not count" (the branch lock already stops pushes). |

Two things to tell students honestly:

- **The lock fires on the first nightly run after the deadline, not at the deadline itself.** Anything pushed in between is filtered out - the submission falls back to the last commit *committed* before the deadline. That date comes from the student's own machine (`GIT_COMMITTER_DATE`), so it reconstructs the ordinary case correctly and is not evidence in a dispute.
- **A student who only pushed after the deadline has no submission.** That shows in the run as a no-submission, not an error, and does not fail the cohort's nightly.

Check what actually applied in `lockdowns/<id>/lockdown-record.json`: `lock_method` is `ruleset`, `demotion` or `none`, per student as well as per run. A `demotion` under "Does not count" means the ruleset could not be applied - the run log says why, and the old behaviour is the floor. To unlock a repository, delete its `pxl-classroom-deadline` ruleset:

```bash
gh api repos/<org>/<repo>/rulesets --jq '.[] | select(.name=="pxl-classroom-deadline") | .id'
```

then `gh api -X DELETE repos/<org>/<repo>/rulesets/<id>`.

**A student can delete that ruleset** - it lives in their own repository and they are its admin. Nothing is lost if they do: preservation has already pushed a copy to the assignment's archive repository, which they cannot touch, and disabling deadline enforcement on your own repository is a deliberate, visible act in a way *"I committed at 22:31"* is not. If you ever want a lock they cannot reach, that would be an **organization** ruleset - it lives above the student's repository, so being its admin does not help. This is an option, not a gap: the argument above is that the repository ruleset is enough. Should you decide otherwise, the App already declares `organization_administration: write`, so what it would take is every installed org approving that permission (§10.6) and the code to create the ruleset - `lib/submission-lock.mjs` applies one per student today.

Measured before recommending it: one org ruleset matching `exam2026-*` blocked pushes to both cohort repos and left an unrelated repo alone, and one `PUT` released them all.

## 3.5 Before an exam deadline: nobody in the cohort may be an organization owner

Lock-down cannot freeze an organization **owner**. GitHub grants owners admin on every repository in the org, so the demotion writes `pull`, reads the permission back, gets `admin`, and records `verified: false`. The freeze does not hold for that account and nothing says so until someone reads the record afterwards.

Check it **in advance**, on the assignment: open **System Health** → Tier 3 carries *Cohort Can Be Frozen At The Deadline*. By hand:

```bash
gh api "repos/<org>/pxl-classroom-control/contents/acceptances/<id>" --jq '.[].name' | sed 's/\.json$//' > /tmp/a
gh api "orgs/<org>/members?role=admin&per_page=100" --jq '.[].login' > /tmp/o
grep -Fxi -f /tmp/o /tmp/a    # anything printed cannot be frozen
```

**The exam is not at risk.** The outcome is `partial`, which exits 0, so preservation and reporting still run and every other student freezes correctly. What those accounts can do is keep pushing after the deadline.

Usually the match is you or a colleague testing the assignment — students are added as repository *collaborators*, so a student is an owner only if somebody promoted them, which is why this is a warning rather than a failure. If one of them really is a student, either remove them from the cohort or change their role to **Member** under **People → Role** before the deadline.

### 3.6 Student says "I clicked Accept but nothing happened"

**First, how long have they actually waited?** Provisioning is two chained Actions runs (broker → `repository_dispatch` → hub), so **20 to 40 seconds is normal** and longer is common when Actions is queued. The page says so, counts the elapsed seconds, and updates itself the moment the repository appears — a student who waits 30 seconds has waited a normal amount of time.

The page only offers a "look for a repository invitation" link when it could **not** read `/user/repository_invitations`. If it *could*, it already knows: a pending invitation puts the student in a state with an in-app **Accept invitation** button, and no invitation means there is nothing to accept. A student who is already an org member or owner is added as a direct collaborator and never receives one.

Possible causes:

- **They accepted but signed out before the SPA could detect the repo.** Ask them to re-open their invitation link. The SPA polls `/repos/<org>/<expected-name>` and `/user/repository_invitations` - if the repo exists, they'll see the link.
- **`provisioning-failed` is in the tracking issue.** Likely a rate-limit during a burst. The student can simply accept again from their invitation link. Alternatively, a lecturer can trigger **Retry acceptance** from the student's row on the assignment's roster & progress page (the **···** action).
- **A student says the Accept button does nothing.** If the page reports "GitHub is blocking your request", their GitHub account has been flagged and its content is hidden from everyone but themselves - the acceptance issue is created and removed before the broker sees it. Confirm with `gh api users/<login>`: a flagged account returns 404 to everyone else and 200 to itself. Only GitHub Support can lift it; provision the student manually in the meantime.
  - *Lecturer Retry Flow:* the student comes from the report row, so there is no login to validate; the SPA checks whether the assignment window is closed and warns the lecturer (asking to confirm bypass), triggers `retry-acceptance.yml` with `bypass_window: "true"`, and initiates a background watch (4-minute timeout, polling every 5s) for the workflow run to complete successfully. The toast notifications include a direct link to the running workflow run.
- **Outside `opens_at..deadline_at` or assignment closed.** The student accept card gates acceptance and displays early/closed status messages instead of the Accept button. If a student needs to accept outside the window, the lecturer must trigger a retry acceptance (which prompts to bypass window checks).
- **`max_acceptances` reached.** SPA will say so. Either raise the cap (edit assignment YAML directly or via Admin Panel) or reject. Note the cap is a **guardrail, not an exact seat count**: acceptances are checked and recorded in parallel runs, so a simultaneous burst can land a couple over it. That is deliberate — making it exact would serialize every acceptance in the cohort (ARCHITECTURE §5.4). If you need an exact number, reconcile afterwards rather than relying on the cap.
- **The student is not on the roster.** Under `roster_mode: enforced` (not the default - new assignments are `open`) the acceptance is rejected server-side with `rejected:not-on-roster` (or `rejected:no-roster` if `students/roster.yml` is missing), and the student sits on "Setting up your repository…" until it times out - the SPA cannot read the private roster, so it can't say this directly. Confirm in the hub's Actions tab: the `Accept assignment` run for that student shows the rejection reason in its summary. Fix by importing the roster (§6.4) or, for an assignment with no fixed cohort, switching it to open enrollment (§6.4 -> *Running an assignment without a roster*).

## 3.7 Nightly finalize failed

Check which step failed in the `Daily Activity & Deadline Check` run - the matrix runs one leg per (org, assignment).

- **`3. Preserve` -> `remote unpack failed: index-pack failed`.** The archive push sent an incomplete object graph. Fixed by fetching full history before pushing; if it reappears, verify `preserve/preserve.mjs` is not fetching with `--depth`. Submissions for that assignment were **not** archived - the next nightly run retries automatically (see below); preservation is idempotent (`push --force` to a per-student ref).

**Failed finalizes retry themselves.** An assignment counts as finalized only once every locked-down student has a verified `preservation.json`, so a leg that locked down but failed to archive is re-queued on the next nightly run, and the workflow will not self-disable while a leg is failing. Retried snapshots are frozen - a student's late commit can never replace their on-time submission.

Retries stop after 3 attempts (`finalize_attempts` in `lockdowns/<id>/lockdown-record.json`) so a permanently un-preservable repo does not run every night forever. The run log names the assignment and the pending students. After fixing the cause, force another attempt by editing that file and setting `finalize_attempts` back to `0`:

```bash
gh workflow run daily-activity.yml
```
- **`1. Collect` -> `fail:no-repos`.** An assignment nobody accepted. No longer fails the run; if you still see it, the hub is on an older commit.
- **Weekly usage 403 `Resource not accessible by integration`.** Organization `organization_administration: read` is missing/unapproved, or Enhanced Billing is unavailable (§10.6). The report skips that org; System Health reports the permission drift and probes the live billing endpoint.

### 3.8 The nightly workflow is disabled and a student needs the dashboard updated

Expected: `daily-activity.yml` disables itself when no assignments are active. A re-publish reactivates it. To force one regen:

1. Actions -> `regenerate-dashboard.yml` -> Run workflow -> input: org.

For a forced nightly run:

1. Actions -> `daily-activity.yml` -> enable, then Run workflow.
2. Or from the SPA: an assignment's detail page offers **Run daily activity now** while no report exists yet (dispatches the same workflow scoped to the org and watches for the report to land).

(The publish workflow also enables it, so publishing any assignment also wakes it up.)

### 3.9 The acceptance URL 404s on cold load

Likely the SPA 404 shim isn't routing. Verify `frontend/public/404.html` exists in the deployed Pages output, and that `index.html` has the redirect decoder. Rerun `deploy-frontend.yml`.

### 3.10 Migrating legacy assignments

Assignments created before the `template.{owner,repository}` schema rename may still have the top-level `template_owner` and `template_repo` fields. The synchronous acceptance flow will fail with a `fail:exception` if a student accepts an unmigrated assignment.

To migrate these assignments, use `yq` in your control repository:
```bash
yq -i 'if has("template_owner") then .template.owner = .template_owner | .template.repository = .template_repo | del(.template_owner, .template_repo) else . end' assignments/*.yml
```


## 3.11 "CI results sync failed ... due to API errors"

**Check the rate limit first, and expect it to be fine** - a near-full quota is what rules out the cause the wording implies and points at a permission instead.

The cause is the same shape as §6.7 and the fix is the same two steps. Reading a grade out of CI uses two endpoints, `GET /repos/{owner}/{repo}/commits/{ref}/check-runs` and `GET /repos/{owner}/{repo}/check-runs/{id}/annotations`, and GitHub gates **both** behind the **Checks** repository permission. The Admin Panel authenticates with a *user-to-server* token from the App, which is capped by what the App declares - so without `checks: read` declared and approved, the sync cannot work anywhere, for anyone, and the message is about a state that will never change on its own.

1. **App owner**: `https://github.com/organizations/PXL-Digital-Application-Samples/settings/apps/pxl-classroom-provisioner/permissions` -> **Repository permissions** -> **Checks: Read-only** -> **Save changes**. Confirm with `gh api apps/pxl-classroom-provisioner --jq .permissions.checks` (must print `read`).
2. **Each org owner**: `https://github.com/organizations/<org>/settings/installations` -> **pxl-classroom-provisioner** -> **Review request** -> approve.
3. Sign out of the Admin Panel and back in, so the device flow issues a token carrying the new permission. An existing session keeps the old one.

`node scripts/check-app-declaration.mjs` answers step 1 immediately and needs no token; `scripts/check-installation-approvals.mjs` (the `installation-approvals` job in `weekly-usage-report.yml`) answers step 2 for every org at once.

Until step 1 is done the panel says so directly rather than blaming the API. Nothing is ever written on a failed sync - the code refuses to save a partial result, so retrying after the fix is safe.

---

### 3.12 "Invitation Exposure" is failing in System Health

Acceptance opens an issue on the public broker whose *title* carries a `pxl-accept:` value. The broker redacts that title within seconds, so under normal operation there is nothing to find — **a leftover means the redaction did not run.**

A leftover means one of three things:

1. **The broker's redaction step did not run or failed.** Check the broker's own Actions run for that acceptance — `Redact and close trigger issue` on the accepted path, `Reject invalid invitation` on the rejected one. Both need only `issues: write`, which `github.token` on the broker has, so a failure here is a dead run or a workflow predating the step, not a permission.
2. **`INVITE_ENABLED` is `false`.** The job-level `if` skips the whole run, cleanup included, so an issue opened while acceptance was switched off simply sits there.
3. **A run died between the dispatch and the cleanup.**

**Delete the leftovers with your own account**, which must have repository admin — being an org owner is not automatically enough:

```bash
gh issue list --repo <org>/broker-<assignment-id> --state all --search 'in:title pxl-accept' --json number,id
gh api graphql -f query='mutation($id:ID!){deleteIssue(input:{issueId:$id}){clientMutationId}}' -F id=<issue node id>
```

Deleting is manual because an installation token **cannot** delete an issue at any permission level — `deleteIssue` answers `FORBIDDEN: Viewer not authorized to delete` even where the App holds `administration: write`. Do not chase App permissions for this.

**What you do next depends on the assignment's invitation format, and getting it wrong is destructive:**

| Assignment | Sweep says | Then |
|---|---|---|
| Signed (`invite_key`) | **warn** | **Stop. Do not regenerate.** The titles are signatures naming one account, so nothing is exposed, and regenerating would retire every student's link to fix nothing. |
| Legacy (`invite_token` only) | **fail** | Republish with `regenerate_invite: true`. The title *is* the credential, and redaction alone is not enough — a rename stays visible in the issue timeline, so an exposed token must be retired rather than hidden. |

This is the same split `lib/diagnostics.mjs` applies when it raises the finding, and its message says which case you are in.

---

## 4. Manual workflow triggers (lecturer-runnable)

All under Actions in `pxl-classroom`.

| Workflow | When you'd run it |
|---|---|
| `publish-assignment.yml` | First publish or republish broker config |
| `regenerate-dashboard.yml` | Dashboard looks stale after a manual control-repo edit |
| `reconcile-registry.yml` | Quick drift check (deleted repos, revoked access) without waiting for nightly |
| `daily-activity.yml` | Force one nightly cycle (collect + finalize) |
| `deadline-sentinel.yml` | Arm the deadline watchers early, off-cadence (see §4.1) |
| `sync-starter-code.yml` | Push a template correction out to student repositories (§6.13) |
| `open-feedback-prs.yml` | Open the draft Feedback PRs headlessly instead of from the tracking page (§6.10) |
| `weekly-usage-report.yml` | Force a usage report off-cadence |

Each of these takes `org` as an input, and most also take `assignment_id` for scoping. Adding an organization is a different job with different inputs — [ADMIN.md §1.2](ADMIN.md#12-run-setup-organization).

### 4.1 The deadline sentinel

Without it, "Late work: does not count" locks the submission branch on the **first nightly run after the deadline** and reconstructs the submission with `?until=`. With it, the branch locks at the deadline itself and the run records a five-minute `pushed_at` timeline through the critical window - GitHub's own push timestamps, which a student cannot set, and the only thing that settles an argument about when work landed.

**It ships disabled.** `publish-assignment.yml` enables it the next time you publish an assignment, alongside `daily-activity.yml`. To turn it on now:

```bash
gh workflow enable deadline-sentinel.yml
```

and to turn it off again:

```bash
gh workflow disable deadline-sentinel.yml
```

What to expect once it is on: a run every 4 hours, which does nothing at all unless a deadline falls in the next 4.5 hours. When one does, a job holds a runner slot until that instant. The hub is a public repository, so that time is free (ARCHITECTURE §6.5) - but it does consume a **concurrency slot**, and GitHub Team allows 60. `find-armable.mjs` caps how many are armed per firing (`MAX_SENTINELS`, default 8) and logs what it dropped; anything dropped falls through to the nightly, so the deadline still holds, just later.

Every failure degrades the same way. A dropped cron firing, a killed job, a deadline moved out of reach - all of them leave the nightly finalize doing exactly what it did before. Nothing the sentinel does can make things worse than it not having run.

The timeline lands in `lockdowns/<id>/sentinel-<key>.json` in the control repo, beside the lockdown record it explains, with `outcome` (`fired`, `gave-up:runtime`, `gave-up:moved`) and one `pushed_at` sample per poll.

---


---

## 5. Retiring a finished assignment

The reason archives are per assignment (ARCHITECTURE §11.3.1): retiring a cohort is one gesture, and nothing else is in the blast radius.

1. Confirm the grades are out of the system and into wherever they live long-term. Deleting the archive destroys the preserved submission evidence for that cohort - `lockdowns/<id>/lockdown-record.json` in the control repo still holds each student's `snapshot_sha` and GitHub's own `pushed_at`, which is the record of *what* was submitted and *when*, but the content is gone.
2. Delete the student repositories for the assignment (`<repository_name_pattern>`).
3. Delete `<org>/pxl-classroom-archive-<assignment-id>`.
4. Leave the control repo alone. `assignments/<id>.yml`, `reports/<id>.json` and the lockdown record are small and are the audit trail; they are not what grows.

Do **not** delete an archive for an assignment whose deadline has passed but whose finalize has not completed - `find-finalizable.mjs` re-queues an assignment while any student with a `snapshot_sha` lacks a verified `preservation.json` (ARCHITECTURE §6.2.1), and it would push the branches back.

---


## 6. Roster, groups, grading and corrections

**Most of what a lecturer does after publishing lives here, and most of it has both a Web UI and a CLI route:**

| I want to… | Go to |
|---|---|
| Import a roster from a CSV | §6.4 |
| Run an assignment from email addresses, or with no roster at all | §6.4, the two sub-sections after the import |
| Turn the students who actually accepted into a roster | §6.5 |
| See or undo a claim binding | §6.6, §6.7 |
| Check an organization's install is healthy | §6.8 |
| Work with `submit/` tags | §6.9 |
| Open or review the Feedback PRs | §6.10 |
| Download every submission in bulk | §6.11 |
| Set up or read autograding | §6.12 |
| **Fix a mistake in an assignment students have already accepted** | §6.13 |
| Run System Health and its one-click fixes | §6.14 |

§6.1–§6.3 install and configure the CLI, and are needed only for the CLI route. Everything from §6.4 onwards is a task, and each says which surfaces can do it.

The `pxl-classroom` CLI in `cli/` is an optional power-user surface for the actions that scale poorly through the SPA: CSV roster import, install audits, feedback-PR orchestration, bulk submission download, and autograding. Same App, same device-flow auth, same schemas as the Admin Panel.

### 6.1 Install (from a clone of the hub)

```bash
git clone https://github.com/PXL-Digital-Application-Samples/pxl-classroom.git
cd pxl-classroom
npm install                       # installs the CLI workspace as well
npm link --workspace=cli          # exposes `pxl-classroom` on PATH
pxl-classroom --help
```

A `gh extension install` distribution will follow once Phase A stabilises. On Windows, the npm-link form is the supported path until then.

### 6.2 First-run authentication

```bash
pxl-classroom auth login --client-id <Iv23li…>     # Client ID from the App settings page ("About"), the /setup completion screen, or the PXL_APP_CLIENT_ID secret
# -> prints a verification URL + 8-char user code (+ a security notice:
#   authorize only "PXL Classroom Provisioner")
# -> attempts to open the verification page in your default browser
#   (best-effort; on headless shells use the printed URL)
# -> token cached at ~/.config/pxl-classroom/token (0600)

pxl-classroom auth status     # who am I, when did I auth, where is the token?
pxl-classroom auth logout     # wipe the cached token (config is preserved)
```

Set `PXL_APP_CLIENT_ID` in the shell to skip the `--client-id` flag.

### 6.3 Configuration locations

| OS | Token + config |
|---|---|
| POSIX | `$XDG_CONFIG_HOME/pxl-classroom/{token, config.json}` (falls back to `~/.config/pxl-classroom/…`) |
| Windows | `%APPDATA%\pxl-classroom\{token, config.json}` |

Both files are JSON, chmod 0600 on POSIX. Token TTL matches the device-flow OAuth user token (8 h); re-run `auth login` after expiry.

### 6.4 Importing a roster

The lecturer's roster (`students/roster.yml`) is schema v2. Either the SPA's Admin Panel -> **Roster** tab or the CLI imports it from CSV.

**CSV format** (header row required):

| Column | Required | Notes |
|---|---|---|
| `student_number` | Yes | Institutional SIS ID; treated as a string (preserves leading zeroes). |
| `full_name`      | Yes | Display name. |
| `email`          | Optional | Validated against the `email` format. |
| `class_group`    | Optional | E.g. `3A`. |
| `github_login`   | Optional | If known up front; otherwise filled at acceptance. |
| `github_id`      | Optional | Integer; pinned to survive renames. Usually filled at acceptance. |
| `active`         | Optional | Boolean (`true`/`false`/`1`/`0`/`yes`/`no`); defaults to `true`. |
| `team_slug`      | Optional | Only used to **seed** a first group assignment (§1.3). Membership belongs to the assignment, not the roster, so a later re-import does not move anyone between teams. |
| `team_name`      | Optional | Display name for `team_slug`. |

Unknown columns are rejected — the list above is `KNOWN_COLUMNS` in `lib/roster-csv.mjs`. Duplicate `student_number` values are rejected.

**CLI flow:**

```bash
pxl-classroom roster import --org <org> roster.csv --dry-run    # preview diff
pxl-classroom roster import --org <org> roster.csv              # commit (asks to confirm removals)
pxl-classroom roster import --org <org> roster.csv --force      # commit incl. removals without prompting (CI)
pxl-classroom roster list   --org <org>                          # tabular view
```

An import whose diff **removes** students prompts for confirmation on a TTY (same guard as the Admin Panel); non-interactive runs must pass `--force` to allow removals.

The `--org` value sticks (config remembers it) so subsequent invocations can omit the flag. When the flag is omitted, the CLI prints a reminder to stderr identifying the resolved last-used organization.

All CLI commands query the control repo. If assignments or reports are queried that do not exist, the CLI catches 404 errors and displays a friendly explanation instead of raw stack traces. If repository records are empty, it handles the 404 gracefully and returns an empty list.

**SPA flow:** open `/dashboard/<org>/admin#roster`, drop a CSV (or paste it), preview the added/updated/removed diff, click **Commit roster**. Schema validation runs against the same `schemas/roster.schema.json` the CLI uses - no drift between surfaces.

Both surfaces commit to `<org>/pxl-classroom-control:students/roster.yml`. The CLI uses `lib/gittree.mjs` (rebase-on-non-FF retry); the SPA uses the existing single-file Contents-API `commitFile()` - both safe for one-shot writes.

#### Running an assignment from a list of email addresses

Set **Who may accept** to `claim` when your roster carries students' PXL email addresses but not their GitHub usernames — the ordinary case, since you are given addresses and they choose their own usernames.

The student opens the invitation link, and the page shows them **their own GitHub-verified addresses** that match the allowed domains. They confirm one; the address is encrypted in the browser to the hub's public key (INSTALL.md §3.2) and only ciphertext ever travels over the public acceptance issue. The hub decrypts it, matches it to a roster entry by address, and writes the binding to `students/claims/<github_id>.json`.

**It is org-scoped and permanent.** Claim once, and every later assignment in that organization recognises the same account — no second prompt.

| What happens | Outcome |
|---|---|
| Address matches a roster entry | Accepted, bound to that student |
| Address is not on the roster | `rejected:no-claim-match` — a typo, or you registered a different address |
| Address already claimed by another account | `rejected:claim-taken` — first come wins; unlink it if the wrong person got there first |
| Address outside the allowed domains | `rejected:claim-domain` |
| Five failed attempts | `rejected:claim-blocked` — the student is told to contact you |

**Prerequisites, both one-off:** the claim keypair (INSTALL.md §3.2) and the App's account permission **Email addresses: Read** (INSTALL.md §2). Without the keypair the assignment fails closed with a red run rather than rejecting students. Without the permission the page cannot list a student's verified addresses — it says so honestly and offers the typed box, and every claim is then recorded `claim_verified: false`.

**`claim_verified` is evidence, not a control.** It is true only when the student picked an address GitHub had already verified on their account. The hub cannot check it — an installation token cannot read a user's email addresses — so anyone opening the acceptance issue by hand can assert it. Its value is that the ordinary path records it truthfully, which makes a cohort review far sharper than "does this address look like one of my students".

**A roster entry with no `email` can never be claimed.** Two entries sharing an address are refused at import, so it cannot surface at acceptance.

#### Running an assignment without a roster

`open` is what a new assignment gets by default: students need the invitation link and nothing else, and `max_acceptances` is the only limit. To gate on a roster instead, set **Who may accept** to `enforced` in the Admin Panel's **Guardrails** section (equivalently, `roster_mode: enforced` in the YAML).

**A roster is still useful under `open`.** It stops deciding who may accept; it does not stop being a roster. Reports and CSV exports are built from the union of the roster and the actual acceptances, so imported students appear before they accept and carry their student number, name and class group. Students who accept without being on it show up with their GitHub login only, for you to reconcile afterwards.

Any GitHub account can then claim a repo while the assignment is open, so the deadline window and **Max acceptances** become your only limits. The cap is therefore **required** with open enrollment - the form will not save without it, and `accept.mjs` rejects a hand-edited uncapped open assignment with `fail:config`. Keep it close to the real headcount. Accepted students appear on the dashboard immediately, with an empty name/student number until you import a roster or add overrides; importing a roster later backfills those columns on the next report run.

### 6.5 Promoting accepted students onto the roster

After an `open` assignment, the students who turned up are known only as GitHub logins in `acceptances/<id>/<login>.json`. Promotion copies them onto `students/roster.yml`, so the **next** assignment can run `enforced` against the cohort that actually enrolled.

**SPA flow:** open the assignment's tracking page (`/dashboard/<org>/<id>`) → **··· More** → **Add accepted students to roster**. The modal previews exactly who would be added before anything is written. It is offered only on an `open` assignment that somebody has accepted — under `enforced` every acceptor was already on the roster, so the action would be a no-op on every assignment.

**CLI flow:**

```bash
pxl-classroom roster promote --org <org> --assignment <id> --dry-run   # preview
pxl-classroom roster promote --org <org> --assignment <id>             # commit
```

What a promoted entry does and does not carry:

| Field | Promoted? | Why |
|---|---|---|
| `github_login`, `github_id` | Yes | The only identity GitHub gives us |
| `source: accepted` | Yes | Marks it as not-yet-identified so a later CSV import can reconcile it |
| `promoted_from` | Yes | `assignment_id`, `accepted_at`, `promoted_at`, `promoted_by` |
| `student_number`, `full_name`, `email`, `class_group` | **No** | GitHub never learns them. A guessed name lands in a graded field; a synthesised student number collides with real SIS numbering |
| `team_slug` / `team_name` | **No** | Membership belongs to the assignment, and a CSV re-import would wipe it (§5.6) |

Rules worth knowing before you run it:

- **It only adds.** A student already on the roster is left exactly as they are - promotion never overwrites a student number, name or class group with the little it knows. Matching is case-insensitive, the same way `accept.mjs`'s gate matches.
- **Re-running is free.** A second run finds nothing to add and commits nothing.
- **It refuses rather than guesses.** A roster that is a bare list of students (no `students:` key) is rejected with an explanation, not rewritten - that shape already lets nobody accept, and you need to know.
- **Promoting an `enforced` assignment** is normally a no-op. If it does add somebody, they accepted and were removed from the roster afterwards; the command says so and names them.

Afterwards, fill in the real identities by exporting the roster, adding `student_number`/`full_name` columns, and re-importing - the `source: accepted` marker is how you spot which rows still need it.

### 6.6 Seeing and undoing a claim binding

Under `roster_mode: claim` the student binds themselves: they confirm one of their own GitHub-verified addresses, and the hub writes `students/claims/<github_id>.json`. That binding is **org-scoped** and lives outside `roster.yml`, so the roster's own `github_login` column is usually empty by design - which is why the Roster tab shows a **binding** rather than that column alone.

**Where to look:** Admin Panel → **Roster** tab. Each student's GitHub Account cell shows one of:

| Shown | Means | What to do |
|---|---|---|
| `@account` (green) | Claimed, and GitHub had verified the address | Nothing |
| `@account` + *unverified* | Claimed with an address the student **typed** | Nothing, unless the cohort review says otherwise |
| `@account` (green, no claim) | Pre-linked by you in the roster CSV | Nothing - this works too |
| `@account ≠ roster` (amber) | Claimed by an account that differs from the `github_login` on their roster row | **Unlink** the wrong one |
| `Pending linking` | Nobody is bound yet | Wait, or chase the student |
| `No address` | The roster entry has no email, so it can **never** be claimed | Re-import the roster with an address column |

**CLI equivalent:** `pxl-classroom roster list` prints the same binding column plus a summary line, and names any orphan claims (an address on no roster entry - usually a student removed from the roster, or an address corrected after they claimed). Orphans are reported, never deleted automatically.

**Unlinking**, from the Roster tab's **Unlink** button or:

```bash
pxl-classroom roster unlink --org <org> --login <account> --dry-run   # preview
pxl-classroom roster unlink --org <org> --login <account>             # delete
pxl-classroom roster unlink --org <org> --email <address>             # by address instead
```

- It removes the binding **and the failed-attempt counter**. That is deliberate: you are usually unlinking because the student has been failing to claim, and five failures locks the account out - clearing the binding without the counter hands them back a door they still cannot open.
- Their **repository and acceptance are untouched.** Unlinking does not revoke access to work already provisioned; it only lets them bind again.
- It **refuses on a partial read.** If any file under `students/claims/` cannot be read, both the button and the command stop rather than delete - unlinking off an incomplete list can remove the wrong binding, and "no such binding" for a file that would not load reads as success.
- The CLI confirms before deleting, and requires `--force` when not attached to a terminal.

When a student **deletes and recreates their GitHub account**, their new `github_id` is a different student as far as the binding is concerned - unlink the old one and let them claim again.

**Folding claims into the roster.** The binding already governs acceptance, so this is optional - what it buys is a self-contained roster, so the *next* assignment can run `enforced` against a cohort whose usernames are now known, and an exported CSV carries them:

```bash
pxl-classroom roster promote --org <org> --claims --dry-run   # preview
pxl-classroom roster promote --org <org> --claims             # commit
```

`promote` now takes exactly one source, and the two are opposites: `--assignment <id>` **adds** entries for logins the roster has never heard of (open mode, §6.5), `--claims` **updates** entries it already has with the account the student bound. It writes only into an **empty** `github_login` - a value you set yourself is never overwritten, and a claim that disagrees with it is reported as a conflict for you to unlink. Nothing else is copied off the claim: the address is already the join, and `claim_verified` is evidence about one acceptance rather than a roster fact.

### 6.7 Which addresses a claim assignment accepts

`claim_domains` on the assignment decides which email domains a student may bind. Absent, it falls back to the deployment default - `claim_domains` in **`deployment.yml`** at the repository root, which is the one place to change it for a different institution (see ARCHITECTURE §2.1).

```yaml
claim_domains: ["student.pxl.be"]     # this assignment only accepts student addresses
claim_domains: []                     # deliberate opt-out: any domain passes the filter
```

**Absent and empty are different answers.** No key means the default; an explicit `[]` means you turned the filter off on purpose. Matching is on the **whole domain label**, never a suffix - anyone can register `notstudent.pxl.be`.

It is a filter, not proof. Nothing checks that a claimed address *exists*, so `asdf@student.pxl.be` passes the domain test - it is the roster match that refuses it. A student with no PXL address on their GitHub account may still type one; the binding is recorded with `claim_verified: false` and shows as *unverified* on the Roster tab. That is by design: requiring a GitHub-verified address locks out a real fraction of students and stops nothing determined, because the page is public JavaScript either way.

A student who has spent their five attempts is refused with `rejected:claim-blocked` and told to contact you - deliberately without a countdown, since that is a progress bar for whoever is enumerating addresses. Clear it by unlinking them (§6.6), which removes the counter as well as any binding.

**Under `roster_mode: open`, none of this refuses anybody.** The same confirm-your-address prompt runs and the same binding is recorded, but an acceptance is never rejected because of it and no attempts are counted. Open enrolment means the link, the window and the cap are the limits - a student with an older link or a browser that cannot sign still gets their repository, which is exactly why the address cannot be a gate here: anyone who wanted a second repository would simply skip the prompt.

What you get instead is a record to read afterwards, in `reports/<id>.json` and the CSV export:

| Column | Read it as |
|---|---|
| `claimed_email` | The address they confirmed. Empty means they never did - normal, not an error |
| `claim_verified` | `true` if GitHub had already verified that address for them; `false` if they typed it |
| `claim_domain_allowed` | `false` means the address is outside `claim_domains`. **Recorded, not refused** |

Two addresses confirmed by two different accounts show up as a duplicate in `pxl-classroom roster list` and on the Roster tab. Treat all of this as a review aid for an exam cohort, not as enrolment control - if you need control, `enforced` or `claim` is the mode.

Symptom this fixes: with `roster_mode: enforced` and an empty or missing `students/roster.yml`, every acceptance is rejected with `rejected:not-on-roster` / `rejected:no-roster`, and the student sits on "Setting up your repository…" until it times out. Check the `Accept assignment` run in the hub's Actions tab to confirm the rejection reason.

### 6.8 Auditing an org's install

`pxl-classroom audit` runs read-only health checks against an org's App installation, control repo scaffold, participating-orgs registry, and (with `--assignment`) the per-assignment lockdown/archive state. The SPA shows the same checks in the **System health** panel at the top of the dashboard.

```bash
pxl-classroom audit --org PXLAutomation
pxl-classroom audit --org PXLAutomation --assignment linux-processes-2026
pxl-classroom audit --org PXLAutomation --json    # machine output for CI
```

Exit codes: `0` clean, `1` warnings, `2` failures. The check engine lives in `lib/audit.mjs` and is shared with the SPA - both surfaces use the same code path, only the HTTP carrier differs (Octokit in the CLI, browser fetch in the SPA).

If `app-permissions match manifest` reports drift, re-approve the App in the org -> Settings -> GitHub Apps -> PXL Classroom Provisioner -> Configure. The expected permissions are the canonical `EXPECTED_APP_PERMISSIONS` in `lib/audit.mjs`, which `SetupView.vue` also imports - there is only one source of truth.

### 6.9 Tagged submissions

`collect/` lists `refs/tags/submit/*` on each student repo in addition to the default-branch snapshot. When a matching tag is found, a `tagged-submission` observation is written alongside the snapshot, and `report.mjs` prefers the tagged SHA for classification.

Tag format students copy from the template README:

```bash
git tag submit/$(date -u +%Y-%m-%dT%H:%M:%SZ)-$(git rev-parse --short HEAD) && git push origin --tags
```

The system never requires the tag - untagged submissions still land via the snapshot path. The timestamp inside the tag name is `declared_at` (observed-not-authoritative); the `observed_at` written by `collect/` is the time the hub saw the tag and is what classification uses.

The lecturer dashboard's **Submit tag** column on `AssignmentDetailView` shows the latest tag per student, and the student `AssignmentView` shows a "Submission tagged at …" banner once `collect/` has seen the tag.

### 6.10 Feedback PRs

Enable `feedback_pr: true` on the assignment (the Admin Panel's **Guardrails** section has a checkbox; manual YAML also works). Provisioning then creates and protects a `pxl-baseline` branch on each new student repo.

Open the actual draft PRs lazily - at provisioning time, `main` and `pxl-baseline` point at the same SHA and GitHub refuses with 422 "No commits between …".

**Option A: Web UI (1-Click):**
Navigate to the assignment's `AssignmentDetailView` in the SPA. Click the **Open Feedback PRs** button in the action bar. The web app iterates all student repositories with pushed commits and opens draft pull requests (`main` -> `pxl-baseline`), committing record updates to the control repo and displaying PR links immediately.

**Option B: CLI Companion:**

```bash
pxl-classroom feedback open --assignment linux-processes-2026                  # opens for all students with commits ahead of pxl-baseline
pxl-classroom feedback open --assignment linux-processes-2026 --login alice    # one student
pxl-classroom feedback open --assignment linux-processes-2026 --dry-run        # preview only - creates no PRs, commits nothing

pxl-classroom feedback list --assignment linux-processes-2026                  # PR URLs + open review-comment counts
```

The operation is idempotent - re-runs skip students whose record already has `feedback_pr_number`, and a student who has an open PR the record does not know about is **adopted** rather than given a second one. The summary counts opened and adopted separately, and a run that failed for any student **exits non-zero**: check the count before assuming a green tick means the whole cohort. Records for the PRs that did open are committed either way, so a re-run only picks up what is genuinely missing. The Admin Panel's `AssignmentDetailView` shows a **Feedback PR** column when the assignment opts in; "- pending" means provisioning created the baseline but no PR exists yet (student hasn't pushed, or you haven't opened PRs).

`feedback list`'s answer is in the app too: **··· More → Refresh feedback PR status** fills the same column with each PR's state (Draft / Open / Merged / Closed) and its inline review-comment count. It is an on-demand read - one request per open PR - so nothing is fetched until you ask, and it reports how many it could not read rather than quietly showing fewer.

Lecturer workflow: leave inline review comments on the PR like any GitHub PR. Comments persist as the student keeps pushing - the PR head tracks `main`. The student cannot delete `pxl-baseline` (App-level protection outranks repo admin).

### 6.11 Bulk Submission Download & Preservation Status

`pxl-classroom download` clones each preserved submission out of `<org>/pxl-classroom-archive-<assignment-id>` (the archive-backed evidence layer, immune to post-deadline rewrites of the student repo). The repository and ref come off each report row, so a cohort finalized before archives went per assignment still downloads from the org's old shared archive without a flag.

```bash
pxl-classroom download --org PXLAutomation \
                       --assignment linux-processes-2026 \
                       --dir ./submissions \
                       --concurrency 4
```

- Resumable: a re-run skips students whose checkout already matches the archive SHA.
- Writes `./submissions/_manifest.json` with `{login, archive_sha, archive_branch, archive_branch_url, downloaded_at}` rows for plagiarism tools / local CI.
- **Preservation Summary Banner:** When an assignment's deadline has passed, `AssignmentDetailView` renders a top banner displaying live preserved counts vs eligible students, lockdown execution timestamp, and measured uncertainty delay (`uncertainty_seconds = lockdown_at - deadline_at`). Quick buttons allow 1-click targeted retries, downloading the SHA manifest, navigating to the archive repo, and copying the CLI download command.
- **Direct Archive Links:** The student table and teams table display direct clickable hyperlinks to `https://github.com/<org>/pxl-classroom-archive-<assignment-id>/tree/preserved/<assignment-id>/<login>` (or team slug) for every preserved submission. The repository and ref are read off the report row, so links to cohorts archived before ARCHITECTURE §11.3.1 keep working.

### 6.12 Autograding

**In the Admin Panel**, the Guardrails section shows one line - **Automated checks** - and a **Set up** button. The modal behind it asks the two questions that are decisions:

* **Where do they run?** *On your machine* costs no Actions minutes, keeps the checks out of the student repository, and you run `pxl-classroom grade` after the deadline. *In each student's repo* runs them on every push, on the organization's Actions minutes, and shows the student a pass/fail each time.
* **Can students read the checks?** Only asked for the second answer. *Yes* commits them to each student's repository; *No* keeps them in the control repository and runs them from there.

Then add checks from three named starting points - *a command that must succeed*, *compare output for given input*, *a Python script* - each of which arrives pre-filled with a working example to edit. The table totals the points. A check with a missing ID, a duplicate ID, an empty command, an empty points box or (for Python) no script cannot be saved, and says so on its own row. **A blank points box is not zero** - if a check is genuinely worth nothing (a setup step that must succeed), type `0`. Saving with **no** checks is not a state: use **Turn off automated checks**. Escape, the backdrop and **×** all close without saving.

**Or edit the YAML directly** (the shape the panel writes):

```yaml
autograde:
  enabled: true
  execution_environment: github_actions
  visibility: public
  tests:
    - id: hello-world                      # lowercase slug; `id`, not `name`
      type: run
      command: "pytest tests/test_lab.py"
      timeout_s: 5
      points: 5
    - id: validator
      type: python
      script: |                            # `script`, not `command` - see below
        import subprocess
        assert subprocess.run(["./solution"]).returncode == 0
      timeout_s: 15
      points: 10
```

**A `python` test is its `script`, and nothing else.** Every runner - `--runner host`, `--runner docker`, and the generated Actions workflow - writes `script` to a file and executes it; `command` is ignored, and the schema rejects a `python` test that has no `script`. Write the assertions you want run directly in `script`. If you want pytest, use `type: run` with `command: pytest ...` instead: a `script` is executed by the interpreter, so a file that only *defines* `def test_x()` passes without testing anything. And nothing is installed before it runs - `setup_command` was read by the Actions generator, was never a schema field, and is gone - so keep a python test to the standard library plus whatever the repository itself provides.

#### Option A: Lecturer-side (CLI-only)

When `execution_environment` is `lecturer_local`, run the grader **on your machine** - never on the platform:

```bash
pxl-classroom grade --org PXLAutomation \
                    --assignment linux-processes-2026 \
                    --runner docker \
                    --concurrency 2

pxl-classroom grade --assignment linux-processes-2026 --login alice --dry-run    # one student, no commit
```

Defaults: `--runner docker` (recommended; `--network=none`, read-only mount, 512 MB memory, per-test wall-clock timeouts), or `--runner host` for trusted code (POSIX only - uses `/bin/sh`).

Results land in `<org>/pxl-classroom-control:grading/<assignment-id>/<login>.json` (validated against `schemas/grading-result.schema.json`) plus `summary.json` driving the **Autograder** panel on `AssignmentDetailView`.

#### Option B: Student-side (GitHub Actions)

When `execution_environment` is `github_actions`, the tests run automatically on GitHub Actions whenever the student pushes code.

- **Template Preservation**: If the assignment's template repository already contains a custom autograding workflow (`.github/workflows/autograding.yml` or `classroom.yml`, such as standard GitHub Classroom or Cloud PE workflows), it is preserved during provisioning without overwrite.
- **No checks, autograding on**: the injected workflow **fails** with a message saying the assignment defines none, rather than guessing at the student's toolchain and reporting the guess as a grade. The Admin Panel cannot produce that state; only a hand-edited YAML the schema rejects can.
- **Workflow Generation**: If no workflow exists in the template, provisioning injects a workflow utilizing `classroom-resources/autograding-*-grader` and `classroom-resources/autograding-grading-reporter`. A `python` test becomes **two** steps - one that writes its `script` to `.pxl-autograde/<test-id>.py` (the source travels in `env:`, so a quote in it cannot break the workflow) and the grader step that runs `python3` over that file. That is the same thing the CLI runners do, which is what makes a test definition mean one thing on both paths.
- **Guardrails**: The generated workflow automatically enforces `timeout-minutes: 10` (preventing infinite loops from burning runner quotas) and `concurrency: { cancel-in-progress: true }` (cancelling obsolete runs if a student pushes repeatedly).
- **Visibility `private`**: The injected workflow calls a reusable workflow stored in the control repository (`pxl-classroom-control`), hiding the actual tests and commands from the student's view.
- **Visibility `public`**: The tests are executed openly in the student's repository, allowing them to see exactly what commands are run.

To pull the grades back into the control repository:
1. Open the SPA and navigate to the `AssignmentDetailView` for the assignment (or run `pxl-classroom grade --assignment <id>`).
2. Choose **··· More → Read scores from GitHub Actions**. Once there are grades on screen the same action also sits in the Autograder panel.
3. The system fetches the Checks API at each student's preserved or latest observed SHA, reads the score from the check run's **annotations**, and writes `grading/<id>/summary.json` to the control repository. The Score and CI Status columns fill in immediately, and the CSV export carries them.

**This works for an assignment whose autograding came with the template.** If the template repository ships its own `classroom.yml` - the ordinary GitHub Classroom setup - the assignment does not need an `autograde` block in the Admin Panel, and you do not need to re-enter the exercises or their points: the reporter's annotation carries the maximum. The action is offered on any assignment that has not explicitly chosen a lecturer-local runner.

**Where the number comes from, and what it is not.** A check run created by GitHub Actions has an empty output body; the reporter emits `Points <earned>/<total>` and `{"totalPoints":…,"maxPoints":…}` as annotations, and that is what is read. A run with no such annotation is recorded from the run's conclusion instead - full marks or zero - and marked `score_source: "conclusion"` so it can be told apart from a real score. There is **no per-test breakdown** on this path: annotations carry the grand total only, so the drill-down links to the run rather than inventing a table. For a per-test breakdown, grade locally with `pxl-classroom grade --runner docker`, which writes `grading/<id>/<login>.json`.

### 6.13 Correcting an assignment after students have accepted

Spotted a mistake in the assignment? Fix it in the **template repository**, commit, and push. The sync distributes **that commit**.

> Commit the fix on its own. The sync offers the files your *latest* template commit touched, so a commit that mixes a correction with three unrelated edits offers all four.
>
> And be careful what the last commit contains: if you have been solving the exercises in the template to check them, the sync will happily offer your solution as the starter code. Solve in a scratch repository, or revert before syncing.

#### Option A: Web UI (Interactive Modal)
1. On `AssignmentDetailView`, choose **··· More → Sync Starter Code**.
2. **Review the commit and pick files.** The modal shows the template's latest commit and the files it changed, each with its diff. Everything is ticked; untick anything you do not want to send.
3. **Pre-flight.** Each student repository is read once and sorted into:
   - **Updated in place** - they have not touched these files, so the new version is committed straight to their `main` and arrives on their next `git pull`.
   - **Pull request** - they have changed at least one of them, so those files arrive as a PR and their work is not overwritten.
   - **Nothing to do** / **Could not read**.
   Ticking and unticking files re-sorts the cohort instantly; it does not re-scan.
4. **Customize & Dispatch:** adjust the commit/PR title, the student-facing instructions, and whether to open a tracking issue. Click **Apply Starter Update**.

The split is **per file**: a student who edited one of four corrected files still gets the other three directly, and a PR for the one. That is why a sync record can say `merged-and-pr` for the same student.

#### Option B: CLI Companion

```bash
# Preview what would be updated across the cohort
pxl-classroom sync-starter --assignment linux-processes-2026 --dry-run

# Send every file the latest template commit changed
pxl-classroom sync-starter --assignment linux-processes-2026

# Selectively sync specific files and customize the message
pxl-classroom sync-starter --assignment linux-processes-2026 \
                           --files "tests/test_lab1.py" \
                           --title "Fix assertion in test 3" \
                           --message "Updated test suite with corrected edge case assertion."
```

- **Mechanics:** the sync copies file content; it never merges the template's history into a student repository. Files the student has not touched are committed directly to `main`; files they have changed go onto `refs/heads/starter-update-<timestamp>` with a pull request into `main`, so their work is never overwritten.
- **Re-running is safe.** A second run of the same sync skips students who already have the change and reuses the pull request it already opened, rather than adding another.
- `--dry-run` reads only. No commits, no branches, no pull requests, no issues.
- **Audit Records:** Complete execution summaries are stored in the control repo at `syncs/<assignment-id>/<sync-id>.json`.

### 6.14 Pre-Flight Diagnostics, System Health & 1-Click Auto-Fixes

PXL Classroom features an automated diagnostic and self-healing engine (`lib/diagnostics.mjs`) accessible directly from both the Web UI and the CLI.

#### Option A: Web UI (Unified System Health Center)

1. **Organization-Wide Health Check (Dashboard):**
   - Click the **Activity Pulse icon** (`activity`) to the right of the Organization Selector on `DashboardView`.
   - The modal automatically verifies GitHub session validity, API rate-limit quota, App installation, permissions drift, `participating-orgs.yml` enrollment, and control repository scaffold integrity.
2. **Assignment Pre-Flight Troubleshooter (Admin Panel):**
   - When creating or editing an assignment on `AdminView`, click the **Troubleshoot** button in the header (or click any warning banner).
   - The troubleshooter executes a 5-tier inspection in dependency order:
     - **Tier 0:** Auth & Quota.
     - **Tier 1:** Org & GitHub App Foundation.
     - **Tier 2:** Control Repository Foundation (scaffold & privacy).
     - **Tier 3:** Assignment Definition & Starter Template (`is_template: true` on GitHub).
     - **Tier 4:** Acceptance Broker Infrastructure (`broker-<id>` repository & `.github/workflows/acceptance-trigger.yml`).
     - **Tier 5:** Student Portal & Pages Edge (`public/assignments.json` & CDN reachability).
3. **1-Click Self-Healing Repairs:**
   - **Template not marked as template:** Click **[Mark as Template on GitHub]** to execute an immediate API patch.
   - **Broker repository missing:** Click **[Create Broker Repository Now]** to dispatch `publish-assignment.yml`.
   - **Broker repository private:** Click **[Make Broker Public]** to patch repository visibility.
   - **Pages deployment propagating:** Click **[Deploy to GitHub Pages]** to trigger `deploy-frontend.yml`.
   - **Enforced roster missing:** Click **[Open Roster Editor]** to navigate directly to the roster editor tab.

#### Option B: CLI Audit Companion

```bash
# Run read-only organization health audit
pxl-classroom audit --org PXL-CSMobile

# Run deep per-assignment diagnostic audit
pxl-classroom audit --org PXL-CSMobile --assignment voorbeeld-project

# Output machine-readable JSON for CI health monitoring
pxl-classroom audit --org PXL-CSMobile --assignment voorbeeld-project --json
```

Exit codes:
- `0` = Clean (all checks OK/Info).
- `1` = Warnings (non-blocking issues or in-flight deployments).
- `2` = Failures (action required before student acceptance).
