# Open items

Known gaps that are **not** defects and have no home in a procedure: infrastructure that works today and would fail in a way nobody would be told about, controls deliberately weaker than they could be, paths that have never been exercised, and questions about how the app is arranged that it has not answered.

Counting them here was itself a thing that drifted - this sentence said "one designed control" while listing two - so it describes the kinds and leaves the count to the headings.

This is a standing register, not a plan: nothing here is scheduled, and an entry earns its place by being something a reader of [RUNBOOK.md](RUNBOOK.md), [INSTALL.md](INSTALL.md) or [ADMIN.md](ADMIN.md) would otherwise have to rediscover. Every entry says how to tell whether it is still open, so it can be closed from evidence rather than from memory.

---

## 1. The SPA shares a Pages origin with another site

**Status: open.** Verified 2026-08-31, amended 2026-09-22.

The SPA holds a lecturer's GitHub access token in `localStorage`, through [`frontend/src/lib/auth-storage.js`](frontend/src/lib/auth-storage.js) and nothing else. Browser storage is scoped to an **origin**, and `pxl-digital-application-samples.github.io` is one origin shared by every Pages site the organization publishes. An XSS in any of them runs same-origin with the SPA and can read that token, which reads the private control repo: roster names, student numbers, institutional email addresses.

**This entry said `sessionStorage` until 2026-09-22, and the move widened it.** Per-tab storage meant the token was reachable only while that tab lived; on the computer it now survives tab closes and restarts until GitHub's 8-hour expiry or a sign-out, and every tab shares it. The trade was made deliberately and its costs are written down in [LESSONS.md](LESSONS.md) (*"What the chosen one costs"*) - including the measurement that the only sibling Pages site, `security-flag-validator`, answers 301 to its own domain, and that every member of the hub organization is an owner who could change the SPA itself anyway. What changed here is the exposure window, not the verdict.

The organization currently publishes two Pages sites:

```
pxl-classroom            public
security-flag-validator  private repo, Pages published
```

Given its name, the second is exactly the class of application where an injection is plausible.

**Two ways out, in increasing order of effort:**

- **Policy** - nothing else publishes Pages from this organization. Free and immediate, and holds only as long as somebody remembers it, which is why it is written down here rather than agreed in a meeting.
- **A custom domain**, which removes the problem instead of managing it. Settings → Pages → Custom domain on `pxl-classroom`, CNAME to `pxl-digital-application-samples.github.io`, enable **Enforce HTTPS**. The SPA then has an origin no sibling repository can reach. Update `ALLOWED_ORIGINS` in [`cors-worker/worker.js`](cors-worker/worker.js) and redeploy the Worker **before** switching, or sign-in breaks at the cutover - the Worker refuses an origin it does not know, which is the control working.

**How to tell it is closed:** either the SPA is on its own domain, or

```bash
gh api "orgs/PXL-Digital-Application-Samples/repos?per_page=100" \
  --jq '.[] | select(.has_pages==true) | .name'
```

returns `pxl-classroom` alone.

---

## 2. The sign-in Worker is on a personal Cloudflare account

**Status: open.** Verified 2026-08-31.

`pxl-cors.tom-cool-38e.workers.dev` is the **primary** device-flow proxy (`device_flow_proxy` in [`deployment.yml`](deployment.yml)), so it sits on the critical path of every sign-in. It lives in a single-owner Cloudflare account.

If that account is lost, sign-in does not break - it fails over to the third-party secondary and keeps working. That is the problem: the system carries on with a third party seeing every access token, which is the state the ordering exists to prevent, and nobody would be told. System Health warns when the primary does not answer, but not when it answers from an account nobody at PXL can administer.

**Moving it:**

1. Create a Cloudflare account under a PXL address with more than one owner.
2. `cd cors-worker && npx wrangler@latest login && npx wrangler@latest deploy` from that account. Deploy from the repository rather than the dashboard editor - the Worker carries a security allowlist and a pasted copy drifts from the reviewed one.
3. Verify with the probes in [`cors-worker/README.md`](cors-worker/README.md): a browser-origin POST returns a device code, `OPTIONS` answers 204, both allowlists refuse by exact match.
4. Update `device_flow_proxy` in `deployment.yml` and deploy the frontend.
5. Keep the old Worker running for a week - cached bundles still point at it - then delete it.

**How to tell it is closed:** `device_flow_proxy` in `deployment.yml` names a Worker on a shared PXL account.

---

## 3. Organization-scoped lock-down holds real cohorts, and no real cohort has been reopened from it

