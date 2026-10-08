// The public card for one assignment: what a student's invitation page reads,
// published at `data/<org>/i/<digest of the link>.json`.
//
// Built here for two readers, so the two cannot disagree: pages/generate.mjs
// writes it, and the editor builds the same card from the SAVED document and
// compares it with the one students are served - which is how it knows whether
// students see what was saved, after a refresh as much as right after a save
// (2026-10-08: the only status was a toast that vanished). A second spelling of
// this object in the browser would be a comparison that is wrong the day one
// copy gains a field.
//
// Isomorphic and pure: configuration (the deployment's timezone) is a
// parameter, never imported (CLAUDE.md).

import { normalizeRosterMode } from "./roster-mode.mjs";
import { brokerRepoName } from "./broker-repo.mjs";

/** Which documents have a card at all. */
export function hasStudentCard(def) {
  return def?.state === "published" || def?.state === "closed";
}

/**
 * @param {import("./types.mjs").Assignment} def   the assignment document
 * @param {{acceptedCount?: number, timezone: string}} opts
 */
export function studentCard(def, { acceptedCount = 0, timezone }) {
  // Extract ONLY public metadata - no roster, no repo URLs, no tokens
  return {
    id: def.id,
    title: def.title,
    description: def.description || null,
    organization: def.organization,
    state: def.state,
    opens_at: def.opens_at,
    deadline_at: def.deadline_at,
    timezone: def.timezone || timezone,
    acceptance_mode: def.acceptance_mode || "self-service",
    // Policy flag, not student data - the SPA uses it to explain accurately
    // why an acceptance may not complete. Never carries roster contents.
    roster_mode: normalizeRosterMode(def.roster_mode),
    // Pattern is public - it's a template, not student data. SPA needs it
    // to compute the expected repo URL after acceptance (P0-10).
    repository_name_pattern: def.repository_name_pattern || `${def.id}-{github_login}`,
    // The broker repo name is public (the broker is a public repo)
    broker_repo: def.state === "published" ? brokerRepoName({ assignment: def }) : null,
    // No cap means NO cap. `accept.mjs` reads `if (maxAcceptances && ...)`,
    // so an absent value is unlimited there - publishing `?? 150` invented a
    // limit the assignment does not have, and `AssignmentView` then refused
    // student 151 an acceptance the server would have granted.
    max_acceptances: def.max_acceptances ?? null,
    accepted_count: acceptedCount,
    assignment_type: def.assignment_type || "individual",
    group_config: def.assignment_type === "group" ? (def.group_config || null) : undefined,
    // The student's browser filters their own verified addresses by this and
    // refuses one outside it before sealing. Without it the page fell back to
    // the deployment default and enforced THAT: a lecturer who set
    // `claim_domains: ["howest.be"]` had students refused at the button for
    // an address the hub would have accepted, and one who set `[]` to lift
    // the restriction still had the defaults imposed on them.
    //
    // ABSENT and EMPTY stay different answers on the wire, exactly as in the
    // YAML: an array is published verbatim (including `[]`, the deliberate
    // opt-out) and an absent key is OMITTED, so the browser falls back to the
    // deployment default rather than to "no restriction".
    //
    // These are domains, not addresses - public by nature, and the scanner's
    // email-address rule needs an `@`, so a bare domain cannot trip it.
    claim_domains: Array.isArray(def.claim_domains) ? def.claim_domains : undefined,
    // The same reason, for the address FORM: the page filters and refuses by
    // it, so an assignment that switched it off must say so on the wire or
    // the browser enforces the deployment's rule the hub no longer does.
    // Only the opt-out is published; absent is the deployment default.
    // Under `claim` the ROSTER decides, and the hub admits an address it
    // registers whatever its form - so a page filtering by form would hide
    // the one address that can get in from a student registered as
    // `12345678@`. Off on the page; the hub still refuses an unregistered
    // address without the form, and counts it as a failed attempt.
    claim_address_format: def.claim_address_format === false || normalizeRosterMode(def.roster_mode) === "claim" ? false : undefined,
    // WHETHER THE STUDENT IS ASKED FOR AN ADDRESS AT ALL, under `open`.
    //
    // `accept.mjs` enforces this and the page decides whether to show the
    // field, so leaving it unpublished made the two disagree in the worst
    // possible direction: the student was never shown the input, accepted
    // without a claim, and was refused with `rejected:no-claim` for omitting
    // something nobody asked them for. The waiting page then hid the claim
    // causes on the same missing field, so it could not even name what had
    // happened - it offered "the registration cap has been reached" instead.
    // PXL-Automation-II/test-pe3, 2026-09-03.
    //
    // Under `claim` the mode already says so and the page reads roster_mode;
    // this is the `open` + require_claim combination, which has no other
    // signal on the wire. Published as a boolean rather than omitted-when-
    // false, because "absent" here would be indistinguishable from an
    // assignment written before the field existed.
    require_claim: def.roster_mode === "open" ? def.require_claim === true : undefined,
  };
}

/** Card fields a lecturer's save can change, with the words a lecturer knows them by. */
export const CARD_FIELD_LABELS = Object.freeze({
  title: "title",
  description: "description",
  state: "state",
  opens_at: "opening time",
  deadline_at: "deadline",
  timezone: "time zone",
  roster_mode: "who may accept",
  require_claim: "email confirmation",
  max_acceptances: "acceptance limit",
  assignment_type: "assignment type",
  group_config: "team settings",
  claim_domains: "allowed email domains",
  claim_address_format: "email address format",
  repository_name_pattern: "repository name",
  acceptance_mode: "acceptance mode",
  broker_repo: "acceptance repository",
});

/**
 * Where the card students are served differs from the one the saved document
 * makes: `[{ key, label, saved, served }]`, empty when they agree. The count of
 * acceptances is not compared: it changes with every student, not with a save.
 * Compared as JSON, so an omitted key and `undefined` are the same thing - as
 * they are once the card is a file. Over the fields THIS card makes: a served
 * card carrying a field it does not (written by a newer generator than this
 * page) is not a version the lecturer saved differently.
 */
export function cardDifferences(saved, served) {
  const norm = (c) => JSON.parse(JSON.stringify(c || {}));
  const a = norm(saved);
  const b = norm(served);
  // Every key the builder sets, including the ones it sets to undefined: a
  // field the lecturer removed is absent from the saved card and still on the
  // served one, and that is a difference.
  const keys = Object.keys(saved || {}).filter((k) => k !== "accepted_count");
  return keys
    .filter((k) => JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null))
    .map((k) => ({ key: k, label: CARD_FIELD_LABELS[k] || k.replace(/_/g, " "), saved: a[k] ?? null, served: b[k] ?? null }));
}
