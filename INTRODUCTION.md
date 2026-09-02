# Introduction

PXL Classroom hands each student their own private
repository for an assignment, watches what they push, freezes the work at the
deadline, and gives you a dashboard and a report. It runs entirely on GitHub.

## Lecturer

1. **Connect your course organization** once. You are the owner of it; there is no user list and no roles to manage.
2. **Fill in one form.** Title, starter template, when it opens and closes, individual or group, who may accept.
3. **Publish, and share one link.** Not one link per student - one link for the assignment.
4. **Monitor the dashboard.** Who accepted, who has pushed, who has not started.
5. **At the deadline**, the work is frozen and a copy is preserved automatically. You can autograde from the dashboard, the CSV export, or locally with the CLI.

## Student

- Opens the link, sign in with GitHub, and click Accept.
- Their private repository appears in under a minute from your starter template, with them as the
only member.

## Choices

**Who may accept**

- *Open* admits anyone with the link up to a cap
- *Roster* admits only students you imported.
- *Claim* is the same, but the student confirms their institution email address first - for when you have addresses and not GitHub usernames.

**Late work**

- either counts and is flagged, or
- does not count and the repository locks at the deadline.
- late or on time is judged by the timestamp on the commit.

**Group assignment**

- gives one repository to a team instead of one to each student.
- the first member to accept creates it; the rest join.

## How it is built, and why that is unusual

There is **no server and no database**.

- the web app is a static page on GitHub Pages.
- the work happens in GitHub Actions.
- course data lives in an ordinary private repositor: assignments, roster and reports.

Everything runs from **one shared repository**: each course organization holds only data.

Targets **GitHub Team for Education**

- does not require Enterprise.
- when nothing is active it bills no Actions minutes at all.

**the evidence is the git history**, not a log file.

## Where to go next

- Using it for a course: **[RUNBOOK.md](RUNBOOK.md)**
- Setting up an organization: **[ADMIN.md](ADMIN.md)**
- Standing up your own deployment: **[INSTALL.md](INSTALL.md)**
- How it works inside: **[ARCHITECTURE.md](ARCHITECTURE.md)**
