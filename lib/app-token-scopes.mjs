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
  // The control repo (checkout, push, the budget owner's issue) plus GET
  // /orgs/{org} and the organization billing-usage endpoint, which a repository
  // list does not restrict.
  ".github/workflows/weekly-usage-report.yml#usage.token": {
    app: "provisioning",
    repositories: [CONTROL_REPO],
    permissions: { contents: "write", issues: "write", metadata: "read", organization_administration: "read" },
  },
  ".github/workflows/weekly-usage-report.yml#usage.token_degraded": {
    app: "provisioning",
    repositories: [CONTROL_REPO],
    permissions: { contents: "write", issues: "write", metadata: "read" },
  },

  // --- Stage 2, dispatched by a person: starter sync, feedback PRs, org setup -

  // open-feedback-prs.mjs, per recorded student repository: GET .../compare
  // (Contents: read), GET and POST .../pulls (Pull requests); then the job
  // pushes the updated records to the control repo (Contents: write).
  ".github/workflows/open-feedback-prs.yml#open-prs.token": {
    app: "provisioning",
    repositories: "all",
    permissions: { contents: "write", pull_requests: "write" },
    reason: "It opens pull requests in the student repositories named in the records, and no list in the YAML can know their names.",
  },
  // GET /repos/{org}/pxl-classroom-control (Metadata), POST /orgs/{org}/repos
  // and PUT /repos/{org}/{repo}/actions/permissions/access (Administration:
  // write), then a git push of the scaffold (Contents: write).
  ".github/workflows/setup-org.yml#setup-control-repo.generate_token": {
    app: "provisioning",
    repositories: "all",
    permissions: { administration: "write", contents: "write" },
    reason: "It creates the control repository, which does not exist when the token is minted, and a list naming it would fail the mint.",
  },
  // sync-starter.mjs and lib/gittree.mjs: template reads (commits, trees,
  // blobs: Contents read), student writes through the git data API (blobs,
  // trees, commits, refs: Contents write), GET and POST .../pulls (Pull
  // requests), POST .../issues (Issues), and the control-repo push. Creating or
  // moving a ref whose commit touches .github/workflows/ needs the set
  // {Contents: write, Workflows: write} in GitHub's reference data, and nothing
  // stops a template commit from touching it.
  ".github/workflows/sync-starter-code.yml#sync-starter.token": {
    app: "provisioning",
    repositories: "all",
    permissions: { contents: "write", pull_requests: "write", issues: "write", workflows: "write" },
    reason: "It reads the template and writes into the student repositories named in the records; no list in the YAML can know their names.",
  },

  // --- Stage 3: acceptance and the deadline, one job per change, drilled ------

  // check-publish-preflight.mjs: GET the template (Metadata) and its commits
  // (Contents: read), GET /orgs/{org} for the plan. The broker: gh repo view
  // (Metadata), gh repo create / POST /orgs/{org}/repos and gh repo edit /
  // PATCH (Administration: write), gh variable set (Variables: write), gh
  // secret set and delete, including the public-key read (Secrets: write), a
  // git fetch and push of .github/workflows/ (Contents and Workflows: write).
  // The control repo: checkout and the state push (Contents: write).
  //
  // Organization administration: read is for the plan alone. GitHub documents
  // an "Organization plan" permission for it, which this App does not hold and
  // must not gain (a new App permission emails every org owner for approval),
  // yet the broad token read it - so read is kept, and a token that cannot see
  // the plan makes the preflight say "not checked" rather than a plan.
  ".github/workflows/publish-assignment.yml#publish.token": {
    app: "provisioning",
    repositories: "all",
    permissions: {
      actions_variables: "write",
      administration: "write",
      contents: "write",
      metadata: "read",
      organization_administration: "read",
      secrets: "write",
      workflows: "write",
    },
    reason: "It creates the broker repository, which does not exist when the token is minted, and a list naming it would fail the mint.",
  },

  // Checkout and the record pushes (Contents: write); read-team-payload.mjs GETs
  // the acceptance issue on the broker (Issues: read) and
  // publish-acceptance-outcome.mjs labels it (Issues: write). ./acceptance,
  // ./provisioning and ./notify mint their own. The label steps run with
  // continue-on-error, so only the label on the issue proves this is enough -
  // which tests/live/drill.mjs checks.
  ".github/workflows/acceptance-handler.yml#accept.token": {
    app: "provisioning",
    repositories: "all",
    permissions: { contents: "write", issues: "write", metadata: "read" },
    reason: "The broker it labels is named by the dispatch payload, which is validated only after the token is minted.",
  },
  // Checkout, the wipe and record pushes, and GET /users/{login}, which is
  // public. ./acceptance, ./provisioning and ./notify mint their own.
  ".github/workflows/retry-acceptance.yml#retry.token": {
    app: "provisioning",
    repositories: [CONTROL_REPO],
    permissions: { contents: "write" },
  },
  // Checkout and the push (Contents: write). close-acceptance.mjs PATCHes
  // INVITE_ENABLED (Variables: write) and DELETEs the broker's secrets
  // (Secrets: write). grade-at-deadline.mjs reads commits (Contents: read),
  // check runs and their annotations (Checks: read) in the student
  // repositories. The composite actions mint their own. Steps 5 and 6 run with
  // continue-on-error: the drill checks the broker is closed; the grading read
  // is not drilled, because no drill assignment grades.
  ".github/workflows/daily-activity.yml#finalize.token": {
    app: "provisioning",
    repositories: "all",
    permissions: { actions_variables: "write", checks: "read", contents: "write", metadata: "read", secrets: "write" },
    reason: "It closes the assignment's broker and reads the student repositories named in the report; no list in the YAML can know their names.",
  },
  // Checkout, pull and the timeline push (Contents: write). deadline-sentinel.mjs
  // lists the org's repositories for pushed_at (Metadata) and reads the
  // assignment (Contents). Stop writes runs lockdown.mjs with STOP_ONLY, which
  // never reaches the owner check: GET and POST/PUT /orgs/{org}/rulesets
  // (Organization administration: write, for the read as well), repository
  // rulesets and the demotion fallback (Administration: write), GET
  // /repositories/{id} (Metadata) and GET /apps/{slug}, which is public.
  // Lockdown degrades rather than fails, so only `lock_method` on the record
  // shows a missing ruleset permission - which the drill checks per row.
  ".github/workflows/deadline-sentinel.yml#watch.token": {
    app: "provisioning",
    repositories: "all",
    permissions: { administration: "write", contents: "write", metadata: "read", organization_administration: "write" },
    reason: "It watches and locks the student repositories named in the records; no list in the YAML can know their names.",
  },
  // Checkout and the push (Contents: write). migrate-org-lock.mjs: GET /apps/{slug},
  // the organization ruleset (Organization administration: write), GET
  // /repositories/{id} and the repository rulesets list (Metadata), and PUT a
  // repository ruleset to disabled (Administration: write). A dry run calls nothing.
  ".github/workflows/migrate-org-lock.yml#migrate.token": {
    app: "provisioning",
    repositories: "all",
    permissions: { administration: "write", contents: "write", metadata: "read", organization_administration: "write" },
    reason: "It disables the repository rulesets of the student repositories named in the lockdown records.",
  },
  // accept.mjs step 7: GET the student repository and, when it exists, GET its
  // rulesets. GitHub's reference data puts both under Metadata: read. A 403 on
  // the rulesets read is taken as the free-plan answer (not frozen), so a token
  // missing it would hand over a frozen repository without a sound -
  // tests/live/drill.mjs retries a locked student to prove the read works.
  "acceptance/action.yml#token": {
    app: "provisioning",
    repositories: "all",
    permissions: { metadata: "read" },
    reason: "It reads the student repository the acceptance would create or reuse, which usually does not exist yet.",
  },
  // provision.mjs: GET the template and the student repository (Metadata),
  // POST .../generate (Administration: write with Contents: read), PUT and
  // DELETE collaborators and invitations on a team switch (Administration), GET
  // contents while the new repository populates, PUT autograding.yml and POST
  // the feedback baseline ref, both of which can carry .github/workflows/
  // (Contents and Workflows: write), and PUT branch protection on the baseline
  // (Administration: write).
  "provisioning/action.yml#token": {
    app: "provisioning",
    repositories: "all",
    permissions: { administration: "write", contents: "write", metadata: "read", workflows: "write" },
    reason: "It creates the student repository, which does not exist when the token is minted.",
  },
  // preserve.mjs: GET the archive (Metadata), POST /orgs/{org}/repos when it is
  // absent (Administration: write), its README (Contents), then git fetch from
  // the student repository and push to the archive. A student's commits carry
  // .github/workflows/ as often as not, and pushing a ref that adds one needs
  // Workflows: write beside Contents.
  "preserve/action.yml#token": {
    app: "provisioning",
    repositories: "all",
    permissions: { administration: "write", contents: "write", metadata: "read", workflows: "write" },
    reason: "It creates the archive repository on first use and reads the student repositories named in the lockdown record.",
  },
  // lockdown.mjs in full mode: everything the sentinel's Stop writes needs
  // (see deadline-sentinel.yml#watch.token) plus the phase-2 reads of each
  // student repository and its commits (Metadata, Contents: read), and GET
  // /orgs/{org}/members?role=admin for the owners it cannot freeze (Members:
  // read). It writes nothing to the control repo itself.
  "lockdown/action.yml#token": {
    app: "provisioning",
    repositories: "all",
    permissions: { administration: "write", contents: "read", members: "read", metadata: "read", organization_administration: "write" },
    reason: "It locks the student repositories named in the records; no list in the YAML can know their names.",
  },
});
