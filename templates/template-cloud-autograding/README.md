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
3. Commit and push with the message **`einde examen`** — exactly that, nothing
   before or after it. That is what runs the checks.

They can hand in more than once; the newest hand-in commit is the one that
counts. Anything they push afterwards does not re-run the checks and does not
replace the score.

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
- After the exam, use **Read scores from GitHub Actions** in the dashboard.
  Students whose hand-in commit is missing are listed by name — they are not
  scored zero.

## Why the checks are not re-run afterwards

The sandbox account is gone once the session ends, so the archived code cannot
be re-graded against it. The check run left on the hand-in commit is the
measurement, and it is what the archive preserves alongside the code.
