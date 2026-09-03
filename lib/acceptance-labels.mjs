// The two words the hub is allowed to say to a student in public.
//
// One file, because three surfaces spell them: the hub writes them
// (scripts/publish-acceptance-outcome.mjs), the SPA reads them
// (frontend/src/lib/acceptance-outcome.js), and the tests assert them. A label
// written one way and matched another is a channel that silently carries
// nothing - which is exactly how the comment version of this spent a day
// posting into a void.
//
// Isomorphic and dependency-free: the browser imports it as readily as the hub.

/** The collaborator grant returned 201 - GitHub sent an invitation to accept. */
export const INVITED_LABEL = "outcome:invited";

/**
 * The acceptance was refused. DELIBERATELY GENERIC.
 *
 * A per-reason label would be filterable in one click, turning a public broker
 * into a sortable list of which named students are not on the roster - and that
 * is enrolment data about people who never chose to publish it. This says who
 * was refused, which their own public acceptance issue already said, and never
 * why. The reason stays in the private control repository, where the lecturer
 * reads it and the student can ask for it.
 */
export const REJECTED_LABEL = "outcome:rejected";

/** Everything the hub may put on a student's acceptance issue, and nothing else. */
export const OUTCOME_LABELS = Object.freeze([INVITED_LABEL, REJECTED_LABEL]);
