# PXL Classroom - Administration

**Audience: a system administrator or an organization owner.** Onboarding an organization, budgets, usage thresholds, App permissions, and incident response.

> [!IMPORTANT]
> **Not what you are looking for?**
> - **Running assignments as a lecturer** - publishing, deadlines, extensions, grading, troubleshooting a student - is [RUNBOOK.md](RUNBOOK.md).
> - **Standing up the whole system from scratch**, once, for the institution is [INSTALL.md](INSTALL.md). You do **not** need it to add an organization: PXL Classroom is multi-tenant, and one hub and one App set serve every org.

What the system *is* → [ARCHITECTURE.md](ARCHITECTURE.md). Why a rule exists → [LESSONS.md](LESSONS.md). Known infrastructure gaps → [OPEN-ITEMS.md](OPEN-ITEMS.md).

---

## 1. Onboarding a new organization (per org)

> [!NOTE]
> Follow this procedure whenever a lecturer wants to use PXL Classroom for a new course or academic year organization (e.g. `PXL-2TIN-DevOps-2627`).
> **You do NOT need to deploy a frontend or create a new GitHub App.** All course organizations connect to the existing central hub (`PXL-Digital-Application-Samples/pxl-classroom`) and use the existing central GitHub App!

Done by a system administrator together with the organization owner.

### 1.1 Install the central GitHub App on the new org

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

The manifest at `/setup` declares Organization **Administration**, but the manifest only applies at App *creation*. If the App predates that manifest entry it does not hold the permission, and no installation - however fresh - can receive it. Confirm before onboarding:

```bash
gh api apps/pxl-classroom-provisioner --jq .permissions
```

If `organization_administration` is absent, the App owner must add it first (§6.6); otherwise Setup Organization fails at its billing preflight (§3.1).

### 1.2 Run Setup Organization

In `pxl-classroom` -> Actions -> **Setup Organization** -> Run workflow:

| Input | Value |
|---|---|
| `target_org` | `PXLAutomation` (or other org login) |

The workflow:

- Mints a least-privilege token and probes the Enhanced Billing Usage API. Onboarding stops with an actionable error if Organization Administration has not been approved or Enhanced Billing is unavailable.
- Mints the full provisioning token for the new org's App installation.
- Creates `<org>/pxl-classroom-control` (private) if it doesn't already exist.
- Pushes the initial scaffold - `CONTROL_SCAFFOLD_DIRS` in `lib/control-layout.mjs`: `assignments/`, `students/`, `teams/`, `acceptances/`, `repositories/`, `observations/`, `lockdowns/`, `reports/`, `overrides/`, `public/`.
- Adds the org to `participating-orgs.yml` on the `participating-orgs` branch, with the budget owner.
- Dispatches `deploy-frontend.yml`, which is what makes the org appear in the SPA's switcher.

### 1.3 Configure the org's Actions budget

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

### 1.4 Grant lecturers access to the hub repo

Lecturers trigger **Publish** from the Admin Panel and **Retry acceptance** from a student's row on the tracking view; both dispatch workflows on `PXL-Digital-Application-Samples/pxl-classroom` using the lecturer's own token. Without collaborator access to the hub repo, `workflow_dispatch` returns 403 and the SPA shows a detailed error toast (e.g. `Trigger failed (403): ... Most often: the App needs actions:write, or you're not a collaborator on the hub repo with write access`).

- Add each org's lecturers as **Write** collaborators (or members of a team with write) on the hub repo.
  `workflow_dispatch` requires write - Read is not enough, and produces exactly the 403 described above.