**Status: open - the default, on real cohorts since 2026-10-12; a reopen on one has not been done.** Re-checked 2026-10-17: no `unlocked/` record in any course organization the hub account can read, and both cohorts below still at `reopened_count: 0`. On the testbed, Reopen, Lock again, and a reopen with time locked again at its end, were all run in the real dialogs that day (`relock.live.mjs`, `reopen-time.live.mjs`). PXL-Systems-Expert's `2627-systemsexp-pe1-groepsindeling` (31 students, 2026-10-12) and PXL-Automation-II's `pxl-2627-autii-pe1` (38, 2026-10-13) are held by `lock_method: org-ruleset`, with `reopened_count: 0` and no reopen record. **Reopen** and **Lock again** were clicked in the real dialog on the testbed on 2026-10-15 (`tests/live/ui/relock.live.mjs`), each checked on GitHub, over an organization ruleset that listed a deleted repository.

**What it is.** Under `late_policy: block`, an assignment that does not say otherwise is covered by one organization ruleset targeted by `repository_id` (ARCHITECTURE §11.2.1). A student who is admin of their own repository cannot delete, disable or leave it (measured 2026-09-08: 404 on each, 409 on a push) and keeps their Actions and secrets. Reopen removes one id (`lib/repo-unlock.mjs`), Lock again adds it back (`lib/repo-relock.mjs`), and every write recovers from a deleted repository in the list (`withoutGoneRepos`). `org_scoped_lock: false` opts an assignment back to one repository ruleset per student, which such a student can switch off in their own settings; `scripts/migrate-org-lock.mjs` moves a cohort the other way.

**What is still open.** A reopen, and Lock again, on a real cohort's lock. The testbed proves the mechanism with accounts the operator controls; a real course is the first time it meets a real lecturer and real students.

**How to tell it is closed:** a real course's assignment has a reopen record, and that student's repository is out of its organization ruleset:

```bash
gh api "repos/<org>/pxl-classroom-control/contents/lockdowns/<assignment-id>/unlocked" --jq '.[].name'
gh api "orgs/<org>/rulesets?per_page=100" --jq '.[] | select(.name|startswith("pxl-classroom-deadline-")) | .name'
```

---

## 4. The least-privilege way to give a lecturer hub access has never been used

**Status: open.** Verified 2026-09-02.

[ADMIN.md](ADMIN.md) §1.4 tells an administrator to add lecturers as **Write collaborators** on the hub repo, because publishing an assignment and retrying an acceptance both `workflow_dispatch` on the hub with the lecturer's own token, and write is what that needs. It is the correct grant and the smallest one.

Nobody has ever done it. Measured today:

```
repos/…/pxl-classroom/collaborators?affiliation=outside   0
repos/…/pxl-classroom/collaborators?affiliation=direct    0
orgs/PXL-Digital-Application-Samples default_repository_permission   read
```

Everyone who publishes today is an **owner** of the central organization, which works for a reason unrelated to the documented path: GitHub grants owners admin on every repository. So the instruction in ADMIN.md is followed by no one, and the first administrator to follow it will be the first to find out whether it holds.

Two things make that worth writing down rather than assuming:

- **Organization membership alone does not work, and fails in a confusing way.** The hub org's base permission is `read`, so a plain member lands on read for `pxl-classroom` and every dispatch returns 403 - which reads as "I added the lecturer and it still fails" rather than as a permission level.
- **The owner workaround is not equivalent.** An owner of the central organization is also an owner of the **App** registered there, and can therefore generate a private key that mints installation tokens for every participating org ([ARCHITECTURE.md](ARCHITECTURE.md) §4.3). Handing that to each lecturer to avoid testing a collaborator grant is a real widening of the blast radius.

A lecturer without hub write can still create and edit assignments - those writes go to their own control repo - but **Publish** and **Retry acceptance** fail.

**Half of this is now closed.** System Health's `hub-dispatch` check reads the viewer's own `permissions.push` on the hub repo and warns before they reach the 403, naming the membership trap explicitly. What remains open is the part a check cannot settle: whether the collaborator grant actually works end to end, which only a real non-owner publishing an assignment will tell you.

A sibling of this was found and closed the same day: a **published assignment with no acceptance broker** was invisible everywhere except that one assignment's Admin panel, and two of them sat that way unnoticed. System Health's `published-brokers` check now sweeps every published assignment in the org, and an assignment it could not read blocks a green result rather than being counted as fine.

**How to tell it is closed:** a lecturer who is not an owner of the central organization has published an assignment successfully, and

```bash
gh api repos/PXL-Digital-Application-Samples/pxl-classroom/collaborators?affiliation=direct --jq 'length'
```

returns a non-zero count.

---

## 5. Lecturer-defined checks have never been used on a live assignment

**Status: open.** Verified 2026-09-04, re-measured 2026-09-08.

Autograding has two shapes (ARCHITECTURE §11.6). One reads the score a workflow that came with the template produced; the other has the lecturer describe checks in the Admin Panel, from which the system either writes a workflow into every student repository or grades locally with `pxl-classroom grade --runner docker`.

