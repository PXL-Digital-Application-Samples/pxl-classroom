# Manual

Short answers to the questions the interface raises. Each topic opens from the
help button beside the control it describes, and the whole thing is readable at
once from **Help** in the header.

This is not a reference. It covers the settings people ask about twice; anything
deeper lives in the operational documentation.

## Who may accept

- **Roster** is the default. Only students already on your organization's roster can accept; anyone else is turned away.
- **Claim** is the same gate with a way in. The student proves an institutional email address and it has to match a roster entry. Use it when you hold addresses but not GitHub usernames.
- **Open** lets any GitHub account accept, between the open date and the deadline, until the cap is reached. You work out who they were afterwards.
- Open enrolment **requires a cap**. The form will not save without one, because the cap is then the only limit there is.
- The roster is organization-wide, not per assignment. One assignment can narrow it to certain class groups.

### How it works

The decision is made by the acceptance workflow in the central hub, never in the
browser, so the page cannot let anyone in by itself. Under **claim** the address
the student types is sealed in their browser and only the hub can open it.

After an open assignment you can add everyone who turned up to the roster in one
step, so the next assignment can run on a roster. See [Adding students who accepted](#adding-students-who-accepted).

## Late work

- **Report** is the default. Late pushes are still collected and marked late; nothing is blocked.
- **Block** stops writes once the deadline passes, and the submission is rebuilt from the last commit made before it.
- Late or on time is decided by **the commit's own timestamp**, not by when the system happened to look.
- That timestamp comes from the student's own machine. It reconstructs the ordinary case correctly, and it is not evidence in a dispute.
- A student with an extension is judged against their own deadline, not the cohort's.

### How it works

Under **block**, the lock falls on the first nightly run after the deadline, or
at the deadline itself if the deadline sentinel is enabled. Anything pushed in
between is filtered out rather than counted.

## Deadlines and extensions

- An extension moves the deadline **for one student**, and nothing else about the assignment changes.
- While an extension runs, that student's repository stays open and everyone else is locked at the deadline as normal.
- When the extension expires that student is locked, preserved and reported like everybody else.
- Grant it **before** the deadline passes if you can. Afterwards the work is already frozen.

### How it works

Every deadline comparison in the system asks for the deadline *for that student*,
so an extension does not have to be applied in more than one place. The
assignment stays active until the last extension expires.

## Archiving

- At the deadline every submission is copied into a private archive repository, one per assignment.
- The copy is frozen. A commit made later cannot replace it.
- Students have no access to the archive, and it survives a student deleting their own repository.
- Each submission is a **branch**, so the archive's front page looks empty when you open it. It is not.
- Delete the archive together with that assignment's student repositories when you retire the course year.

### How it works

Preservation runs after lock-down in the nightly finalize. If it fails for
somebody, the assignment is re-queued on the next run rather than left half
done, and an already-preserved submission is never overwritten.

## Group assignments

- A group assignment gives one repository to a team rather than one to each student.
- The first member to accept creates the repository; the rest join it.
- Team membership belongs to the assignment. It is not written back to the roster, so re-importing a roster cannot wipe it.
- Carrying the same groups into a later assignment is a deliberate step, not automatic.

### How it works

Teams are seeded from what you supply, and the acceptance workflow places each
student into their team's repository as they accept.

## Automated checks

- Optional. An assignment without them behaves normally in every other way.
- Checks can run **on the student's push**, so they see results themselves, or **on your machine** from the CLI when you grade.
- Student-side runs are capped so a runaway test cannot burn through the organization's minutes.
- Scores are advisory. Nothing is graded automatically on your behalf.

### How it works

Student-side checks are an ordinary workflow in the student's repository, with a
time limit and cancellation of superseded runs already set for you.

## Feedback pull requests

- Optional, and **you have to opt in when you create the assignment** — it needs a baseline branch made at provisioning time.
- Opens one draft pull request per student, which is where you leave line-by-line comments.
- Re-running is safe: students who already have one are skipped, and a pull request opened by hand is adopted rather than duplicated.
- A student who has pushed nothing does not get one.

### How it works

The run reports how many it opened and how many it adopted, and it fails loudly
if it could not do them all, so a green tick is not mistaken for full coverage.

## Adding students who accepted

- Turns the people who accepted an **open** assignment into roster entries, so the next assignment can run on a roster.
- Only adds. Somebody already on the roster is left exactly as they are.
- It copies the GitHub account and nothing else. Names and student numbers are not invented, because a guess would land in a graded field.
- Running it twice is free; the second run finds nothing to add.
- Offered from the **Roster** tab and from the assignment itself. Both do the same thing.

### How it works

Entries added this way are marked as not yet identified, which is how you find
the rows that still need a real name and number after a later import.

## Retiring an assignment

- Closing an assignment stops new acceptances. It does not touch anybody's work.
- Archiving hides it from the dashboard while keeping everything intact.
- The archive repository and the student repositories are separate things, and deleting one does not delete the other.
- Retire a course year by deleting the student repositories **and** that assignment's archive, once you are sure you no longer need either.

### How it works

The nightly cycle disables itself once nothing is active, so a retired course
costs nothing to keep.
