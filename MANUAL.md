# Manual

What each setting does, and what it changes for your students.

## How the pieces fit

- **Roster** - every student you teach. There is one roster per organization, and everything else refers to it.
- **Class group** - a label on a student, such as `3A`. Use it to filter the roster when you are picking students.
- **Cohort** - the students one assignment is for, picked from the roster.
- **Team** - students who share a repository on one assignment. Use **Copy teams from...** to reuse teams on a later assignment.

A class group helps you find students on the roster. A team gives students a shared repository. They are not related.

## Who may accept

Two questions, under **Students** on the assignment.

**Who may accept**

- **Anyone with the link**, until the cap is reached. Needs a **Max acceptances** number; the form will not save without one.
- **Only students on the roster.** Anyone else is refused.

**When accepting, students**

- **confirm their {{institution_short}} email address.** They pick an address GitHub has verified on their account before they can accept. With *Anyone with the link* it records who they are and turns nobody away. With *Only students on the roster* it must match the roster's **Email** column. This is the default.
- **just click Accept.** Nothing extra is asked. With *Anyone with the link* you only learn their GitHub username. With *Only students on the roster* their username must be in the roster's **GitHub Account** column, so fill that column in first.

Use the roster with email when you have students' addresses but not their usernames, which is the usual case.

Your roster belongs to the whole course, not to one assignment. Each assignment picks who it is for.

