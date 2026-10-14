# Review tracker, 2026-10-14

Every finding from every review round today, and what happened to it.

## Next, once every item below is closed (asked 2026-10-14)

One phase at a time: a phase starts only when the one before it is done. Scope is everything implemented or touched today, every commit from `462930c` on plus the working tree.

1. **DESIGN.md against every UI file touched today.** List the touched `.vue`, frontend `lib/` and `style.css` files from the diff, read DESIGN.md whole, and check each file against every section that applies (one primary button, tokens only, status from facts, labels not stored values, no doc pointers, menu rows, dialogs, wording). Each miss is a row here, fixed before phase 2.
2. **Testing, for every behaviour touched today.** A table of each change with: its edge cases written out, the unit test that covers each, the e2e that covers it if it shows on screen, and **the live test** that exercised it on the testbed (drill, smoke, or a one-off script under `tests/live/`). A blank cell is a gap to fill, not a note. Live is the column that matters most: a change no live run has exercised is not done.
3. **Documentation, in two parts.** (a) The documents: every fact today's work changed, checked in ARCHITECTURE.md, RUNBOOK.md, ADMIN.md, INSTALL.md, MANUAL.md, CLAUDE.md and LESSONS.md - still true, said once and linked elsewhere, section references still resolving, nothing describing removed behaviour (submit tags above all). (b) The built-in help: every help text, hover, hint and explanation the SPA shows (the contextual help, dialog and form explanations, the student pages), checked against what the code does now.
4. **A review from afar, then close up, last.** As if seeing it for the first time. From afar: read the day's changes as a whole and ask what they add up to, where the reasoning has gaps, and which areas nobody thought about at all (a reader of a changed rule that was never visited, a path no test or drill walks, a case between two features). Close up: area by area, whether an assumption was wrong, whether the logic and the algorithm are right, whether a fix in one place broke a rule somewhere else, best practices, and bugs. Review agents for the areas too large to hold at once (acceptance and provisioning; grading; lockdown, sentinel and archive; the SPA). Every finding a row here, fixed like the rest.

Where it stands: every item below closed (batch 3 pushed in `0a5739b`, both drills of the day passed, F8 and A6 verified live). Phase 1 done and pushed in `4c8362c`. Phase 2 in progress: four read-only coverage audits, one per area (acceptance and teams; grading and the CLI; lock, sentinel and archive; the screens).

### Phase 2: testing (in progress)

Defects the coverage audits found in the code itself, each verified in the code before it is listed as confirmed. The test gaps they listed are worked through after these, area by area, and the live tests last.

