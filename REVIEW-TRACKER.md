# Review tracker, 2026-10-14

Every finding from every review round today, and what happened to it.
Status: **FIXED-462930c** (pushed), **FIXED** (in the commit after 462930c, or the working tree), **OPEN** (being fixed - every one will be), **ASK** (will be built with the recommended option, named here), **REMOVED** (the feature was removed on request: submit tags, 2026-10-14; LESSONS.md has why).

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
| R1-8 | CLI grading's outcome kinds tested only by grepping the source | OPEN (low) |
| R1-9 | A Deadline Sentinel hung after its deadline is flagged only at its 5-hour timeout | OPEN (low) |
| R1-10 | A submit tag held back the "read at" time and kind on Progress | REMOVED |
| R1-11 | Runs stuck in GitHub's `pending` state are watched by nothing | OPEN (low) |
| R1-12 | Stuck-run test derivation weaker than its title | FIXED |
| R1-13 | Students the local runner skips show "Not read yet" with nothing to read them | OPEN (low) |
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
| D12 | Disabled menu rows drop out of keyboard Tab order (every disabled row, not just this one) | OPEN (low) |
| D13 | "Change" left focus behind, unnamed for screen readers | FIXED (+ e2e 109) |
| D14 | ARCHITECTURE: stale tag format, stale §11.7 sync wording; RUNBOOK copy of the tag command | FIXED |
| D15 | ARCHITECTURE carried incident history | FIXED |
| D16 | Docs said "not handed in" where Progress says "No submission" | FIXED |
| D17a | "a result with no points to count" reads like a zero | OPEN (low) |
| D17b | Red card "Nothing handed in by their deadline" when only some are past it | OPEN (low) |
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
| G8b | The dashboard's stuck-run warning also reads one page | OPEN |
| G9 | Stuck limit had no margin for a 45-minute sync | FIXED |
| G11 | Tag command bash-only (PowerShell breaks or writes local time as UTC) | REMOVED |
| G12 | Tests missing: Read score again "run ended" path, per-student deadline cards, watchdog age | OPEN |
| G13a | CLI hand-spelled the summary path | FIXED |
| G13b | CLI reads the summary without `ref`: a stale read refuses | FIXED (read at the head commit) |
| G13c | Refresh classifies on time / late by the Refresh moment, not the commit | FIXED (commit's own time) |
| G13d | Watchdog: a stuck re-run is never alerted (dedup key has no attempt); "Triggered at" beside a different age | OPEN (low) |
| G13e | CLI puts the token in a git remote URL | FIXED (= A10) |
| G13f | Sync status hidden when sync is refused, also hiding an earlier cut-off sync | OPEN (low) |

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
| F4b | With the setting off, a failed full-history copy is never recovered | OPEN (low) |
| F5 | A fast-forward onto a template commit after the deadline reads on time (template dates) | ASK (code fix by push time, or keep the manual's advice to choose "Pushing stops") |
| F6 | Commit count is "minus what was given", not "what they added" | FIXED (docs say what it is) |
| F8 | The reuse recovery (push log actor) has never run against real GitHub | OPEN (live test) |
| F9 | Unit test sends no auth header over file:// | OPEN (low) |
| F10 | Private template's branch names in the public run log | FIXED |
| F11 | No time limit on clone/push | FIXED |
| F12 | Template push workflows run per branch in every student repository | ASK (turn Actions off during the copy, or keep the manual's warning) |

## Round 3: archiving (asked for after round 2)

| # | Finding | Status |
|---|---|---|
| A1 | Archive or Back to draft before the nightly: never locked, preserved, or broker closed | FIXED (finalized whenever students have repositories; Archive question says so; unit) |
| A2 | A partial preservation lets the nightly switch itself off, so the retry never runs | FIXED (owed work counts as active; unit) |
| A3 | A failed preservation reads "not required", which opens Reopen | FIXED (lib/preservation-status.mjs + unit) |
| A4 | A read failure during lockdown loses that student's preservation silently | FIXED (`snapshot_unread` row, read again next pass, shows as failed; unit) |
| A5 | The retry ceiling counts passes, not failures | FIXED (counts only passes that retried owed work; unit) |
| A6 | Archive pushes run the template's workflows in the archive repository | OPEN (verify live) |
| A7 | `block`: a student who pushed only after the deadline reads on time with the starter preserved | OPEN |
| A8 | Submit tags read late after any post-deadline collect, and sent false late notices | REMOVED |
| A9 | Preservation and grading ignore the tag the report calls the submission | REMOVED |
| A10 | CLI `grade` and `download` put the token in a git remote URL (and the Docker sandbox can read it) | FIXED (+ sweep test over every source file) |
| A11 | Preservation banner and "Try again" promise what they do not do | FIXED (counts only students owed a copy; "nothing to archive" said) |
| A12 | Every pass re-pushes everyone, no git time limit, inside a 10-minute job | FIXED (already-archived skipped, time kept; 3-minute limit; real-git test) |
| A13 | An unstarted student's preserved starter is graded (full history: the App's commit has a grading run) | FIXED (no score for No submission + unit) |
| X1 | (found while fixing A13) GitHub's copy that provisioning commits the grading workflow to starts at 2 commits, so every untouched student read "On time" | FIXED (that commit recorded as the start; `full_history` flag separates the two kinds; unit + provisioning test) |
| A14 | Full history: only the default branch is archived | ACCEPTED (documented: the exercise must end on it) |
| A15 | Reopened team rows duplicated per member | OPEN |
| A16 | Deleting a closed, unfinalized assignment loses the deadline snapshot without warning | OPEN |
| A17 | `preserved_submissions` counts students, not archive branches | OPEN (low) |
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
| S6 | Team cleanup log says "somebody's work" where it only saw a second branch | OPEN (low) |
| S7 | The nightly's unrecorded-repository check cannot see a full-history copy | FIXED (found by the template's root commit, `copiedFrom`; script test) |
| S8 | `download` fetches one commit: a git exercise is graded on its history | OPEN (low) |
| S9 | CLI `feedback open` writes back repository records read minutes earlier | FIXED (read again just before, written only onto that version) |
| S10 | The page's feedback PR candidates include untouched repositories; "no commits" counted as failed | FIXED (started rows only; "nothing yet" counted apart) |
| S11 | Author blanking keyed on a recorded start, not the setting | FIXED |
| S12 | Roster CLI commands write back a whole roster read earlier | OPEN (pre-existing) |

### Acceptance, retries, records (done)
| # | Finding | Status |
|---|---|---|
| AC1 | A lecturer's Retry is refused "repository exists" over the student's own repository (refuse policy; team with a lost record) | FIXED (`retriedOwnRepo` reads the set-aside record; frozen still refused; unit) |
| AC2 | = S7 (unrecorded check blind to full-history copies) | FIXED (= S7) |
| AC3 | A switch whose provisioning fails early loses the old team's cleanup for good | OPEN |
| AC4 | A full-history copy still being pushed reads empty, and a switch away deletes it | ACCEPTED (the no-age-guard decision; the failing run says so) |
| AC5 | A team repository's starting commit leaves with the member who carried it | OPEN |
| AC6 | `full_history` read from the assignment at record time, not from what provisioning did | FIXED (provisioning outputs it) |
| AC7 | Full-history copy timings: 15-minute job, short teammate waits | OPEN (low) |
| AC8 | On a switch, "own earlier attempt" comes from the old team's record | OPEN (pre-existing, low) |
| AC9 | Joining a team that no longer exists silently creates it | OPEN (pre-existing, low) |
| AC10 | = S5 / T5b (old names reserved only against lecturer renames) | FIXED (= S5, T5b) |
| AC11 | Comment and workflow header wording out of date | OPEN (low) |
| AC12 | Other git error lines can still carry branch or file names into the public log | OPEN (low) |

### Nightly grader, collector, report (done)
| # | Finding | Status |
|---|---|---|
| GR1 | A tag judged on time erases all late evidence from the branch (status, warning, notice) | REMOVED |
| GR2 | Docs still promise a server-side time for tags | REMOVED |
| GR3 | The row's commit date depends on directory order now that tag observations carry one | REMOVED (the report reads snapshots only; unit) |
| GR4 | A re-pointed tag (`git tag -f`) resolves to its oldest commit | REMOVED |
| GR5 | Grading reads the tagged commit even when the tag is late or off the branch | REMOVED |
| GR6 | A template with more than ~1000 commits stops hand-in grading for every student | OPEN (was R1-14, accepted; now has a fix) |
| GR7 | A dialog suggests Sync Starter Code on an assignment that refuses it | OPEN (low) |
| GR8 | One deleted repository can block the whole nightly grading summary | OPEN |
| GR9 | A rate-limit 403 on hand-in reads is called a permission problem | OPEN (low) |
| GR10 | Fast-forward onto a prepared branch: late count 0, `block` picks the template commit, count includes merged commits | OPEN (docs) / ASK with F5 |
| GR11 | Stale workflow comment about the scores token | OPEN (low) |

### Student pages, the dashboard, publishing (done)
| # | Finding | Status |
|---|---|---|
| PG1 | One team name holding an email address stops the Pages deploy for every organization (and cannot be undone from the screen) | FIXED (published as its slug; both forms and the rename refuse it; generator + scan test, unit) |
| PG2 | The stale-page rename fix fails in its main case: the student's own attempt drags them into a phantom old-name team | FIXED (`attemptTeamSlug` + unit) |
| PG3 | Student banner: "the tagged commit is graded" is untrue after the deadline | REMOVED |
| PG4 | A submit tag can be pushed after the lock, judged by a date the student sets | REMOVED |
| PG5 | The student's own list never shows a team assignment, then says they accepted nothing | OPEN (pre-existing) |
| PG6 | = G8b (dashboard stuck-run banner reads one page) | OPEN |
| PG7 | Student pages say "Submitted on time" for an untouched repository | OPEN |
| PG8 | Publish preflight knows nothing about full history (branch name rule, workflows in the template) | FIXED (`fullHistoryFindings`: refuses an unusable default branch, warns on workflows; real-run test) |
| PG9 | = T5b / AC10 / S5 | FIXED (= T5b) |
| PG10 | A renamed team's old name can be published although it never was before | OPEN (low) |
| PG11 | A team pattern with `{github_login}` names the first member's repository; pages use the viewer's | ACCEPTED (pre-existing; the editor allows it, rare) |
| PG12 | Whether students see a rename is said only in a toast | OPEN (low) |

### Lockdown and the deadline (done)
| # | Finding | Status |
|---|---|---|
| LD1 | An acceptance started late after the sentinel's stop makes a repository no lock covers | FIXED (the sentinel's stop ends the late-start grace, like the lock record; unit) |
| LD2 | The report calls the tag the submission; lockdown and the archive take the branch | REMOVED |
| LD3 | Tags stay pushable after the deadline under "Pushing stops" | REMOVED (a tag decides nothing now) |
| LD4 | Lockdown rebuilds "as of the deadline" from commit dates even where the sentinel's stop proves the head is the deadline state | OPEN |
| LD5 | A record naming a deleted repository makes the sentinel's stop "fail" for every assignment at that instant; a repository named only by a team file is never locked | OPEN |
| LD6 | Reopening a read-only team repository restores only the member clicked | OPEN (pre-existing) |
| LD7 | Sentinel evidence reads "capped" after a team repository was deleted | OPEN (low) |
| LD8 | Read-only lock re-invites a student whose access was removed | OPEN (pre-existing, low) |
| LD9 | The watchdog may cancel a queued duplicate Deadline Sentinel | OPEN (low, unverified) |
| LD10 | Full-history archive cost not measured against the 10-minute finalize | OPEN (measure live) |
