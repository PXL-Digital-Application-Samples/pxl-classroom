// PXL Classroom - the assignment document the Admin Panel writes.
//
// This lived inside AdminView.vue as `buildDoc()`, and
// tests/contract-form-diagnostics.test.mjs carried a HAND-MAINTAINED COPY of it
// called `vueBuildDoc` - "Helper recreating AdminView.vue's exact buildDoc()
// logic". It had already drifted, silently, and the drift was in the fields
// that matter most:
//
//   * no `invite_key` / `invite_pubkey` - the signed-acceptance keypair
//     (ARCHITECTURE §4.3.2). The copy still emitted only `invite_token`, the
//     format that was withdrawn.
//   * no `claim_domains`, `autograde`, `feedback_pr`, `description`,
//     `unassigned_fallback`.
//   * `min_team_size: Number(...) || 1`, where lib/group-config.mjs's shared
//     default is 0 - the exact decoy-constant failure that module was written
//     about.
//
// So the diagnostics contract was verified against a document shape the Admin
// Panel had not produced for months: a mock that accepts anything tests
// nothing. One implementation, imported by both, is the only version of this
// that stays true.
//
// PURE, and deliberately takes the form state as a PARAMETER rather than
// reaching for a ref: that is what lets a Node test drive it. Same rule as
// lib/effective-deadline.mjs and lib/roster-csv.mjs. The SPA reaches it through
// the thin re-export at frontend/src/lib/assignment-doc.js, like archive-repo.
//
// `#deployment`, never "./deployment.mjs" - this module is ISOMORPHIC, and the
// Node reader uses node:fs / node:url. The subpath resolves to lib/deployment.mjs
// in Node (package.json "imports") and to frontend/src/lib/deployment.js in the
// browser (vite.config.js "resolve.alias"). See the note in lib/archive-repo.mjs.

import { TIMEZONE } from '#deployment'
import { maxTeamSize as teamMaxSize } from './group-config.mjs'
import { cleanChecks } from '../frontend/src/lib/autograde.js'

/** datetime-local string -> UTC ISO, or "" for anything unparseable. */
export function localToUtc(localStr) {
  if (!localStr) return ''
  const d = new Date(localStr)
  // `toISOString()` throws RangeError on an unparseable date, and this runs
  // inside the `shareAssignment` computed - so a hand-edited YAML carrying
  // `deadline_at: soon` took the entire editor pane down during render, with
  // the field that would fix it on the far side of the crash. An empty string
  // instead: the cohort card says "no deadline set", fieldErrors names it, and
  // the schema refuses the save.
  return Number.isNaN(d.getTime()) ? '' : d.toISOString()
}

/**
 * UTC ISO -> the YYYY-MM-DDTHH:MM a datetime-local input wants.
 *
 * AN UNPARSEABLE INSTANT DELIBERATELY YIELDS `NaN-NaN-NaNTNaN:NaN`, not "".
 * That string is what the editor's `fieldErrors` recognises to tell a lecturer
 * "that is not a date the panel can read" for a hand-edited YAML carrying
 * `deadline_at: soon`. Guarding it to "" during the extraction of this module
 * read as defensive and silently removed the error message - the input simply
 * looked empty, Save stayed enabled, and
 * tests/e2e/38-published-cohort-edges.spec.mjs caught it. Empty means "no
 * deadline set"; a broken one has to look broken.
 */