Every live assignment uses the **first**. On 2026-09-08 the registry held **17** organizations, **14** with a control repository the sweep could read, **8** of those carrying assignments at all - **20** assignment YAMLs between them, and not one has an `autograde` block. Not one has a `submission_marker` either, so every assignment that grades is on the template's own schedule. Both lecturers doing autograding - `d-ries` on `proef-pe1`, `dhoubrechts` on `python-hacking-intro` - ship a GitHub Classroom `classroom.yml` in their template, which is where these courses come from.

Three organizations 404 for the sweep, which is unreadable rather than empty, so the count is a floor.

That is not a defect, and the path is not dead code: it is the only way to keep checks **out** of the student's repository, and the only one that produces a score per check rather than one total. But it is unexercised, and unexercised code is wrong in ways tests do not catch. It shipped for months handing every generated workflow a `timeout` in **minutes** where the schema field is seconds - a 30-second test capped at 30 minutes, on the side that bills an organization's Actions minutes - and nothing noticed, because nothing ran one.

The modal now opens on the template branch for that reason, so nobody meets the unproven path by default.

**The round trip was drilled on 2026-09-08**, on `PXL-Systems-Advanced-II` with two accounts: two `run` checks declared in the panel, `execution_environment: github_actions`, through publish → accept → push → deadline → finalize. Provisioning generated the workflow into both student repositories, GitHub ran it, and the scores came back **20/20 and 5/20 read from the annotations** (`score_source: annotation-json`) - the partial one being the case a red conclusion used to record as 0. The generated reporter's env keys carried their hyphens (`HAS-ANSWER_RESULTS`), which is the spelling the fix earlier that day restored. `io` and `python` checks were not part of that drill; `run` was.

So the path works where it had never been run. What the entry still says is unchanged: no assignment a real cohort uses has an `autograde` block, and a drill on an organization with nothing at stake is not that.

**`io` and `python` were drilled on 2026-09-09, and the drill found the thing this entry predicts.** `classroom-resources/autograding-python-grader@v1` is a Docker action whose own Dockerfile fails (`apt-get install jq`, exit 100), and GitHub builds every Docker action in a job *before* running any step - so it did not merely fail its own check, it took the whole grading job down and skipped the `io` check with it. Nobody scored anything. The same assignment with the python step removed scored 6/6, which is how the failure was isolated to that one action. Fixed by generating `autograding-command-grader` instead: we were already driving the python grader as a plain command runner with an empty `setup-command`, so it contributed a container that will not build and nothing else.

**One trap is left, unfixed and worth knowing before a lecturer meets it.** All three runners put the script *outside* the repository - Actions at `.pxl-autograde/<id>.py`, `runner-host` at `<scratch>/t.py`, `runner-docker` mounted at `/t.py` - and Python puts the SCRIPT's directory on `sys.path`, not the working directory. So the obvious thing a lecturer writes, `import solution`, fails in every runner with `ModuleNotFoundError` for a reason that has nothing to do with the student's work. It is at least consistent across all three, so a check behaves the same on the CLI and on Actions; the fix would be putting the repository on `PYTHONPATH` in all three, which is a change to each runner and is not made here.

```bash
grep -rn "PYTHONPATH" provisioning/provision.mjs cli/src/lib/runner-host.mjs cli/src/lib/runner-docker.mjs
```

printing nothing is that trap still open.

**It was exercised end to end on 2026-09-08, and it was broken in four places.** A drill assignment on `pxl-classroom-testbed` - three checks, ten points, a template with a deliberate bug - provisioned, graded and read back. What it found, in the order it was hit ([LESSONS.md](LESSONS.md), *"The unexercised path was broken in four places"*):

1. **The workflow injection races template population**, because `POST /generate` returns before the repository has content and `provision.mjs` writes immediately after it. Two students provisioned two minutes apart got two *different* broken repositories - one with the starter code and no workflow, one with the workflow and no starter code - and both runs logged `[ok] inject-autograding` and exited `created`. **Fixed**: provisioning waits for the copy to be filled (`await-template`) and fails the run (`fail:template-not-populated`) if it never is.
2. **The reporter's environment variable was renamed by the generator**, so every hyphenated check id was invisible to it: all graders green, grading job red, no score. **Fixed** - the key is derived the way `autograding-grading-reporter@v1` derives it.
3. **Two tests asserted the broken spelling**, having been written from the generator's output rather than the reporter's rule. **Fixed** - both derive it now.
4. **`autograding-python-grader@v1` cannot build its Docker image** (`apt-get install jq` exits 100), and a Docker action that fails to build takes the whole job down before `Checkout code`. So **no `type: python` check can run on Actions today**, and it is upstream, not ours.

