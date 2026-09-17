// PXL Classroom - what every GitHub App token the hub mints is allowed to reach.
//
// `actions/create-github-app-token` with only `owner:` returns a token for EVERY
// repository the installation covers, with EVERY permission the installation
// holds - administration, members, secrets, workflows and organization
// administration at write, on a course organization. It lives for up to an
// hour, and for the whole job it sits in `control/.git/config`, because the
// control-repo checkout persists it and the commit steps push with it. Anything
// that runs in that job after it is minted - our scripts, the npm packages they
// load, a third-party action - can use all of it.
//
// zizmor's `github-app` audit reported 23 of the 27 token steps that way
// (2026-09-17). Narrowing is staged (OPEN-ITEMS.md §10): a missing permission is
// a 403 at the moment of use, and some of these steps run only at a deadline.
//
// THIS TABLE IS THE ONE PLACE A TOKEN'S SCOPE IS DECIDED. The workflow must ask
// for exactly its row; tests/app-token-scopes.test.mjs checks both directions,
// so a new token step fails until someone decides its scope, and a row whose
// step is gone fails too. It proves the YAML and the table agree, and that no
// row asks for more than the App declares. It cannot prove a list is ENOUGH:
// only running the job does (a testbed drill, then the nightly).
//
// Row fields:
//   app          "provisioning" | "broker" - which App's client id the step uses
//   repositories "all" | [names] - `repositories:` on the step, in order
//   permissions  "all" | { permission_name: "read" | "write" } - `permission-*`
//   pending      "stage 2" | "stage 3" - not decided yet (either field is "all")
//   reason       why a field stays "all" on purpose
// A row with any "all" carries exactly one of `pending` or `reason`.
//
// Node-only: it reads deployment.yml through lib/deployment.mjs, and nothing in
// the SPA imports it.
import { CONTROL_REPO, HUB_REPO_NAME } from "./deployment.mjs";

