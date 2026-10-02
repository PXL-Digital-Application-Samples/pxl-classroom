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

## Open

- A roster student whose GitHub username is not known yet (they confirm their
  email address when they accept) cannot be placed in a team in advance: team
  membership is stored by username. Say so where a lecturer would try, or find
  another way - not yet decided.