A fifth thing is a defect in the *reading* half rather than this path: a `failure` conclusion with no score annotation is recorded as a real zero, and item 2 above is one way to produce exactly that. See the register's sibling note in LESSONS.md; both callers guard "could not finish reading the annotations" and neither guards "read them all, no score in them".

**`visibility: private` has never been able to work at all.** It generates `uses: <org>/pxl-classroom-control/.github/workflows/grade.yml@main`, and nothing in this repository ever creates that file - ARCHITECTURE §3.1 says control repos contain no workflows, which is load-bearing. **Withdrawn**: the option is gone from the panel, checks that run on Actions are always committed to the student's repository, and the schema keeps the field only as vestigial so an older document validates.

**How to tell it is closed:** an assignment in some organization carries an `autograde` block, and a student repository under it has a grading run that came from `provisioning/provision.mjs` rather than from the template. For the first half:

```bash
for org in $(gh api "repos/PXL-Digital-Application-Samples/pxl-classroom/contents/participating-orgs.yml?ref=participating-orgs" \
      -H "Accept: application/vnd.github.raw" | grep -oP '(?<=- login: ).*'); do
  for f in $(gh api "repos/$org/pxl-classroom-control/contents/assignments" --jq '.[].name' 2>/dev/null); do
    gh api "repos/$org/pxl-classroom-control/contents/assignments/$f" \
      -H "Accept: application/vnd.github.raw" 2>/dev/null | grep -q '^autograde:' && echo "$org/$f"
  done
done
```

printing nothing is this item still open. It reads only organizations whose control repository you can see, so run it as an owner of each.

---


## 8. e2e specs stage report fixtures the report schema would refuse

**Status: open - bounded and guarded.** Measured 2026-09-07, narrowed the same day.

**What changed.** Every spec that both stages a report and asserts on a write to `reports/` is now clean, and `setupStandardMockRoutes` refuses a report fixture the schema would reject - at the moment it is staged, in the spec that staged it, naming the field. The remainder are listed by name in `REPORT_FIXTURE_EXEMPT`, so a **new** spec cannot join them without editing that list, and a spec that later gains a save is no longer excused by being on it. `tests/e2e/72-report-fixture-guard.spec.mjs` proves the guard fires and that a correct fixture still passes; `tests/fixture-options.test.mjs` fails if the list names a spec that no longer exists.

Three of the exempted specs were found by the runtime guard and by nothing else - their fixtures are assembled by helpers, invisible to a source scan. That is the argument for checking where a fixture is staged rather than where it is typed, and it is why the count below is a floor rather than a total.

What is still open is the remainder itself: 21 specs whose report fixtures describe documents the backend would refuse, kept because they only render.

Report fixtures staged by e2e specs are hand-written objects, and many of them are not the shape the app writes. Root fields the schema does not declare (`org:` is the common one), row fields that do not exist, required fields absent. `report.schema.json` is `additionalProperties: false`, so the real writer would be refused.

**They stay green because they never reach a save.** A spec that only renders a report never validates it; the divergence surfaces only when a test drives a write. That is exactly how `tests/e2e/69-live-refresh-saves.spec.mjs` was written - the first draft staged an `org:` field, and the save it exists to guard failed against the schema rather than against the bug.

A careful scan finds ~113 real violations: 19 x `org` and 14 x `assignment_title` at the root, 4 missing `assignment_id` (required), and row fields the schema does not declare - `name` where a team has `team_name`, plus the autograding fields that belong on a grading summary. An earlier looser count said 185.

This is not a defect in the deployed system, and it is not urgent: the fixtures that matter - the ones behind a write - are already correct, and `tests/fixtures/e2e-fixtures.mjs` validates every control-repo write against the schema for its path. It is here because *"a mock that accepts anything tests nothing"* is a rule this repository already paid for, and a fixture that could not survive contact with the writer is a standing bet that it never will meet one.

**The decision taken 2026-09-07** was to fix the specs that could reach a save and guard the rest, rather than rewrite all of them. Touching 21 specs to correct fixtures risks changing what they assert, which is a worse trade than a divergence that cannot reach a writer - and the guard makes the set countable instead of a number somebody re-measures each time. What remains open is whether to spend the pass that empties the list.

**How to tell it is closed:** `REPORT_FIXTURE_EXEMPT` in `tests/fixtures/e2e-fixtures.mjs` is empty. It holds **21** specs today, and the guard in front of it means the number can only go down.

```bash
sed -n '/^const REPORT_FIXTURE_EXEMPT/,/^]);/p' tests/fixtures/e2e-fixtures.mjs | grep -c "\.spec\.mjs'"
```

---

## 9. A team repository's name can drop the assignment, and only the form stops it

**Status: CLOSED 2026-09-18.** Found 2026-09-09; the first version of this entry overstated it, the second narrowed it to a residual, and the residual is now answered at the click. Kept here rather than moved to the table below, because the reasoning about what may and may not block is the useful part and it does not fit a row.