export const APP_TOKEN_SCOPES = Object.freeze({
  // --- Stage 1: the token only checks out the control repo -----------------
  //
  // The composite actions in these jobs mint their own tokens, so the job's
  // token serves the `control` checkout and nothing else.

  // Checkout, then "Commit + push to control repo" with the persisted token.
  ".github/workflows/daily-activity.yml#collect.token": {
    app: "provisioning",
    repositories: [CONTROL_REPO],
    permissions: { contents: "write" },
  },
  // Checkout, a local read (scripts/find-finalizable.mjs), an artifact.
  ".github/workflows/daily-activity.yml#find-finalizable.token": {
    app: "provisioning",
    repositories: [CONTROL_REPO],
    permissions: { contents: "read" },
  },
  // Checkout, a local read (scripts/find-armable.mjs), an artifact.
  ".github/workflows/deadline-sentinel.yml#arm.token": {
    app: "provisioning",
    repositories: [CONTROL_REPO],
    permissions: { contents: "read" },
  },
  // Checkout, ./registry (mints its own), then a push with the persisted token.
  ".github/workflows/reconcile-registry.yml#reconcile.token": {
    app: "provisioning",
    repositories: [CONTROL_REPO],
    permissions: { contents: "write" },
  },

  // --- Stage 2 --------------------------------------------------------------

  // notify.mjs makes five calls, all on the control repo it is handed:
  // GET and POST /issues, GET /issues/{n}/comments, PATCH /issues/comments/{id},
  // POST /issues/{n}/comments. GitHub's REST reference data
  // (github/docs src/rest/data, progAccess) lists `Issues` for each, with
  // `Pull requests` as an alternative set for the comment endpoints, never as
  // a second requirement. Every caller runs it with continue-on-error except
  // retry-acceptance's, which runs only after provisioning already failed.
  "notify/action.yml#token": {
    app: "provisioning",
    repositories: ["${{ inputs.control-repo }}"],
    permissions: { issues: "write" },
  },
  // report.mjs calls GitHub only through notifyEvent (the late-activity and
  // deadline-gap notices), on CONTROL_REPO, so exactly notify's five issue
  // calls; none of the lib/ modules it imports makes a request. Both calls
  // are .catch()ed, so a wrong list would log, never fail a finalize.
  "report/action.yml#token": {
    app: "provisioning",
    repositories: [CONTROL_REPO],
    permissions: { issues: "write" },
  },
  // reconcile.mjs: GET /repos/{org}/{repo} and
  // GET /repos/{org}/{repo}/collaborators/{login}/permission on each recorded
  // student repository - both `Metadata: read` in GitHub's REST reference data -
  // plus notifyEvent's issue calls on the control repo when it finds drift.
  // It reads a 404 as deleted or revoked and writes that into the record, so a
  // list too narrow to see a repository would be believed; the drill compares
  // its drift lines with the broad token's.
  "registry/action.yml#token": {
    app: "provisioning",
    repositories: "all",
    permissions: { metadata: "read", issues: "write" },
    reason: "It reads every student repository named in the records, and no list in the YAML can know their names.",
  },
  // collect.mjs, per recorded student repository: GET /repos/{org}/{repo}
  // (Metadata: read); GET .../commits, GET .../git/matching-refs/tags/submit/
  // and GET .../git/tags/{sha} (Contents: read). GET /rate_limit and
  // GET /users/{login} need no permission. It writes only local files; the
  // workflow commits them with its own token.
  //
  // This one guards evidence, not a notification: inside finalize a failed
  // collect skips lockdown for that assignment, so the drill must reproduce the
  // broad token's snapshot lines exactly before a nightly uses it.
  "collect/action.yml#token": {
    app: "provisioning",
    repositories: "all",
    permissions: { contents: "read", metadata: "read" },
    reason: "It reads every student repository named in the records, and no list in the YAML can know their names.",
  },
  // The control-repo checkout and push, plus generate-interim-reports.mjs,
  // which runs report/report.mjs per published or closed assignment with this
  // token in GITHUB_TOKEN - and report.mjs uses it only for notifyEvent's issue
  // calls on the control repo. ./pages and prune-dashboard.mjs make no calls.
  // A failure here leaves students reading a stale page, not a lost
  // notification, so it is drilled before anything dispatches it.
  ".github/workflows/regenerate-dashboard.yml#generate.token": {
    app: "provisioning",
    repositories: [CONTROL_REPO],
    permissions: { contents: "write", issues: "write" },
  },

  // --- Already narrow -------------------------------------------------------

  ".github/workflows/publish-assignment.yml#publish.broker_token": {
    app: "broker",
    repositories: [HUB_REPO_NAME],
    permissions: { contents: "write" },
  },
  "acceptance/broker-workflow.yml#dispatch.token": {
    app: "broker",
    repositories: [HUB_REPO_NAME],
    permissions: { contents: "write" },
  },
  ".github/workflows/setup-org.yml#setup-control-repo.billing_token": {
    app: "provisioning",
    repositories: "all",
    permissions: { organization_administration: "read" },
    reason: "It probes an organization-level billing endpoint; no repository is involved, so a list narrows nothing.",
  },
  ".github/workflows/weekly-usage-report.yml#usage.token": {
    app: "provisioning",
    repositories: "all",
    permissions: { contents: "write", issues: "write", metadata: "read", organization_administration: "read" },
    pending: "stage 2",
  },
  ".github/workflows/weekly-usage-report.yml#usage.token_degraded": {
    app: "provisioning",
    repositories: "all",
    permissions: { contents: "write", issues: "write", metadata: "read" },
    pending: "stage 2",
  },

  // --- Stage 2: not exam-critical -------------------------------------------

  ".github/workflows/open-feedback-prs.yml#open-prs.token": { app: "provisioning", repositories: "all", permissions: "all", pending: "stage 2" },
  ".github/workflows/setup-org.yml#setup-control-repo.generate_token": { app: "provisioning", repositories: "all", permissions: "all", pending: "stage 2" },
  ".github/workflows/sync-starter-code.yml#sync-starter.token": { app: "provisioning", repositories: "all", permissions: "all", pending: "stage 2" },

  // --- Stage 3: acceptance and the deadline, outside deadline windows ---------

  ".github/workflows/acceptance-handler.yml#accept.token": { app: "provisioning", repositories: "all", permissions: "all", pending: "stage 3" },
  ".github/workflows/retry-acceptance.yml#retry.token": { app: "provisioning", repositories: "all", permissions: "all", pending: "stage 3" },
  ".github/workflows/publish-assignment.yml#publish.token": { app: "provisioning", repositories: "all", permissions: "all", pending: "stage 3" },
  ".github/workflows/daily-activity.yml#finalize.token": { app: "provisioning", repositories: "all", permissions: "all", pending: "stage 3" },
  ".github/workflows/deadline-sentinel.yml#watch.token": { app: "provisioning", repositories: "all", permissions: "all", pending: "stage 3" },
  ".github/workflows/migrate-org-lock.yml#migrate.token": { app: "provisioning", repositories: "all", permissions: "all", pending: "stage 3" },
  "acceptance/action.yml#token": { app: "provisioning", repositories: "all", permissions: "all", pending: "stage 3" },
  "provisioning/action.yml#token": { app: "provisioning", repositories: "all", permissions: "all", pending: "stage 3" },
  "preserve/action.yml#token": { app: "provisioning", repositories: "all", permissions: "all", pending: "stage 3" },
  "lockdown/action.yml#token": { app: "provisioning", repositories: "all", permissions: "all", pending: "stage 3" },
});