export function utcToLocalInput(utcIso) {
  if (!utcIso) return ''
  const date = new Date(utcIso)
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * Keep the stored instant when the visible local value has not changed.
 *
 * A datetime-local input renders in the BROWSER's zone, so round-tripping an
 * untouched field through localToUtc would rewrite the stored instant for any
 * lecturer whose machine is not in the assignment's zone.
 */
export function preserveOrLocal(localStr, originalUtc) {
  if (!originalUtc) return localToUtc(localStr)
  if (utcToLocalInput(originalUtc) === localStr) return originalUtc
  return localToUtc(localStr)
}

/**
 * Build the assignment YAML document from the editor's form state.
 *
 * REBUILT FIELD BY FIELD, so anything not carried here is DELETED on the next
 * save. That is how editing a published assignment used to wipe its invitation
 * and silently retire every student's link. `tests/admin-lifecycle-ui.test.mjs`
 * fails if the schema allows a field this does not carry - do not remove that
 * test, it is the only thing standing between a new schema field and the same
 * bug for the fourth time.
 *
 * @param {object} form the editor's form state (AdminView's `form.value`)
 * @param {{state?: string|null}} [opts] override the state being saved
 */
export function buildAssignmentDoc(form, { state = null } = {}) {
  const [tplOwner, tplRepo] = String(form?.template || '').split('/')
  return {
    schema_version: 1,
    id: form.id,
    title: form.title,
    ...(form.description ? { description: form.description } : {}),
    organization: form.organization,
    template: { owner: tplOwner || '', repository: tplRepo || '' },
    repository_name_pattern: form.repository_name_pattern,
    opens_at: preserveOrLocal(form.opens_at_local, form._opens_at_original),
    deadline_at: preserveOrLocal(form.deadline_at_local, form._deadline_at_original),
    // deployment.yml's value, not a literal. Baking `Europe/Brussels` in here
    // wrote it into every assignment a fork ever saved, whatever their
    // deployment said - and `TIMEZONE` was validated as required and read by
    // nobody. See frontend/src/lib/config.js.
    timezone: form.timezone || TIMEZONE,
    submission_ref: form.submission_ref || 'refs/heads/main',
    // The commit message a template-owned grading workflow gates on. OMITTED
    // when blank rather than written as an empty marker: absent means "every
    // push grades", and an assignment that never had a hand-in commit should
    // not gain a field saying it has an empty one - `readSubmissionMarker`
    // would refuse it anyway and the schema's minLength would refuse the save.
    ...(String(form.submission_marker_value ?? '').trim()
      ? { submission_marker: { type: 'commit_message', value: String(form.submission_marker_value).trim() } }
      : {}),
    student_permission: form.student_permission,
    acceptance_mode: form.acceptance_mode,
    roster_mode: form.roster_mode || 'enforced',
    late_policy: form.late_policy,
    state: state || form.state,
    ...(form.max_acceptances ? { max_acceptances: Number(form.max_acceptances) } : {}),
    // Ask for an institutional address, and refuse acceptance without one.
    // Only meaningful under `open`: `claim` requires an address inherently, and
    // `enforced` gates by GitHub username and collects none - writing it in
    // either would be a stored value nothing reads.
    ...(form.roster_mode === 'open' ? { require_claim: !!form.require_claim } : {}),
    // Which class groups may accept. OMITTED when empty rather than written as
    // `[]`, because absent and empty mean the same thing here - every group -
    // and an assignment that never restricted anything should not gain a field
    // saying so. Written only when the roster is actually the gate: under
    // `open` the roster does not decide who accepts, so a cohort list there
    // would be a stored value nothing reads.
    ...(Array.isArray(form.class_groups) && form.class_groups.length && form.roster_mode !== 'open'
      ? { class_groups: [...form.class_groups] }
      : {}),
    lock_down_enabled: !!form.lock_down_enabled,
    // Minted by publish-assignment.yml and never edited here - but this rebuilds
    // the whole document, so anything not carried through is deleted. Dropping
    // these silently retires the invitation link already handed to students.
    ...(form.invite_token ? { invite_token: form.invite_token } : {}),
    ...(form.invite_nonce ? { invite_nonce: form.invite_nonce } : {}),
    ...(form.invite_expires_at ? { invite_expires_at: form.invite_expires_at } : {}),
    // The signed-acceptance keypair. invite_key is the link secret and
    // invite_pubkey is what the broker verifies against - dropping either on a
    // save breaks every student's acceptance, the same way dropping the token
    // used to retire every link.
    ...(form.invite_key ? { invite_key: form.invite_key } : {}),
    ...(form.invite_pubkey ? { invite_pubkey: form.invite_pubkey } : {}),
    // Carried, not authored. There is no control for claim_domains yet, so the
    // only way to set one is by hand - and this rebuilds the whole document
    // field by field, so a field it does not carry is DELETED on the next save.
    // That is the invite_token bug exactly: a lecturer who narrowed the allowed
    // domains would have them silently reverted to the deployment default by
    // editing anything else on the assignment, and students accepted under the
    // narrowed list would start being refused.
    //
    // Array.isArray, not a truthy check, so an explicit [] - the deliberate
    // opt-out - survives a save as well.
    ...(Array.isArray(form.claim_domains) ? { claim_domains: form.claim_domains } : {}),
    ...(form.assignment_type ? { assignment_type: form.assignment_type } : {}),
    ...(form.assignment_type === 'group'
      ? {
          group_config: {
            max_team_size: teamMaxSize(form.group_config),
            ...(form.group_config?.min_team_size ? { min_team_size: Number(form.group_config.min_team_size) } : {}),
            formation_mode: form.group_config?.formation_mode || 'self-service',
            allow_team_creation: form.group_config?.allow_team_creation !== false,
            ...(form.group_config?.formation_mode === 'pre-assigned'
              ? {
                  unassigned_fallback:
                    form.group_config?.unassigned_fallback === 'self-service' ? 'self-service' : 'block',
                }
              : {}),
          },
        }
      : {}),
    ...(form.feedback_pr
      ? {
          feedback_pr: true,
          feedback_pr_baseline_branch: form.feedback_pr_baseline_branch || 'pxl-baseline',
        }
      : {}),
    // Included whenever enabled - an empty tests list then fails schema
    // validation visibly instead of being silently dropped from the YAML.
    ...(form.autograde_enabled
      ? { autograde: { enabled: true, execution_environment: form.autograde_execution_environment, visibility: form.autograde_visibility, tests: cleanChecks(form.autograde_tests) } }
      : {}),
  }
}