After an open assignment you can [add everyone who accepted](#adding-students-who-accepted) to the roster.

### Good to know

- The check runs on GitHub after the student clicks Accept, not in their browser. A student cannot get in by editing the page.
- Whenever students confirm an address, it is encrypted in their browser. Only PXL Classroom can read it.
- With *Only students on the roster*, an address that is not on your roster is refused.

## Who is this assignment for

With *Only students on the roster*, the form shows your roster and you tick the students this assignment is for.

- **Tick nobody and everyone on the roster can accept.** The form says so on screen. That is the right answer for work the whole course does.
- **A whole class is one click.** Click the class chip to show it, then tick the box at the top of the list - it reads *Select all 20 in 3A*. You never tick students one at a time to take a class.
- The chips are **filters**, not the answer. Showing a class does not select it, and the form warns you while that is true.
- **Mixing is the point.** Take 3A, then search for the two students from another class you also want and tick them. Searching looks across everyone, so the class filter stands down while you type. That is a remediation or resit cohort, and it needs nothing set up in advance.
- **Selected · 22** shows you what you have built, so you can read it back instead of trusting the count.
- **No group** is a filter too, so students you never put in a section are visible and tick like anyone else.
- The list is sorted by class, so a section reads as one block.
- The list is a **snapshot**. A student you import next week is not in an assignment you made today. Open the assignment's **Settings** tab and press **Add students** - it shows the same list with the current cohort already ticked. You can only add: taking a student out would not delete their repository or their work, so it is not offered.
- Published with nobody ticked, it stays open to the whole roster and cannot be narrowed. Stop accepting first if you need to.

### Class groups

A class group is a label on a student, and it exists to make that list quick to filter.

- Put one on each student: click the **Group** cell on the **Roster** page and type it, a `class_group` column in the roster CSV, or the Class Group field under **+ Add student** or **Edit details…**. A student is in one group at most.
- The cell offers the groups your roster already uses, so you complete an existing one rather than typing `3a` beside `3A` and splitting a section in two. A new name is still typed freely.
- For many students at once, tick them on the **Roster** page, type the group under **Set group to** and press **Apply**.
- Nothing is decided by a group. It only narrows the list you pick from; the assignment stores the students you ticked.

### Good to know

- With *Anyone with the link* the roster does not decide who may accept, so there is nothing to pick and the list is not shown.
- Picking more students than **Max acceptances** allows means the ones past the cap are refused. The form warns you before you save.

## Confirming an email address

Linking a student's GitHub account to their {{institution_short}} email address.

The student signs in and chooses one of the addresses GitHub has already verified for their account. If none fits, they can type one instead, which is recorded as **unverified**. Only the firstname.lastname@ form is accepted unless you untick that under **Advanced**. One confirmation applies to every assignment in the organization.

There are two ways to ask for it.

### At acceptance

Under **When accepting, students**, choose **confirm their {{institution_short}} email address**. It is the default for a new assignment.

- The student confirms an address before they can accept.
- With *Anyone with the link*, it does not restrict who may accept: anyone with the link still can.
- With **just click Accept** instead, you get their GitHub username and nothing else.

### With a link

Every published assignment has one: **Invite link**, then **Copy confirm-email link**. Send it to students whose roster row shows only a GitHub username.

- No repository is created. It works under any **Who may accept** setting, and before the assignment opens.
- It works until the deadline. The lock at the deadline switches it off, as it does the invitation link, and so do **Stop accepting**, **Archive** and **Back to draft**. **Regenerate link** retires it at once.
- To collect addresses later, send the link from an assignment that is still open, or publish one for the purpose. Confirming creates no repositories.

### What waits for you on the Roster page

- Confirmed addresses link themselves to roster rows overnight. **N need your decision** lists the ones that cannot: an address the student typed rather than confirmed, one naming a different account than the row already holds, or one two accounts claim. **Link anyway** or **Discard** each.
- A student told they tried too many addresses is let back in with **Clear failed attempts…**, by their GitHub username.

### If a student confirms the wrong address

They open the confirm-email link again and confirm the right one; it replaces the old one. Otherwise, on the **Roster** page, open that student's actions menu and choose **Forget this account**, then ask them to confirm again. That removes only the link on their row. Nothing on GitHub changes, and their repository and work are untouched.

## Late work

**After the deadline** has three answers.

- **Pushing stops.** Students can no longer push to the submission branch, and the submission is the last commit before the deadline. They keep their repository, Actions, secrets and runners. The lock sits above their repository, so they cannot lift it themselves. This is the default.
- **Nothing is locked.** Late commits count, and are marked late in the report.
- **The repository becomes read-only.** Pushing stops, and students also lose Actions, secrets, environments, runners and settings until you reopen the repository.

An older assignment may show a fourth answer, **Read-only, but late work still counts**: students lose their tools at the deadline, and anything they pushed before the lock landed still counts. It is kept so opening that assignment changes nothing, and it is not offered for new ones.

A student with an extension is judged against their own deadline.

### Good to know

- The submission is the submission branch as it stood at the deadline. A tag a student pushes is an ordinary git tag: nothing collects or grades it.
- On the **Progress** tab, on time or late is decided by the time on the commit, not by when PXL Classroom looked at it. That time comes from the student's own computer: good enough for marking, not proof if a student disputes it. A hand-in for grading is judged by when GitHub received the push.
- The lock lands at the deadline, or at the next nightly check if that is missed. Work pushed in between does not count.

## Deadlines and extensions

- The deadline is entered in your computer's time. Students see it in the time zone set under **Advanced**.
- An extension moves the deadline for one student, and for every member of their team. Nothing else about the assignment changes.
- Grant it in the student's **⋯** dialog, under **Grant deadline extension**, with a reason. Their own page shows the new date, never the reason.
- While it runs, that student can keep pushing. Everyone else is locked at the class deadline as normal.
- When it runs out, that student is locked and their work saved, the same as everyone else.
- Grant it before the deadline if you can. Granted afterwards it changes how their work is judged, but their repository stays locked: **Reopen the repository** in the same dialog lets them push.
- A finished assignment opens again only once its deadline is moved into the future.

## One student's actions

The **⋯** button on a student's row, on **Progress** or **Grading**, opens what you can do for that student alone.

- **Grant deadline extension** gives them a later deadline, with a reason. See [Deadlines and extensions](#deadlines-and-extensions).
- **Hand-ins** gives them more hand-ins than the limit. See [Autograding](#autograding).
- **Retry acceptance** runs their acceptance again, for a row that says it failed or got stuck. Their work is not touched.
- **Reopen the repository**, after the deadline, lets them push again, with a reason that is kept. It is offered once their work is safely archived. Nothing else ever locks a reopened repository again: once it is reopened, the dialog says when, by whom and why, and offers **Lock again** instead.
- **Grading** shows their score now. **Read score again** reads their run again; **Choose the commit that counts…** grades another commit; **Set score by hand** replaces the score. A chosen commit or a score by hand outranks every later reading until you take it back with **Go back to the rules** or **Remove the score set by hand**.

## The assignment's status

The button at the top of an assignment says where it stands: **Draft**, **Not open yet**, **Accepting**, **Deadline passed**, **Closed** or **Archived**. Its menu is what you can do from there.

- **Publish** creates the invitation link and lets students accept.
- **Stop accepting** stops new students accepting. After the deadline nobody can accept anyway, so it only marks the assignment closed.
- **Reopen for acceptance** lets students with the link accept again. Past the deadline it offers **Move the deadline…** instead, because acceptance needs a deadline in the future.
- **Back to draft** takes the assignment off the student pages and stops the invitation link.
- **Lock everyone out now** locks every student and archives their work straight away. It is offered after the deadline until the lock has run.
- **Archive** and **Delete assignment…** are described in [Retiring an assignment](#retiring-an-assignment).

When you save a change students would see, a line under the header says their page does not show it yet. **Update the student page now** sends it.

## Archiving

- At the deadline, a copy of every submission is saved to a separate private repository.
- One archive repository per assignment.
- Students cannot reach it, and PXL Classroom never overwrites a copy once it is made. It survives a student deleting their own repository.
- Each student's copy is a **branch**, so the archive's front page looks empty when you open it. Click the **Branches** tab to see them.
- On the **Progress** tab, the archive line's **Manage** menu opens the archive, and offers **Try again for N students** when some copies failed.
- Deleting the assignment does not delete the archive. Delete it yourself when you retire the course year.

## Group assignments

Whether each student gets their own repository, or a team shares one.

- **Alone.** One repository per student. This is the default.
- **In teams.** One repository shared by two or more students. The first member to accept creates it; the others join it.

Choose before you publish. Switching afterwards does not move students who have already accepted.

A **team** is not a **class group**. A team shares one repository for one assignment. A class group is a label on a student that helps you filter the roster when you pick who an assignment is for. Nothing links them.

### Teams only

- Set the maximum team size, and the minimum if you want the report to flag teams that are short.
- **Self-service** lets students form their own teams. **Pre-assigned** means you seed the teams first, and you decide what happens to a student who is in none.
- **Joining a team needs a code from someone in it** keeps strangers out of a team. The student who creates a team gets a code to give their teammates. You can see every team's code on the **Teams** tab, for a student who lost it. Teams you make or seed have no code and anyone can join them.
- Teams belong to the assignment, not to your roster, so re-importing a roster cannot wipe them.
- Using the same teams again on a later assignment is a separate step, not automatic. **Copy teams from…** carries them over, and warns you about anyone it carried who this assignment is not for.
- A team nobody has accepted into yet can be renamed: **Manage**, then **Rename team**. Its repository will get the new name. Once someone has accepted, the repository already has the old name, so the team keeps it.
- With self-service teams, a student who joined the wrong team can fix it themselves with **Switch team** on their page, until the assignment's deadline (an extension does not move it). A team left empty, whose repository nobody pushed to, is removed with its repository.

## Every branch and its history

Normally each student gets the template's default branch as one fresh commit, with no history. Tick **Give students every branch and its full history**, under **Advanced**, for an exercise built on the history itself, such as prepared branches to merge, rebase or repair. While it is on, a line under the template says so.

- Each student repository gets every branch, tag and commit of the template. The branches share their history, so they merge into each other.
- Students can read everything ever committed to the template. Do not commit a solution to it, not even one you remove later.
- A student shows as **No submission** until their default branch moves on from the commit they were given. The commit count leaves out the commits they were given, so a prepared branch they merge in counts its commits too.
- Choose **Pushing stops** at the deadline. A prepared branch merged in without a merge commit keeps the template's own dates, so without the lock it can read as on time when it was not: its commits are not counted as late, and the copy kept as of the deadline can be that template commit.
- Only the default branch is read for progress and grading, and archived, so the exercise has to end with the work on it. Where pushing stops at the deadline, only that branch is locked; the other branches stay open.
- With a hand-in message, a template commit on the branch they were given never counts as a hand-in. One they bring over from a prepared branch can, so do not word a template commit like the hand-in message. A template with more than about 1000 commits cannot be read for hand-ins at all.
- A workflow in the template that runs on push runs once per branch, and for up to three tags, in every student repository when it is copied. Leave workflows out of such a template unless the exercise needs one.
- **Sync Starter Code** does not run on such an assignment, or on one where any student was given such a copy: the branches are the students' to change.
- It reaches students who accept after you save it. The template still has to be ticked as a **Template repository**.

## Sync Starter Code

Changing the template after students have accepted reaches nobody by itself. **Sync Starter Code**, under **More** on the **Progress** tab, sends it.

- It brings every student from where they are up to the template's latest commit, so a student who missed an earlier update gets that too.
- You see each changed file and its difference, and untick anything you do not want to send.
- A file the student has not touched is updated straight on their submission branch. A file they changed arrives as a pull request, so their work is never overwritten.
- Each student can be sent a tracking issue that explains the change; GitHub emails them about it.
- It is safe to run again: students who already have the change are skipped. The **Starter code** line above the student table says how a sync went and offers **Sync again** for students it did not reach.
- It does not run where students were given the template's full history.
- Check the template first: a solution you committed to it would be sent as the starter code.

## Autograding

Optional. Tests that run against a student's work and give you a score per student. Scores are advisory; nothing is marked for you.

### Who defines the checks

- **They come with my template.** Your template already contains a workflow that grades, and PXL Classroom leaves it alone. Most templates do. You do not list the exercises or their points here.
- **I define them here.** For a template that does not grade itself, or when you need checks students cannot read, or a score per check instead of one total.

### If they come with your template

- The panel says what your template grades on. If it has none, **Add a starter workflow** writes one. Its example check fails until you replace it, so a forgotten placeholder cannot hand out full marks.
- Adding it does not reach students who already accepted. Use **Sync Starter Code** for that, except where students were given the template's full history.
- If the template grades on different words than the assignment says, the panel says so. The template's wording is the one that decides.
- **On every push.** Scores come from each student's last commit.
- **Only on a hand-in commit.** Scores come from the commit carrying the message you name. Type it exactly as you asked students for it. A hand-in counts only when it is the last commit of a push, and on time or late is judged by when GitHub received that push, not by the date on the commit.
- **They may hand in more than once** is on. The last hand-in before the deadline counts, so a student who fixes something and hands in again is graded on the fix. Off, the first one counts.
- **Maximum hand-ins per student** (optional, empty is no limit). With 5, only the first 5 hand-ins before the deadline count and the 5th is graded. Each hand-in is a full run of your workflow; the limit does not stop those runs, it only decides which are graded, so tell students how many count.
- Pushes are never blocked: a sixth hand-in still runs, it just does not count.
- Every hand-in that does not count is listed by name with the reason, in the box above the scores. The results and the exports show each student's count, like **6 / 5**.
- A hand-in after the deadline is never graded. That student is listed by name with the time.

### One student may hand in more

- On the student's row, **⋯ → Hand-ins**: give them extra hand-ins on top of the limit, and a reason. Optionally extend their deadline too, for a late hand-in that should count.
- Their score is read again straight away, so a hand-in that was over the limit counts at once.
- Your name, the time and the reason are kept, and appear in the exports.
- **Revoke the extra hand-ins** takes it back, with its own reason. A deadline extension given with it stays.
- In a group, the team shares one count, and the largest extra any member was given applies to the whole team.

### If you define them here

- List each check: a command that must succeed, a command whose output is compared, or a Python script. Each carries its own points.
- **In each student's repo** runs them on every push and shows the student the result.
- **On your machine** writes nothing to student repositories. You run the checks yourself after the deadline against the archived submission.
- Checks in a student's repository are time-limited, so one that never finishes cannot keep running.

### Reading the scores

- **You do not have to ask for them.** Scores are read at the deadline and are on the **Grading** tab, and in the exports (**Export grades** on Grading, **Export CSV** on Progress), by themselves.
- Before the deadline, **Read scores from GitHub Actions** shows you where the cohort has got to so far.
- **Read score again** is in each student's **⋯** dialog, under **Grading**. Use it when you re-ran their run, or you fixed a check for them. Only their score changes.
- A run a student re-ran themselves does not count: the score stays the one their push produced.
- **Read all scores again** reads every student again and replaces each score it can read. A score set by hand or a commit you chose stays, and a student whose read fails keeps their earlier score.
- Re-grading changes nothing in anybody's repository. The run has already happened; this only reads it.
- Scores you ran on your own machine are never replaced by the deadline run. Scores read from the page are read again then; a commit you chose or a score set by hand outranks every reading until you remove it.
- A student who pushes something after their hand-in commit still keeps that score.
- Every student has a row. One with no score says why: **Not handed in** (grey until their deadline, red after), **Handed in after the deadline**, **No score to read**, **Being graded** or **Not read yet**. **Needs a look** collects the late ones and those with no score to read. None of them counts as a zero.

## Feedback pull requests

A pull request is GitHub's review page: it shows a set of changes, and you can attach a comment to any line of them. Students get an email for each comment and can reply under it. It is the difference between one mark at the end and remarks on the work itself.

Switched on, each student gets one of these on their own repository, kept as a draft so it is never merged.

- Switch it on before students accept. A student who accepted earlier gets one only after **Retry acceptance** in their **⋯** dialog.
- A student who has pushed nothing does not get one.
- Open them when you are ready to mark: **Grading** tab, **More**, **Open feedback PRs**. The **Feedback PR** column on **Progress** links each one: **Not opened** is a student who handed in and has none yet, a dash is nothing to review. **Refresh feedback PRs** shows each one's state and comment count.
- Safe to run more than once. Students who already have one are skipped, and a pull request you opened by hand is used rather than duplicated.
- Their work is compared against a frozen copy of the starter code, so the review page shows what the student wrote and not the template.

## Adding students who accepted

- Adds the students who accepted an **open** assignment to your roster.
- Do this so the next assignment can use the roster instead of being open to anyone.
- It only adds. A student already on the roster is left exactly as they are.
- It copies the GitHub username, and the address the student confirmed when the assignment asked for one. Names and student numbers are not guessed, because a guess would end up in a graded field.
- Safe to run twice. The second time finds nothing to add.
- Available on the **Roster** page, and on the assignment itself.

### Good to know

- A student added this way has a Name cell reading **Name unknown**, or **Not yet identified** when no address came with them, so you can find the rows that still need a real name and number.

## Retiring an assignment

- **Stop accepting**, in the menu of the status button at the top of the assignment, stops new students accepting. Nobody's work is touched. After the deadline nobody can accept anyway, so it only marks the assignment closed.
- **Archive** takes it off the **Assignments** list (tick **Show archived** to see it) and off students' pages. Everything is kept; if the deadline has not passed, students are still locked and archived after it.
- Neither of them deletes anything.

### Delete

A closed, archived or draft assignment can be deleted. You type its ID to confirm.

- **Student repositories are never touched.** Nobody's work is deleted.
- The archive repository is kept. If the deadline's lock has not run yet, or some copies failed, those copies will never be made; the dialog says so, and waiting for the nightly check is then the fix.
- The grades and the report are moved to a folder in the control repository, with a note of what was removed and by whom. No screen shows them after that, so export the grades first.
- Everything else goes: who accepted, what was read from each repository, its locks, teams and extensions, and the public repository students accept through.
- Only that public repository cannot be brought back. The rest stays in the control repository's history.
- To finish retiring a course year, delete the student repositories and the archive repository yourself, once you are sure you need neither.
