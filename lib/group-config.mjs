// PXL Classroom - the defaults a group assignment falls back to.
//
// `group_config.max_team_size` is optional, so seven places had to decide what
// its absence means and all of them wrote `|| 3` by hand. `lib/seed-teams.mjs`
// did export a DEFAULT_MAX_TEAM_SIZE whose own comment said it was "used
// everywhere group_config.max_team_size is absent" - and it was used in exactly
// one file. A constant nobody reads is not a source of truth, it is a decoy:
// changing it, which is the obvious thing to do given its name, would have made
// the planner seed teams one member larger than accept.mjs is willing to admit,
// and the last member of every seeded team would have been turned away with
// `rejected:team-full`.
//
// These must also agree with schemas/assignment.schema.json, which declares the
// same defaults - lib/validate.mjs runs AJV with `useDefaults: true`, so a
// validated document arrives with them already filled in and the two would
// otherwise disagree about a document that had merely taken a different route.
//
// Pure and dependency-free: the acceptance gate, the planner and the student's
// browser all reach it.

/** Maximum members per team when the assignment does not say. */
export const DEFAULT_MAX_TEAM_SIZE = 3;

/**
 * Target minimum per team when the assignment does not say.
 *
 * Zero rather than one, deliberately: this only drives the "under capacity"
 * warning on the dashboard, and defaulting it to 1 would flag every team that
 * has anybody in it at all.
 */
export const DEFAULT_MIN_TEAM_SIZE = 0;

/**
 * The maximum in force for an assignment.
 *
 * `Number(...) || DEFAULT` rather than `??`, because the value arrives from
 * YAML a human edits: `max_team_size: ""` and a missing key must both mean the
 * default, and `0` is not a legal team size (the schema's minimum is 2).
 */
export function maxTeamSize(groupConfig) {
  return Number(groupConfig?.max_team_size) || DEFAULT_MAX_TEAM_SIZE;
}

/** The under-capacity threshold in force for an assignment. */
export function minTeamSize(groupConfig) {
  return Number(groupConfig?.min_team_size) || DEFAULT_MIN_TEAM_SIZE;
}