**What is actually true.** A team repository's name comes from `repository_name_pattern`, and `{team_slug}` on its own carries no assignment - so two assignments with a `team-a` would produce the same repository name for different people. Slugs like `team-a` or `de-bende` repeat every year; repeating is what they are for.

**But the default already prevents it, and nothing in the field deviates.** The form prefills `<assignment-id>-{team_slug}`, and measured across all 13 participating organizations on 2026-09-09, **all 20 live assignments carry their id** - 5 team assignments among them, every one of the form `test-groepsopdracht-{team_slug}`. Not one bare placeholder anywhere. The first version of this entry used `grp-{team_slug}` as its example and made a hand-crafted shape look like the norm.

**Two things now close the gap from both ends:**

- `patternProblem` (`lib/assignment-collision.mjs`) refuses a pattern that is only a placeholder, and refuses an unknown one like `{slug}` or `{login}` that `deriveRepoName` would copy into the name verbatim.
- `lib/existing-repo.mjs` resolves an absent `existing_repo_policy` to `refuse` for a team assignment, so if a name ever does collide, that acceptance is turned away and the lecturer is told by name rather than the cohort being handed another team's work.

**Drilled live on 2026-09-09**, through the real broker with a second account: a team assignment on `liveteam-{team_slug}` over a pre-planted `liveteam-team-a`. `team-a` was refused with the team wording, and the lecturer's tracking issue named it; a second acceptance into a fresh `team-zz` was created from the template and provisioned normally. The refusal wrote **nothing**: no acceptance record, no repository record, and no `teams/live-team/team-a.json`, so a turned-away team leaves no state to clean up. The previous team's repository was untouched, still holding only its own file.

**What remained, and was closed on 2026-09-18.** Two assignments sharing a pattern is refused only while both are **live** (`clashingAssignments` reads the assignment list). A deleted or archived assignment whose repositories survive is not in that list, so a new assignment may legitimately be created on a colliding pattern - and it was the acceptance-time refusal above, not the form, that caught it. A defence in the right place, but the lecturer learned at the first acceptance rather than at the click.

`retiredPatternClash` (`lib/assignment-collision.mjs`) is the click half: of the repositories a pattern would produce, the ones **no assignment that still exists** would produce. It costs no request - the form holds the organization's listing and the assignment list already, and the answer is a subtraction - and it rides in the dialog Save opens rather than under the field, which is where the lecturer is already deciding what happens to a student who owns one.

**It names nothing, deliberately.** Which retired assignment those repositories came from is not knowable here: the manifest records the id, the title and the date, and never the pattern, so attribution would be a guess with a name on it. The sentence says what was computed. And it never blocks, for the reason the head of `lib/assignment-collision.mjs` gives: the deletion record is written by every delete, so refusing on it would refuse "I opened it, nobody joined, starting over".

**How to tell it is closed:**

```bash
node -e "import('./lib/assignment-collision.mjs').then(m => console.log(typeof m.retiredPatternClash === 'function' ? 'checked' : 'not checked - still open'))"
```

---

## 10. A dispatched acceptance is not bound to the broker that sent it

**Status: open, accepted.** Found and verified 2026-09-22. To be revisited next summer.

`acceptance-handler.yml` mints an App token for `client_payload.org` and acts in that organization. Nothing binds that field to the broker the dispatch came from. `resolveBrokerIssue` ([`lib/broker-issue-target.mjs`](lib/broker-issue-target.mjs)) confines only *which issue* the hub reads and writes - the owner of `broker_repo` must equal `org` - and [`acceptance/accept.mjs`](acceptance/accept.mjs) never sees `broker_repo` at all.

Dispatching needs `contents: write` on the hub, which means the broker App's private key. That is **one key, copied to every broker repo** (`publish-assignment.yml`, step *Create and configure broker repo*), and brokers live in the course orgs. So anyone with admin on **one** participating organization can push a workflow to a broker there, read the key out, and submit an acceptance into **any other** participating organization. The signature check does not stop them: it runs on the *broker*, and holding the key means dispatching directly instead.

**Why this is accepted rather than fixed.** The principal is a lecturer or an organization admin, who already has far more destructive options inside their own org. What this buys is one student repository generated from a peer course's template, plus a slot off its `max_acceptances`. No administration, no secrets, no App key, nothing reachable from the internet. ARCHITECTURE §4.3 and §4.3.4 used to deny it outright; they now say this instead, which was the part that could not wait.

**The shape of the fix.** Have the hub verify the student's signed title itself, against the assignment's `invite_pubkey` in its own control repo, rather than trusting the broker to have done it. A forged dispatch for another org would then need a live invitation link for that org.

