// PXL Classroom — app configuration.
//
// These values configure the frontend. In production, set via environment
// variables (VITE_ prefix) at build time.

export const config = {
  // GitHub App client ID (for device flow auth)
  clientId: import.meta.env.VITE_GITHUB_CLIENT_ID || '',

  // Default organization (for single-org pilot)
  defaultOrg: import.meta.env.VITE_DEFAULT_ORG || 'PXLAutomation',

  // Control repo name pattern
  controlRepo: import.meta.env.VITE_CONTROL_REPO || 'pxl-classroom-control',

  // Public assignments data URL (from Pages)
  assignmentsUrl: import.meta.env.VITE_ASSIGNMENTS_URL || '',

  // App name displayed in the UI
  appName: 'PXL Classroom',

  // Default timezone
  timezone: 'Europe/Brussels',
}
