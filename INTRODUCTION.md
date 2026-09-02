# Introduction

For someone meeting PXL Classroom for the first time. What it is, what using it
looks like from both sides, and what is unusual about how it is built.

If you want the shorter version: it hands each student their own private
repository for an assignment, watches what they push, freezes the work at the
deadline, and gives you a dashboard and a report. It runs entirely on GitHub.

## The problem it solves

Handing out starter code and collecting work back is administratively dull and
easy to get wrong. Email attachments lose versions. A shared repository lets
students see each other's work. Doing it by hand costs an hour per assignment
and produces no record of when anything arrived.

GitHub already solves the hard parts - version control, access control, code
review. What it does not do is the classroom bookkeeping: who gets which
repository, who accepted, what the state of each submission was at 23:59 on the
deadline. That is the gap.

## What a lecturer does

1. **Connect your course organization** once. You are the owner of it; there is no user list and no roles to manage.
2. **Fill in one form.** Title, starter template, when it opens and closes, individual or group, who may accept.
3. **Publish, and share one link.** Not one link per student - one link for the assignment.
4. **Watch the dashboard.** Who accepted, who has pushed, who has not started.
5. **At the deadline**, the work is frozen and a copy is preserved automatically. You grade from the dashboard, the CSV export, or locally with the CLI.

Nothing in that list is a background job you have to remember to run.

## What a student does

They open the link, sign in with GitHub, and click Accept. Their repository
appears in under a minute, from your starter template, private, with them as the
only member. They work in it normally.

That is the whole student experience. There is no account to create, nothing to
install, and no separate platform to learn.

## Three choices worth knowing about

**Who may accept** is the one setting that changes what a student experiences.
*Roster* admits only students you imported. *Claim* is the same, but the student
confirms their school email address first - for when you have addresses and not
GitHub usernames. *Open* admits anyone with the link up to a cap, which is what
exams and workshops need and what GitHub Classroom stopped supporting.

**Late work** either counts and is flagged, or does not count and the repository
locks at the deadline. Late or on time is judged by the timestamp on the commit
itself, not by when the system happened to look - a distinction that matters,
because the system looks on a schedule and students work up to the last minute.

**Group assignments** give one repository to a team instead of one to each
student. The first member to accept creates it; the rest join.

## How it is built, and why that is unusual

There is **no server and no database**. The web app is a static page on GitHub
Pages. The work happens in GitHub Actions. Course data lives in an ordinary
private repository - assignments, roster and reports are files you can read,
diff and back up with git.

Everything runs from **one shared repository**, and each course organization
holds only data. That is what makes the system upgradable in one place: fixing
something here fixes it for every course at once, and a course organization can
be handed to a colleague or deleted without taking any machinery with it.

It targets **GitHub Team for Education** and never requires Enterprise. When
nothing is active it bills no Actions minutes at all.

The consequence worth understanding: **the evidence is the git history**, not a
log file. What each student had pushed, when it was observed, and the frozen copy
taken at the deadline are all commits in a repository you control. They do not
expire, and they are not somewhere only an administrator can reach.

## What it does not do

It does not mark work for you. Automated checks are optional, their scores are
advisory, and nothing is graded on your behalf.

It does not detect plagiarism, and it is not a learning platform - no lectures,
no quizzes, no grade book of record. It distributes work, collects it, and tells
you what happened.

## Where to go next

- Using it for a course: **[RUNBOOK.md](RUNBOOK.md)**
- Setting up an organization: **[ADMIN.md](ADMIN.md)**
- Standing up your own deployment: **[INSTALL.md](INSTALL.md)**
- How it works inside: **[ARCHITECTURE.md](ARCHITECTURE.md)**
- The two diagrams that summarise it: the component view and the usage flow in **[README.md](README.md)**