- **Adding them to the hub organization is not the same thing, and on its own does not work.** `PXL-Digital-Application-Samples` carries `default_repository_permission: read`, so a plain member lands on read for `pxl-classroom` and every dispatch 403s - which reads as "I added the lecturer and it still fails". Measured 2026-08-31: all 11 members of the hub org are owners, there are no teams, and there are no outside collaborators on the hub repo, so the write-collaborator route above has never actually been exercised here. Organization **owner** works because GitHub grants owners admin on every repository; it also makes them an owner of the **App**, which is registered on that org, so anyone granted it can generate a private key that mints installation tokens for every participating org (ARCHITECTURE §4.3). Write on `pxl-classroom` is the least-privilege grant that does the same job.
- Without this access, the lecturer can still create/edit assignments (writes go to their own control repo), but cannot publish or retry from the SPA - a hub admin must run those workflows on their behalf.

### 1.5 Register the budget owner

Edit `participating-orgs.yml` on the `participating-orgs` branch - add or update the entry:

```yaml
orgs:
  - login: PXLAutomation
    budget_owner_login: tomcoolpxl       # GitHub login, used for @-mention in weekly usage report
    budget_owner_email: tom.cool@pxl.be  # optional, informational only
    overrides:                           # optional per-org SKU overrides
      "Actions Linux": 2000
```

Schema: `schemas/participating-orgs.schema.json`. See §6 for what `overrides` means and how thresholds are resolved.

---

## 2. Per-org budget policy

Each participating org must have:

- A named human **budget owner** (`budget_owner_login` in `participating-orgs.yml` - GitHub login).
- A configured **Actions spending limit** in GitHub UI (≥ recommended floor in §1.3) - the hard stop.
- **Billing alerts** at 50% / 80% / 100% routed to the budget owner - early warning.

Beyond GitHub's own limit/alerts (which are EUR-based), PXL Classroom runs its own **weekly per-SKU threshold check** that fires before the EUR cap is hit. See §6 for tuning the thresholds. The two systems are complementary:

- **GitHub's spending limit** stops Actions when EUR is exceeded. A blunt, after-the-fact cutoff.
- **PXL Classroom's weekly check** warns the budget owner on Monday morning when *any* repo's actual usage (minutes, storage GiB·h, etc.) crosses a configured threshold. Catches outliers - e.g. a repo accumulating storage with zero CI activity - that the EUR view hides.

The hub side itself has no per-org cost (public repo). Everything billed lives in the participating org and is bounded by the limit there.

---

---

## 3. When onboarding or permissions fail

### 3.1 Setup Organization fails: "The permissions requested are not granted to this installation"

`setup-org.yml` mints a token scoped to `organization_administration: read` before it creates any org state. A 422 at that step means the permission is missing - it is **not** about repository access or org membership. Fix in order:

1. **App owner** (owner of `PXL-Digital-Application-Samples`): `https://github.com/organizations/PXL-Digital-Application-Samples/settings/apps/pxl-classroom-provisioner/permissions` -> **Organization permissions** -> **Administration: Read-only** -> **Save changes**. Verify with `gh api apps/pxl-classroom-provisioner --jq .permissions` (`organization_administration: read` must appear).
2. **Each org owner**, including the org being onboarded: `https://github.com/organizations/<org>/settings/installations` -> **pxl-classroom-provisioner** -> **Review request** -> approve. While there, set **Repository access** to **All repositories**.
3. Re-run **Setup Organization**.

`weekly-usage-report.yml`'s `app-declaration` job catches this drift within a week of it appearing; run `node scripts/check-app-declaration.mjs` locally for the same answer immediately (no token needed).

Step 2 alone never works if step 1 was skipped: an org owner can only approve permissions the App declares. Until then `weekly-usage-report.yml` runs in degraded mode - it mints a token without the billing scope, annotates a warning, and skips the usage report for that org rather than failing every org's matrix leg.

### 3.2 The App declares permissions nothing uses

`check-app-declaration.mjs` compares **both** directions. It reports what the App is *missing* - a feature that cannot work - and what the App *holds and no code asks for*, because that is blast radius: every permission on the provisioning App is inherited by anyone who obtains its private key.

Run `node scripts/check-app-declaration.mjs` for the current answer; no token needed.

The App's permissions page has four collapsible sections, and **which section a permission lives in decides who has to approve a change and where you click**:

