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
- **Students with no GitHub username yet: confirm first, then make teams.**
  Decided 2026-10-03; built 2026-10-05 (`teamCandidates` `waiting`; the line
  says "they appear here once they confirm", since the tab re-reads
  confirmations on load and does not watch for them). Teams store usernames, so an address-only
  roster row cannot be placed. The Teams tab's pickers list such students
  greyed, *no GitHub username yet*, with one line above: *N students can't be
  placed yet. Send them the confirm-email link; they appear here as soon as
  they confirm*, and a *Copy confirm link* button. The pickers read
  confirmations (`students/claims/`) directly, so a student is placeable right
  after confirming, not after the nightly folds it into the roster. No change to
  how teams are stored or to acceptance; reserving a place by address was
  considered and declined (it changes the team file, acceptance, team-size
  counting, lockdown and grading).
- **The Assignments list titles its two groups when there are drafts:
  *Drafts* and *Published*.** Noted 2026-10-03, the second title decided
  2026-10-04; built 2026-10-05 (`DashboardView.vue`, spec 37). *Drafts* a bit bigger than now, *Published* the same
  size, over the accepting and closed cards - everything below it has been
  published, which is the distinction the titles exist to make. With no drafts,
  no group titles at all.

### The Teams tab, from the live test (decided 2026-10-04; built 2026-10-05)

- **The table follows the team files**, not the report a minute behind them
  (`frontend/src/lib/team-rows.js`).
- **A move says what it does to that student**, computed per case; moving into
  a team with no repository is allowed and says they must accept again.
- **Every dialog keeps its title and buttons; only the body scrolls.**
- **The Teams tab asks in its own dialog** (`ConfirmDialog.vue`): Move, Delete
  team, Undo copy. The row's red Delete went; an empty team is deleted from
  Manage. Remove in Manage is a plain button.
- **No GitHub username yet**: the item above.
- **Each member in Manage says where they stand** (has the team repository /
  has not accepted yet); a username does not wrap.
- **Wording**: assignment titles, not ids; no "control repository"; the
  name clash names the other assignment and the names it makes.
- **The tab bar draws its line inside itself** (no 1px scroll).
- **Capacity dots**: amber below the minimum, green otherwise.
- **A username that is not a GitHub account** is said as such on removal, and
  the Roster asks GitHub before storing one.

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

### First look on beta (decided 2026-10-03)

The lecturer tried it on a real course. The org tabs were rebuilt on every
click and blinked out while a page loaded, and sat wherever the left side of
the bar ended. Settings was a different page that drew the header inside the
editor's card, reloaded on every click and still carried the old Admin layout.

- **One shared top bar for the organization.** Drawn once for every page under
  `/dashboard/<org>`, with the org picker in it, the tabs centred, and only the
  page below it swapped. The tabs show at once when this session already knows
  the account is staff in that org; the first load still waits for that, so a
  student never sees them.
- **Settings is a real tab** of the assignment page: same header, same width,
  instant switch. Save, Cancel and Troubleshoot sit in a bar stuck to the
  bottom of the window.
- **Settings stops showing** the *Published & Verified* panel (its *Regenerate
  link* moves into the Invite link menu; a one-line status stays while a publish
  is going live), the accepted/deadline card with *Track roster & progress*,
  and the *Course roster* line. ~~The *Edit settings* fold stays.~~ Reversed
  the same day, on a second look: the fold goes, the form is always open.
- **Teams stays group-only**, as decided: an individual assignment has no Teams
  tab.

### Second look (decided 2026-10-03)

- **The form keeps its readable width; a list of its sections fills the rest**
  (left, sticky, jumps to each section, lights the one on screen). Hidden on a
  narrow window.
- **Invite link stays blue on Settings until a field is edited**; then Save is
  the blue one. Still one solid button at a time.
- **Unsaved edits are said**: *Unsaved changes* in the bottom bar and a dot on
  the Settings tab; *Not saved yet* on a new assignment.
- **A state change with unsaved edits is refused** (save or cancel first),
  rather than saving them silently with it.
- Fixed as bugs: signing out cleared the sign-in before asking about unsaved
  edits; Regenerate link made an untouched form read as edited.
- **A one-time "New look" card for lecturers** above the Assignments list:
  three plain sentences under *This page changed.* - Admin is gone, settings
  are on each assignment's Settings tab and save on Save, everything else saves
  as soon as you act - with *Got it* to dismiss (five bullets until
  2026-10-05, the last of which said everything waits for Save). Remembered per
  browser on the live app; on beta per session, so it shows on every visit.
  Not a dialog, no link to documentation, never shown to a student.

## Open

Nothing open right now.
