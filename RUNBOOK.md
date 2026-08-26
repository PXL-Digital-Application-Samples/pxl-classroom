# PXL Classroom - Runbook

Operational procedures for setting up, running, and recovering PXL Classroom. Pairs with `ARCHITECTURE.md` (the technical reference).

> [!IMPORTANT]
> ### Where do I start?
> - **Onboarding a new course or academic year organization (e.g. `PXL-2TIN-DevOps-2627`)?**
>   **Do not follow §1.** You do **not** need to deploy a frontend or create a new GitHub App. PXL Classroom is multi-tenant: the central hub and central App serve all organizations. **Jump straight to [Section 2: Onboarding a new organization](#2-onboarding-a-new-organization-per-org)**.
> - **Setting up the entire central PXL Classroom infrastructure from scratch for the first time?**
>   Follow [Section 1: First-time system setup](#1-first-time-system-setup-one-time-central-system-administrator). This is executed **only once** by the central system administrator on the root hub repository (`PXL-Digital-Application-Samples/pxl-classroom`).
> - **Lecturer managing assignments, rosters, and deadlines for your course?**
>   Jump to [Section 4: Creating and publishing an assignment](#4-creating-and-publishing-an-assignment).

---

## 1. First-time system setup (one time, central system administrator)

> [!CAUTION]
> **This section is for the central system administrator ONLY and is performed ONCE for the entire institution.**
> If the central hub (`PXL-Digital-Application-Samples/pxl-classroom`) and the central GitHub App already exist, **skip this section entirely**. To onboard a new course organization, go directly to **[Section 2: Onboarding a new organization](#2-onboarding-a-new-organization-per-org)**.

The hub is `PXL-Digital-Application-Samples/pxl-classroom`. These steps initialize it. They are run once, by an admin who owns the hub.

### 1.1 Enable Pages

1. In GitHub -> `pxl-classroom` -> Settings -> Pages -> Build and deployment -> Source: select **GitHub Actions**.
   > [!NOTE]
   > GitHub displays "Suggested workflows" below this setting. You do **not** need to click "Configure" or create a new workflow - the repository already includes `.github/workflows/deploy-frontend.yml` which GitHub Actions uses automatically.
2. Trigger the initial build: go to Actions -> **Deploy frontend to Pages** -> **Run workflow** (branch `main`).
   > [!NOTE]
   > Running `deploy-frontend.yml` before setting the secrets in §1.3 is completely safe and expected. The data fetch script (`scripts/fetch-pages-data.mjs`) detects that credentials are not configured yet, logs an informational notice, and exits cleanly with an empty index, deploying the frontend shell so the `/setup` page becomes accessible.

### 1.2 Create the central GitHub App

1. In a browser, open the Pages site at `https://<pages-host>/pxl-classroom/setup` (e.g. `https://pxl-digital-application-samples.github.io/pxl-classroom/setup`).
2. Enter the owning **organization** (recommended - leaving it empty registers the App under your personal account) and click **Create GitHub App**. The manifest pre-fills the install-time permissions declared in `frontend/src/views/SetupView.vue`:
   - Repository: **Actions RW**, **Administration RW**, **Contents RW**, **Issues RW**, **Metadata R**, **Pull requests RW**, **Secrets RW**, **Workflows RW**.
   - Organization: **Administration R** (Enhanced Billing usage reports).
   - Device Flow: enabled.
   - Callback URLs: pre-filled for your Pages domain.
3. Confirm on GitHub's page.
   > [!NOTE]
   > **App Name Uniqueness & 34-Character Limit:** GitHub App names must be **globally unique across GitHub.com** and **at most 34 characters long**. The manifest automatically generates a scoped name (e.g. `PXL Classroom (<org>)` or `PXL (<org>)`). If GitHub reports "Name already taken", adjust the name in the text field to any unique name up to 34 characters (e.g. `PXL Provisioner 2627` or `PXL (<org>)`) and click **Create GitHub App for <org>**.

   GitHub redirects back to `/setup`, which exchanges the one-time manifest code and shows the new App's **App ID**, **Client ID** (string starting with `Iv…`), and a **Download .pem** button for the private key. These are shown **once** - store them per §1.3 immediately. (If the exchange fails - the code is single-use and expires after one hour - the App still exists: collect the IDs from the App settings page under "About" and use **Generate a private key** there.)
4. Account permissions are **not in the installation manifest** and need to be set manually on the App settings page after creation, before installing the App on any org:
   - Account: **Starring RW** - legacy. Acceptance no longer stars the broker (ARCHITECTURE §4.3.2); the student opens an issue carrying their signed invitation. Harmless to leave granted.
   - Account: **Email addresses: Read** - **required by the claim flow.** A student confirms one of their own GitHub-*verified* addresses, which is a user-to-server read of `/user/emails`; an installation token cannot read it at all, and without the declaration the SPA's user token is not scoped for it either. Set by you alone - no organization owner approves account permissions. `scripts/check-app-declaration.mjs` (weekly) warns until it is set; it deliberately does not fail, because nothing consumes it until the claim flow ships.

### 1.3 Set hub secrets

In `pxl-classroom` -> Settings -> Secrets and variables -> Actions:

| Secret | Value |
|---|---|
| `PXL_APP_CLIENT_ID` | Client ID from §1.2 (the `Iv…` string). Required by `actions/create-github-app-token` - the older `app-id` input is deprecated. |
| `PXL_APP_PRIVATE_KEY` | full PEM body from §1.2, including BEGIN/END lines |
| `VITE_GITHUB_CLIENT_ID` | Same Client ID as `PXL_APP_CLIENT_ID`; used at SPA build time to wire the device flow. |
| `VITE_CORS_PROXY_URL` | Optional. Defaults to `https://corsproxy.io/?url=`. See ARCHITECTURE.md §10.2 for the threat model. MUST end in `?url=` or `?` (`?` is auto-rewritten to `?url=`); anything else throws at SPA init. |
| `PXL_INVITE_SIGNING_KEY` | Ed25519 private key that signs invitation tokens. See §1.3.1. `publish-assignment.yml` fails closed without it. |

#### 1.3.1 Invitation signing keypair

Acceptance is triggered by a public event on a public repository, so anyone can fire a broker. The signed invitation token is what makes an unauthorized trigger cost nothing: the broker verifies it before minting an App token (ARCHITECTURE §4.3.2).

```bash
node scripts/generate-invite-keypair.mjs 1
```

1. Pipe the **private** half into the hub secret. Do not paste it into a terminal you are sharing, and do not commit it:

   ```bash
   gh secret set PXL_INVITE_SIGNING_KEY --repo PXL-Digital-Application-Samples/pxl-classroom < key.pem
   ```

2. Put the **public** half in `acceptance/invite-keys.json` under its key id and commit it. It belongs in a public repository: every broker reads it from a hub checkout, and a public key is what lets the broker reject a forged token without holding anything worth stealing.

3. Delete the local `key.pem`.

**Rotation.** Generate with the next key id, keep the previous entry in `invite-keys.json` so links already in circulation keep verifying, and set the `INVITE_KID` repository *variable* on the hub to the new id so new links use it. Drop the old entry once every assignment signed with it is closed.

**Retiring one assignment's links** does not need the key: republish it with `regenerate_invite: true`, which mints a new nonce *and* a new acceptance keypair, and writes both to the broker's `INVITE_NONCE` and `INVITE_PUBKEY` variables. Every previously issued link for that assignment then stops working - and anyone who follows one lands on a page saying it is out of date and to ask you for the current one, rather than on a "not found" that could mean three different things. Plain republishing keeps the existing link alive, so a repair does not silently break links the day before a deadline. In the Admin Panel this is **Regenerate link →**, in the share block beside the link it retires; it opens the republish dialog with the box already ticked and states the consequence before you confirm. The same dialog reached from *Lifecycle → Republish broker* arrives **unticked**, because that path is a repair.

**Switching acceptance off** without deleting anything: set the broker's `INVITE_ENABLED` variable to `false`. It is read in the workflow's job-level `if`, so GitHub skips the run without allocating a runner.

**"Invitation Exposure" is failing in System Health.** Acceptance opens an issue on the public broker whose *title* carries the invitation. The broker redacts that title within seconds, so under normal operation there is nothing to find - a leftover means the **redaction** did not run.

The issue itself is never deleted, and cannot be: `deleteIssue` refuses an App installation token with `FORBIDDEN: Viewer not authorized to delete`, measured live 2026-08-26 in two organizations that both grant the App `administration: write`. Only a user token with repository admin can delete an issue, and this system holds no such credential by design. Deleting leftovers by hand is therefore a manual step, and after the move to signed acceptance it is tidying rather than an exposure - the title is a signature naming one account, not a link.

A leftover means one of these:

1. **The broker's redaction step did not run or failed.** Check the broker's own Actions run for that acceptance - `Redact and close trigger issue` on the accepted path, `Reject invalid invitation` on the rejected one. Both need only `issues: write`, which `github.token` on the broker has, so a failure here is a dead run or a workflow that predates the step rather than a permission.

   Remove the leftovers with your **own** account, which must have repository admin (being an org owner is not automatically enough):

   ```bash
   gh issue list --repo <org>/broker-<assignment-id> --state all --search 'in:title pxl-accept' --json number,id
   gh api graphql -f query='mutation($id:ID!){deleteIssue(input:{issueId:$id}){clientMutationId}}' -F id=<issue node id>
   ```

   Do **not** chase App permissions for this. An installation token cannot delete an issue whatever it is granted (see above), and older wording in this runbook sent people to approve `Administration: write` on organizations that already had it.

2. **`INVITE_ENABLED` is `false`.** The job-level `if` skips the whole run, cleanup included, so an issue opened while acceptance was switched off simply sits there.

3. **A run died between the dispatch and the cleanup.**

In every case: delete the listed issues, then republish with `regenerate_invite: true`. Redaction is not enough on its own - a rename is still visible in the issue timeline, so a token that was exposed has to be retired, not just hidden.

```bash
gh issue list --repo <org>/broker-<assignment-id> --state all --search 'in:title pxl-accept' --json number,title
gh issue delete --repo <org>/broker-<assignment-id> <number> --yes
```

#### 1.3.2 Migrating an assignment to signed acceptance

There is one republish per assignment that **cannot** keep its links alive, and it is not optional.

Until signed acceptance shipped, the invitation itself travelled in the acceptance issue's title - and that title lands in GitHub's public event feed, which GH Archive mirrors permanently. Measured 2026-08-25: one unauthenticated `curl` against a broker's `/events` returned a live token on an issue that had already been deleted. The link now carries a private key and the student's browser signs with it, so the event carries a signature instead (ARCHITECTURE §4.3.2).

An assignment moves across when it is next published. Nothing is automatic and nothing is scheduled: until you republish, that assignment keeps working exactly as before.

**What to do, per published assignment:**

1. Open it in the Admin Panel. If it still uses the old format, *Republish broker* carries a warning saying so - that warning is the migration flag.
2. Republish. This mints the keypair, sets `INVITE_PUBKEY` on the broker, and rewrites the broker's workflow.
3. **Copy the new link and send it to anyone who has not accepted yet.** This is the part nothing can do for you.

**What students holding the old link see.** Not a 404: the old digest keeps resolving, to a page saying *"This invitation link is out of date - ask your lecturer for the current one."* Their repositories, if they already accepted, are untouched.

**Verify it worked** with *Troubleshoot* on the assignment. Tier 4 checks the assignment's `invite_key` and that the broker's `INVITE_PUBKEY` matches it. A missing or mismatched public key fails **every** acceptance in silence, and is exactly what a half-completed republish leaves behind - so check it rather than assuming.

It also catches the inverse, which is the more dangerous half: a broker that has `INVITE_PUBKEY` for an assignment whose keypair was never committed. The publish workflow sets that variable and pushes the broker's workflow in one step and commits the assignment afterwards, so a failure in between - an org ruleset rejecting the push - leaves the broker verifying signatures while every student's link is still the older kind. Every acceptance is then refused as out of date, and the token, key id and nonce all still check out, so nothing else says a word. Republishing fixes it.

**Do not** hand-edit `invite_key` or `invite_pubkey` in a control repo. They are one pair; changing either half alone locks the cohort out.

#### 1.3.3 The `provisioning` environment

Every hub job that holds `PXL_APP_PRIVATE_KEY` or `PXL_INVITE_SIGNING_KEY` declares `environment: provisioning`. That environment allows deployments from `main` only, and a job naming an environment does not start when the run's ref is outside the policy - which is what stops a `workflow_dispatch --ref <other-branch>` from running hub code with a credential in scope (ARCHITECTURE §4.3.4).

Create it once, on the hub:

```bash
gh api --method PUT repos/PXL-Digital-Application-Samples/pxl-classroom/environments/provisioning -f 'deployment_branch_policy[protected_branches]=false' -f 'deployment_branch_policy[custom_branch_policies]=true'
```

Then add `main` as the only allowed branch:

```bash
gh api --method POST repos/PXL-Digital-Application-Samples/pxl-classroom/environments/provisioning/deployment-branch-policies -f name=main -f type=branch
```

Do **not** add required reviewers or a wait timer: acceptance runs synchronously and would stall behind an approval.

**Where each secret lives.** `PXL_APP_PRIVATE_KEY` and `PXL_INVITE_SIGNING_KEY` are **environment** secrets on `provisioning`, with no repository-level copy - a job that does not name the environment cannot read them. `PXL_APP_CLIENT_ID` remains a repository secret on purpose: a client id is not secret and already ships in the SPA bundle.

If you ever re-add one at repository level, note that it silently shadows nothing - environment secrets win for jobs that name the environment - but it does hand the value to any job that does not. `tests/workflow-hardening.test.mjs` fails CI if such a job appears.

**Blocking ad-hoc branch creation.** Not yet applied. A ruleset stops anyone but an admin creating branches on the hub, which removes the other half of the branch-ref path. `participating-orgs` is excluded because `setup-org.yml` creates it on a fresh hub:

```bash
gh api --method POST repos/PXL-Digital-Application-Samples/pxl-classroom/rulesets --input ruleset.json
```

with `ruleset.json` containing target `branch`, enforcement `active`, rule `creation`, `conditions.ref_name.include` of `~ALL` excluding `refs/heads/participating-orgs`, and bypass actors for OrganizationAdmin and the repository admin role.

### 1.4 Install the App on the hub's owning org, scoped narrowly

The broker workflows mint tokens against this installation to dispatch into the hub. Scope it tightly.

1. App settings page -> **Install App** -> choose `PXL-Digital-Application-Samples`.
2. **Only select repositories** -> tick `pxl-classroom` only.
3. Confirm install.

Verify: `gh api /app/installations` (with App-level JWT) should show this installation with `repository_selection: selected` and `repositories: [pxl-classroom]`.

### 1.5 Branch protection on `main`

`pxl-classroom` is public. The workflows are the highest-value target. The repo is maintained by direct pushes to `main` (no pull requests), so PR-review and required-status-check rules are deliberately **not** used - a required status check rejects any direct push, because the pushed commit cannot have a passing check yet. CI still runs on every push and fails loudly.

Configure (both branch rules can be applied via the API, see below):

- Branch rule for `main`: block force-pushes and deletions, **including for administrators**. No PR requirement, no required checks, no signed-commits requirement.
- Settings -> Code security: enable secret scanning **and** push protection.

```
printf '{"required_status_checks":null,"enforce_admins":true,"required_pull_request_reviews":null,"restrictions":null,"allow_force_pushes":false,"allow_deletions":false}' | \
  gh api -X PUT repos/PXL-Digital-Application-Samples/pxl-classroom/branches/main/protection --input -
```

### 1.6 Protection on `participating-orgs` branch

This branch is the registry of participating orgs. The Setup-Organization workflow commits to it directly from automation, so it must accept plain pushes. Apply the same rule as `main` (force-push and deletion blocking only - same API call with `participating-orgs` in place of `main`).

### 1.7 Verify

```
# Hub is public, Pages is live
curl -I https://pxl-digital-application-samples.github.io/pxl-classroom/

# App exists and is correctly scoped
gh api /app
gh api /app/installations
```

### 1.8 SPA directory structure

Do not move `frontend/` to a subdirectory without updating `frontend/vite.config.js` `server.fs.allow` - `lib/dashboard-aggregate.mjs` is imported from outside the SPA root.

System is now ready to onboard the first organization.

---

## 2. Onboarding a new organization (per org)

> [!NOTE]
> Follow this procedure whenever a lecturer wants to use PXL Classroom for a new course or academic year organization (e.g. `PXL-2TIN-DevOps-2627`).
> **You do NOT need to deploy a frontend or create a new GitHub App.** All course organizations connect to the existing central hub (`PXL-Digital-Application-Samples/pxl-classroom`) and use the existing central GitHub App!

Done by a system administrator together with the organization owner.

### 2.1 Install the central GitHub App on the new org

> [!TIP]
> A lecturer does not need this section to get started. Signing in to the SPA gives
> them **Connect an organization** - in the org switcher, and on the dashboard when
> they have no orgs yet - which opens GitHub's own installation picker. The SPA then
> walks them through what is left. This section is the reference for what that flow does.

1. Organization owner: Open the installation page for the central **PXL Classroom Provisioner** App (e.g. `https://github.com/apps/pxl-classroom-provisioner` or through the App settings -> **Install App**).
2. Choose the target organization (e.g. `PXL-2TIN-DevOps-2627`).
3. Scope: **All repositories** (the App needs Administration RW across the org to provision student repos and manage permissions).
4. Confirm installation.

Repository access **must** be "All repositories" - "Only select repositories" makes provisioning fail once students accept.

The manifest at `/setup` declares Organization **Administration: Read**, but the manifest only applies at App *creation*. If the App predates that manifest entry it does not hold the permission, and no installation - however fresh - can receive it. Confirm before onboarding:

```bash
gh api apps/pxl-classroom-provisioner --jq .permissions
```

If `organization_administration` is absent, the App owner must add it first (§10.6); otherwise Setup Organization fails at its billing preflight (§6.7).

### 2.2 Run Setup Organization

In `pxl-classroom` -> Actions -> **Setup Organization** -> Run workflow:

| Input | Value |
|---|---|
| `target_org` | `PXLAutomation` (or other org login) |

The workflow:

- Mints a least-privilege token and probes the Enhanced Billing Usage API. Onboarding stops with an actionable error if Organization Administration has not been approved or Enhanced Billing is unavailable.
- Mints the full provisioning token for the new org's App installation.
- Creates `<org>/pxl-classroom-control` (private) if it doesn't already exist.
- Pushes an initial scaffold (`assignments/`, `acceptances/`, `repositories/`, `observations/`, `lockdowns/`, `reports/`, `public/`).
- Adds the org to `participating-orgs.yml` on the `participating-orgs` branch.

### 2.3 Configure the org's Actions budget

**Default: leave the spending limit at €0.** All hub workflows (provisioning, collection, finalize, dashboards) run on the public hub repo and are free. The only Actions billed to a participating org are workflows inside its private student repos - student-side autograding and any CI students add themselves - and those first draw from the plan's included minutes (GitHub Team: 3,000 min/month). With a €0 limit nothing can ever bill, and an acceptance-spam attacker cannot rack up cost.

1. Org -> Settings -> **Billing & Licensing** -> **Budgets and alerts** -> **New budget**: Product-level budget -> **Actions** -> scope: entire organization -> amount **€0** -> toggle **"Stop usage when budget limit is reached"** ON -> check "Receive budget threshold alerts" with the budget owner as recipient -> Create.
2. Note: GitHub's alert emails fire at fixed 75/90/100% *of the budget amount*, so on a €0 budget they provide no early warning - they become useful only if the budget is later raised. Early warning on included-minutes consumption comes from the system's own weekly usage report, which checks each org against `limits.yml` and @-mentions the `budget_owner_login` in the Instructor Notifications issue.

Raise the limit per the table below **only when** the autograding workload actually exhausts the included minutes:

| Class size | Suggested limit when raising | Headroom |
|---|---|---|
| ≤ 50 students | €60 / month | ~10,000 min ≈ 200 min/student |
| 51-150 students | €120 / month | ~20,000 min ≈ 130 min/student |
| 151-500 students | €250 / month | ~42,000 min ≈ 80 min/student |

Bursty courses (Terraform, container builds) need higher limits; size the budget against the actual workload, not the headcount.

**What 100% means:** GitHub stops Actions on private repos in that org. Student-owned CI runs queue and never start. The hub side is unaffected (hub Actions are free - public repo). What you do at 100%: confirm with budget owner; raise if appropriate; otherwise communicate to students that CI is paused until the next monthly reset (integrity layer - lock-down, preservation, reports - continues to run).

### 2.4 Grant lecturers access to the hub repo

Lecturers trigger **Publish** from the Admin Panel and **Retry acceptance** from a student's row on the tracking view; both dispatch workflows on `PXL-Digital-Application-Samples/pxl-classroom` using the lecturer's own token. Without collaborator access to the hub repo, `workflow_dispatch` returns 403 and the SPA shows a detailed error toast (e.g. `Trigger failed (403): ... Most often: the App needs actions:write, or you're not a collaborator on the hub repo with write access`).

- Add each org's lecturers as **Write** collaborators (or members of a team with write) on the hub repo.
  `workflow_dispatch` requires write - Read is not enough, and produces exactly the 403 described above.
- Without this access, the lecturer can still create/edit assignments (writes go to their own control repo), but cannot publish or retry from the SPA - a hub admin must run those workflows on their behalf.

### 2.5 Register the budget owner

Edit `participating-orgs.yml` on the `participating-orgs` branch - add or update the entry:

```yaml
orgs:
  - login: PXLAutomation
    budget_owner_login: tomcoolpxl       # GitHub login, used for @-mention in weekly usage report
    budget_owner_email: tom.cool@pxl.be  # optional, informational only
    overrides:                           # optional per-org SKU overrides
      "Actions Linux": 2000
```

Schema: `schemas/participating-orgs.schema.json`. See §10 for what `overrides` means and how thresholds are resolved.

---

## 3. Per-org budget policy

Each participating org must have:

- A named human **budget owner** (`budget_owner_login` in `participating-orgs.yml` - GitHub login).
- A configured **Actions spending limit** in GitHub UI (≥ recommended floor in §2.3) - the hard stop.
- **Billing alerts** at 50% / 80% / 100% routed to the budget owner - early warning.

Beyond GitHub's own limit/alerts (which are EUR-based), PXL Classroom runs its own **weekly per-SKU threshold check** that fires before the EUR cap is hit. See §10 for tuning the thresholds. The two systems are complementary:

- **GitHub's spending limit** stops Actions when EUR is exceeded. A blunt, after-the-fact cutoff.
- **PXL Classroom's weekly check** warns the budget owner on Monday morning when *any* repo's actual usage (minutes, storage GiB·h, etc.) crosses a configured threshold. Catches outliers - e.g. a repo accumulating storage with zero CI activity - that the EUR view hides.

The hub side itself has no per-org cost (public repo). Everything billed lives in the participating org and is bounded by the limit there.

---

## 4. Creating and publishing an assignment

Done by a lecturer.

### 4.1 Create the template repository

1. In your organization, create a new repository whose name starts with `template-` (e.g., `template-automation-pe-1`).
2. Settings -> General -> tick **Template repository**.
3. Add starter code, `.github/workflows/` for the student's own CI, and assignment instructions. Anything you commit here becomes the student's starting point.

**A fork can be a template**, and that used to be invisible: GitHub's repository search omits forks unless the query says `fork:true`, so a forked template was missing from the picker with no error and the wall claiming the org had none. The query carries the qualifier now. If a template still does not appear, the other cause is **search indexing lag** on a brand-new repository - type `owner/repo` into the box directly, which probes the repository via the REST API instead and works immediately.

Step 2 is the one people miss, and it is the most common reason the Admin Panel's template list is empty: a repository that is not ticked as a **Template repository** does not appear in `is:template` search results, whatever it contains. The form says so in place now - an organization with no templates gets the explanation and a link to `https://github.com/organizations/<org>/repositories/new` rather than one line assuming you know what a template is. The text box stays usable in that state on purpose: typing `owner/repo` by hand is the only way to name a template in another organization, and the panel probes it live and reports back.

### 4.2 Define the assignment in the Admin Panel

1. Open the dashboard: `https://<pages-host>/pxl-classroom/dashboard/<org>`.
2. Sign in with device flow.
3. Click **Admin Panel**.
4. Click **New assignment** and fill the form:

| Field | Note |
|---|---|
| Title | shown to students |
| Slug (URL identifier) | URL-safe, auto-derived from the title, e.g. `linux-processes-2026`. The Admin Panel checks for duplicate slugs in the local list and queries the control repo's Contents API to block silent overwrites. |
| Template repository | pick from template repositories in your org (repositories marked as templates on GitHub) |
| Repository name pattern | must contain `{github_login}` (individual) or `{team_slug}` (group), e.g. `linux-processes-{github_login}` or `group-project-{team_slug}` |
| Collaboration Model | **Individual** (1 student per repository) or **Group** (multi-student collaboration per repository with `max_team_size`, optional `min_team_size` under-capacity warning, and self-service team creation toggles) |
| Opens at / Deadline | local time, automatically converted to UTC for storage. The deadline must be after the open date; a deadline in the past shows a warning (the next nightly run would finalize immediately) |
| Who may accept | **`enforced` by default** - only logins in `students/roster.yml`. The form shows the live count underneath and links to the **Roster** tab: `No students imported yet - nobody can accept`, `213 students on the roster`, or - when the `github_login` column is still empty - `213 students on the roster, but none has a GitHub username yet - nobody can accept`. That last one is the trap: `github_login` is optional in the CSV and is the only field acceptance matches on, so a roster imported before students hand in their usernames blocks everybody. Switch to `open` only for a cohort you do not know up front, e.g. an exam - it removes the roster gate entirely and then requires a cap (§12.4). |
| Max acceptances | guardrail: cap on accepted students (default **50**; leave empty for **no cap at all** - nothing substitutes a number for you; 0 is rejected). Mandatory under `open` (§12.4). |
| Lock down student repos at the deadline | default on |
| Open a draft Feedback PR for each student | optional - creates a protected `pxl-baseline` branch at provisioning (see §12.7) |
| Automated checks | optional - one line showing what is configured (`Off`, `3 checks · run on your machine`, `2 checks · run in student repos, hidden`) with **Set up** / **Edit** / **Remove** beside it. Everything else is in the modal behind it (see §12.9). |

5. The Admin Panel validates against `assignment.schema.json` and commits `assignments/<id>.yml` to your control repo via the Contents API with your own lecturer token. **Save as draft** keeps it invisible to students.

### 4.2b Reuse the groups from an earlier group assignment

Students should not have to re-form the same teams for every group assignment. Seeding copies an existing grouping into the new assignment; each student then confirms their group with one click instead of picking a team.

1. Create and **save** the new group assignment first - teams are stored under its ID, and the seed reads its team size and repository pattern, so the button stays disabled while the form has unsaved edits.
2. Open the assignment's **Teams** tab (or the group section of the editor) and click **Seed teams**.
3. Pick a source:
   - **A previous group assignment** - the normal choice. It carries the *final* membership, including switches and dropouts, so always seed from the most recent grouping rather than from the first one.
   - **The roster's team columns** - for the first group assignment of a course, when you already have the groups elsewhere. Fill `team_slug` / `team_name` via the Roster tab's CSV import (§12.4) first.
4. Review the plan. It lists every team and its members before anything is written, and refuses outright if:
   - a team is larger than the new assignment's maximum team size (raise the maximum or split the team - members are never dropped silently);
   - the new assignment shares a repository name pattern with the source. **Fix this one before anything else**: both assignments would resolve to the same repository names, and provisioning would hand students the previous assignment's locked-down repository instead of a fresh one;
   - the pattern has no `{team_slug}`.
5. Warnings do not block. Expect them for students who left the roster, teams below the minimum size, and teams students have already formed in the new assignment (those are kept untouched - seeding never overwrites real membership).
6. Applying writes every team in one commit and dispatches `regenerate-dashboard.yml`, which is what makes the teams visible to students. Nothing is published while the assignment is still a draft, so seed, review in the Teams tab, adjust, and publish.

Afterwards the Teams tab shows a "carried over from …" line, a standing "N students on the roster have no team" line naming who is left to place by hand, and - once the assignment is published - dimmed members with a per-team "N not accepted yet" count.

**Seeded the wrong source?** The Teams tab's **Undo seed (N)** button (or `pxl-classroom teams unseed --assignment <id>`) deletes the carried-over teams in one commit. It only ever removes teams that came from a seed, have no repository, and have no member who has accepted; anything a student has already joined is kept and reported in the confirmation. On a draft that is all of them, which is why reviewing before publishing is the cheap moment to change your mind. **Seeding is not enrolment**: the repository is created when the first member accepts, and each other member only gets access once they accept too.

Headless equivalent:

```bash
pxl-classroom teams seed --org <org> --from <previous-assignment-id> --to <new-assignment-id> --dry-run
```

Drop `--dry-run` to apply. `--from-roster` uses the roster columns instead; `--yes` skips the confirmation prompt when the plan has warnings; `--no-publish` skips the dashboard regeneration (the teams then stay invisible to students until it runs).

**Students with no carried-over group** - late enrollers, Erasmus arrivals, anyone whose partners all dropped out - depend on the assignment's formation mode:

| Formation mode | Unassigned student sees |
|---|---|
| Self-service (default) | The normal join/create tabs. Nothing to configure. |
| Pre-assigned, "Let students with no assigned team form their own" **off** | "No Pre-Assigned Team - contact your instructor". You add them from the Teams tab. |
| Pre-assigned, that box **on** | The join/create tabs, exactly like self-service. |

Under self-service, a carried-over group is a strong default rather than a lock: the student can still use **Choose a different group**. Under pre-assigned, they cannot, and a request naming another team is rejected server-side.

### 4.3 Publish

In the editor -> click **Save & publish** in the header bar (on an existing draft, *Lifecycle -> State -> **Publish (create broker, enable nightly)*** does the same). The panel watches for the broker repo and confirms when the accept link is live.

Once it is published, opening it again leads with the invitation link, an accepted/deadline summary and a link to the tracking page; the six fieldsets move behind **Edit settings** and *Lifecycle* separates **Repair** (Republish broker) from the state transitions below it.

If the workflow dispatch fails (typically 403 - you're not a hub collaborator, see §2.4), the panel automatically reverts the assignment to **draft** so the YAML never claims "published" while no broker exists. Fix hub access, then publish again.

This dispatches `publish-assignment.yml`, which:

- Creates `<org>/broker-<id>` (public).
- Pushes the broker's `acceptance-trigger.yml` workflow.
- Sets variables on the broker (`ASSIGNMENT_ID`, `CONTROL_ORG`).
- Flips `state` from `draft` -> `published` in the control repo.
- **Enables the nightly workflow** (`gh workflow enable daily-activity.yml`). From here on, the nightly cycle is active for your org.

### 4.4 Share the link

The student-facing URL is the invitation link: `https://<pages-host>/pxl-classroom/<org>/i/<invite-token>`. It cannot be constructed from the assignment id - the token is minted at publish time and recorded in the control repo (ARCHITECTURE §4.3.2).

**Where to find it.** The **Share with students** block appears in four places, and you never have to open the editor to reach it:

| Where | What you get |
|---|---|
| The banner after publishing, in the Admin Panel | The link, **Copy**, **Open** (the page a student sees), and **Regenerate link →** |
| The assignment's detail page, under the header | The same block, with the live accepted count feeding its status |
| Each published row in the Admin Panel's assignment list | A copy button |
| Each published card on the dashboard | A copy button |

The link is shown truncated - hover it for the whole thing, and Copy always puts the full URL on the clipboard. The status line underneath is what a **student** would see if they opened it right now: `Live`, `Opens <date>`, `Closed`, or `Cap reached`. If it says `Published, but no link`, the invitation was never minted - republish (§12.5).

That's the only URL students need. They open it, sign in, click Accept, wait ~30 seconds, get a repo link.

---

## 5. Day-to-day monitoring

### 5.1 The Instructor Notifications issue

Each org's control repo has an open issue titled **PXL Classroom - Instructor Notifications**. The system posts (or updates) a comment for each significant event:

| Event | Meaning |
|---|---|
| `provisioning-failed` | A student accepted but the repo wasn't created. Most often: GitHub rate limit during a burst. The student retries by opening their invitation link again. |
| `acceptance-rejected` | A student was turned away - not on the roster, outside the window, or the cap is full. The reason is in the comment. Deduped per assignment+login+reason, so a student retrying the same closed door updates one comment rather than adding another. |
| `collection-failed` | The nightly collect step couldn't reach a student's repo. Usually transient. |
| `deadline-gap` | An observation gap straddles a deadline. Reduces evidence quality; mention in grading. |
| `missing-access` | The reconcile step found a repo where the student's admin grant has been revoked. |
| `unexpected-deletion` | A managed repo was deleted. See §6 (Student deleted their repo). |
| `late-activity` | Activity observed after the deadline. Reports include details. |
| `preservation-failed` | The archive copy of the deadline SHA didn't succeed. |

Make this issue your daily checklist.

### 5.2 The dashboard

Same Pages URL: `/dashboard/<org>`. Per-assignment overview, per-student table, search and filter by status, CSV/JSON export.

The dashboard reads the **aggregate** `reports/dashboard.json` from your control repo in one fetch with your lecturer token. It refreshes when the nightly run completes or when a student accepts (both trigger `regenerate-dashboard.yml`).

---

## 6. Edge cases

### 6.1 Student deleted their repository

The reconcile step posts `unexpected-deletion` in Instructor Notifications.

To restore:

1. In the control repo, delete `repositories/<id>/<login>.json`.
2. (Optional) delete `acceptances/<id>/<login>.json` if you want them to re-confirm acceptance.
3. Ask the student to open their invitation link and accept again. The acceptance handler re-provisions because the registry no longer shows them.

### 6.2 Grant an extension

1. Open the assignment's **roster & progress** page (`/dashboard/<org>/<assignment-id>`) and click the **···** action on the student's row.
2. Fill: new deadline, reason. The login comes from the row, so there is nothing to type from memory - the Admin Panel's own copy of this form was deleted for that reason (UX_PLAN WS5). The Lifecycle block in the editor links here.
3. The modal shows any extension already in force, then commits `overrides/<id>/<login>.json` (validated against `override.schema.json`), appending to the existing history rather than replacing it.
4. The next nightly run recomputes `effective_deadline_at` for this student, or the lecturer can trigger a Refresh in the assignment detail view to reclassify and commit the updated status immediately; the dashboard updates after `regenerate-dashboard.yml` runs.

**Grant it before the deadline passes.** While the extension runs, the nightly finalize leaves that student's repository open and records them as `deferred` in `lockdowns/<id>/lockdown-record.json` - everyone else is locked at the deadline as normal - and the assignment stays "active" so `daily-activity.yml` keeps observing their work. Once the extension expires, the assignment is re-queued automatically and that student is locked down, preserved and reported (ARCHITECTURE §6.2.2).

On a **group** assignment an extension granted to one member applies to the whole team, because they share one repository.

To see who is deferred, open `lockdowns/<id>/lockdown-record.json` in the control repo: deferred students carry `deferred_until` and a null `snapshot_sha`, and `deferred_count` sits beside `locked_count`.

### 6.2a An extension granted after lock-down does not reopen the repository

Lock-down is a permission change (student -> `pull`) and nothing currently reverses it. If a student has already been locked down and you grant an extension anyway, the override is recorded and `report.mjs` will use it to classify their submission, but they cannot push. Restore write access manually:

```bash
gh api -X PUT repos/<org>/<repo>/collaborators/<login> -f permission=push
```

Then delete `lockdowns/<id>/lockdown-record.json`'s entry for that student, or the next finalize will re-lock them at the frozen snapshot. Grant extensions before the deadline wherever possible.

### 6.2b Deciding what happens to late work

Two independent switches in **Guardrails**, and until August 2026 neither did anything - `late_policy: block` never refused a push and `lock_down_enabled` never decided anything, because lockdown demoted every student on every assignment.

| Setting | At the deadline |
|---|---|
| **Late work: Counts** (default for new assignments) | Nothing is blocked. Late commits are part of the submission and flagged in the report. |
| **Late work: Does not count** | The submission branch is locked with a repository ruleset. Students keep their repository, Actions, secrets and runners - they simply cannot push, force-push or delete that branch. |
| **Also take admin away** | The student is demoted to read-only, losing Actions and secrets too. Defaults **on** for assignments that predate this change, and comes **off** when you pick "Does not count" (the branch lock already stops pushes). |

Two things to tell students honestly:

- **The lock fires on the first nightly run after the deadline, not at the deadline itself.** Anything pushed in between is filtered out - the submission falls back to the last commit *committed* before the deadline. That date comes from the student's own machine (`GIT_COMMITTER_DATE`), so it reconstructs the ordinary case correctly and is not evidence in a dispute.
- **A student who only pushed after the deadline has no submission.** That shows in the run as a no-submission, not an error, and does not fail the cohort's nightly.

Check what actually applied in `lockdowns/<id>/lockdown-record.json`: `lock_method` is `ruleset`, `demotion` or `none`, per student as well as per run. A `demotion` under "Does not count" means the ruleset could not be applied - the run log says why, and the old behaviour is the floor. To unlock a repository, delete its `pxl-classroom-deadline` ruleset:

```bash
gh api repos/<org>/<repo>/rulesets --jq '.[] | select(.name=="pxl-classroom-deadline") | .id'
```

then `gh api -X DELETE repos/<org>/<repo>/rulesets/<id>`.

**A student can delete that ruleset** - it lives in their own repository and they are its admin. Nothing is lost if they do: preservation has already pushed a copy to the assignment's archive repository, which they cannot touch, and disabling deadline enforcement on your own repository is a deliberate, visible act in a way *"I committed at 22:31"* is not. If you want a lock they cannot reach, that is an **organization** ruleset, and it needs an App permission the App does not yet declare:

1. The App owner changes *Organization permissions → Administration* to **Read and write** at `https://github.com/settings/apps/pxl-classroom-provisioner/permissions`.
2. Every installed org approves the new request (§10.6 - the same re-approval flow as any permission change).
3. The system then locks a cohort with one API call instead of one per student.

Measured before recommending it: one org ruleset matching `exam2026-*` blocked pushes to both cohort repos and left an unrelated repo alone, and one `PUT` released them all.

### 6.3 Student says "I clicked Accept but nothing happened"

**First, how long have they actually waited?** Provisioning is two chained Actions runs (broker → `repository_dispatch` → hub), so **20 to 40 seconds is normal** and longer is common when Actions is queued. The page says so, counts the elapsed seconds, and updates itself the moment the repository appears — a student who waits 30 seconds has waited a normal amount of time.

The page only offers a "look for a repository invitation" link when it could **not** read `/user/repository_invitations`. If it *could*, it already knows: a pending invitation puts the student in a state with an in-app **Accept invitation** button, and no invitation means there is nothing to accept. A student who is already an org member or owner is added as a direct collaborator and never receives one.

Possible causes:

- **They accepted but signed out before the SPA could detect the repo.** Ask them to re-open their invitation link. The SPA polls `/repos/<org>/<expected-name>` and `/user/repository_invitations` - if the repo exists, they'll see the link.
- **`provisioning-failed` is in the tracking issue.** Likely a rate-limit during a burst. The student can simply accept again from their invitation link. Alternatively, a lecturer can trigger **Retry acceptance** from the student's row on the assignment's roster & progress page (the **···** action).
- **A student says the Accept button does nothing.** If the page reports "GitHub is blocking your request", their GitHub account has been flagged and its content is hidden from everyone but themselves - the acceptance issue is created and removed before the broker sees it. Confirm with `gh api users/<login>`: a flagged account returns 404 to everyone else and 200 to itself. Only GitHub Support can lift it; provision the student manually in the meantime.
  - *Lecturer Retry Flow:* the student comes from the report row, so there is no login to validate; the SPA checks whether the assignment window is closed and warns the lecturer (asking to confirm bypass), triggers `retry-acceptance.yml` with `bypass_window: "true"`, and initiates a background watch (4-minute timeout, polling every 5s) for the workflow run to complete successfully. The toast notifications include a direct link to the running workflow run.
- **Outside `opens_at..deadline_at` or assignment closed.** The student accept card gates acceptance and displays early/closed status messages instead of the Accept button. If a student needs to accept outside the window, the lecturer must trigger a retry acceptance (which prompts to bypass window checks).
- **`max_acceptances` reached.** SPA will say so. Either raise the cap (edit assignment YAML directly or via Admin Panel) or reject. Note the cap is a **guardrail, not an exact seat count**: acceptances are checked and recorded in parallel runs, so a simultaneous burst can land a couple over it. That is deliberate — making it exact would serialize every acceptance in the cohort (ARCHITECTURE §5.4). If you need an exact number, reconcile afterwards rather than relying on the cap.
- **The student is not on the roster.** Under `roster_mode: enforced` (not the default - new assignments are `open`) the acceptance is rejected server-side with `rejected:not-on-roster` (or `rejected:no-roster` if `students/roster.yml` is missing), and the student sits on "Setting up your repository…" until it times out - the SPA cannot read the private roster, so it can't say this directly. Confirm in the hub's Actions tab: the `Accept assignment` run for that student shows the rejection reason in its summary. Fix by importing the roster (§12.4) or, for an assignment with no fixed cohort, switching it to open enrollment (§12.4 -> *Running an assignment without a roster*).

### 6.3b Nightly finalize failed

Check which step failed in the `Daily Activity & Deadline Check` run - the matrix runs one leg per (org, assignment).

- **`3. Preserve` -> `remote unpack failed: index-pack failed`.** The archive push sent an incomplete object graph. Fixed by fetching full history before pushing; if it reappears, verify `preserve/preserve.mjs` is not fetching with `--depth`. Submissions for that assignment were **not** archived - the next nightly run retries automatically (see below); preservation is idempotent (`push --force` to a per-student ref).

**Failed finalizes retry themselves.** An assignment counts as finalized only once every locked-down student has a verified `preservation.json`, so a leg that locked down but failed to archive is re-queued on the next nightly run, and the workflow will not self-disable while a leg is failing. Retried snapshots are frozen - a student's late commit can never replace their on-time submission.

Retries stop after 3 attempts (`finalize_attempts` in `lockdowns/<id>/lockdown-record.json`) so a permanently un-preservable repo does not run every night forever. The run log names the assignment and the pending students. After fixing the cause, force another attempt by editing that file and setting `finalize_attempts` back to `0`:

```bash
gh workflow run daily-activity.yml
```
- **`1. Collect` -> `fail:no-repos`.** An assignment nobody accepted. No longer fails the run; if you still see it, the hub is on an older commit.
- **Weekly usage 403 `Resource not accessible by integration`.** Organization `organization_administration: read` is missing/unapproved, or Enhanced Billing is unavailable (§10.6). The report skips that org; System Health reports the permission drift and probes the live billing endpoint.

### 6.4 The nightly workflow is disabled and a student needs the dashboard updated

Expected: `daily-activity.yml` disables itself when no assignments are active. A re-publish reactivates it. To force one regen:

1. Actions -> `regenerate-dashboard.yml` -> Run workflow -> input: org.

For a forced nightly run:

1. Actions -> `daily-activity.yml` -> enable, then Run workflow.
2. Or from the SPA: an assignment's detail page offers **Run daily activity now** while no report exists yet (dispatches the same workflow scoped to the org and watches for the report to land).

(The publish workflow also enables it, so publishing any assignment also wakes it up.)

### 6.5 The acceptance URL 404s on cold load

Likely the SPA 404 shim isn't routing. Verify `frontend/public/404.html` exists in the deployed Pages output, and that `index.html` has the redirect decoder. Rerun `deploy-frontend.yml`.

### 6.6 Migrating legacy assignments

Assignments created before the `template.{owner,repository}` schema rename may still have the top-level `template_owner` and `template_repo` fields. The synchronous acceptance flow will fail with a `fail:exception` if a student accepts an unmigrated assignment.

To migrate these assignments, use `yq` in your control repository:
```bash
yq -i 'if has("template_owner") then .template.owner = .template_owner | .template.repository = .template_repo | del(.template_owner, .template_repo) else . end' assignments/*.yml
```

### 6.7 Setup Organization fails: "The permissions requested are not granted to this installation"

`setup-org.yml` mints a token scoped to `organization_administration: read` before it creates any org state. A 422 at that step means the permission is missing - it is **not** about repository access or org membership. Fix in order:

1. **App owner** (owner of `PXL-Digital-Application-Samples`): `https://github.com/organizations/PXL-Digital-Application-Samples/settings/apps/pxl-classroom-provisioner/permissions` -> **Organization permissions** -> **Administration: Read-only** -> **Save changes**. Verify with `gh api apps/pxl-classroom-provisioner --jq .permissions` (`organization_administration: read` must appear).
2. **Each org owner**, including the org being onboarded: `https://github.com/organizations/<org>/settings/installations` -> **pxl-classroom-provisioner** -> **Review request** -> approve. While there, set **Repository access** to **All repositories**.
3. Re-run **Setup Organization**.

`weekly-usage-report.yml`'s `app-declaration` job catches this drift within a week of it appearing; run `node scripts/check-app-declaration.mjs` locally for the same answer immediately (no token needed).

Step 2 alone never works if step 1 was skipped: an org owner can only approve permissions the App declares. Until then `weekly-usage-report.yml` runs in degraded mode - it mints a token without the billing scope, annotates a warning, and skips the usage report for that org rather than failing every org's matrix leg.

### 6.7a "CI results sync failed ... due to API errors"

Reported live 2026-08-26 on `python-hacking-intro`, with **4,995 of 5,000** API calls still available - which is what ruled out the rate limit the wording implied.

The cause is the same shape as §6.7 and the fix is the same two steps. Reading a grade out of CI uses two endpoints, `GET /repos/{owner}/{repo}/commits/{ref}/check-runs` and `GET /repos/{owner}/{repo}/check-runs/{id}/annotations`, and GitHub gates **both** behind the **Checks** repository permission. The App never declared it, and the Admin Panel authenticates with a *user-to-server* token from that App - which is capped by what the App asks for. So the sync could not work anywhere, for anyone, and said "try again later" about a state that would never change.

1. **App owner**: `https://github.com/organizations/PXL-Digital-Application-Samples/settings/apps/pxl-classroom-provisioner/permissions` -> **Repository permissions** -> **Checks: Read-only** -> **Save changes**. Confirm with `gh api apps/pxl-classroom-provisioner --jq .permissions.checks` (must print `read`).
2. **Each org owner**: `https://github.com/organizations/<org>/settings/installations` -> **pxl-classroom-provisioner** -> **Review request** -> approve.
3. Sign out of the Admin Panel and back in, so the device flow issues a token carrying the new permission. An existing session keeps the old one.

`node scripts/check-app-declaration.mjs` answers step 1 immediately and needs no token; `scripts/check-installation-approvals.mjs` (the `installation-approvals` job in `weekly-usage-report.yml`) answers step 2 for every org at once.

Until step 1 is done the panel says so directly rather than blaming the API. Nothing is ever written on a failed sync - the code refuses to save a partial result, so retrying after the fix is safe.

---

## 7. Manual workflow triggers (lecturer-runnable)

All under Actions in `pxl-classroom`.

| Workflow | When you'd run it |
|---|---|
| `publish-assignment.yml` | First publish or republish broker config |
| `regenerate-dashboard.yml` | Dashboard looks stale after a manual control-repo edit |
| `reconcile-registry.yml` | Quick drift check (deleted repos, revoked access) without waiting for nightly |
| `daily-activity.yml` | Force one nightly cycle (collect + finalize) |
| `deadline-sentinel.yml` | Arm the deadline watchers early, off-cadence (see §7.1) |
| `weekly-usage-report.yml` | Force a usage report off-cadence |
| `setup-org.yml` | Add a new org (admin only) |

Every workflow takes `org` as an input; many also take `assignment_id` for scoping.

### 7.1 The deadline sentinel

Without it, "Late work: does not count" locks the submission branch on the **first nightly run after the deadline** and reconstructs the submission with `?until=`. With it, the branch locks at the deadline itself and the run records a five-minute `pushed_at` timeline through the critical window - GitHub's own push timestamps, which a student cannot set, and the only thing that settles an argument about when work landed.

**It ships disabled.** `publish-assignment.yml` enables it the next time you publish an assignment, alongside `daily-activity.yml`. To turn it on now:

```bash
gh workflow enable deadline-sentinel.yml
```

and to turn it off again:

```bash
gh workflow disable deadline-sentinel.yml
```

What to expect once it is on: a run every 4 hours, which does nothing at all unless a deadline falls in the next 4.5 hours. When one does, a job holds a runner slot until that instant. The hub is a public repository, so that time is free (ARCHITECTURE §6.5) - but it does consume a **concurrency slot**, and GitHub Team allows 60. `find-armable.mjs` caps how many are armed per firing (`MAX_SENTINELS`, default 8) and logs what it dropped; anything dropped falls through to the nightly, so the deadline still holds, just later.

Every failure degrades the same way. A dropped cron firing, a killed job, a deadline moved out of reach - all of them leave the nightly finalize doing exactly what it did before. Nothing the sentinel does can make things worse than it not having run.

The timeline lands in `lockdowns/<id>/sentinel-<key>.json` in the control repo, beside the lockdown record it explains, with `outcome` (`fired`, `gave-up:runtime`, `gave-up:moved`) and one `pushed_at` sample per poll.

---

## 8. Removing an organization

1. Edit `participating-orgs.yml` on the `participating-orgs` branch - remove the org's entry, commit.
2. Uninstall the App from the org (org owner) -> org Settings -> Integrations -> PXL Classroom Provisioner -> Uninstall.
3. Decide what to do with the data:
   - **Keep:** leave `<org>/pxl-classroom-control` and every `<org>/pxl-classroom-archive-<assignment-id>` in place. They remain readable to org members.
   - **Archive:** rename them to indicate they're decommissioned.
   - **Delete:** delete the repos. Preserved submission evidence is lost - be sure.

   Archives are per assignment, so `pxl-classroom-archive-` is the prefix to list:

   ```bash
   gh repo list <org> --limit 200 --json name --jq '.[].name | select(startswith("pxl-classroom-archive"))'
   ```

   A pre-2026-08-26 org may also hold the single `pxl-classroom-archive`, which holds every cohort finalized before that date. It has no prefix suffix, so the command above still lists it - and it is the one archive that cannot be retired per cohort.

---

## 8a. Retiring a finished assignment

The reason archives are per assignment (ARCHITECTURE §11.3.1): retiring a cohort is one gesture, and nothing else is in the blast radius.

1. Confirm the grades are out of the system and into wherever they live long-term. Deleting the archive destroys the preserved submission evidence for that cohort - `lockdowns/<id>/lockdown-record.json` in the control repo still holds each student's `snapshot_sha` and GitHub's own `pushed_at`, which is the record of *what* was submitted and *when*, but the content is gone.
2. Delete the student repositories for the assignment (`<repository_name_pattern>`).
3. Delete `<org>/pxl-classroom-archive-<assignment-id>`.
4. Leave the control repo alone. `assignments/<id>.yml`, `reports/<id>.json` and the lockdown record are small and are the audit trail; they are not what grows.

Do **not** delete an archive for an assignment whose deadline has passed but whose finalize has not completed - `find-finalizable.mjs` re-queues an assignment while any student with a `snapshot_sha` lacks a verified `preservation.json` (ARCHITECTURE §6.2.1), and it would push the branches back.

---

## 9. Security incident response

### 9.1 Compromised App private key

1. App settings -> Private keys -> **Revoke** the leaked key.
2. Generate a new key, download the PEM.
3. Update `PXL_APP_CLIENT_ID` (unchanged) and `PXL_APP_PRIVATE_KEY` (new PEM) in the hub's repo secrets.
4. No per-org change needed - installations re-mint from the new key automatically.
5. Investigate the leak vector before re-enabling workflows.

### 9.2 A student repo was accidentally made public

1. Org Settings -> Repositories -> set the repo private again.
2. Open the repo -> Settings -> check for any forks created while public; coordinate with the student.
3. If the repo contained secrets, treat as a leak: rotate.

### 9.3 Malicious acceptance burst

A bot stars many brokers from many accounts.

1. Edit affected `assignments/<id>.yml` - set `state: closed`. Acceptance handler rejects new attempts on closed assignments.
2. Optionally lower `max_acceptances` to the current accepted count.
3. Set the broker's `INVITE_ENABLED` variable to `false`. It is read in the workflow's job-level `if`, so GitHub skips the run without allocating a runner (ARCHITECTURE §4.3.2). Archiving the broker repository also works, but the variable is reversible in one click.
4. Reconcile in Admin Panel to identify any provisioned bot repos; delete them in bulk.

### 9.4 Hub workflow file was modified by a fork PR

If branch protection is configured (§1.5), this can't merge without admin review. If it did merge - assume compromise:

1. Revert the malicious commit.
2. Force-rotate the App key (§9.1) on the assumption the workflow exfiltrated it.
3. Audit `git log` for any subsequent commits made under the bot identity.

### 9.5 Control-repo data corrupted

Control repos are Git. Recovery is `git reset --hard <good-commit>` followed by `git push --force-with-lease`. Be careful: any acceptances or observations recorded after the good commit are lost. Prefer `git revert` for individual bad commits.

### 9.6 `participating-orgs.yml` encoded as UTF-16 (or has a BOM)

Symptom: `get-participating-orgs.mjs` and `get-budget-owner.mjs` fail with `... is UTF-16 LE. Re-encode as UTF-8 (LF, no BOM) ...`. Cause: an editor (often on Windows) saved the file in UTF-16. Subsequent appends from a Linux runner produce a mixed-encoding file.

Recover:

```
git fetch origin participating-orgs:participating-orgs
git checkout participating-orgs
iconv -f UTF-16LE -t UTF-8 participating-orgs.yml | sed -e '1s/^\xef\xbb\xbf//' -e 's/\r$//' > new && mv new participating-orgs.yml
git add participating-orgs.yml
git commit -m "Re-encode participating-orgs.yml as UTF-8"
git push origin participating-orgs
```

Verify: `file participating-orgs.yml` reports `ASCII text` or `UTF-8 Unicode text`, no `BOM`. `setup-org.yml` now normalises automatically going forward - this recovery is only needed once.

---

## 10. Weekly usage tracking - tuning thresholds

The system warns when any repo crosses a per-SKU threshold. Three layers of configuration; first match wins:

### 10.1 Where thresholds live

| Layer | File | When to use |
|---|---|---|
| **Global** | `limits.yml` (hub root) | The default. Edit when a new SKU appears in the weekly reports, or when a default needs adjusting for the typical course. |
| **Per-org** | `participating-orgs.yml` -> `orgs[i].overrides` | An entire org has a different profile. Example: an Actions-heavy course org gets a higher `Actions Linux` budget across the board. |
| **Per-repo** | `<org>/pxl-classroom-control/limits-overrides.json` | One specific repo is an outlier. Example: `pxl-sweeper-HanneloreRamakersPXL` accumulates artifacts as a feature; raise its `Actions storage` limit. |

### 10.2 Example: silence one noisy repo's storage warning

```json
{
  "schema_version": 1,
  "repos": {
    "pxl-sweeper-HanneloreRamakersPXL": { "Actions storage": 10 }
  }
}
```

Commit to `<org>/pxl-classroom-control/limits-overrides.json`. The next Sunday's report respects the override; the dashboard tile turns green.

### 10.3 SKUs you'll see

GitHub's Enhanced Billing API returns SKUs as data - the catalog isn't fixed. Common ones for PXL Classroom orgs:

| SKU | Unit | Typical usage |
|---|---|---|
| `Actions Linux` | Minutes | Student CI |
| `Actions Windows` | Minutes | Windows-specific courses |
| `Actions macOS` | Minutes | Rare |
| `Actions storage` | GigabyteHours | Artifact retention (build outputs, test reports) |
| `Packages storage` | GigabyteHours | Container images pushed by student workflows |
| `Packages data transfer` | Gigabytes | Pulls of org-hosted packages |
| `Git LFS storage` | GigabyteHours | Large binary assets in repos |
| `Git LFS bandwidth` | Gigabytes | LFS object downloads |
| `Codespaces compute` | Hours | If your org enables Codespaces |
| `Codespaces storage` | GigabyteHours | Codespace prebuilds |

Add an entry to `limits.yml` for any SKU you want thresholded. SKUs without a configured threshold are recorded in the report but never flagged.

### 10.4 Cadence

- **Sunday 22:00 UTC** the weekly cron fires.
- Report is written to the org's control repo even when nothing is over threshold (so the dashboard always has the latest data).
- If anything is over: comment posted to the **"PXL Classroom - Weekly Usage Report"** issue with `@budget_owner_login`. GitHub emails the budget owner via their notification settings.
- The workflow run exits non-zero on overrun -> red X in the Actions tab.

### 10.5 Manual rerun

Need a fresh report mid-week:

- From the SPA: the Usage pages (`/dashboard/<org>/usage` and `/usage`) have a **Generate report now** button while empty and a **Regenerate now** button once a report exists.
- Or Actions -> **Weekly Usage Report** -> Run workflow (optionally scope to one `org` input).

The SPA adds a correlation ID to each dispatch and watches that exact Actions run every five seconds. It reads the report only after the run completes, stops immediately on failure/cancellation, and reports a completed run that produced no new report as a billing-access error instead of polling stale JSON for 5-10 minutes.

### 10.6 If you change App permissions (re-approval flow)

Whenever the App's permission set widens - for example, adding `organization_administration: read` for the weekly usage report, or `actions: write` so the Admin UI can dispatch hub workflows (`publish-assignment.yml`, `retry-acceptance.yml`, `weekly-usage-report.yml`) directly from the SPA - every already-installed org needs to opt back in.

1. Update the manifest in `frontend/src/views/SetupView.vue` **and** widen the live App at `github.com/organizations/PXL-Digital-Application-Samples/settings/apps/pxl-classroom-provisioner/permissions`. The manifest only applies at App creation; editing it does nothing to an App that already exists. Verify with `gh api apps/pxl-classroom-provisioner --jq .permissions` before telling anyone to approve.
2. Each org owner: open the org's installed-apps page (`github.com/organizations/<org>/settings/installations`) -> PXL Classroom Provisioner -> click **Review request** and approve the new permissions. There is no request to review until step 1 lands.
3. Lecturers who were already authenticated keep their previous (narrower) token until it expires (8 h max). Next sign-in mints a token with the new scope.
4. No control-repo or workflow change needed.

Verify with `node scripts/check-app-declaration.mjs` (compares the live App against `MANIFEST_APP_PERMISSIONS`, no token needed) or `gh api /app` - `permissions` should reflect the new set. Lecturers can verify their own token's scope at `https://github.com/settings/applications` -> PXL Classroom Provisioner.

**Verifying step 2 - who has actually approved.** The declaration check above says what the App *asks* for; it cannot say who granted it. An org that never clicked **Review request** keeps the old permission set, so a feature is live on the App and dead on that org with nothing red anywhere. `gh api orgs/<org>/installations` answers only for an owner **of that org**, so chasing it by hand stalls at the orgs you do not own - on the 2026-08-25 `members` + `organization_administration: write` rollout that was 4 of 11.

Run **Actions -> Weekly Usage Report** and read the `installation-approvals` job, or wait for the Sunday cron. It mints an App JWT, walks `GET /app/installations` (every org at once), compares each installation against the App's live declaration, and sorts the result into three:

| Class | Reported as |
|---|---|
| A **participating** org that has not approved | `::error` naming the org and its Review-request URL — fails the run |
| A participating org with **no installation at all** | `::error` — nothing can be provisioned there |
| An installation **not in `participating-orgs.yml`** | `::notice` — named, but does not fail the run |

The third class exists because the App is publicly **listed**: hub-and-spoke needs it to be, since each course org is a separate organization and a private App can only be installed on the account that owns it. So any GitHub account can install it, and one unrelated org did on 2026-08-22. It grants them nothing in a PXL org, and failing every Sunday over an org nobody can make approve anything would make the check unreadable.

It reports `DID NOT RUN` rather than a false all-clear when the credentials are absent or the API is unreadable, and if `participating-orgs.yml` itself cannot be read it warns and treats **every** installation as participating — over-reporting rather than silencing real gaps. Locally:

```bash
PXL_APP_CLIENT_ID=... PXL_APP_PRIVATE_KEY="$(cat key.pem)" node scripts/check-installation-approvals.mjs
```

**Recent re-approval triggers in this project:**
- `organization_administration: read` - current Enhanced Billing endpoint requirement, used by the weekly usage report. This is an organization permission and is distinct from repository `administration: write`.
- `actions: write` - `workflow_dispatch` from the Admin UI / Usage view. Without it the SPA's "Generate now", "Publish", and "Retry acceptance" buttons return 403 (`Resource not accessible by integration`).

## 11. Verification checklist (after major changes)

Run periodically, especially after touching workflows or App settings.

- [ ] `pxl-classroom audit --org <org>` is clean - it now covers the two rows below automatically (App declaration and repository access).
- [ ] `gh api /app` shows the App's permissions match the SetupView manifest (`actions: write`, `administration: write`, `contents: write`, `issues: write`, `metadata: read`, `organization_administration: read`, `pull_requests: write`, `secrets: write`, `workflows: write`) plus account `starring: write`.
- [ ] `gh api /app/installations` shows the hub installation scoped to `repository_selection: selected, repositories: [pxl-classroom]`.
- [ ] Each participating org's installation shows `repository_selection: all`.
- [ ] `participating-orgs.yml` matches the set of orgs where the App is installed.
- [ ] `gh api /repos/PXL-Digital-Application-Samples/pxl-classroom/branches/main/protection` matches §1.5: force-pushes and deletions blocked (incl. admins), no PR/status-check requirements.
- [ ] No `.github/workflows/` directory exists in any `<org>/pxl-classroom-control` repo.
- [ ] `git grep corsproxy.io` in `frontend/src/` returns no matches.
- [ ] `git grep '@v[0-9]\+ ' .github/workflows/` returns no matches (all third-party actions SHA-pinned).
- [ ] Each participating org has `budget_owner_login` set in `participating-orgs.yml`.
- [ ] App permissions include `organization_administration: read` and System Health reports **Enhanced Billing Usage API** healthy.
- [ ] Every participating org's **base repository permission** is `none` (`gh api orgs/<org> --jq .default_repository_permission`). System Health Tier 1 reports it: `read` is a warning, `write`/`admin` a failure. It grants students nothing today - they are repository collaborators, not org members - but it is a floor beneath lock-down's demotion the moment anyone is enrolled through membership, and at `read` it exposes the private control repo (roster, reports) to every member. Fix under **Settings → Member privileges → Base permissions**, or `gh api -X PATCH orgs/<org> -f default_repository_permission=none`.
- [ ] **Before every exam deadline:** no accepted student is an **organization owner**. Open System Health on the assignment - Tier 3 carries *Cohort Can Be Frozen At The Deadline* - or check by hand:

      gh api "repos/<org>/pxl-classroom-control/contents/acceptances/<id>" --jq '.[].name' | sed 's/\.json$//' > /tmp/a
      gh api "orgs/<org>/members?role=admin&per_page=100" --jq '.[].login' > /tmp/o
      grep -Fxi -f /tmp/o /tmp/a    # anything printed cannot be frozen

  An owner keeps admin on every repository in the org, so lock-down writes `pull`, verifies, reads back `admin`, and records `verified: false`. This is normally a colleague testing the assignment - students are added as repository collaborators, so a student is an owner only if somebody promoted them - which is why it is reported as a warning rather than a failure. **The exam is not at risk** - the outcome is `partial`, which exits 0, so preservation and reporting still run and every other student freezes correctly - but those accounts can keep pushing after the deadline. Either remove them from the cohort, or change their role to **Member** under **People → Role** before the deadline. Your own test acceptance is the common case and is reported as a warning rather than a failure.
- [ ] App permissions include `actions: write` (required for `workflow_dispatch` from the Admin UI / Usage view).
- [ ] `limits.yml` exists at hub root and validates against `schemas/limits.schema.json`.
- [ ] Cold-load an invitation link `https://<pages-host>/pxl-classroom/<org>/i/<invite-token>` lands on AssignmentView with the right assignment resolved.
- [ ] The Instructor Notifications issue exists and is open in each control repo.

## 12. CLI installation (companion tooling)

The `pxl-classroom` CLI in `cli/` is an optional power-user surface for lecturer-side actions that scale poorly through the SPA: CSV roster import, install audits, feedback-PR orchestration, bulk submission download, and autograding. Same App, same device-flow auth, same schemas as the Admin Panel.

### 12.1 Install (from a clone of the hub)

```bash
git clone https://github.com/PXL-Digital-Application-Samples/pxl-classroom.git
cd pxl-classroom
npm install                       # installs the CLI workspace as well
npm link --workspace=cli          # exposes `pxl-classroom` on PATH
pxl-classroom --help
```

A `gh extension install` distribution will follow once Phase A stabilises. On Windows, the npm-link form is the supported path until then.

### 12.2 First-run authentication

```bash
pxl-classroom auth login --client-id <Iv23li…>     # Client ID from the App settings page ("About"), the /setup completion screen, or the PXL_APP_CLIENT_ID secret
# -> prints a verification URL + 8-char user code (+ a security notice:
#   authorize only "PXL Classroom Provisioner")
# -> attempts to open the verification page in your default browser
#   (best-effort; on headless shells use the printed URL)
# -> token cached at ~/.config/pxl-classroom/token (0600)

pxl-classroom auth status     # who am I, when did I auth, where is the token?
pxl-classroom auth logout     # wipe the cached token (config is preserved)
```

Set `PXL_APP_CLIENT_ID` in the shell to skip the `--client-id` flag.

### 12.3 Configuration locations

| OS | Token + config |
|---|---|
| POSIX | `$XDG_CONFIG_HOME/pxl-classroom/{token, config.json}` (falls back to `~/.config/pxl-classroom/…`) |
| Windows | `%APPDATA%\pxl-classroom\{token, config.json}` |

Both files are JSON, chmod 0600 on POSIX. Token TTL matches the device-flow OAuth user token (8 h); re-run `auth login` after expiry.

### 12.4 Importing a roster

The lecturer's roster (`students/roster.yml`) is schema v2. Either the SPA's Admin Panel -> **Roster** tab or the CLI imports it from CSV.

**CSV format** (header row required):

| Column | Required | Notes |
|---|---|---|
| `student_number` | Yes | Institutional SIS ID; treated as a string (preserves leading zeroes). |
| `full_name`      | Yes | Display name. |
| `email`          | Optional | Validated against the `email` format. |
| `class_group`    | Optional | E.g. `3A`. |
| `github_login`   | Optional | If known up front; otherwise filled at acceptance. |
| `github_id`      | Optional | Integer; pinned to survive renames. Usually filled at acceptance. |
| `active`         | Optional | Boolean (`true`/`false`/`1`/`0`/`yes`/`no`); defaults to `true`. |

Unknown columns are rejected. Duplicate `student_number` values are rejected.

**CLI flow:**

```bash
pxl-classroom roster import --org <org> roster.csv --dry-run    # preview diff
pxl-classroom roster import --org <org> roster.csv              # commit (asks to confirm removals)
pxl-classroom roster import --org <org> roster.csv --force      # commit incl. removals without prompting (CI)
pxl-classroom roster list   --org <org>                          # tabular view
```

An import whose diff **removes** students prompts for confirmation on a TTY (same guard as the Admin Panel); non-interactive runs must pass `--force` to allow removals.

The `--org` value sticks (config remembers it) so subsequent invocations can omit the flag. When the flag is omitted, the CLI prints a reminder to stderr identifying the resolved last-used organization.

All CLI commands query the control repo. If assignments or reports are queried that do not exist, the CLI catches 404 errors and displays a friendly explanation instead of raw stack traces. If repository records are empty, it handles the 404 gracefully and returns an empty list.

**SPA flow:** open `/dashboard/<org>/admin#roster`, drop a CSV (or paste it), preview the added/updated/removed diff, click **Commit roster**. Schema validation runs against the same `schemas/roster.schema.json` the CLI uses - no drift between surfaces.

Both surfaces commit to `<org>/pxl-classroom-control:students/roster.yml`. The CLI uses `lib/gittree.mjs` (rebase-on-non-FF retry); the SPA uses the existing single-file Contents-API `commitFile()` - both safe for one-shot writes.

#### Running an assignment without a roster

`open` is what a new assignment gets by default: students need the invitation link and nothing else, and `max_acceptances` is the only limit. To gate on a roster instead, set **Who may accept** to `enforced` in the Admin Panel's **Guardrails** section (equivalently, `roster_mode: enforced` in the YAML).

**A roster is still useful under `open`.** It stops deciding who may accept; it does not stop being a roster. Reports and CSV exports are built from the union of the roster and the actual acceptances, so imported students appear before they accept and carry their student number, name and class group. Students who accept without being on it show up with their GitHub login only, for you to reconcile afterwards.

Any GitHub account can then claim a repo while the assignment is open, so the deadline window and **Max acceptances** become your only limits. The cap is therefore **required** with open enrollment - the form will not save without it, and `accept.mjs` rejects a hand-edited uncapped open assignment with `fail:config`. Keep it close to the real headcount. Accepted students appear on the dashboard immediately, with an empty name/student number until you import a roster or add overrides; importing a roster later backfills those columns on the next report run.

#### 12.4a Promoting accepted students onto the roster

After an `open` assignment, the students who turned up are known only as GitHub logins in `acceptances/<id>/<login>.json`. Promotion copies them onto `students/roster.yml`, so the **next** assignment can run `enforced` against the cohort that actually enrolled.

**SPA flow:** open the assignment's tracking page (`/dashboard/<org>/<id>`) → **··· More** → **Add accepted students to roster**. The modal previews exactly who would be added before anything is written. It is offered only on an `open` assignment that somebody has accepted — under `enforced` every acceptor was already on the roster, so the action would be a no-op on every assignment.

**CLI flow:**

```bash
pxl-classroom roster promote --org <org> --assignment <id> --dry-run   # preview
pxl-classroom roster promote --org <org> --assignment <id>             # commit
```

What a promoted entry does and does not carry:

| Field | Promoted? | Why |
|---|---|---|
| `github_login`, `github_id` | Yes | The only identity GitHub gives us |
| `source: accepted` | Yes | Marks it as not-yet-identified so a later CSV import can reconcile it |
| `promoted_from` | Yes | `assignment_id`, `accepted_at`, `promoted_at`, `promoted_by` |
| `student_number`, `full_name`, `email`, `class_group` | **No** | GitHub never learns them. A guessed name lands in a graded field; a synthesised student number collides with real SIS numbering |
| `team_slug` / `team_name` | **No** | Membership belongs to the assignment, and a CSV re-import would wipe it (§5.8) |

Rules worth knowing before you run it:

- **It only adds.** A student already on the roster is left exactly as they are - promotion never overwrites a student number, name or class group with the little it knows. Matching is case-insensitive, the same way `accept.mjs`'s gate matches.
- **Re-running is free.** A second run finds nothing to add and commits nothing.
- **It refuses rather than guesses.** A roster that is a bare list of students (no `students:` key) is rejected with an explanation, not rewritten - that shape already lets nobody accept, and you need to know.
- **Promoting an `enforced` assignment** is normally a no-op. If it does add somebody, they accepted and were removed from the roster afterwards; the command says so and names them.

Afterwards, fill in the real identities by exporting the roster, adding `student_number`/`full_name` columns, and re-importing - the `source: accepted` marker is how you spot which rows still need it.

Symptom this fixes: with `roster_mode: enforced` and an empty or missing `students/roster.yml`, every acceptance is rejected with `rejected:not-on-roster` / `rejected:no-roster`, and the student sits on "Setting up your repository…" until it times out. Check the `Accept assignment` run in the hub's Actions tab to confirm the rejection reason.

### 12.5 Auditing an org's install

`pxl-classroom audit` runs read-only health checks against an org's App installation, control repo scaffold, participating-orgs registry, and (with `--assignment`) the per-assignment lockdown/archive state. The SPA shows the same checks in the **System health** panel at the top of the dashboard.

```bash
pxl-classroom audit --org PXLAutomation
pxl-classroom audit --org PXLAutomation --assignment linux-processes-2026
pxl-classroom audit --org PXLAutomation --json    # machine output for CI
```

Exit codes: `0` clean, `1` warnings, `2` failures. The check engine lives in `lib/audit.mjs` and is shared with the SPA - both surfaces use the same code path, only the HTTP carrier differs (Octokit in the CLI, browser fetch in the SPA).

If `app-permissions match manifest` reports drift, re-approve the App in the org -> Settings -> GitHub Apps -> PXL Classroom Provisioner -> Configure. The expected permissions are the canonical `EXPECTED_APP_PERMISSIONS` in `lib/audit.mjs`, which `SetupView.vue` also imports - there is only one source of truth.

### 12.6 Tagged submissions

`collect/` lists `refs/tags/submit/*` on each student repo in addition to the default-branch snapshot. When a matching tag is found, a `tagged-submission` observation is written alongside the snapshot, and `report.mjs` prefers the tagged SHA for classification.

Tag format students copy from the template README:

```bash
git tag submit/$(date -u +%Y-%m-%dT%H:%M:%SZ)-$(git rev-parse --short HEAD) && git push origin --tags
```

The system never requires the tag - untagged submissions still land via the snapshot path. The timestamp inside the tag name is `declared_at` (observed-not-authoritative); the `observed_at` written by `collect/` is the time the hub saw the tag and is what classification uses.

The lecturer dashboard's **Submit tag** column on `AssignmentDetailView` shows the latest tag per student, and the student `AssignmentView` shows a "Submission tagged at …" banner once `collect/` has seen the tag.

### 12.7 Feedback PRs

Enable `feedback_pr: true` on the assignment (the Admin Panel's **Guardrails** section has a checkbox; manual YAML also works). Provisioning then creates and protects a `pxl-baseline` branch on each new student repo.

Open the actual draft PRs lazily - at provisioning time, `main` and `pxl-baseline` point at the same SHA and GitHub refuses with 422 "No commits between …".

**Option A: Web UI (1-Click):**
Navigate to the assignment's `AssignmentDetailView` in the SPA. Click the **Open Feedback PRs** button in the action bar. The web app iterates all student repositories with pushed commits and opens draft pull requests (`main` -> `pxl-baseline`), committing record updates to the control repo and displaying PR links immediately.

**Option B: CLI Companion:**

```bash
pxl-classroom feedback open --assignment linux-processes-2026                  # opens for all students with commits ahead of pxl-baseline
pxl-classroom feedback open --assignment linux-processes-2026 --login alice    # one student
pxl-classroom feedback open --assignment linux-processes-2026 --dry-run        # preview only - creates no PRs, commits nothing

pxl-classroom feedback list --assignment linux-processes-2026                  # PR URLs + open review-comment counts
```

The operation is idempotent - re-runs skip students whose record already has `feedback_pr_number`, and a student who has an open PR the record does not know about is **adopted** rather than given a second one. The summary counts opened and adopted separately, and a run that failed for any student **exits non-zero**: check the count before assuming a green tick means the whole cohort. Records for the PRs that did open are committed either way, so a re-run only picks up what is genuinely missing. The Admin Panel's `AssignmentDetailView` shows a **Feedback PR** column when the assignment opts in; "- pending" means provisioning created the baseline but no PR exists yet (student hasn't pushed, or you haven't opened PRs).

`feedback list`'s answer is in the app too: **··· More → Refresh feedback PR status** fills the same column with each PR's state (Draft / Open / Merged / Closed) and its inline review-comment count. It is an on-demand read - one request per open PR - so nothing is fetched until you ask, and it reports how many it could not read rather than quietly showing fewer.

Lecturer workflow: leave inline review comments on the PR like any GitHub PR. Comments persist as the student keeps pushing - the PR head tracks `main`. The student cannot delete `pxl-baseline` (App-level protection outranks repo admin).

### 12.8 Bulk Submission Download & Preservation Status

`pxl-classroom download` clones each preserved submission out of `<org>/pxl-classroom-archive-<assignment-id>` (the archive-backed evidence layer, immune to post-deadline rewrites of the student repo). The repository and ref come off each report row, so a cohort finalized before archives went per assignment still downloads from the org's old shared archive without a flag.

```bash
pxl-classroom download --org PXLAutomation \
                       --assignment linux-processes-2026 \
                       --dir ./submissions \
                       --concurrency 4
```

- Resumable: a re-run skips students whose checkout already matches the archive SHA.
- Writes `./submissions/_manifest.json` with `{login, archive_sha, archive_branch, archive_branch_url, downloaded_at}` rows for plagiarism tools / local CI.
- **Preservation Summary Banner:** When an assignment's deadline has passed, `AssignmentDetailView` renders a top banner displaying live preserved counts vs eligible students, lockdown execution timestamp, and measured uncertainty delay (`uncertainty_seconds = lockdown_at - deadline_at`). Quick buttons allow 1-click targeted retries, downloading the SHA manifest, navigating to the archive repo, and copying the CLI download command.
- **Direct Archive Links:** The student table and teams table display direct clickable hyperlinks to `https://github.com/<org>/pxl-classroom-archive-<assignment-id>/tree/preserved/<assignment-id>/<login>` (or team slug) for every preserved submission. The repository and ref are read off the report row, so links to cohorts archived before ARCHITECTURE §11.3.1 keep working.

### 12.9 Autograding

**In the Admin Panel**, the Guardrails section shows one line - **Automated checks** - and a **Set up** button. The modal behind it asks the two questions that are decisions:

* **Where do they run?** *On your machine* costs no Actions minutes, keeps the checks out of the student repository, and you run `pxl-classroom grade` after the deadline. *In each student's repo* runs them on every push, on the organization's Actions minutes, and shows the student a pass/fail each time.
* **Can students read the checks?** Only asked for the second answer. *Yes* commits them to each student's repository; *No* keeps them in the control repository and runs them from there.

Then add checks from three named starting points - *a command that must succeed*, *compare output for given input*, *a Python script* - each of which arrives pre-filled with a working example to edit. The table totals the points. A check with a missing ID, a duplicate ID, an empty command, an empty points box or (for Python) no script cannot be saved, and says so on its own row. **A blank points box is not zero** - if a check is genuinely worth nothing (a setup step that must succeed), type `0`. Saving with **no** checks is not a state: use **Turn off automated checks**. Escape, the backdrop and **×** all close without saving.

**Or edit the YAML directly** (the shape the panel writes):

```yaml
autograde:
  enabled: true
  execution_environment: github_actions
  visibility: public
  tests:
    - id: hello-world                      # lowercase slug; `id`, not `name`
      type: run
      command: "pytest tests/test_lab.py"
      timeout_s: 5
      points: 5
    - id: validator
      type: python
      script: |                            # `script`, not `command` - see below
        import subprocess
        assert subprocess.run(["./solution"]).returncode == 0
      timeout_s: 15
      points: 10
```

**A `python` test is its `script`, and nothing else.** Every runner - `--runner host`, `--runner docker`, and the generated Actions workflow - writes `script` to a file and executes it; `command` is ignored, and the schema rejects a `python` test that has no `script`. Write the assertions you want run directly in `script`. If you want pytest, use `type: run` with `command: pytest ...` instead: a `script` is executed by the interpreter, so a file that only *defines* `def test_x()` passes without testing anything. And nothing is installed before it runs - `setup_command` was read by the Actions generator, was never a schema field, and is gone - so keep a python test to the standard library plus whatever the repository itself provides.

#### Option A: Lecturer-side (CLI-only)

When `execution_environment` is `lecturer_local`, run the grader **on your machine** - never on the platform:

```bash
pxl-classroom grade --org PXLAutomation \
                    --assignment linux-processes-2026 \
                    --runner docker \
                    --concurrency 2

pxl-classroom grade --assignment linux-processes-2026 --login alice --dry-run    # one student, no commit
```

Defaults: `--runner docker` (recommended; `--network=none`, read-only mount, 512 MB memory, per-test wall-clock timeouts), or `--runner host` for trusted code (POSIX only - uses `/bin/sh`).

Results land in `<org>/pxl-classroom-control:grading/<assignment-id>/<login>.json` (validated against `schemas/grading-result.schema.json`) plus `summary.json` driving the **Autograder** panel on `AssignmentDetailView`.

#### Option B: Student-side (GitHub Actions)

When `execution_environment` is `github_actions`, the tests run automatically on GitHub Actions whenever the student pushes code.

- **Template Preservation**: If the assignment's template repository already contains a custom autograding workflow (`.github/workflows/autograding.yml` or `classroom.yml`, such as standard GitHub Classroom or Cloud PE workflows), it is preserved during provisioning without overwrite.
- **No checks, autograding on**: the injected workflow **fails** with a message saying the assignment defines none. It used to run `npm test` - a guess at the student's toolchain whose result was then reported as this assignment's grade. The Admin Panel cannot produce that state; only a hand-edited YAML the schema rejects can.
- **Workflow Generation**: If no workflow exists in the template, provisioning injects a workflow utilizing `classroom-resources/autograding-*-grader` and `classroom-resources/autograding-grading-reporter`. A `python` test becomes **two** steps - one that writes its `script` to `.pxl-autograde/<test-id>.py` (the source travels in `env:`, so a quote in it cannot break the workflow) and the grader step that runs `python3` over that file. That is the same thing the CLI runners do, which is what makes a test definition mean one thing on both paths.
- **Guardrails**: The generated workflow automatically enforces `timeout-minutes: 10` (preventing infinite loops from burning runner quotas) and `concurrency: { cancel-in-progress: true }` (cancelling obsolete runs if a student pushes repeatedly).
- **Visibility `private`**: The injected workflow calls a reusable workflow stored in the control repository (`pxl-classroom-control`), hiding the actual tests and commands from the student's view.
- **Visibility `public`**: The tests are executed openly in the student's repository, allowing them to see exactly what commands are run.

To pull the grades back into the control repository:
1. Open the SPA and navigate to the `AssignmentDetailView` for the assignment (or run `pxl-classroom grade --assignment <id>`).
2. Choose **··· More → Read scores from GitHub Actions**. Once there are grades on screen the same action also sits in the Autograder panel.
3. The system fetches the Checks API at each student's preserved or latest observed SHA, reads the score from the check run's **annotations**, and writes `grading/<id>/summary.json` to the control repository. The Score and CI Status columns fill in immediately, and the CSV export carries them.

**This works for an assignment whose autograding came with the template.** If the template repository ships its own `classroom.yml` - the ordinary GitHub Classroom setup - the assignment does not need an `autograde` block in the Admin Panel, and you do not need to re-enter the exercises or their points: the reporter's annotation carries the maximum. The action is offered on any assignment that has not explicitly chosen a lecturer-local runner.

**Where the number comes from, and what it is not.** A check run created by GitHub Actions has an empty output body; the reporter emits `Points <earned>/<total>` and `{"totalPoints":…,"maxPoints":…}` as annotations, and that is what is read. A run with no such annotation is recorded from the run's conclusion instead - full marks or zero - and marked `score_source: "conclusion"` so it can be told apart from a real score. There is **no per-test breakdown** on this path: annotations carry the grand total only, so the drill-down links to the run rather than inventing a table. For a per-test breakdown, grade locally with `pxl-classroom grade --runner docker`, which writes `grading/<id>/<login>.json`.

### 12.10 Correcting an assignment after students have accepted

Spotted a mistake in the assignment? Fix it in the **template repository**, commit, and push. The sync distributes **that commit**.

> Commit the fix on its own. The sync offers the files your *latest* template commit touched, so a commit that mixes a correction with three unrelated edits offers all four.
>
> And be careful what the last commit contains: if you have been solving the exercises in the template to check them, the sync will happily offer your solution as the starter code. Solve in a scratch repository, or revert before syncing.

#### Option A: Web UI (Interactive Modal)
1. On `AssignmentDetailView`, choose **··· More → Sync Starter Code**.
2. **Review the commit and pick files.** The modal shows the template's latest commit and the files it changed, each with its diff. Everything is ticked; untick anything you do not want to send.
3. **Pre-flight.** Each student repository is read once and sorted into:
   - **Updated in place** - they have not touched these files, so the new version is committed straight to their `main` and arrives on their next `git pull`.
   - **Pull request** - they have changed at least one of them, so those files arrive as a PR and their work is not overwritten.
   - **Nothing to do** / **Could not read**.
   Ticking and unticking files re-sorts the cohort instantly; it does not re-scan.
4. **Customize & Dispatch:** adjust the commit/PR title, the student-facing instructions, and whether to open a tracking issue. Click **Apply Starter Update**.

The split is **per file**: a student who edited one of four corrected files still gets the other three directly, and a PR for the one. That is why a sync record can say `merged-and-pr` for the same student.

#### Option B: CLI Companion

```bash
# Preview what would be updated across the cohort
pxl-classroom sync-starter --assignment linux-processes-2026 --dry-run

# Send every file the latest template commit changed
pxl-classroom sync-starter --assignment linux-processes-2026

# Selectively sync specific files and customize the message
pxl-classroom sync-starter --assignment linux-processes-2026 \
                           --files "tests/test_lab1.py" \
                           --title "Fix assertion in test 3" \
                           --message "Updated test suite with corrected edge case assertion."
```

- **Mechanics:** the sync copies file content; it never merges the template's history into a student repository. Files the student has not touched are committed directly to `main`; files they have changed go onto `refs/heads/starter-update-<timestamp>` with a pull request into `main`, so their work is never overwritten.
- **Re-running is safe.** A second run of the same sync skips students who already have the change and reuses the pull request it already opened, rather than adding another.
- `--dry-run` reads only. No commits, no branches, no pull requests, no issues.
- **Audit Records:** Complete execution summaries are stored in the control repo at `syncs/<assignment-id>/<sync-id>.json`.

### 12.11 Pre-Flight Diagnostics, System Health & 1-Click Auto-Fixes

PXL Classroom features an automated diagnostic and self-healing engine (`lib/diagnostics.mjs`) accessible directly from both the Web UI and the CLI.

#### Option A: Web UI (Unified System Health Center)

1. **Organization-Wide Health Check (Dashboard):**
   - Click the **Activity Pulse icon** (`activity`) to the right of the Organization Selector on `DashboardView`.
   - The modal automatically verifies GitHub session validity, API rate-limit quota, App installation, permissions drift, `participating-orgs.yml` enrollment, and control repository scaffold integrity.
2. **Assignment Pre-Flight Troubleshooter (Admin Panel):**
   - When creating or editing an assignment on `AdminView`, click the **Troubleshoot** button in the header (or click any warning banner).
   - The troubleshooter executes a 5-tier inspection in dependency order:
     - **Tier 0:** Auth & Quota.
     - **Tier 1:** Org & GitHub App Foundation.
     - **Tier 2:** Control Repository Foundation (scaffold & privacy).
     - **Tier 3:** Assignment Definition & Starter Template (`is_template: true` on GitHub).
     - **Tier 4:** Acceptance Broker Infrastructure (`broker-<id>` repository & `.github/workflows/acceptance-trigger.yml`).
     - **Tier 5:** Student Portal & Pages Edge (`public/assignments.json` & CDN reachability).
3. **1-Click Self-Healing Repairs:**
   - **Template not marked as template:** Click **[Mark as Template on GitHub]** to execute an immediate API patch.
   - **Broker repository missing:** Click **[Create Broker Repository Now]** to dispatch `publish-assignment.yml`.
   - **Broker repository private:** Click **[Make Broker Public]** to patch repository visibility.
   - **Pages deployment propagating:** Click **[Deploy to GitHub Pages]** to trigger `deploy-frontend.yml`.
   - **Enforced roster missing:** Click **[Open Roster Editor]** to navigate directly to the roster editor tab.

#### Option B: CLI Audit Companion

```bash
# Run read-only organization health audit
pxl-classroom audit --org PXL-CSMobile

# Run deep per-assignment diagnostic audit
pxl-classroom audit --org PXL-CSMobile --assignment voorbeeld-project

# Output machine-readable JSON for CI health monitoring
pxl-classroom audit --org PXL-CSMobile --assignment voorbeeld-project --json
```

Exit codes:
- `0` = Clean (all checks OK/Info).
- `1` = Warnings (non-blocking issues or in-flight deployments).
- `2` = Failures (action required before student acceptance).
