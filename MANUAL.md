# Manual

What each setting does, and what it changes for your students.

## Who may accept

- Decides who is allowed to use the invitation link.
- **Roster** — only students you have imported. Anyone else is refused. This is the default.
- **Claim** — the same, but the student confirms their school email address first. Use it when you have email addresses but not GitHub usernames.
- **Open** — anyone with the link, until the cap is reached. You match them to real students afterwards.
- **Open** needs a **Max acceptances** number. The form will not save without one.
- Your roster belongs to the whole organisation, not to one assignment. An assignment can limit itself to certain class groups.
- After an open assignment you can [add everyone who accepted](#adding-students-who-accepted) to the roster.

### Good to know

- The check runs on GitHub after the student clicks Accept, not in their browser. A student cannot get in by editing the page.
- With **Claim**, the email address is encrypted before it leaves the student's browser. Only PXL Classroom can read it.
- A student who types an address that is not on your roster is refused. A student whose GitHub account has no school address can still type one, and it is recorded as unverified.

## Late work

- Decides what happens to work pushed after the deadline.
- **Counts** — late commits are collected and marked late in the report. Nothing is blocked. This is the default.
- **Does not count** — the repository is locked at the deadline, and the submission is the last commit made before it.
- Late or on time is judged by the time on the commit itself, not by when PXL Classroom looked at it.
- A student with an extension is judged against their own deadline, not the class deadline.

### Good to know

- The commit time comes from the student's own computer. It is right in ordinary use, and it is not proof if a student disputes it.
- With **Does not count**, the lock happens on the next nightly run after the deadline, or at the deadline itself if the deadline sentinel is switched on for your organisation.

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

- One repository for a team, instead of one for each student.
- The first team member to accept creates the repository. The others join it.
- Teams belong to the assignment, not to your roster, so re-importing a roster cannot wipe them.
- Using the same teams again on a later assignment is a separate step, not automatic.

## Automated checks

- Optional tests that run against a student's work. An assignment without them works normally in every other way.
- **On push** — the tests run in the student's own repository when they push, and the student sees the result.
- **When you grade** — you run the same tests yourself from the command line.
- Scores are advisory. Nothing is graded for you.
- Tests that run in a student's repository are time-limited, so a test that never finishes cannot keep running.

## Feedback pull requests

- A draft pull request for each student, where you comment on their code line by line.
- You have to switch this on when you create the assignment. It cannot be added afterwards.
- A student who has pushed nothing does not get one.
- Safe to run more than once. Students who already have one are skipped, and a pull request you opened by hand is used rather than duplicated.

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
- To retire a course year, delete the student repositories and the archive repository yourself, once you are sure you need neither.