| Section | Count | Contains |
|---|---|---|
| Repository permissions | 9 + 1 mandatory | `actions`, `actions_variables`, `administration`, `checks`, `contents`, `issues`, `pull_requests`, `secrets`, `workflows` (+ `metadata`, mandatory, cannot be removed) |
| Organization permissions | 2 | `members`, `organization_administration` |
| Account permissions | 1 | `emails` |

> [!CAUTION]
> **"Administration" is a label in BOTH the Repository and Organization sections, and they are different permissions.** Repository → Administration (`administration: write`) is what creates student repositories and manages collaborators - **breaking it breaks provisioning for every cohort**. Organization → Administration (`organization_administration`) is the billing one, and is the one to downgrade. Check which section you are in before touching anything labelled Administration.

**Two permissions are held above what the code uses, deliberately.** `excessDeclaredPermissions` would otherwise report them every week for ever, and a permanent amber beside real findings is how a check stops being read - so the exceptions are written into `lib/audit.mjs` with their reasons rather than left to the report:

| Permission | Section | Held at | Code needs | Why it is held |
|---|---|---|---|---|
| `members` | Organization | write | read | `unfreezableAcceptorsFinding` lists `GET /orgs/{org}/members?role=admin` to find acceptors who are org owners and therefore cannot be frozen at a deadline. `write` keeps `roster_mode: org_member` restorable, since that mode enrols by org invitation and genuinely needs it. **Nothing in this codebase writes org membership** - that GET is the only membership call in the source. |
| `organization_administration` | Organization | write | read | Read covers Enhanced Billing and `default_repository_permission` on `GET /orgs/{org}`. ARCHITECTURE §11.2.1's org-scoped lockdown needs **write**, and every installed org has already approved it, so the feature is unblocked; narrowing would re-block it. |

Both are held for the same reason: **a reduction is instant, and an increase needs every org owner to approve.** A permission a designed feature will need is cheaper to hold than to re-acquire.

> [!IMPORTANT]
> **Check the code before removing a permission, never the changelog.** Deleting `roster_mode: org_member` removed the *enrolment* use of `members`, not the *diagnostic* one - and dropping it would not even have gone red, because an unreadable owner list yields **no check at all** rather than a failing one. A control that silently stops existing is the failure mode this whole section guards against.

When the check does report a genuine excess, fix it in **one** of two ways, both legitimate:

- **Narrow the App**: `https://github.com/organizations/PXL-Digital-Application-Samples/settings/apps/pxl-classroom-provisioner/permissions`, remove or downgrade the permission, **Save changes**.

  **This costs nobody a click.** GitHub's own wording: *"If you remove permissions or webhooks from your GitHub App, the changes will take effect immediately"* - whereas adding one means *"each account where the app is installed will need to approve the new permissions"*. So a reduction lands on every installation at once with no approval round; org owners may receive an informational email, but there is nothing for them to action and nothing breaks while they ignore it. Account-level permissions clear the same way, and need no owner at all.

  This asymmetry is worth remembering in the other direction: the day something genuinely needs a NEW permission, every org owner has to click *Review request* before that org works again, and the feature is dead on the ones nobody chases. That is what `check-installation-approvals.mjs` exists to see (§6.6).
- **Or add it to `MANIFEST_APP_PERMISSIONS`** in `lib/audit.mjs` with a comment naming the caller, if something really does use it. This is what happened to `actions_variables: write` - genuinely required by `publish-assignment.yml`'s five `gh variable set` calls, and simply never written down. The check is what forces that constant to be a truthful inventory instead of a partial one.

---

## 4. Removing an organization

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

## 5. Security incident response

### 5.1 Compromised App private key

