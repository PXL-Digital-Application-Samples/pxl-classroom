# Beta UX to-do

The open and decided UX questions of the SPA work on the `beta` branch
(`<site>/beta/`, ARCHITECTURE.md §10.8). One line each, with what was decided and
when. This file exists only on `beta` and is deleted in the commit that merges
`beta` into `main` (CLAUDE.md, Documentation). Infrastructure gaps for the whole
project are in [OPEN-ITEMS.md](OPEN-ITEMS.md), not here.

## To build (decided)

- **Team pickers offer this assignment's students, not the whole roster.**
  Decided 2026-10-02; built 2026-10-02 (`lib/team-candidates.mjs`). The Teams tab's *Add member* dropdown, *Create team*
  checklist and its "N students have no team" line read every roster student
  with a GitHub username in the organization - other sections and previous
  years included - so a lecturer can place a student in a team who is then
  refused at acceptance. Offer and count only the students the assignment
  admits (its selected students, or the whole roster when none are selected),
  through the same judge acceptance uses (`lib/cohort.mjs`).
- **Copying the teams of an earlier assignment is found on the Teams tab.**
  Decided 2026-10-02; built 2026-10-02 - and "Seed teams" is called *Copy
  teams* everywhere a lecturer reads it. It exists (*Seed teams*, `lib/seed-teams.mjs`) but a
  lecturer looking for it did not find it. An empty group assignment's Teams
  tab leads with *Copy the teams of an earlier assignment*, beside "or let
  students form their own when they accept". Not in the assignment form.
- **Who may accept and who is with whom stay two separate steps.** Decided
  2026-10-02. The form chooses the students (who may accept); the Teams tab
  chooses the teams and only ever offers those students (first item). Nothing
  stored twice, no merged table, and the teams never decide who may accept.

### The assignment page (decided 2026-10-02; built 2026-10-02)

Built as decided (`AssignmentHeader.vue`, `lib/state-actions.js`). Where the
building changed a detail: the state button offers Publish / Delete draft on a
draft; Stop accepting / Back to draft / Archive on a published one; Reopen /
Back to draft / Archive / Delete on a closed one; *Lock everyone out now* once
the deadline has passed; and **no Reopen past the deadline** - nobody can accept
then, and a locked assignment cannot be published again - but *Move the
deadline…*, which opens Settings at the schedule. *Invite link* is the solid
button on Progress, Teams and Grading, and plain on Settings, whose Save is.

The page a card opens had one long scroll: summary cards, the student list (or,
for a group assignment, a Teams View / Students View toggle over it), and an
*Autograder* table at the bottom. Scores were shown three times (a column in the
student list, a column in the teams table, the bottom table), and everything
about configuring the assignment lives under Admin, linked from nowhere but an
empty state.

- **Underline tabs: Progress, Teams, Grading, Settings.** Same style as the
  organization's tabs (DESIGN.md §1.4). Progress is today's summary cards and
  student list. Teams appears for group assignments only. Grading takes the
  bottom table and everything about scores. Settings is today's editor (see
  *The organization's tabs* below). No code is moved out of the big views
  (CLAUDE.md, Frontend).
- ~~Settings stay in Admin, linked both ways.~~ Superseded the same day by the
  Settings tab, when Admin was reconsidered.
- **The state is a button in the header, and it carries the lifecycle.**
  `Draft v` offers Publish; `Published v` offers Stop accepting and Close;
  `Closed v` offers Reopen and Archive; Delete is last and guarded. Reachable
  from every tab, so closing an exam is not a matter of finding a form
  section.
- **Teams tab = making teams + progress per team.** Create, move, add, copy
  from an earlier assignment, and each team's status and score in the same
  table. The Teams View / Students View toggle goes; Progress is per student.
- **Progress keeps one read-only Score column.** Everything else about grading
  (graded commit, earned/total, hand-ins, CI status, last graded, read again,
  exports, per-student decisions) is on Grading only. The CI status column
  leaves Progress and the teams table.
- **Grading is always there.** Without autograding it says nothing grades this
  assignment (work is still collected and archived) and offers *Set up
  grading*, which opens the Settings tab at its Grading section.
- **Above the tabs: title, state button, deadline, Invite link.** The
  counting cards (total / on time / late / none) move into Progress, because
  clicking one filters the Progress list. Grading has its own summary line.
- **Each tab has its own actions; nothing appears twice.** Progress: export
  submissions, download all, Sync starter code, add accepted students to the
  roster. Grading: read scores again, export grades and breakdown,
  command-line grading, feedback pull requests. Teams: new team, copy teams.
  The bottom table's buttons and the duplicate menu entries go.
- **The tab is in the address** (`?tab=grading`), so a link opens a tab, Back
  moves between tabs and a refresh stays put. No tab means Progress.

### The organization's tabs (decided 2026-10-02; built 2026-10-02)

Built as decided (`OrganizationView.vue`, `lib/org-notices.mjs`,
`lib/course-activity.mjs`). Where the building changed a detail: the editor's
list is not hidden but gone, so the Settings tab and *New assignment* are two
addresses (`/<id>/settings`, `/new`) and old `/admin` links redirect to them;
System health sits outside every loading state of the Organization page,
because it is the tool for when that page cannot load.

"Admin" was not administration: it was a second list of every assignment beside
the full editor, and the only place drafts existed. Watching an assignment and
editing it were two trees, and the organization's own things were scattered
(System Health a header button, Usage & limits under the assignment cards, Setup
on its own route).

- **Assignments | Roster | Organization.** Admin goes. Everything about one
  assignment is under that assignment (its Settings tab); everything about the
  organization is under Organization.
- **The Settings tab shows the existing editor with its list hidden**, so the
  editor is not split out of AdminView. *+ New assignment* opens the same
  editor on its own.
- **Drafts get their own row above the live and closed cards** on Assignments;
  archived stay behind a toggle. A draft opens on its Settings tab.
- **Organization leads with what needs the lecturer, else "All quiet".** One
  sentence and only actionable items (an acceptance that got no answer, a
  repository nothing recorded, a deadline that did not lock, failed
  provisioning), each with its fix beside it. When there are none: everything
  ran as expected, and when the nightly last checked. Below, folded: Course
  activity, System health, Usage & limits, Connection & setup.
- **Course activity is per assignment, in plain words**, built from the
  course's own records ("Lab 3: 41 accepted, 2 refused, collected today 02:00";
  "Exam: locked at the deadline, 38 of 38 archived"), with a folded *Technical
  details* of the recent hub runs that can be tied to this organization
  (acceptance runs by their name, nightly legs), status and links.
- **Instructor notifications are read in the app**, in the "needs you" list,
  with a link to the GitHub issue, which stays the record and the email
  channel.
- **Every lecturer of the organization sees it.** A repair only an
  administrator can do (App permissions, cancelling a hub run) says so, never a
  button that fails.

## Open

- A roster student whose GitHub username is not known yet (they confirm their
  email address when they accept) cannot be placed in a team in advance: team
  membership is stored by username. Say so where a lecturer would try, or find
  another way - not yet decided.