| # | Finding | Status |
|---|---|---|
| P2-1 | CLI `grade` scores a student with nothing handed in: the shared grader refuses "no submission" before reading, the CLI's own paths (Actions, and the local runner) never ask (A13 not reached) | FIXED (confirmed; asked where the shared grader asks it, after a decision and a hand-in marker; unit on both paths) |
| P2-2 | A repository the App cannot see answers 404 like a deleted one, reads "no longer exists" and replaces a stored score (GR8) | FIXED (confirmed; a repository answering 404 is a failed read: named, the cohort not refused, a stored score kept; unit) |
| P2-3 | CLI `grade`: rows carried over for students outside the queue are written without a check of the summary they came from (R1-13) | FIXED (confirmed; a carried row turns on the check, as a kept one does; unit: a newer summary refuses the write) |
| P2-4 | The page's Open feedback PRs writes back whole repository records read during the press, with no check (the S9 defect, fixed in the CLI only) | FIXED (confirmed; the write is refused when a record is not the text read, at the commit it lands on, and the message gives the reason; e2e, the first that presses the button) |
| P2-5 | A rate-limit 403 on check runs, annotations or a dispatched run still reads as a missing permission and refuses the cohort; the CLI's request adapter drops the headers that say rate limit (GR9 half done) | FIXED (confirmed for check runs, the dispatched-run filter and `readRunScore`; annotations already failed as unreadable. The CLI adapter keeps GitHub's message and headers; unit for each) |
| P2-6 | `download --history` into a directory holding an earlier one-commit copy reports it cached and never deepens it (S8) | FIXED (confirmed; a shallow copy is deepened with `--unshallow` when the history is wanted; and a fetched commit other than the preserved one is a failure that says so, where it was never compared; unit) |
| P2-7 | After a failed records save, the feedback PR message says the column shows "Not opened" while the column shows the PR number, set in memory first (P1-4) | FIXED (confirmed; the numbers go on screen only after the save; e2e) |
| P2-8 | `roster` CLI reads the roster by branch name, not at the head commit, so its new check can refuse on a stale read (S12) | FIXED (confirmed; read at the head commit through `readFileAtHead`, which the JSON read now uses too; unit) |
| P2-9 | The CLI has its own `readScoreAtCommit`, answering 404 and 422 differently from the shared one | FIXED (confirmed; the CLI calls the shared reader, and its now-unused annotations wrapper is removed; CLI tests) |
| P2-10 | A cohort read where every read was rate-limited says "Nobody has a score to read yet" instead of "try again" | FIXED (confirmed; students whose read failed are counted apart and told to read again in a few minutes; unit) |
| P2-11 | `cli/tests/grade.test.mjs` swaps `process.stdout.write` while node:test reports, so three of its four results are swallowed | FIXED (confirmed: the runner's results are binary frames on stdout; the capture keeps the command's text and passes them through, in `download.test.mjs` too. Every test now reports by name) |
| P2-12 | Five "Feature 3" tests in `tests/features-archive-banner-feedback.test.mjs` test their own copy of the old feedback-PR rule (`head: "main"`) | FIXED (confirmed, and "Feature 2" did the same for the preservation banner: both removed; the real code is covered by e2e 113, `open-feedback-prs.test.mjs` and `preservation-status.test.mjs`) |
| P2-13 | The credential-in-URL sweep matches only `x-access-token:...@` | FIXED (confirmed; any interpolated or concatenated user part of an `https://` URL, with the patterns tested against the forms they must catch and miss) |
| P2-14 | A student page loaded before a rename follows it once, when the hub answers; if the rebuilt teams file is not live yet it ends on the old repository (T1) | FIXED (confirmed; while the teams file it read is older than the student's attempt, the page keeps polling and following for up to three minutes, and does not time out meanwhile; e2e, fails without the fix) |
| P2-15 | Whether a student's own token can read a repository's push log is unmeasured; if not, both student pages fall back to the commit date (PG7) | FIXED (measured with `tests/live/activity-probe.mjs`, read-only: both drill students' own tokens answer 200 at `read` after the lock, the same entries the lecturer sees; the App-only case was read on real GitHub by the F8 step) |
| P2-16 | Rename refused as "has accepted" for every member while the report has no rows (open enrolment before anyone accepts), on the page and at the click | FIXED (confirmed; Rename counts only a report row that says so, and the acceptance records read at the click; move and delete keep the cautious answer; e2e both ways) |
| P2-17 | The delete dialog says "The archive is kept" when the lock record could not be read, and while it is still being read (fails open) | FIXED (confirmed; the dialog shows what the reads found: checking, could not be read, nobody to archive, nothing archived yet, some not archived, or kept; e2e for each) |
| P2-18 | Create Team on the Teams tab writes without reading again at the click, over a team file made meanwhile | FIXED (confirmed; the teams are read again at the click, so a name renamed away since stays that team's, and the file is written as new, so GitHub refuses it if it exists; e2e both) |
| P2-19 | Copy teams prints the skip reason `renamed-away` raw | FIXED (confirmed; the words live beside the planner, `SEED_SKIP_REASONS`, the dialog imports them, and a test derives every reason the planner writes from its source) |
| P2-20 | A retry of GitHub's copy whose first run failed before the grading workflow was added adds it and records no start, so the student reads 2 commits, "On time" (X1 on retry) | FIXED (confirmed; that commit is the start where the commit under it is GitHub's generated one, `generatedFromTemplate`; over anything else nothing is recorded; unit, fails without the fix) |
| P2-21 | A reused full-history copy adopts the template's own `pxl-baseline` branch as the feedback baseline (S2 on reuse) | FIXED (confirmed; on a copy this system pushed, a baseline branch at the template's own branch of that name is the template's; one an earlier run made is adopted; an unreadable template adopts nothing; unit both ways, fails without the fix) |
| P2-22 | `tests/portal-logic.test.mjs` tests its own copy of the student home's matching, which PG5 changed | FIXED (confirmed; the matching moved to `frontend/src/lib/student-assignments.js`, which the page and the test both import; team, invitation, other-org and specific-rival cases added) |
| P2-23 | The drill's step 9 reports "the retry log says nothing" where the log now says the repository is the attempt's own (AC1 wording) | FIXED (confirmed; that line is read as what it is, a locked repository handed back) |
| P2-24 | "without the setting, GitHub's copy is used and nothing is recorded" never checks that nothing was recorded | FIXED (confirmed; retitled to what it can show, with no start output asserted; the recording case is `provision-injected-start.test.mjs`) |
| P2-25 | Archived or back to draft BEFORE its deadline with students in it: the nightly's active count reads published and closed only, so it can switch itself off, and the sentinel skips it: never locked, archived or closed (A1 half done) | FIXED (confirmed; the queue and the count ask one predicate, `mayHaveStudents`; unit. The sentinel half is DECIDED, recommended option: the nightly locks it after the deadline, and under Pushing stops lockdown rebuilds the deadline state, so nothing pushed late counts; the Archive question now says "by the nightly check rather than at the instant". Arming would cost a read per assignment on every poll) |
| P2-26 | A deleted repository fails the sentinel's stop for every assignment at that instant on the repository-ruleset and demotion paths (LD5 fixed for the organization ruleset only) | FIXED (confirmed; after a failed lock, a 404 by id is gone where the installation sees every repository, and stays a missed stop under "Only select repositories"; unit on all three paths, fails without the fix; live with the next `--repo-lock` drill) |
| P2-27 | A repository created after the sentinel's stop (a Retry) has HEAD read as the deadline state, though no stop covered it (LD4) | FIXED (confirmed; the stop counts only for a repository that existed at it, by GitHub's `created_at`: otherwise rebuilt as of the deadline, and locked at this run, not at the stop; unit, fails without the fix) |
| P2-28 | A reopened student with nothing frozen reads "failed" preservation, so the banner offers Try again (A3 with A15) | FIXED (confirmed; Reopen refuses failed and pending rows, so a reopened row with nothing frozen owed nothing: not-required; unit) |
| P2-29 | Reopen re-invites a team member the lock found gone or a lecturer removed (LD6 without LD8's presence check) | FIXED (confirmed; a teammate the presence check calls gone is not re-invited, the student clicked is restored whatever, an unreadable answer restores; unit) |
| P2-30 | The delete dialog says the archive is kept when the lock ran but preservation failed for some (A16) | FIXED (confirmed; locked, it counts the report's pending and failed rows and names how many; e2e) |
| P2-31 | A pass that reads an unread snapshot again stamps `lockdown_at` with its own clock, dropping the first (A4) | FIXED (confirmed; a row locked with an unread snapshot keeps its first lock time; unit, fails without the fix) |
| P2-32 | A lecturer's Retry after the sentinel's stop provisions a repository no stop covers (LD1, the window bypass) | DECIDED (recommended option: allowed, as a lecturer's deliberate act. With P2-27 nothing pushed after the deadline counts under Pushing stops, and the finalize locks it; refusing would leave a student the lecturer meant to let in with nothing) |
| P2-33 | The dashboard's stuck-run banner throws away whether every page was read, so a failed page shows nothing (G8b) | FIXED (confirmed; a list not read whole shows a quiet line with Diagnostics; e2e) |
| P2-34 | A failed close-acceptance step is not owed work, so no finalize pass retries it and the key can stay on the broker | FIXED (confirmed; the step records what it did, `broker-closed.json`, and the nightly queues a pass while acceptance is open or the key is on, up to the ceiling; a 404 on the variable is closed and the key still comes off, where it used to stop with the key left on; unit; existing brokers checked live with broker-hygiene) |
| P2-35 | The drill's demotion check reads the lock row, never the student's permission on GitHub, so it cannot fail (LD8) | FIXED (the drill reads `collaborators/<login>/permission` and expects read; live with the next drill) |
| P2-36 | The A6 unit test never asserts the `{enabled:false}` body, and the drill never checks the archive's Actions | FIXED (the body is asserted, also on the pass that creates the archive; every drill reads the archive's Actions and the broker-closed record) |
| P2-37 | The LD7 test's "an unreadable listing keeps what it had" half cannot fail: an empty set takes no sample | FIXED (a sample for every poll is asserted) |
| P2-38 | (found fixing P2-33) The dashboard read hub write access only when the organization's control repository could not be read, so its stuck-run banner never showed over a working course | FIXED (one read of the hub's permission after a normal load; e2e, fails without the fix) |
| P2-39 | (found by the full e2e run) The P2-14 fix waited up to three minutes on a run GitHub stopped, so a team join that did not go through said so three minutes late | FIXED (only a run that succeeded and left no answer can have put the student in a renamed team; a stopped or undelivered one says so at once; e2e 92) |
| P2-40 | (found by the full unit run) The test that the CLI words an unscored run like the hub grepped for a call the CLI no longer makes, since it now reads through the hub's own reader | FIXED (the test asserts the CLI imports the shared reader and parses nothing itself) |
| P2-41 | (found checking P2-34 live) Six assignments were finalized before `close-acceptance.mjs` existed (2026-09-03, 22:51), and the nightly's comment said every older broker was closed. Four are confirmed closed; the two `test-opdracht` brokers (PXL-2TIN-CloudEssentials-2627, PXL-2TIN-DevOps-2627) cannot be read with tomcoolpxl's token, a member there, and no nightly ever closed them. Every finalize since then closed its broker (136 nightly logs: 93 closed, one broker already deleted) | OPEN (the comment is corrected. Needs an admin of each of those two orgs: delete the test assignment in the Admin Panel, which removes the broker, or on the broker repository set `INVITE_ENABLED` to `false` and delete `PXL_BROKER_PRIVATE_KEY`) |
| P2-42 | (found reading a failed run, 2026-10-14 19:21) GitHub refused an App token for a moment, and the steps that run past a failure (`always()`) then failed again over a control checkout that never happened, burying the cause: regeneration, the nightly's collect and finalize, the org-lock migration, feedback PRs | FIXED (each reads its checkout's outcome, `steps.control.outcome == 'success'`, beside `always()` or `!cancelled()`; a new test fails on any `steps.<id>` that is not an earlier step of its job, so a misspelt id cannot silently skip a lock. DECIDED, recommended option: the sentinel is left as it is, because it re-clones its checkout on a handover and one id cannot say whether a directory exists there; gating its evidence commit on the wrong one could drop the timeline) |

### Phase 2: test gaps

From the four coverage audits (grading and the CLI; the screens; acceptance and teams; lock, sentinel and archive). Items the P2 fixes above already closed are left out. Live click-throughs in the pane (the audits' L1-L12) need the user's sign-in and come last.

| # | Gap | Status |
|---|---|---|
| TL-1 | Lockdown, LD4 other cases: a deferred student's expired extension with a done stop reads `?until` at their deadline; a `stop: pending` timeline rebuilds | DONE (unit; both pass as the code stood) |
| TL-2 | Lockdown, LD5 fallback: the org ruleset POST fails after a gone repository is dropped; dropped targets recorded gone, the rest stopped by repository rulesets | DONE (unit. It held, but the log never named the gone repository on that path and closed with "org-ruleset applied to 2 repositories" after the organization ruleset had failed: both now say what happened, per lock, in the log and the stop's summary) |
| TL-3 | Lockdown, A4 read failures: repository object 502 and `?until` 502 give `snapshot_unread` rows, and find-finalizable queues both | DONE (unit for both rows; find-finalizable's own test queues any `snapshot_unread` row) |
| TL-4 | Lockdown, A7 teams: two member records naming one repository, `starter_sha` on one only; a HEAD-path row still at the start | DONE (unit, both members read against the one start. DECIDED, recommended option: a HEAD still at the start is no submission, as the rebuilt path already said; it archived the starter as the student's work. Such a row now keeps its first lock time on a later pass; unit) |
| TL-5 | Preserve, A12 failures: archive ref at another commit, archive unreachable, a git step that hangs | DONE (unit, real git: the other commit is never overwritten and only that student fails; each student fails on their own; a stalled git server is killed by the step limit, `PXL_GIT_STEP_MS` for the test, in provisioning too) |
| TL-6 | Reopen, LD6: a member whose lock row says `permission_after: none` gets no PUT; team e2e; the logins filter testable | DONE (`unlockLogins` in lib/repo-unlock.mjs, which the page calls: a member the lock found with no access is left out even when the live check cannot answer; unit, and e2e 62's team case; `lockdownRowFor` compares logins through lib/github-login.mjs) |
| TL-7 | Provisioning `granted` output: true when the grant ran even if the fill failed; absent at `fail:grant` and in a dry run | DONE (unit through the real script, all three; and the record step writes an individual student's record from it, unit against real git) |
| TL-8 | Sentinel LD7: a blob 404 and a `repositories/<id>/` 404 after every record was removed | DONE (found a gap: GitHub answers 404 for an empty directory, and the sentinel read it as unreadable, so a cohort whose records were all removed was sampled for ever. A 404 while the control repository answers is now no records; a 404 while it does not, and a blob that cannot be read, keep the last set. Unit for each, fails without the fix; the LD7 test's unreadable poll is a 502 now, as it meant) |
| TL-9 | find-finalizable A2/A5: the active count at the ceiling is 0; a pass for an expired extension alone does not count an attempt | OPEN |
| TL-10 | close-acceptance on an archived assignment document still closes the broker and removes the key | DONE (unit: archived, draft and closed all close; the step never reads the state) |
| TL-11 | Watchdog LD9/R1-11: pending runs (a sentinel at 400 min, an acceptance at 60) alert and are never cancelled; an in-progress sentinel at 320 min alerted, not cancelled; replaces the grep | DONE (unit through `runWatchdog`; the grep in the stuck-runs test is replaced by the three surfaces' own tests) |
| TL-12 | acceptance-reserve LD1: a `gave-up:runtime` timeline and `due: false` still give the grace | DONE (unit, real pipeline against a git remote) |
| TL-13 | System Health: a pending-list 502 is `warn`; the watchdog's `capped` includes the pending list; `pagesRedeployDue` counts a pending deploy | DONE (found two gaps: the watchdog did not count a deploy held behind the running one as on its way, so it would dispatch another, and System Health showed nothing at all when no run list could be read. Both fixed; the capped check covers pending and queued; unit for each, fails without the fix; e2e 114 shows a pending run and leaves a sentinel inside its limit out. DECIDED, recommended option: a person may still cancel a stuck sentinel from the dashboard or System Health; only the watchdog never does) |
| TL-14 | e2e: System Health's hub pipeline check (a waiting sentinel offers no Cancel; a partial list warns); the A11 archive banner ("Try again for 1 student", "nothing to archive"); the Archive question's sentence | DONE (e2e 114: Diagnostics says the runs could not all be read, with nothing to cancel; e2e 17: a student owed no copy is not counted, and a cohort with nothing handed in says so with no Try again; e2e 38: the Archive question's sentence. A waiting sentinel's Cancel: see TL-13) |
| TA-1 | Acceptance units, AC3/AC8/AC1: an unreadable repository record gives no `previous_repo`; a switch under explicit reuse with a stranger's repository at the new name is not the student's own; a set-aside record with run id `0` under refuse is refused; direct units for `retriedOwnRepo`, `ownDecisionMadeTeamRepo`, `manifestRepoName` | OPEN |
| TA-2 | CLI `teams seed` / `unseed` run against a stub API, with a target team changed between the prompt and the commit; replaces the grep | DONE (`cli/tests/teams.test.mjs`, against `cli/tests/fake-control.mjs`, a fake control repository with commits and a fast-forward-only ref: a team made at the commit, teams changed between the two plans, a member who accepted before the unseed commit, and a dry run that writes nothing. The CLI half of the grep is gone; the dialog's fork guard stays. The shared guard said "since this page loaded" to the CLI: "since the teams were read" now) |
| TA-3 | F10/F11/AC7 wiring: the success log names no branch; `GIT_STEP_MS` injectable with a stalled git server; `fillWaitChecks` inside `main` without the pin | OPEN |
| TA-4 | PG8: an unreadable branch listing with `feedback_pr` warns; workflows only on a prepared branch (decide, then test) | OPEN |
| TA-5 | PG1: an address in Create Team and in the rename box is refused (e2e); a crafted issue with an address name; a vacant team with a code is published as its slug | OPEN |
| TA-6 | Rename edges: `renamed_from` capped at 20, over 100 characters, the old slug sent as the name only, two renames, an acceptance after the rename; e2e: publish failure, "Renaming...", the refresh after a refusal, a seed after a rename | OPEN |
| TA-7 | S7 with the setting off: a record-level copy is still looked for, or that is written down | OPEN |
| TA-8 | T1 remaining paths: follow on the not-processed path; no follow for a non-member | OPEN |
| TA-9 | Small provisioning branches: injection failing on a copy, a template already shipping `autograding.yml`, PATCH failing on a fresh copy, a push log empty or 100+, `branchHead` / `commitCountAt` unreadable, the writer where `sameRepo` is false; a POST that answers 422 because the name now exists | OPEN |
| TA-10 | R1-5: the "No submission" rule in a lib, a row with `commit_count: 0`, a start and on-time | OPEN |
| TA-11 | S11: the report blanks the author on setting alone (records without `full_history`) | OPEN |
| TA-12 | Commit-time checks in e2e (rename, Undo copy, member save, move): the fixture answers `?ref=`, a click-time read and a later read differ | OPEN |
| TG-1 | CLI G4b/G13b: the stored summary read at the head commit, a 500 keeps the row, "nothing new was read" | OPEN |
| TG-2 | Nightly G4b: an annotations 500 keeps the stored score and says so | OPEN |
| TG-3 | CLI G3/G7, `--login`: a 502 writes nothing; a graded run changes that row only, `graded_by` and `runner` kept | OPEN |
| TG-4 | CLI S9 `feedback open`: a record changed between the list and the write is not overwritten; the 422 adopt path records the PR | DONE (`cli/tests/writes.test.mjs`: opened from `master`, recorded; a record changed at the commit is kept and the PR said to be open and unrecorded; the next run adopts and records it onto the record as it is) |
| TG-5 | CLI S12 `roster import`: the roster changed at the parent refuses, "Nothing was committed" | DONE (same file: a clean import commits; a Roster-tab save at the commit refuses it, and that save stands) |
| TG-6 | G13c: Refresh's on-time / late classification in a lib, with a unit | OPEN |
| TG-7 | Small grading units: R1-8 kinds on CLI rows, `lookup-failed` in `failedReads`, `permissionDenied` on runs and push-log 403, the given walk at its cap, a repository GET 500 | OPEN |
| TG-8 | Grading e2e: G4b on the page; G6 (a newer summary at save, a cancelled run); G5/G7 assertions; Regrade on full history; the pill reset; the nothing-graded message | OPEN |
| TS-1 | T4/D8: `canSwitchTeam` / `switchUntil` in a lib with units; e2e with an extension; the clock crossing the deadline closes the switch line | OPEN |
| TS-2 | PG7 e2e on the team card: a bot-only log reads "No commits pushed"; a 403 falls back as the individual page does | OPEN |
| TS-3 | Student home e2e: only a team invitation; the same name in another org | OPEN |
| TS-4 | Student create-team form: a renamed team not listed, mixed case, Enter while refused sends nothing | OPEN |
| TS-5 | Rename e2e: commit-time refusal, 404 at the click, address label from claims, reserved slug and address, over 100, Cancel focus, Enter-open does not commit, D10 exact text, a stored file failing the schema; `memberEditsPending` in a lib | OPEN |
| TS-6 | PG12 e2e: teams file 500, 404, Update the student pages dispatches, two renamed teams, no invitation secret | OPEN |
| TS-7 | Full-history editor: assignment-doc units, the D3/D4 hints, the notice after a template change, the Autograde hints, Change by exact name, report unreadable fallback, Regrade advice | OPEN |
| TS-8 | Starter sync box: the "some of its students" unit; a row with the setting off; refused stopped and failed states | OPEN |
| TS-9 | D12 rows: Enter and Space on aria-disabled rows, absence checked after a wait, the dimming in light and dark | OPEN |
| TS-10 | Cards: `missingWorkLabel` / `missingWorkTitle` in a lib with units; e2e hover text, "No submission yet", D17a | OPEN |
| TS-11 | Copy teams: the exception path; the footnote wording. Delete dialog: from a draft once published | OPEN |
| TS-12 | Tests that cannot fail: the greps (team-rename both screens, broker-teams, untouched-repo PG7, grade-dispatch GR7, open-feedback-prs S1/S10, AC9); e2e 111 final count, 112 empty issues, 108 D10, 109 Change by substring, 56 which date | OPEN |
| TV-1 | Live: the drill's new checks (P2-34 record, P2-35 permission, P2-36 archive Actions) | DONE (drill-20261014-1858 on the code in `3b531d5`: every check passed, GitHub reading `read` for both students, the archive's Actions off, the broker-closed record written) |
| TV-2 | Live grading drill (`--grades`): nightly scores one student, the other not handed in; CLI `grade`, `--login`; a deleted repository read again | OPEN |
| TV-3 | Live feedback PRs on a `master` template; CLI `feedback open` | OPEN |
| TV-4 | Live `download --history` twice on a full-history drill, no token in `.git/config` | OPEN |
| TV-5 | Live full history on a team: a fast joiner waits for the fill; a switch out; a joiner's start from the team file | OPEN |
| TV-6 | Live rename: stale slug lands in the renamed team, a second rename refused, the old name refused, the teams file has `renamed_from` | OPEN |
| TV-7 | Live `--repo-lock` drill with one repository deleted before the deadline (P2-26) | OPEN |
| TV-8 | Live watchdog: what status a queued sentinel reports; `auto_cancel` cancels nothing | OPEN |
| TV-9 | Live drill assertions: no `starter_sha` after the default retry; a full-history template whose default branch is not `main`; an older start kept, a newer one wins; read the full-history acceptance logs for branch names | OPEN |
| TV-10 | Live PG8 publish: a template with `pxl-baseline` and `feedback_pr` fails with the error; one with a workflow warns | OPEN |
| TV-11 | Live S7: remove one drill record, the nightly lists the repository, restore it | OPEN |
| TV-12 | Read-only on PXL-Automation-II: an in-memory cohort read diffed against the stored summary, nothing written | OPEN |
| TV-13 | Pane click-throughs L1-L12 (rename, stale page, switch line, PG7, student home, create form, full-history editor, sync refused, delete dialog, aria-disabled rows, cards, Copy teams) | OPEN (needs the user's sign-in) |

### Phase 1: DESIGN.md against today's UI files (done)
| # | Finding | Status |
|---|---|---|
| P1-1 | Delete dialog says "the nightly", a word only this codebase uses | FIXED ("the nightly check", as the Organization tab says it) |
| P1-2 | Copy teams: a failed write is said only in a toast (§1.5) | FIXED (said in the dialog until the next press or another source, and the plan is read again; a changed plan likewise. The skip reason now says "with members or a repository", as the planner decides; e2e) |
| P1-3 | Rename team: a schema refusal prints the validator's raw `instancePath` and message | FIXED (every refusal a typed name can cause is worded by the planner; this one says it is about the stored file and who to tell, the details go to the console) |
| P1-4 | Open feedback PRs: failures, "nothing to review yet" and a records save that failed are said only in toasts, without naming who; the column shows a failed student as "pending" like one with nothing to review (§1.5) | FIXED (the column is worked out from facts: handed in with no PR is "Not opened", nothing past the start is a dash that says so on hover; it also covers a failed press, after a refresh too, and the records-failed message points at it; e2e) |
| P1-5 | "control repository" in lecturer-facing errors (the editor's save, feedback PRs) | ACCEPTED (it names a real repository in the lecturer's organization, which setup creates and the Organization tab links by that name) |
| P1-6 | DESIGN.md §4's missing-work rule does not describe the "N past their deadline" label added today | FIXED |
| P1-7 | DESIGN.md §7 still budgets a "Submit tag" column, removed today | FIXED |
| P1-8 | The full-history sync refusal is worded four ways (menu row, sync box, editor notice, grading dialog) | FIXED (one phrase, "given the template with its full history", and "students in it" where some or all may hold such a copy; e2e updated) |

Status: **FIXED-462930c** (pushed), **FIXED** (in the commit after 462930c, or the working tree), **OPEN** (being fixed - every one will be), **ASK** (will be built with the recommended option, named here), **REMOVED** (the feature was removed on request: submit tags, 2026-10-14; LESSONS.md has why), **DECIDED** (an ASK item: the recommended option is what stands, named with why), **ACCEPTED** (left as it is, with the reason: a fix would cost more than the defect, or make it worse).

## Round 1: first review of the week's work (fixes pushed in 462930c)

| # | Finding | Status |
|---|---|---|
| R1-1 | Emptied-team cleanup never worked: acceptance token lacked Contents: read | FIXED-462930c |
| R1-2 | System Health had its own stuck-run rule, offered to cancel the Deadline Sentinel | FIXED-462930c |
| R1-3 | Team cleanup could remove a repository by the pattern's name | FIXED-462930c |
| R1-4 | Rename: no re-check at the commit; old slug not kept | FIXED-462930c |
| R1-5 | Full history: failed first run lost the starting commit; move carried it; submit/ tags copied; sync not refused per record; 0 commits read as No submission | FIXED-462930c |
| R1-6 | Grading: Read score again kept a finished "Being graded" row; cards not per student deadline; long read called "read again"; `grade --login` wiped everyone | FIXED-462930c |
| R1-7 | Tagged submissions never worked (colons in tag name) | REMOVED |
| R1-8 | CLI grading's outcome kinds tested only by grepping the source | FIXED (the CLI test reads the kinds off the summary it commits) |
| R1-9 | A Deadline Sentinel hung after its deadline is flagged only at its 5-hour timeout | ACCEPTED (a sentinel waits again for a deadline moved during its watch, so "past its instant" is not a stuck signal: an earlier flag would repeat the 2026-10-12 false alarm on exam day, which is worse than a late one) |
| R1-10 | A submit tag held back the "read at" time and kind on Progress | REMOVED |
| R1-11 | Runs stuck in GitHub's `pending` state are watched by nothing | FIXED (read by the watchdog, System Health and the dashboard; a pending run may wait as long as the run ahead of it; alerted, never auto-cancelled; unit) |
| R1-12 | Stuck-run test derivation weaker than its title | FIXED |
| R1-13 | Students the local runner skips show "Not read yet" with nothing to read them | FIXED (every report student keeps the row on record or gets one saying why; unit) |
| R1-14 | A template over ~1000 commits cannot be read for hand-ins | ACCEPTED (documented in the manual) |
| R1-15 | Template commits merged in from a prepared branch count as the student's | ACCEPTED (documented in the manual) |

## Round 2: second review, of this session's work and its fixes (4 reviewers)

### Screens and docs against DESIGN.md
| # | Finding | Status |
|---|---|---|
| D1 | Student page still read only the colon tag format | REMOVED |
| D2 | Editor offered Sync Starter Code from the checkbox alone | FIXED (+ e2e 109) |
| D3 | "Only the default branch is locked" true for one deadline choice only | FIXED |
| D4 | Submission ref hint: jargon, partly untrue | FIXED |
| D5 | Rename threw away unsaved member edits | FIXED (+ e2e 108) |
| D6 | "while the assignment is accepting" (student-facing jargon) | FIXED |
| D7 | Full-history list written twice (MANUAL, RUNBOOK), already drifted | FIXED (RUNBOOK points at the manual) |
| D8 | Team card countdown text and colour on different clocks | FIXED |
| D9 | AutogradeModal "keep their copy :" | FIXED |
| D10 | Rename error said "Nothing was changed" twice | FIXED |
| D11 | Disabled Sync row: wording, and wrong when only some students have a copy | FIXED (+ e2e 109) |
| D12 | Disabled menu rows drop out of keyboard Tab order (every disabled row, not just this one) | FIXED (rows unavailable for a standing reason are `aria-disabled` with a guarded click; busy rows keep `disabled`; DESIGN.md §3; e2e focus + click checks) |
| D13 | "Change" left focus behind, unnamed for screen readers | FIXED (+ e2e 109) |
| D14 | ARCHITECTURE: stale tag format, stale §11.7 sync wording; RUNBOOK copy of the tag command | FIXED |
| D15 | ARCHITECTURE carried incident history | FIXED |
| D16 | Docs said "not handed in" where Progress says "No submission" | FIXED |
| D17a | "a result with no points to count" reads like a zero | FIXED ("graded by checks that carry no points: that result is pass or fail, not a score"; e2e) |
| D17b | Red card "Nothing handed in by their deadline" when only some are past it | FIXED (both cards say "N past their deadline" when only some are, and the hover says the rest are not due yet; e2e) |
| D17c | "a team file called X" (jargon) | FIXED |
| D18 | Rename preview spelled the repository name itself | FIXED (lib/repo-name.mjs, every copy) |
| D19 | Focus lost after Cancel; blocker named members by @login not address | FIXED |

### Grading and progress
| # | Finding | Status |
|---|---|---|
| G1 | = D1 | REMOVED |
| G2 | Observation schema rejected every tag; tag write not validated | REMOVED |
| G3 | `grade --login` replaced a stored score with a failed read | FIXED (one rule: oneReadReplaces) |
| G4a | A cohort read where every read was refused (403) said "Nobody has a score yet" | FIXED |
| G4b | In a cohort read, a failed read replaces that student's earlier score | FIXED (`keepStoredOnFailedReads` in the page, the nightly and the CLI; the page now merges against the summary on record; unit) |
| G5 | "Their earlier score was removed" when there was none | FIXED |
| G6 | Read score again decided from the page's copy, wrote onto a newer one | FIXED |
| G7 | "Scores read by @X" could name the wrong person | FIXED (cohort reader kept) |
| G8a | System Health judged "no stuck runs" from one page | FIXED |
| G8b | The dashboard's stuck-run warning also reads one page | FIXED (`listRunsInStatus` walks every page; unit) |
| G9 | Stuck limit had no margin for a 45-minute sync | FIXED |
| G11 | Tag command bash-only (PowerShell breaks or writes local time as UTC) | REMOVED |
| G12 | Tests missing: Read score again "run ended" path, per-student deadline cards, watchdog age | FIXED (e2e: a "Being graded" row read again after its run was cancelled takes the new answer and leaves the rest; e2e: both cards with one student extended; the watchdog's age from this attempt's start was covered with G13d) |
| G13a | CLI hand-spelled the summary path | FIXED |
| G13b | CLI reads the summary without `ref`: a stale read refuses | FIXED (read at the head commit) |
| G13c | Refresh classifies on time / late by the Refresh moment, not the commit | FIXED (commit's own time) |
| G13d | Watchdog: a stuck re-run is never alerted (dedup key has no attempt); "Triggered at" beside a different age | FIXED (key per attempt; "Started at" this attempt; unit) |
| G13e | CLI puts the token in a git remote URL | FIXED (= A10) |
| G13f | Sync status hidden when sync is refused, also hiding an earlier cut-off sync | FIXED (the box stays and says why; no Sync again, no advice to run it, no warning tone; unit + e2e) |

### Teams
| # | Finding | Status |
|---|---|---|
| T1 | Page loaded before a rename waited for the old repository | FIXED (+ e2e 111) |
| T2 | Fast switch from a mistaken team left an orphan repository and a vacant team | FIXED (+ unit) |
| T3 | Undo copy, member save, move re-applied stale reads | FIXED (lib/team-write-guard.mjs) |
| T4 | "Switch until" used the student's extension; the hub uses the deadline | FIXED |
| T5a | Lecturer could create a team with a renamed team's old name | FIXED (+ e2e 108) |
| T5b | A student page / the hub still let a stranger create a team under a renamed team's old name | FIXED (the page refuses and names the team; the hub refuses `rejected:team-name-renamed`; unit + e2e 112) |
| T6 | Rename's commit check inline in the component, untested | FIXED (lib + unit) |
| T7 | Rename: success toast after a failed publish; no "Renaming…"; no refresh after refusal | FIXED |
| T8 | Repository name spelled in three places, different fallbacks | FIXED |
| T9 | Explicit `existing_repo_policy: reuse` on a team (CLI/hand-edit only) can name another assignment's untouched repository | ACCEPTED (not reachable from the editor) |

### Full-history copies
| # | Finding | Status |
|---|---|---|
| F1 | Reused copy: grading workflow and baseline went to the wrong default branch | FIXED (+ unit) |
| F2 | Record kept an older starting commit over a newer certain one; team records disagreed | FIXED (+ unit) |
| F3a | Starting commit read back from GitHub, a failed read recorded nothing | FIXED (taken from what was pushed) |
| F3b | Recovery on a reuse only when nobody but the App pushed | ACCEPTED (the only certain case) |
| F4a | A GitHub copy could be taken for a full-history copy | FIXED (+ unit) |
| F4b | With the setting off, a failed full-history copy is never recovered | FIXED (recovered whenever nobody but the App pushed, whatever the setting; real-git test) |
| F5 | A fast-forward onto a template commit after the deadline reads on time (template dates) | DECIDED (recommended option: the manual's advice to choose "Pushing stops", which the lock makes true; LD4 keeps HEAD after a confirmed stop. Classifying by push time would need every push's log entry for every student at every report) |
| F6 | Commit count is "minus what was given", not "what they added" | FIXED (docs say what it is) |
| F8 | The reuse recovery (push log actor) has never run against real GitHub | FIXED (live: drill-20261014-1658 strips the second student's start and retries before they push; GitHub's push log names only the App, and the run logged "only PXL Classroom has pushed to it: starts at 103ca3f (2 commits)"; the first student's retry after a push is the other side. A step of every `--full-history` drill now) |
| F9 | Unit test sends no auth header over file:// | FIXED (the copy runs over git's own smart HTTP, `git http-backend`, which answers 401 without the token's header; a wrong token fails at once in our words) |
| F10 | Private template's branch names in the public run log | FIXED |
| F11 | No time limit on clone/push | FIXED |
| F12 | Template push workflows run per branch in every student repository | DECIDED (recommended option: warn, at publish now as well as in the manual (PG8). Turning Actions off during the copy would also stop a workflow the exercise relies on, and the App's own grading workflow) |

## Round 3: archiving (asked for after round 2)

| # | Finding | Status |
|---|---|---|
| A1 | Archive or Back to draft before the nightly: never locked, preserved, or broker closed | FIXED (finalized whenever students have repositories; Archive question says so; unit) |
| A2 | A partial preservation lets the nightly switch itself off, so the retry never runs | FIXED (owed work counts as active; unit) |
| A3 | A failed preservation reads "not required", which opens Reopen | FIXED (lib/preservation-status.mjs + unit) |
| A4 | A read failure during lockdown loses that student's preservation silently | FIXED (`snapshot_unread` row, read again next pass, shows as failed; unit) |
| A5 | The retry ceiling counts passes, not failures | FIXED (counts only passes that retried owed work; unit) |
| A6 | Archive pushes run the template's workflows in the archive repository | FIXED (Actions turned off on the archive every pass; unit; live: drill-20261014-1658's archive answers `enabled: false` with no runs, where drill-20261014-1358's, made before the fix, answers `enabled: true`) |
| A7 | `block`: a student who pushed only after the deadline reads on time with the starter preserved | FIXED (a deadline snapshot still at the start is `no_submission`; unit) |
| A8 | Submit tags read late after any post-deadline collect, and sent false late notices | REMOVED |
| A9 | Preservation and grading ignore the tag the report calls the submission | REMOVED |
| A10 | CLI `grade` and `download` put the token in a git remote URL (and the Docker sandbox can read it) | FIXED (+ sweep test over every source file) |
| A11 | Preservation banner and "Try again" promise what they do not do | FIXED (counts only students owed a copy; "nothing to archive" said) |
| A12 | Every pass re-pushes everyone, no git time limit, inside a 10-minute job | FIXED (already-archived skipped, time kept; 3-minute limit; real-git test) |
| A13 | An unstarted student's preserved starter is graded (full history: the App's commit has a grading run) | FIXED (no score for No submission + unit) |
| X1 | (found while fixing A13) GitHub's copy that provisioning commits the grading workflow to starts at 2 commits, so every untouched student read "On time" | FIXED (that commit recorded as the start; `full_history` flag separates the two kinds; unit + provisioning test) |
| A14 | Full history: only the default branch is archived | ACCEPTED (documented: the exercise must end on it) |
| A15 | Reopened team rows duplicated per member | FIXED (one row per member record; a reopened row with no snapshot is not a preservation error; unit) |
| A16 | Deleting a closed, unfinalized assignment loses the deadline snapshot without warning | FIXED (the dialog says nothing was archived when students hold repositories and no lock ran; e2e 59) |
| A17 | `preserved_submissions` counts students, not archive branches | FIXED (distinct `archive_ref`; unit) |
| A18 | Submit-tag discovery reads one page | REMOVED |

## Round 4: everything else today's work touches

Five reviewers, one per area not yet reviewed against today's changes.

### Feedback pull requests, the CLI, the roster harvest (done)
| # | Finding | Status |
|---|---|---|
| S1 | Every feedback PR surface hard-codes `main`, not the submission branch (a `master` template fails; a full-history `develop` template with a `main` branch opens a PR of template commits for every student) | FIXED (`submissionBranch` on all three surfaces; real-run test) |
| S2 | A template branch named like the feedback baseline is adopted and protected as the baseline | FIXED (publish refuses it; provisioning never adopts one its copy brought; real-git test) |
| S3 | CLI `teams unseed` has no commit check (the Teams tab's fix did not reach it) | FIXED (`unseedRefusalAt` at the commit) |
| S4 | CLI `teams seed` neither re-plans nor checks its commit; a seed overwrites a vacant team that holds work | FIXED (planned again; `seedRefusalAt` in the CLI and Copy teams; a team with a repository is kept; unit) |
| S5 | Seeding can create a team under a renamed team's old name | FIXED (`planSeed` keeps the old name with the renamed team, and says so; unit) |
| S6 | Team cleanup log says "somebody's work" where it only saw a second branch | FIXED (says what was established) |
| S7 | The nightly's unrecorded-repository check cannot see a full-history copy | FIXED (found by the template's root commit, `copiedFrom`; script test) |
| S8 | `download` fetches one commit: a git exercise is graded on its history | FIXED (whole history for a full-history row or `--history`; and the command, never run by a test, could not have worked: wrong `getReport` arguments and the token object as the git credential, both fixed; real-run test) |
| S9 | CLI `feedback open` writes back repository records read minutes earlier | FIXED (read again just before, written only onto that version) |
| S10 | The page's feedback PR candidates include untouched repositories; "no commits" counted as failed | FIXED (started rows only; "nothing yet" counted apart) |
| S11 | Author blanking keyed on a recorded start, not the setting | FIXED |
| S12 | Roster CLI commands write back a whole roster read earlier | FIXED (one guarded writer; refused when the roster changed since it was read; unit) |

### Acceptance, retries, records (done)
| # | Finding | Status |
|---|---|---|
| AC1 | A lecturer's Retry is refused "repository exists" over the student's own repository (refuse policy; team with a lost record) | FIXED (`retriedOwnRepo` reads the set-aside record; frozen still refused; unit) |
| AC2 | = S7 (unrecorded check blind to full-history copies) | FIXED (= S7) |
| AC3 | A switch whose provisioning fails early loses the old team's cleanup for good | FIXED (the next attempt finishes it from the record naming the old repository; unit) |
| AC4 | A full-history copy still being pushed reads empty, and a switch away deletes it | ACCEPTED (the no-age-guard decision; the failing run says so) |
| AC5 | A team repository's starting commit leaves with the member who carried it | FIXED (kept on the team's file; carried from it by the writer and a Teams-tab move; unit) |
| AC6 | `full_history` read from the assignment at record time, not from what provisioning did | FIXED (provisioning outputs it) |
| AC7 | Full-history copy timings: 15-minute job, short teammate waits | FIXED (a teammate waits until the copy's own limit has passed since creation, inside the ten-minute window and the job's fifteen; unit) |
| AC8 | On a switch, "own earlier attempt" comes from the old team's record | FIXED (only an attempt into the same team; unit) |
| AC9 | Joining a team that no longer exists silently creates it | ACCEPTED (the refusal was built and reverted the same day: the page offers a team from its creator's request before the hub saves it, so "no file" is also "not saved yet", and the refusal turned away the teammate in every rush - the full suite's race tests caught it. A removed team made again shows on the Teams tab; a renamed one's old name is still refused. Unit pins the decision) |
| AC10 | = S5 / T5b (old names reserved only against lecturer renames) | FIXED (= S5, T5b) |
| AC11 | Comment and workflow header wording out of date | FIXED (`repo-name.mjs` comment; retry workflow header) |
| AC12 | Other git error lines can still carry branch or file names into the public log | FIXED (`gitCopyFailure`: the cause in our words, never git's lines; real-git test) |

### Nightly grader, collector, report (done)
| # | Finding | Status |
|---|---|---|
| GR1 | A tag judged on time erases all late evidence from the branch (status, warning, notice) | REMOVED |
| GR2 | Docs still promise a server-side time for tags | REMOVED |
| GR3 | The row's commit date depends on directory order now that tag observations carry one | REMOVED (the report reads snapshots only; unit) |
| GR4 | A re-pointed tag (`git tag -f`) resolves to its oldest commit | REMOVED |
| GR5 | Grading reads the tagged commit even when the tag is late or off the branch | REMOVED |
| GR6 | A template with more than ~1000 commits stops hand-in grading for every student | ACCEPTED (= R1-14, documented in the manual. The fix changes the hand-in walk, which the graded exam path now also reads `given` through (X1), for a template size no course has; it fails closed - "could not finish counting" - and grades nobody wrongly) |
| GR7 | A dialog suggests Sync Starter Code on an assignment that refuses it | FIXED (`gradeEntryMissing({ canSync })`; unit) |
| GR8 | One deleted repository can block the whole nightly grading summary | FIXED (a gone repository is a named student; unit) |
| GR9 | A rate-limit 403 on hand-in reads is called a permission problem | FIXED (`isRateLimited` on the hand-in reads; unit) |
| GR10 | Fast-forward onto a prepared branch: late count 0, `block` picks the template commit, count includes merged commits | FIXED (docs: ARCHITECTURE and the manual say all three; decided with F5) |
| GR11 | Stale workflow comment about the scores token | FIXED |

### Student pages, the dashboard, publishing (done)
| # | Finding | Status |
|---|---|---|
| PG1 | One team name holding an email address stops the Pages deploy for every organization (and cannot be undone from the screen) | FIXED (published as its slug; both forms and the rename refuse it; generator + scan test, unit) |
| PG2 | The stale-page rename fix fails in its main case: the student's own attempt drags them into a phantom old-name team | FIXED (`attemptTeamSlug` + unit) |
| PG3 | Student banner: "the tagged commit is graded" is untrue after the deadline | REMOVED |
| PG4 | A submit tag can be pushed after the lock, judged by a date the student sets | REMOVED |
| PG5 | The student's own list never shows a team assignment, then says they accepted nothing | FIXED (any name the team pattern makes, a more specific assignment winning; e2e 14) |
| PG6 | = G8b (dashboard stuck-run banner reads one page) | FIXED (= G8b) |
| PG7 | Student pages say "Submitted on time" for an untouched repository | FIXED (push log / generated head, `personPushed`; unit + e2e 11) |
| PG8 | Publish preflight knows nothing about full history (branch name rule, workflows in the template) | FIXED (`fullHistoryFindings`: refuses an unusable default branch, warns on workflows; real-run test) |
| PG9 | = T5b / AC10 / S5 | FIXED (= T5b) |
| PG10 | A renamed team's old name can be published although it never was before | ACCEPTED (the old slugs are what a page loaded before the rename needs; never-published is a rename within minutes of creating the team, before any rebuild; they are slug-shaped, behind the invitation digest, and a name with an address is now refused (PG1). Telling the two cases apart would need the generator to remember what it published) |
| PG11 | A team pattern with `{github_login}` names the first member's repository; pages use the viewer's | ACCEPTED (pre-existing; the editor allows it, rare) |
| PG12 | Whether students see a rename is said only in a toast | FIXED (a line on the Teams tab, worked out from the teams file the student site serves against the stored teams, with Check again and Update the student pages; unit + e2e) |

### Lockdown and the deadline (done)
| # | Finding | Status |
|---|---|---|
| LD1 | An acceptance started late after the sentinel's stop makes a repository no lock covers | FIXED (the sentinel's stop ends the late-start grace, like the lock record; unit) |
| LD2 | The report calls the tag the submission; lockdown and the archive take the branch | REMOVED |
| LD3 | Tags stay pushable after the deadline under "Pushing stops" | REMOVED (a tag decides nothing now) |
| LD4 | Lockdown rebuilds "as of the deadline" from commit dates even where the sentinel's stop proves the head is the deadline state | FIXED (a confirmed stop covering the student reads HEAD; unit) |
| LD5 | A record naming a deleted repository makes the sentinel's stop "fail" for every assignment at that instant; a repository named only by a team file is never locked | FIXED (a gone repository is not a missed stop; a run that failed after the grant writes the student's record, `granted`; unit) |
| LD6 | Reopening a read-only team repository restores only the member clicked | FIXED (every member with a lock row on that repository is restored; unit) |
| LD7 | Sentinel evidence reads "capped" after a team repository was deleted | FIXED (each poll samples what the records name now; an unreadable listing keeps the last set; unit) |
| LD8 | Read-only lock re-invites a student whose access was removed | FIXED (a student with no access is skipped, an unreadable answer still demotes; unit) |
| LD9 | The watchdog may cancel a queued duplicate Deadline Sentinel | FIXED (a sentinel is never auto-cancelled, only alerted; unit) |
| LD10 | Full-history archive cost not measured against the 10-minute finalize | ACCEPTED (measured: preserve fetches each student's whole history into a fresh repository for every kind of copy, so a full-history copy costs only its longer history. drill-20261014-1358: 2.5 s per full-history student; PXL-Automation-II pe1, 2026-10-12: 38 students in 62 s, 1.6 s each. The 10-minute job holds a few hundred students at either rate, and each git step has its own 3-minute limit) |