**The trap, which is the part worth keeping.** The signature carries `github_id` and **not the login**, while `accept.mjs` gates the roster on `github_login`. So checking the signature against the *payload's* id is not enough: a title lifted from the public `IssuesEvent` firehose, carrying another student's id beside the attacker's own login, passes that check, and `roster_mode: open` then admits the login. Both identities have to come from one authoritative source - the issue author, read from the API - never from the payload.

**Three constraints already measured, so nobody re-derives them:**

- `tests/broker-injection.test.mjs` pins **exactly two** steps reading `github.event.issue.title`. A third read fails it, so the title must be emitted as an output of the verifier that already holds it, canonicalised from its base64url segments (a raw title in `GITHUB_OUTPUT` is the newline-forgery hazard ARCHITECTURE §4.3.1 records).
- The dispatch already sends **9 of GitHub's 10** permitted `client_payload` top-level properties. Adding `title` means dropping `kind` and deriving the purpose from the signature, which `verifyAcceptanceTitle` already returns.
- `INVITE_NONCE` is consulted on the **legacy token path only**. On the signed path retirement is keypair regeneration (`scripts/set-assignment-invite.mjs`), so verifying against `invite_pubkey` already honours it and a nonce comparison would check nothing.

**It needs no new App permission.** The acceptance job's existing token already covers the extra issue read, and `tests/app-token-scopes.test.mjs` tracks only token-minting steps. No approval round, no owner emails.

**What it does cost, and why it is summer work.** Hub code runs from `main` for every organization at once, so it has to land observe-only first. Then every published assignment needs one republish, by someone with access in that org, before the check can be enforced - republishing re-pushes the broker template, sends `regenerate_invite: false` and so retires no links, but it is a per-org action nobody can do centrally.

**How to tell it is closed:**

```bash
grep -c "verify-dispatch-signature" .github/workflows/acceptance-handler.yml
```

`0` while it is open.

---

## 11. A grading run a student started and then deleted leaves no trace

**Status: open, accepted.** Measured 2026-09-27 on `pxl-classroom-testbed/pxl-grade-dispatch-probe`.

Under a hand-in cap, a grading run the student starts themselves uses a slot (`lib/submission-marker.mjs` `listHandIns`). The only record of such a run is the run list. It is not a push, so it never appears in the push log (`/activity`) or the repository events, and deleting the run also deletes its check suite and check runs. A student is admin of their own repository and can delete runs. So a student who starts a grading run, reads the score and deletes the run has spent no slot.

**Why this is accepted.** What it buys is extra graded feedback, never an extra graded submission: the graded commit is still chosen from pushes, which the push log records whatever runs are deleted. The organization audit log would be a witness, but its API needs Enterprise, which this project does not target, and the audit log a Team owner can see in the browser is nothing a job can read.

**The shape of a fix, if it is ever wanted.** Stop the student starting it at all: a grading workflow whose `workflow_dispatch` job refuses any actor who is not the App or a lecturer. That is a change to every student repository's workflow file, delivered by starter sync, and a student with admin can edit it back - so it only raises the cost.

**How to tell it is still open** - start a grading run on a probe repository, delete it, and look for it:

```bash
gh api "repos/pxl-classroom-testbed/pxl-grade-dispatch-probe/actions/runs/<deleted-run-id>" --jq .id
```

`Not Found` while it is open, and neither `/activity` nor `/events` lists the dispatch.

---

## 12. Claim bindings from before `claimed_through` count as gate-admitted

**Status: open, accepted.** Found in the review of v1.5.0, 2026-09-27. Re-measured 2026-10-17: PXL-2TIN-NetAdv-26-27 still holds 95 files under `students/claims/` without the field (of 145, scaffold files included), PXL-Java-Essentials 3 of 207; the other readable organizations hold their scaffold files and nothing else.

A refusal on a binding the claim gate admitted is not counted as a guess; a refusal on one the confirm link or open enrolment wrote is (`acceptance/accept.mjs`, `claimed_through`). A binding written before that field existed has none, and absent is read as gate-admitted - the permissive reading, against "Fail closed".

**Why this is accepted.** The exposure is the one address already bound to that account: switching to any other address writes a new binding with `claimed_through: confirm`, which is counted. It is not a general roster oracle. Reading absent as unchecked instead would count, and so could block, students admitted long ago who open the wrong section's link, which is the lock-out this field was added to end.

**How to tell it is closed** - no binding without the field is left in an organization's control repository:

```bash
gh api "repos/<org>/pxl-classroom-control/contents/students/claims" --jq '.[].name'
```

then read each and count those with no `claimed_through`; `0` in every organization means it is closed.

---

## 13. The Pages artifact lists every invitation card to any signed-in GitHub account

**Status: open, accepted.** Found 2026-10-07, while making one organization's fault stop blocking every other's student pages.

