# Beta UX to-do

The open and decided UX questions of the SPA work on the `beta` branch
(`<site>/beta/`, ARCHITECTURE.md §10.8). One line each, with what was decided and
when. This file exists only on `beta` and is deleted in the commit that merges
`beta` into `main` (CLAUDE.md, Documentation). Infrastructure gaps for the whole
project are in [OPEN-ITEMS.md](OPEN-ITEMS.md), not here.

## To build (decided)

- **Team pickers offer this assignment's students, not the whole roster.**
  Decided 2026-10-02. The Teams tab's *Add member* dropdown, *Create team*
  checklist and its "N students have no team" line read every roster student
  with a GitHub username in the organization - other sections and previous
  years included - so a lecturer can place a student in a team who is then
  refused at acceptance. Offer and count only the students the assignment
  admits (its selected students, or the whole roster when none are selected),
  through the same judge acceptance uses (`lib/cohort.mjs`).
- **Copying the teams of an earlier assignment is found on the Teams tab.**
  Decided 2026-10-02. It exists (*Seed teams*, `lib/seed-teams.mjs`) but a
  lecturer looking for it did not find it. An empty group assignment's Teams
  tab leads with *Copy the teams of an earlier assignment*, beside "or let
  students form their own when they accept". Not in the assignment form.
- **Who may accept and who is with whom stay two separate steps.** Decided
  2026-10-02. The form chooses the students (who may accept); the Teams tab
  chooses the teams and only ever offers those students (first item). Nothing
  stored twice, no merged table, and the teams never decide who may accept.

### The assignment page (decided 2026-10-02)

The page a card opens had one long scroll: summary cards, the student list (or,
for a group assignment, a Teams View / Students View toggle over it), and an
*Autograder* table at the bottom. Scores were shown three times (a column in the
student list, a column in the teams table, the bottom table), and everything
about configuring the assignment lives under Admin, linked from nowhere but an
empty state.

- **Underline tabs: Progress, Teams, Grading.** Same style as Assignments /
  Roster / Admin (DESIGN.md §1.4). Progress is today's summary cards and
  student list. Teams appears for group assignments only. Grading takes the
  bottom table and everything about scores. No code is moved out of the page
  (the big views are not split, CLAUDE.md, Frontend).
- **Settings stay in Admin, linked both ways.** The page gets an *Edit
  settings* button that opens Admin's editor on this assignment; the editor
  gets *Back to the assignment*. A Settings tab was declined because it would
  move the editor out of AdminView.
- **Teams tab = making teams + progress per team.** Create, move, add, copy
  from an earlier assignment, and each team's status and score in the same
  table. The Teams View / Students View toggle goes; Progress is per student.
- **Progress keeps one read-only Score column.** Everything else about grading
  (graded commit, earned/total, hand-ins, CI status, last graded, read again,
  exports, per-student decisions) is on Grading only. The CI status column
  leaves Progress and the teams table.
- **Grading is always there.** Without autograding it says nothing grades this
  assignment (work is still collected and archived) and offers *Set up
  grading*, which opens Edit settings at the Grading section.
- **Above the tabs: title, state, deadline, Edit settings, Invite link.** The
  counting cards (total / on time / late / none) move into Progress, because
  clicking one filters the Progress list. Grading has its own summary line.
- **Each tab has its own actions; nothing appears twice.** Progress: export
  submissions, download all, Sync starter code, add accepted students to the
  roster. Grading: read scores again, export grades and breakdown,
  command-line grading, feedback pull requests. Teams: new team, copy teams.
  The bottom table's buttons and the duplicate menu entries go.
- **The tab is in the address** (`?tab=grading`), so a link opens a tab, Back
  moves between tabs and a refresh stays put. No tab means Progress.

## Open

- A roster student whose GitHub username is not known yet (they confirm their
  email address when they accept) cannot be placed in a team in advance: team
  membership is stored by username. Say so where a lecturer would try, or find
  another way - not yet decided.