1. App settings -> Private keys -> **Revoke** the leaked key.
2. Generate a new key, download the PEM.
3. Update `PXL_APP_PRIVATE_KEY` on the hub's **`provisioning` environment** (Settings -> Environments -> provisioning), **not** at repository level (INSTALL.md §3.4). A repository-level copy is readable by every job that does not name the environment, which is the exposure the environment exists to prevent; `tests/workflow-hardening.test.mjs` fails CI when such a job appears. `PXL_APP_CLIENT_ID` does not change and stays a repository secret on purpose - a client id is not secret and already ships in the SPA bundle.
4. No per-org change needed - installations re-mint from the new key automatically.
5. Investigate the leak vector before re-enabling workflows.

### 5.2 A student repo was accidentally made public

1. Org Settings -> Repositories -> set the repo private again.
2. Open the repo -> Settings -> check for any forks created while public; coordinate with the student.
3. If the repo contained secrets, treat as a leak: rotate.

### 5.3 Malicious acceptance burst

A bot fires many brokers from many accounts. A migrated broker triggers on an **opened issue** and verifies the signed invitation before minting anything, so an attacker without the link costs one boot on a free public runner. One published **before** signed acceptance still triggers on a **star** and verifies nothing, which makes an un-migrated assignment the cheaper target - migrating it (INSTALL.md §3.3) is the durable fix.

1. Edit affected `assignments/<id>.yml` - set `state: closed`. Acceptance handler rejects new attempts on closed assignments.
2. Optionally lower `max_acceptances` to the current accepted count.
3. Set the broker's `INVITE_ENABLED` variable to `false`. It is read in the workflow's job-level `if`, so GitHub skips the run without allocating a runner (ARCHITECTURE §4.3.2). Archiving the broker repository also works, but the variable is reversible in one click.
4. Reconcile in Admin Panel to identify any provisioned bot repos; delete them in bulk.

### 5.4 Hub workflow file was modified by a fork PR

**Branch protection is not what stops this.** §1.5 deliberately configures no PR-review and no status-check requirement - verified live: `required_pull_request_reviews` and `required_status_checks` are both null, and what is enforced is force-push and deletion blocking. What actually stands in the way is that merging needs **write access** on the hub repo, and GitHub holds workflow runs from a first-time fork contributor until someone approves them. If such a PR did merge, assume compromise:

1. Revert the malicious commit.
2. Force-rotate the App key (§5.1) on the assumption the workflow exfiltrated it.
3. Audit `git log` for any subsequent commits made under the bot identity.

### 5.5 Control-repo data corrupted

Control repos are Git. Recovery is `git reset --hard <good-commit>` followed by `git push --force-with-lease`. Be careful: any acceptances or observations recorded after the good commit are lost. Prefer `git revert` for individual bad commits.

### 5.6 `participating-orgs.yml` encoded as UTF-16 (or has a BOM)

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

## 6. Weekly usage tracking - tuning thresholds

The system warns when any repo crosses a per-SKU threshold. Three layers of configuration; first match wins:

### 6.1 Where thresholds live

| Layer | File | When to use |
|---|---|---|
| **Global** | `limits.yml` (hub root) | The default. Edit when a new SKU appears in the weekly reports, or when a default needs adjusting for the typical course. |
| **Per-org** | `participating-orgs.yml` -> `orgs[i].overrides` | An entire org has a different profile. Example: an Actions-heavy course org gets a higher `Actions Linux` budget across the board. |
| **Per-repo** | `<org>/pxl-classroom-control/limits-overrides.json` | One specific repo is an outlier. Example: `pxl-sweeper-HanneloreRamakersPXL` accumulates artifacts as a feature; raise its `Actions storage` limit. |

### 6.2 Example: silence one noisy repo's storage warning

```json
{
  "schema_version": 1,
  "repos": {
    "pxl-sweeper-HanneloreRamakersPXL": { "Actions storage": 10 }
  }
}
```

Commit to `<org>/pxl-classroom-control/limits-overrides.json`. The next Sunday's report respects the override; the dashboard tile turns green.

### 6.3 SKUs you'll see

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

### 6.4 Cadence