Invitation cards and team files are published at `data/<org>/i/<sha256 of the link secret>.json`, so that only a link holder can find one (ARCHITECTURE §4.3.3). But the deploy uploads the whole site as the `github-pages` artifact (`actions/upload-pages-artifact`, kept 30 days so the next deploy can keep an unreadable organization's pages from it after a quiet spell; a current one exists whenever anything has deployed, so the length adds older versions, not exposure of a new kind), and on a public repository any signed-in GitHub account can list and download an artifact - measured with an account outside the organization: list 200, download 302; anonymous 401. The artifact is the full file list, so the digest hides nothing from someone who downloads it.

**Why this is accepted.** What it shows is little. A card holds no secret (the link's signing key is not in it) and nothing the student page does not show to anyone with the link. A team file's members are already public: every acceptance is a public issue on the broker repository, authored by the student and naming the team. What is new is only teams the lecturer seeded, before their members accept. No deployment method avoids it on a public hub - a `gh-pages` branch would be public too - and the hub is public by design (zero minutes).

**How to tell it is closed** - no `github-pages` artifact is downloadable by an account that is not a member of the hub organization:

```bash
gh api "repos/PXL-Digital-Application-Samples/pxl-classroom/actions/artifacts?name=github-pages&per_page=1" --jq '.total_count'
```

`0`, or a download of the newest one refused with a non-member's token, means it is closed.

---

## 14. Two ways the student pages stay behind until the next change, each needing two failures at once

**Status: open, accepted.** Found 2026-10-07 by the review of the night's incident fixes; the user chose to record them rather than fix them.

The watchdog redeploys the student pages when they are behind the data (`pagesRedeployDue`, `scripts/pipeline-watchdog.mjs`). Two cases slip past it. In both, the next publish or acceptance anywhere repairs the pages, usually within the hour.

1. **A deploy that read the data before a regeneration, but finished after it, counts as covering it.** "Behind" compares when runs FINISHED, not when the deploy read each organization. So a regeneration whose own deploy dispatch failed (three attempts), finishing while an unrelated deploy that had already fetched is still running, is taken as deployed. Both have to happen at once. Fixing it means the deploy recording what it read per organization, and changing how "behind" is decided - which risks the ordinary publish path, so it was left.
2. **A regeneration cut short is ignored.** The nightly regenerates every organization in one run; an acceptance's own regeneration of one organization cancels that organization's leg (one group per organization), so the run ends `cancelled` while the other legs committed. The run still dispatches the deploy (`if: always()`), so this matters only when that dispatch ALSO fails: the watchdog skips a cancelled regeneration, and the others' new data waits.

**How to tell it is closed** - the comparison is no longer by finish time and a cancelled regeneration is no longer skipped; while open, both lines print:

```bash
grep -n "newestRegen > lastOkAt\|r.conclusion === \"success\" || r.conclusion === \"failure\"" scripts/pipeline-watchdog.mjs
```

---

## 15. Two brokers finalized before acceptance was closed at the deadline may still hold the broker App's key

**Status: open.** Found 2026-10-14 in a review of the finalize; moved here 2026-10-15 because no nightly will ever retry it. Re-checked 2026-10-16 with `tests/live/broker-hygiene.mjs`: both still unreadable to the hub account (HTTP 403 on the variable and the secrets).

Six assignments were finalized before `scripts/close-acceptance.mjs` existed (2026-09-03). Four of their brokers are confirmed closed. The two `test-opdracht` brokers, `PXL-2TIN-CloudEssentials-2627/broker-test-opdracht` and `PXL-2TIN-DevOps-2627/broker-test-opdracht`, cannot be read by the account that checked (a member there, not an admin), and the finalize queue does not reach them: it re-runs a broker close only for a lock written since closing was recorded (`BROKER_CLOSE_RECORDED_SINCE`, `scripts/find-finalizable.mjs`). Every finalize since 2026-09-03 closed its broker (136 nightly logs: 93 closed, one broker already deleted).

Either broker still open is the broker App's private key on a public repository and a door that books a runner for each attempt. The fix needs an admin of each organization: delete the test assignment in the Admin Panel, which removes the broker, or close it by hand as ADMIN.md §5.7 says (door first, then the key).

**How to tell it is closed** - as an admin of each organization; closed when the variable reads `false` (or the repository is gone) and the secret is not listed:

```bash
gh api repos/PXL-2TIN-CloudEssentials-2627/broker-test-opdracht/actions/variables/INVITE_ENABLED --jq .value
```

```bash
gh secret list --repo PXL-2TIN-CloudEssentials-2627/broker-test-opdracht
```

and the same two for `PXL-2TIN-DevOps-2627/broker-test-opdracht`.

---

## Closed

Kept briefly so they are not reopened from memory. Each was verified against the live system, not against a changelog - 2026-08-31 unless the row says otherwise.

| Item | Closed by | Evidence |
|---|---|---|
| **The roster was organization-wide and lived inside one assignment's editor** (closed 2026-10-17, raised 2026-09-06) | The organization got pages of its own, and the editor became a tab of the assignment it edits | `/dashboard/:org` lists the assignments, beside `/dashboard/:org/roster` (`RosterView.vue`), `/dashboard/:org/organization` and `/dashboard/:org/usage`; an assignment is edited at `/dashboard/:org/:assignmentId` (`tab=settings`) and a new one at `/dashboard/:org/new`. `/dashboard/:org/admin` is a redirect kept for links already handed out (`?edit=` lands on the assignment's settings). `grep -c "RosterTab" frontend/src/views/AdminView.vue` is `0`. |
| **Most App tokens reached every repository with every permission** (2026-09-17) - *found by zizmor's `github-app` audit: 23 of 27 token steps minted with only `owner:`* | Every token step asks for its row in `lib/app-token-scopes.mjs`, narrowed in three stages the same day with no change to the App's own permissions, and each exam-path change proven with `tests/live/drill.mjs` on the testbed (moved to Team for it) as it landed | `grep -c "pending:" lib/app-token-scopes.mjs` is 0, and `tests/app-token-scopes.test.mjs` refuses a row with every permission or a broad row without a reason. On the narrowed tokens, drills `drill-20260917-1519` to `-1646` on `pxl-classroom-testbed` passed publish and republish, both acceptances with their labels, a refusal, a retry, the sentinel stopping writes at the instant, the lock by organization ruleset and by repository ruleset with demotion, a refused late push, preservation, the report, the closed broker, a retry refused over a locked repository, and `migrate-org-lock` run for real. Grading at the deadline (Checks read) is the one path no drill reached, because no drill assignment grades. |
| **Nothing graded automatically, and grading was one button for a whole cohort** (2026-09-08) | `scripts/grade-at-deadline.mjs` as step 6 of the finalize job, plus a per-row re-grade | The nightly reads each student's grading run at the deadline and writes `grading/<id>/summary.json`, so the report and the CSV carry marks with nobody pressing anything. It refuses to replace a summary a person produced (`graded_by` set, or a docker/host runner) and refuses to fail the finalize, which by then has locked the cohort and archived its submissions. Grading on the student's PUSH stays unavailable for the reason the entry gave: it needs a credential in a repository the student administers. `lib/grade-cohort.mjs` is the one implementation - it was inside `AssignmentDetailView.vue`, where the workflow could not reach it. `tests/grade-at-deadline.test.mjs`, `tests/grade-cohort.test.mjs`, `tests/e2e/65`. |
| **The two deadline controls read as one question and a footnote** (2026-09-08) - *filed as "they are one ladder", and that premise was wrong* | Asking them as two questions of the same shape, not merging them | `late_policy` decides what **counts** (lockdown.mjs passes `deadlineFor` to phase 2 only under `block`); `lock_down_enabled` decides **access**. All four combinations are distinct and *still counts* + read-only is what both 2026 exams ran on, so the three-way ladder this entry proposed would have made a live state unrepresentable. What was wrong was the wording: a grading verdict followed by a checkbox beginning "Also". DESIGN.md §1.9, `tests/e2e/29`. |
| **An organization that deletes its last assignment kept the card** (2026-09-08) | `pruneMissingAssignments` reads the listing rather than a set of ids, and takes the scaffold's `.gitkeep` as proof that an empty `assignments/` was really read | The signal the entry called "one candidate" was already there: `scripts/scaffold-control-repo.mjs` writes `SCAFFOLD_KEEPFILE` into every scaffold directory, and all 14 readable control repos carry it. `tests/dashboard-prune.test.mjs` covers both directions - present-and-empty prunes, empty-with-no-marker does not. |
| **Brokers held the provisioning App's private key** | The broker App, plus republishing every live assignment | `gh secret list --repo <org>/broker-<id>` shows `PXL_BROKER_CLIENT_ID` and `PXL_BROKER_PRIVATE_KEY` only. Checked on `PXLAutomation/broker-finalize-drill`; a broker in an org you do not administer returns 403, so confirm the rest as an owner of that org. |
| **`PXL_APP_PRIVATE_KEY` needed rotating after that sweep** | Rotated | The `provisioning` environment secret's `updated_at` is `2026-08-31T13:43:28Z`, after the broker App was created (12:59) and the brokers were migrated (13:13). |
| **Ad-hoc branch creation on the hub was unrestricted** | Ruleset `Block ad-hoc branch creation` | `gh api repos/PXL-Digital-Application-Samples/pxl-classroom/rulesets` returns it `active`, target `branch`, rule `creation`, `~ALL` excluding `refs/heads/participating-orgs`, bypass for OrganizationAdmin, the repository role and, since 2026-09-16, the Dependabot app (`Integration` 29110) - exactly as INSTALL.md §3.4 specifies. |

---

