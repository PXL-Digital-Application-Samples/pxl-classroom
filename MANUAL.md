# Manual

What each setting does, and what it changes for your students.

## Who may accept

Who is allowed to use the invitation link.

- **Enforced.** Only students you imported, matched by GitHub username. Anyone else is refused. Use this when you have their usernames.
- **Claim.** Only students you imported, matched by the institutional email address they confirm. Use this when you have addresses but not usernames.
- **Open.** Anyone with the link, until the cap is reached. You match them to students afterwards. Needs a **Max acceptances** number; the form will not save without one.

Your roster belongs to the whole course, not to one assignment. Each assignment picks who it is for.

After an open assignment you can [add everyone who accepted](#adding-students-who-accepted) to the roster.

### Good to know

- The check runs on GitHub after the student clicks Accept, not in their browser. A student cannot get in by editing the page.
- Under **Claim** the address is encrypted in the student's browser. Only PXL Classroom can read it.
- Under **Claim**, an address that is not on your roster is refused.

## Who is this assignment for

Under **Enforced** and **Claim**, the form shows your roster and you tick the students this assignment is for.

- **Tick nobody and everyone on the roster can accept.** The form says so on screen. That is the right answer for work the whole course does.
- The chips above the list are **filters**, not the answer. `3A · 20` shows you that section; **Select all shown** ticks what you are looking at. The search box finds a name, a student number or a username.
- **No group** is a filter too, so students you never put in a section are visible and tick like anyone else.
- Mixing is the point. Tick 3A, then tick four more people - that is a remediation or resit cohort, and it needs nothing set up in advance.
- The list is a **snapshot**. A student you import next week is not in an assignment you made today; use **Add students** on the assignment to bring them in.

### Class groups

A class group is a label on a student, and it exists to make that list quick to filter.

- Put one on each student: a `class_group` column in the roster CSV, or the field on **Quick add**. A student is in one group at most.
- To add groups to a roster you already imported: **Roster** tab, **Export CSV**, fill the column in, and import it back.
- Nothing is decided by a group. It narrows the list you pick from, and the assignment remembers which groups you picked from so the overview can say **3A**.

### Good to know

- Under **Open** the roster does not decide who may accept, so there is nothing to pick and the list is not shown.
- Picking more students than **Max acceptances** allows means the ones past the cap are refused. The form warns you before you save.

## Confirming an email address

Only under **Open**, where nobody was imported up front.

- Ticked, a student confirms an address before they can accept.
- The page offers the addresses GitHub already verified for their account. A typed one is accepted and recorded as **unverified**.
- It does not restrict who may accept. Anyone with the link still can. It records **who** accepted, so you can match accounts to students afterwards.
- Off, you get their GitHub username and nothing else.

## Late work

What happens to work pushed after the deadline.

- **Counts.** Late commits are collected and marked late in the report. Nothing is blocked. This is the default.
- **Does not count.** Students can no longer push after the deadline. The submission is the last commit dated before it.

A student with an extension is judged against their own deadline.

### Good to know

- On time or late is decided by the time on the commit, not by when PXL Classroom looked at it.
- That time comes from the student's own computer. Good enough for marking, not proof if a student disputes it.
- The lock can land shortly after the deadline rather than on it. Work pushed in that gap does not count.

## Deadlines and extensions

- An extension moves the deadline for one student. Nothing else about the assignment changes.
- While it runs, that student can keep pushing. Everyone else is locked at the class deadline as normal.
- When it runs out, that student is locked and their work saved, the same as everyone else.
- Grant it before the deadline if you can. Afterwards their work is already locked.

## Archiving

- At the deadline, a copy of every submission is saved to a separate private repository.
- One archive repository per assignment.
- The copy cannot be changed afterwards, by you or by the student.
- Students cannot see it. It survives a student deleting their own repository.
- Each student's copy is a **branch**, so the archive's front page looks empty when you open it. Click the **Branches** tab to see them.
- Deleting the assignment does not delete the archive. Delete it yourself when you retire the course year.

## Group assignments

Whether each student gets their own repository, or a team shares one.

- **Individual.** One repository per student. This is the default.
- **Team.** One repository shared by two or more students. The first member to accept creates it; the others join it.

Choose before you publish. Switching afterwards does not move students who have already accepted.

A **team** is not a **class group**. A team shares one repository for one assignment. A class group is a label on a student that helps you filter the roster when you pick who an assignment is for. Nothing links them.

### Teams only

- Set the maximum team size, and the minimum if you want the report to flag teams that are short.
- **Self-service** lets students form their own teams. **Pre-assigned** means you seed the teams first, and you decide what happens to a student who is in none.
- Teams belong to the assignment, not to your roster, so re-importing a roster cannot wipe them.
- Using the same teams again on a later assignment is a separate step, not automatic. **Seed teams from…** carries them over, and warns you about anyone it carried who this assignment is not for.

## Autograding

Optional. Tests that run against a student's work and give you a score per student. Scores are advisory; nothing is marked for you.

### Who defines the checks

- **They come with my template.** Your template already contains a workflow that grades, and PXL Classroom leaves it alone. Most templates do. You do not list the exercises or their points here.
- **I define them here.** For a template that does not grade itself, or when you need checks students cannot read, or a score per check instead of one total.

### If they come with your template

- The panel says what your template grades on. If it has none, **Add a starter workflow** writes one. Its example check fails until you replace it, so a forgotten placeholder cannot hand out full marks.
- Adding it does not reach students who already accepted. Use **Sync Starter Code** for that.
- If the template grades on different words than the assignment says, the panel says so. The template's wording is the one that decides.
- **On every push.** Scores come from each student's last commit.
- **Only on a hand-in commit.** Scores come from the commit carrying the message you name. Type it exactly as you asked students for it.
- **They may hand in more than once** is on. The last hand-in before the deadline counts, so a student who fixes something and hands in again is graded on the fix. Off, the first one counts.
- A hand-in after the deadline is never graded. That student is listed by name with the time.

### If you define them here

- List each check: a command that must succeed, a command whose output is compared, or a Python script. Each carries its own points.
- **In each student's repo** runs them on every push and shows the student the result.
- **On your machine** writes nothing to student repositories. You run the checks yourself after the deadline against the archived submission.
- Checks in a student's repository are time-limited, so one that never finishes cannot keep running.

### Reading the scores

- Either answer produces a score you pull in with **Read scores from GitHub Actions**, or with the command line.
- A student who pushes something after their hand-in commit still keeps that score.
- A student whose commit has no grading run at all has **no score**, and is listed by name rather than counted as a zero. Nothing ran, so nothing was measured.

## Feedback pull requests

A pull request is GitHub's review page: it shows a set of changes, and you can attach a comment to any line of them. Students get an email for each comment and can reply under it. It is the difference between one mark at the end and remarks on the work itself.

Switched on, each student gets one of these on their own repository, kept as a draft so it is never merged.

- Switch it on when you create the assignment. It cannot be added afterwards.
- A student who has pushed nothing does not get one.
- You open them when you are ready to mark, not at the start.
- Safe to run more than once. Students who already have one are skipped, and a pull request you opened by hand is used rather than duplicated.
- Their work is compared against a frozen copy of the starter code, so the review page shows what the student wrote and not the template.

## Adding students who accepted

- Adds the students who accepted an **open** assignment to your roster.
- Do this so the next assignment can use the roster instead of being open to anyone.
- It only adds. A student already on the roster is left exactly as they are.
- It copies the GitHub username and nothing else. Names and student numbers are not guessed, because a guess would end up in a graded field.
- Safe to run twice. The second time finds nothing to add.
- Available on the **Roster** tab, and on the assignment itself.

### Good to know

- Students added this way are marked as not yet identified, so you can find the rows that still need a real name and number.

## Retiring an assignment

- **Close** stops new students accepting. Nobody's work is touched.
- **Archive** hides the assignment from the dashboard. Everything is kept.
- Neither of them deletes anything.

### Delete

Once an assignment is closed or archived you can delete it. You type its name to confirm.

- **Student repositories are never touched.** Nobody's work is deleted.
- The archive repository is kept, so the submission preserved at the deadline is still there.
- The grades and the report are kept, in `retired/<assignment>/`, with a note of what was removed and by whom.
- Everything else goes: the assignment, its acceptances, observations, repository records, lockdowns, teams and overrides, and its broker repository.
- Only the broker cannot be brought back. The rest stays in the control repository's history.
- To finish retiring a course year, delete the student repositories and the archive repository yourself, once you are sure you need neither.
