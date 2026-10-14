# Review tracker, 2026-10-14

Every finding from every review round today, and what happened to it.

## Next, once every item below is closed (asked 2026-10-14)

One phase at a time: a phase starts only when the one before it is done. Scope is everything implemented or touched today, every commit from `462930c` on plus the working tree.

1. **DESIGN.md against every UI file touched today.** List the touched `.vue`, frontend `lib/` and `style.css` files from the diff, read DESIGN.md whole, and check each file against every section that applies (one primary button, tokens only, status from facts, labels not stored values, no doc pointers, menu rows, dialogs, wording). Each miss is a row here, fixed before phase 2.
2. **Testing, for every behaviour touched today.** A table of each change with: its edge cases written out, the unit test that covers each, the e2e that covers it if it shows on screen, and **the live test** that exercised it on the testbed (drill, smoke, or a one-off script under `tests/live/`). A blank cell is a gap to fill, not a note. Live is the column that matters most: a change no live run has exercised is not done.
3. **Documentation, in two parts.** (a) The documents: every fact today's work changed, checked in ARCHITECTURE.md, RUNBOOK.md, ADMIN.md, INSTALL.md, MANUAL.md, CLAUDE.md and LESSONS.md - still true, said once and linked elsewhere, section references still resolving, nothing describing removed behaviour (submit tags above all). (b) The built-in help: every help text, hover, hint and explanation the SPA shows (the contextual help, dialog and form explanations, the student pages), checked against what the code does now.
4. **A review from afar, then close up, last.** As if seeing it for the first time. From afar: read the day's changes as a whole and ask what they add up to, where the reasoning has gaps, and which areas nobody thought about at all (a reader of a changed rule that was never visited, a path no test or drill walks, a case between two features). Close up: area by area, whether an assumption was wrong, whether the logic and the algorithm are right, whether a fix in one place broke a rule somewhere else, best practices, and bugs. Review agents for the areas too large to hold at once (acceptance and provisioning; grading; lockdown, sentinel and archive; the SPA). Every finding a row here, fixed like the rest.

### Phase 1: DESIGN.md against today's UI files (first pass)
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