- **Sunday 22:00 UTC** the weekly cron fires.
- Report is written to the org's control repo even when nothing is over threshold (so the dashboard always has the latest data).
- If anything is over: comment posted to the **"PXL Classroom - Weekly Usage Report"** issue with `@budget_owner_login`. GitHub emails the budget owner via their notification settings.
- The workflow run exits non-zero on overrun -> red X in the Actions tab.

### 6.5 Manual rerun

Need a fresh report mid-week:

- From the SPA: the Usage pages (`/dashboard/<org>/usage` and `/usage`) have a **Generate report now** button while empty and a **Regenerate now** button once a report exists.
- Or Actions -> **Weekly Usage Report** -> Run workflow (optionally scope to one `org` input).

The SPA adds a correlation ID to each dispatch and watches that exact Actions run every five seconds. It reads the report only after the run completes, stops immediately on failure/cancellation, and reports a completed run that produced no new report as a billing-access error instead of polling stale JSON for 5-10 minutes.

### 6.6 If you change App permissions (re-approval flow)

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

## 7. Verification checklist (after major changes)

Run periodically, especially after touching workflows or App settings.

- [ ] `pxl-classroom audit --org <org>` is clean - it now covers the two rows below automatically (App declaration and repository access).
- [ ] `node scripts/check-app-declaration.mjs` is clean - the live App's permissions match `MANIFEST_APP_PERMISSIONS` in `lib/audit.mjs` in **both** directions, plus account `emails: read` (§3.2).
- [ ] `gh api /app/installations` shows the hub installation scoped to `repository_selection: selected, repositories: [pxl-classroom]`.
- [ ] Each participating org's installation shows `repository_selection: all`.
- [ ] `participating-orgs.yml` matches the set of orgs where the App is installed.
- [ ] `gh api /repos/PXL-Digital-Application-Samples/pxl-classroom/branches/main/protection` matches §1.5: force-pushes and deletions blocked (incl. admins), no PR/status-check requirements.
- [ ] No `.github/workflows/` directory exists in any `<org>/pxl-classroom-control` repo.
- [ ] The two device-flow URLs are never fetched outside the proxy helper - `git grep "github.com/login" frontend/src/` shows them only as the `DEVICE_CODE_TARGET` / `TOKEN_TARGET` constants `proxiedPost` appends to a proxy. (This item used to read "`git grep corsproxy.io` in `frontend/src/` returns no matches", which could never pass: `auth.js` has always carried the default proxy. `tests/cors.test.mjs` and `tests/cors-proxy-config.test.mjs` cover the real invariant.)
- [ ] `git grep '@v[0-9]\+ ' .github/workflows/` returns no matches (all third-party actions SHA-pinned).
- [ ] Each participating org has `budget_owner_login` set in `participating-orgs.yml`.
- [ ] App permissions include `organization_administration: read` and System Health reports **Enhanced Billing Usage API** healthy.
- [ ] Every participating org's **base repository permission** is `none` (`gh api orgs/<org> --jq .default_repository_permission`). System Health Tier 1 reports it: `read` is a warning, `write`/`admin` a failure. It grants students nothing today - they are repository collaborators, not org members - but it is a floor beneath lock-down's demotion the moment anyone is enrolled through membership, and at `read` it exposes the private control repo (roster, reports) to every member. Fix under **Settings → Member privileges → Base permissions**, or `gh api -X PATCH orgs/<org> -f default_repository_permission=none`.
- [ ] Before an exam deadline, confirm no accepted student is an organization owner - that is a lecturer's check at a deadline rather than a maintainer's after a change, so it lives in [RUNBOOK.md](RUNBOOK.md).
- [ ] App permissions include `actions: write` (required for `workflow_dispatch` from the Admin UI / Usage view).
- [ ] `limits.yml` exists at hub root and validates against `schemas/limits.schema.json`.
- [ ] Cold-load an invitation link `https://<pages-host>/pxl-classroom/<org>/i/<invite-token>` lands on AssignmentView with the right assignment resolved.
- [ ] The Instructor Notifications issue exists and is open in each control repo.
