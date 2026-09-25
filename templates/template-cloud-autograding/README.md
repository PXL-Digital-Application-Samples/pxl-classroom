# Cloud exam template

A starting point for an exam whose checks read the student's **own cloud
account**, where the grade has to be taken while their lab session is still
open. Copy this into a repository of your own, tick **Template repository**, and
point a PXL Classroom assignment at it.

## What the student does

1. Paste their lab credentials into `creds.txt`, in the format the AWS CLI
   wants:

   ```text
   [default]
   aws_access_key_id=…
   aws_secret_access_key=…
   aws_session_token=…
   ```

2. Do the exercise in their own account.
3. Commit and push with the message **`einde examen`**: exactly that, nothing
   before or after it. That is what runs the checks.

They can hand in more than once: the newest hand-in commit on or before the
deadline is the one that counts, unless you turned that off on the assignment.
Anything else they push does not re-run the checks and does not replace the
score.

If the assignment has a **hand-in limit**, only their first hand-ins up to that
number count, and the last of those is graded. Each hand-in still runs the
checks - a deploy in their lab and Actions minutes - so tell them the limit
before the exam. A hand-in over the limit is not graded, and you see it listed
by name.

## What you do

- Change `.github/aws-autograde/vpc.js` to the check the exercise actually asks
  for, and add one grader step per check in `.github/workflows/classroom.yml`.
  Every step needs its id listed in the reporter's `runners` and its
  `<ID>_RESULTS` variable in the reporter's `env:`, or its points go missing
  from the total without an error.
- Set the assignment's **Hand-in commit message** to the same string the
  workflow gates on. The dashboard then reads each student's score from their
  hand-in commit; without it, a student who pushed anything afterwards is
  reported as having no grading run.
- Optionally set **Maximum hand-ins per student** on the assignment. Every
  hand-in is a full run of this workflow against the student's account, about
  25 Actions minutes on this template. The limit decides what is graded; it
  does not stop a push. A student who needs more (a lab that crashed) can be
  given extra hand-ins from their row, with a reason that is kept.
- After the exam, use **Read scores from GitHub Actions** in the dashboard.
  Students whose hand-in commit is missing are listed by name: they are not
  scored zero. Hand-ins over the limit, or after the deadline, are listed too.

## Why the checks are not re-run afterwards

The sandbox account is gone once the session ends, so the archived code cannot
be re-graded against it. The check run left on the hand-in commit is the
measurement, and it is what the archive preserves alongside the code.
