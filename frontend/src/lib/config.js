// PXL Classroom - app configuration, in the SPA.
//
// THIS FILE IS A VIEW ONTO deployment.yml, NOT A SECOND SOURCE OF TRUTH.
//
// It used to hold its own literals - `'pxl-classroom-control'`,
// `'PXL-Digital-Application-Samples'`, `'pxl-classroom'`, the App client id and
// `'Europe/Brussels'` - beside `deployment.yml`, which declares every one of
// those and is documented as "the file you edit, and apart from secrets it
// should be the only one". They were not the same fact written twice; they were
// the fact and its decoy:
//
//   * `TIMEZONE` was exported by BOTH deployment readers, validated as REQUIRED
//     by lib/deployment.mjs (which throws at import if it is missing), and read
//     by NOTHING. The default actually in force was the literal below, so
//     editing deployment.yml changed nothing on screen and nothing in the
//     assignment YAML the Admin Panel writes.
//   * `controlRepo` and `hubOwner`/`hubRepo` had `VITE_*` overrides that would
//     have silently disagreed with the values every workflow and the audit
//     engine read from deployment.yml.
//
// So the deployment facts come from `deployment.js` now and have no VITE
// override, because there is nowhere for a second answer to come from. What
// stays a `VITE_*` knob is what genuinely varies per BUILD rather than per
// deployment: which org a bare visit lands on, and where the published
// assignment data is served from.

import {
  APP_CLIENT_ID,
  CONTROL_REPO,
  HUB_OWNER,
  HUB_REPO_NAME,
  TIMEZONE,
} from './deployment.js'

export const config = {
  // GitHub App client ID (for device flow auth).
  clientId: APP_CLIENT_ID,

  // Default organization for a bare visit. Per-build, not per-deployment: a
  // fork's pilot org is not a property of the software.
  defaultOrg: import.meta.env.VITE_DEFAULT_ORG || 'PXLAutomation',

  // Control repo name.
  controlRepo: CONTROL_REPO,

  // Public assignments data URL (from Pages).
  assignmentsUrl: import.meta.env.VITE_ASSIGNMENTS_URL || '',

  // App name displayed in the UI. The product name stays "PXL Classroom" -
  // that is the software, deployment.yml is the deployment.
  appName: 'PXL Classroom',

  // Timezone assignment dates are DISPLAYED in when one is not set on the
  // assignment itself.
  timezone: TIMEZONE,

  // Hub repository coordinates.
  hubOwner: HUB_OWNER,
  hubRepo: HUB_REPO_NAME,
}
