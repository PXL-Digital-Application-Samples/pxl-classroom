# PXL Classroom — Runbook

Operational procedures for setting up, running, and recovering PXL Classroom. Pairs with `ARCHITECTURE.md` (the technical reference).

This runbook is for two audiences. **System administrators** (the people who own the hub and the App): §1, §2, §3, §9, §10. **Lecturers** (organization owners running classes): §4, §5, §6, §7, §8.

---

## 1. First-time system setup (one time, system administrator)

The hub is `PXL-Digital-Application-Samples/pxl-classroom`. These steps initialize it. They are run once, by an admin who owns the hub.

### 1.1 Enable Pages

GitHub → `pxl-classroom` → Settings → Pages → Source: **GitHub Actions**.

### 1.2 Create the central GitHub App

1. In a browser, open the Pages site at `https://pxl-digital-application-samples.github.io/pxl-classroom/setup`.
2. Fill the App Manifest form. The form pre-fills the install-time permissions declared in `frontend/src/views/SetupView.vue`:
   - Repository: **Actions RW**, **Administration RW**, **Contents RW**, **Metadata R**, **Secrets RW**.
   - Device Flow: enabled.

   Two additional permissions are **not in the manifest** and need to be set manually on the App settings page after creation, before installing the App on any org:
   - Organization: **Plan: Read** — required for the weekly usage report (Enhanced Billing endpoint, see §10).
   - Account: **Starring RW** — required so students can star the broker to trigger acceptance.
3. Submit. GitHub redirects you through an App-creation handshake. At the end you have a new App named **PXL Classroom Provisioner** and you are shown its **Client ID** (string starting with `Iv…`, on the App settings page under "About") and a generated private key (PEM).

### 1.3 Set hub secrets

In `pxl-classroom` → Settings → Secrets and variables → Actions:

| Secret | Value |
|---|---|
| `PXL_APP_CLIENT_ID` | Client ID from §1.2 (the `Iv…` string). Required by `actions/create-github-app-token` — the older `app-id` input is deprecated. |
| `PXL_APP_PRIVATE_KEY` | full PEM body from §1.2, including BEGIN/END lines |
| `VITE_GITHUB_CLIENT_ID` | Same Client ID as `PXL_APP_CLIENT_ID`; used at SPA build time to wire the device flow. |
| `VITE_CORS_PROXY_URL` | Optional. Defaults to `https://corsproxy.io/?url=`. See ARCHITECTURE.md §10.2 for the threat model. |

### 1.4 Install the App on the hub's owning org, scoped narrowly

The broker workflows mint tokens against this installation to dispatch into the hub. Scope it tightly.

1. App settings page → **Install App** → choose `PXL-Digital-Application-Samples`.
2. **Only select repositories** → tick `pxl-classroom` only.
3. Confirm install.

Verify: `gh api /app/installations` (with App-level JWT) should show this installation with `repository_selection: selected` and `repositories: [pxl-classroom]`.

### 1.5 Branch protection on `main`

`pxl-classroom` is public. The workflows file is the highest-value target. Configure:

- Settings → Branches → Add rule for `main`:
  - Require pull requests, ≥2 approvals.
  - Require status checks: `ci.yml` must pass.
  - Require signed commits.
  - Restrict who can push (admin team only).
  - Block force-pushes and deletions.
- Settings → Code security:
  - Enable secret scanning.
  - Enable push protection.

CODEOWNERS for `/.github/workflows/`, `/acceptance/`, `/provisioning/`, `/collect/`, `/lockdown/`, `/preserve/`, `/report/`, `/pages/`, `/notify/`, `/registry/`, `/lib/`, `/scripts/` — all → the admin team. This forces an extra review for any change to the trusted execution surface.

### 1.6 Light protection on `participating-orgs` branch

This branch is the registry of participating orgs. The Setup-Organization workflow needs to commit to it from automation. Configure:

- Add branch rule for `participating-orgs`: require pull requests with 1 approval, **no signed-commits requirement**, no status-check requirement.

### 1.7 Verify

```
# Hub is public, Pages is live
curl -I https://pxl-digital-application-samples.github.io/pxl-classroom/

# App exists and is correctly scoped
gh api /app
gh api /app/installations
```

System is now ready to onboard the first organization.

---

## 2. Onboarding a new organization (per org)

Done by a system administrator together with the organization owner.

### 2.1 Install the App on the new org

1. Organization owner: App page → Install → choose the target org.
2. Scope: **All repositories**. (The App needs Administration RW across the org to provision student repos.)
3. Confirm.

### 2.2 Run Setup Organization

In `pxl-classroom` → Actions → **Setup Organization** → Run workflow:

| Input | Value |
|---|---|
| `target_org` | `PXLAutomation` (or other org login) |

The workflow:

- Mints a token for the new org's App installation.
- Creates `<org>/pxl-classroom-control` (private) if it doesn't already exist.
- Pushes an initial scaffold (`assignments/`, `acceptances/`, `repositories/`, `observations/`, `lockdowns/`, `reports/`, `public/`).
- Adds the org to `participating-orgs.yml` on the `participating-orgs` branch.

### 2.3 Configure the org's Actions budget

**This step is mandatory.** Each org pays for its own Actions usage (provisioning, collection, finalize). Without a spending limit, an attacker who triggers many acceptances could rack up cost.

1. Org → Settings → Billing and plans → Spending limit → **set Actions spending limit** (recommended floor: see table below).
2. Configure billing alerts at 50%, 80%, 100%. Recipient: the org's named budget owner.

| Class size | Recommended floor | Headroom |
|---|---|---|
| ≤ 50 students | €60 / month | ~10,000 min ≈ 200 min/student |
| 51–150 students | €120 / month | ~20,000 min ≈ 130 min/student |
| 151–500 students | €250 / month | ~42,000 min ≈ 80 min/student |

Bursty courses (Terraform, container builds) need higher limits; size the budget against the actual workload, not the headcount.

**What 100% means:** GitHub stops Actions on private repos in that org. Student-owned CI runs queue and never start. The hub side is unaffected (hub Actions are free — public repo). What you do at 100%: confirm with budget owner; raise if appropriate; otherwise communicate to students that CI is paused until the next monthly reset (integrity layer — lock-down, preservation, reports — continues to run).

### 2.4 Grant lecturers access to the hub repo

Lecturers trigger **Publish** and **Retry acceptance** from the Admin Panel; both dispatch workflows on `PXL-Digital-Application-Samples/pxl-classroom` using the lecturer's own token. Without collaborator access to the hub repo, `workflow_dispatch` returns 403 and the SPA shows a "no hub access" toast.

- Add each org's lecturers as **Read** collaborators (or members of an admin team) on the hub repo.
- Without this access, the lecturer can still create/edit assignments (writes go to their own control repo), but cannot publish or retry from the SPA — a hub admin must run those workflows on their behalf.

### 2.5 Register the budget owner

Edit `participating-orgs.yml` on the `participating-orgs` branch — add or update the entry:

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

- A named human **budget owner** (`budget_owner_login` in `participating-orgs.yml` — GitHub login).
- A configured **Actions spending limit** in GitHub UI (≥ recommended floor in §2.3) — the hard stop.
- **Billing alerts** at 50% / 80% / 100% routed to the budget owner — early warning.

Beyond GitHub's own limit/alerts (which are EUR-based), PXL Classroom runs its own **weekly per-SKU threshold check** that fires before the EUR cap is hit. See §10 for tuning the thresholds. The two systems are complementary:

- **GitHub's spending limit** stops Actions when EUR is exceeded. A blunt, after-the-fact cutoff.
- **PXL Classroom's weekly check** warns the budget owner on Monday morning when *any* repo's actual usage (minutes, storage GiB·h, etc.) crosses a configured threshold. Catches outliers — e.g. a repo accumulating storage with zero CI activity — that the EUR view hides.

The hub side itself has no per-org cost (public repo). Everything billed lives in the participating org and is bounded by the limit there.

---

## 4. Creating and publishing an assignment

Done by a lecturer.

### 4.1 Create the template repository

1. In your organization, create a new repository whose name starts with `template-` (e.g., `template-automation-pe-1`).
2. Settings → General → tick **Template repository**.
3. Add starter code, `.github/workflows/` for the student's own CI, and assignment instructions. Anything you commit here becomes the student's starting point.

### 4.2 Define the assignment in the Admin Panel

1. Open the dashboard: `https://<pages-host>/pxl-classroom/dashboard/<org>`.
2. Sign in with device flow.
3. Click **Admin Panel**.
4. Fill **Create New Assignment**:

| Field | Note |
|---|---|
| `id` | URL-safe slug, e.g. `linux-processes-2026` |
| `title` | shown to students |
| Template | pick from auto-discovered `template-*` repos in your org |
| `repository_name_pattern` | must contain `{github_login}`, e.g. `linux-processes-{github_login}` |
| `opens_at` / `deadline_at` | local time, automatically converted to UTC for storage |
| `max_acceptances` | guardrail — cap on accepted students (default: a sensible buffer over class size) |
| `lock_down_enabled` | default true |

5. The Admin Panel validates against `assignment.schema.json` and commits `assignments/<id>.yml` to your control repo via the Contents API with your own lecturer token.

### 4.3 Publish

In Admin Panel → click **Publish Assignment**.

This dispatches `publish-assignment.yml`, which:

- Creates `<org>/broker-<id>` (public).
- Pushes the broker's `acceptance-trigger.yml` workflow.
- Sets variables on the broker (`ASSIGNMENT_ID`, `CONTROL_ORG`).
- Flips `state` from `draft` → `published` in the control repo.
- **Enables the nightly workflow** (`gh workflow enable daily-activity.yml`). From here on, the nightly cycle is active for your org.

### 4.4 Share the link

The student-facing URL: `https://<pages-host>/pxl-classroom/<org>/a/<assignment-id>`.

That's the only URL students need. They open it, sign in, click Accept, wait ~30 seconds, get a repo link.

---

## 5. Day-to-day monitoring

### 5.1 The Instructor Notifications issue

Each org's control repo has an open issue titled **PXL Classroom — Instructor Notifications**. The system posts (or updates) a comment for each significant event:

| Event | Meaning |
|---|---|
| `provisioning-failed` | A student accepted but the repo wasn't created. Most often: GitHub rate limit during a burst. The student can re-star the broker to retry. |
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
3. Ask the student to re-star the broker. Acceptance handler re-provisions because the registry no longer shows them.

### 6.2 Grant an extension

1. Admin Panel → **Grant Deadline Extension**.
2. Fill: assignment ID, student login, new deadline, reason.
3. The Admin Panel commits `overrides/<id>/<login>.json` (validated against `override.schema.json`).
4. The next nightly run recomputes `effective_deadline_at` for this student; the dashboard updates after `regenerate-dashboard.yml` runs.

### 6.3 Student says "I clicked Accept but nothing happened"

Possible causes:

- **They starred but signed out before the SPA could detect the repo.** Ask them to re-open the assignment URL. The SPA polls `/repos/<org>/<expected-name>` and `/user/repository_invitations` — if the repo exists, they'll see the link.
- **`provisioning-failed` is in the tracking issue.** Likely a rate-limit during a burst. Ask the student to unstar and re-star the broker. Acceptance is idempotent; a successful retry shows the same target repo.
- **Outside `opens_at..deadline_at`.** SPA will say so.
- **`max_acceptances` reached.** SPA will say so. Either raise the cap (edit assignment YAML directly or via Admin Panel) or reject.

### 6.4 The nightly workflow is disabled and a student needs the dashboard updated

Expected: `daily-activity.yml` disables itself when no assignments are active. A re-publish reactivates it. To force one regen:

1. Actions → `regenerate-dashboard.yml` → Run workflow → input: org.

For a forced nightly run:

1. Actions → `daily-activity.yml` → enable, then Run workflow.

(The publish workflow also enables it, so publishing any assignment also wakes it up.)

### 6.5 The acceptance URL 404s on cold load

Likely the SPA 404 shim isn't routing. Verify `frontend/public/404.html` exists in the deployed Pages output, and that `index.html` has the redirect decoder. Rerun `deploy-frontend.yml`.

---

## 7. Manual workflow triggers (lecturer-runnable)

All under Actions in `pxl-classroom`.

| Workflow | When you'd run it |
|---|---|
| `publish-assignment.yml` | First publish or republish broker config |
| `regenerate-dashboard.yml` | Dashboard looks stale after a manual control-repo edit |
| `reconcile-registry.yml` | Quick drift check (deleted repos, revoked access) without waiting for nightly |
| `daily-activity.yml` | Force one nightly cycle (collect + finalize) |
| `weekly-usage-report.yml` | Force a usage report off-cadence |
| `setup-org.yml` | Add a new org (admin only) |

Every workflow takes `org` as an input; many also take `assignment_id` for scoping.

---

## 8. Removing an organization

1. Edit `participating-orgs.yml` on the `participating-orgs` branch — remove the org's entry, commit.
2. Uninstall the App from the org (org owner) → org Settings → Integrations → PXL Classroom Provisioner → Uninstall.
3. Decide what to do with the data:
   - **Keep:** leave `<org>/pxl-classroom-control` and `<org>/pxl-classroom-archive` in place. They remain readable to org members.
   - **Archive:** rename them to indicate they're decommissioned.
   - **Delete:** delete the repos. Preserved submission evidence is lost — be sure.

---

## 9. Security incident response

### 9.1 Compromised App private key

1. App settings → Private keys → **Revoke** the leaked key.
2. Generate a new key, download the PEM.
3. Update `PXL_APP_CLIENT_ID` (unchanged) and `PXL_APP_PRIVATE_KEY` (new PEM) in the hub's repo secrets.
4. No per-org change needed — installations re-mint from the new key automatically.
5. Investigate the leak vector before re-enabling workflows.

### 9.2 A student repo was accidentally made public

1. Org Settings → Repositories → set the repo private again.
2. Open the repo → Settings → check for any forks created while public; coordinate with the student.
3. If the repo contained secrets, treat as a leak: rotate.

### 9.3 Malicious acceptance burst

A bot stars many brokers from many accounts.

1. Edit affected `assignments/<id>.yml` — set `state: closed`. Acceptance handler rejects new attempts on closed assignments.
2. Optionally lower `max_acceptances` to the current accepted count.
3. Disable the broker repository (org Settings → archive the broker repo) — `watch:started` does not fire on archived repos.
4. Reconcile in Admin Panel to identify any provisioned bot repos; delete them in bulk.

### 9.4 Hub workflow file was modified by a fork PR

If branch protection is configured (§1.5), this can't merge without admin review. If it did merge — assume compromise:

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

Verify: `file participating-orgs.yml` reports `ASCII text` or `UTF-8 Unicode text`, no `BOM`. `setup-org.yml` now normalises automatically going forward — this recovery is only needed once.

---

## 10. Weekly usage tracking — tuning thresholds

The system warns when any repo crosses a per-SKU threshold. Three layers of configuration; first match wins:

### 11.1 Where thresholds live

| Layer | File | When to use |
|---|---|---|
| **Global** | `limits.yml` (hub root) | The default. Edit when a new SKU appears in the weekly reports, or when a default needs adjusting for the typical course. |
| **Per-org** | `participating-orgs.yml` → `orgs[i].overrides` | An entire org has a different profile. Example: an Actions-heavy course org gets a higher `Actions Linux` budget across the board. |
| **Per-repo** | `<org>/pxl-classroom-control/limits-overrides.json` | One specific repo is an outlier. Example: `pxl-sweeper-HanneloreRamakersPXL` accumulates artifacts as a feature; raise its `Actions storage` limit. |

### 11.2 Example: silence one noisy repo's storage warning

```json
{
  "schema_version": 1,
  "repos": {
    "pxl-sweeper-HanneloreRamakersPXL": { "Actions storage": 10 }
  }
}
```

Commit to `<org>/pxl-classroom-control/limits-overrides.json`. The next Sunday's report respects the override; the dashboard tile turns green.

### 11.3 SKUs you'll see

GitHub's Enhanced Billing API returns SKUs as data — the catalog isn't fixed. Common ones for PXL Classroom orgs:

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

### 11.4 Cadence

- **Sunday 22:00 UTC** the weekly cron fires.
- Report is written to the org's control repo even when nothing is over threshold (so the dashboard always has the latest data).
- If anything is over: comment posted to the **"PXL Classroom — Weekly Usage Report"** issue with `@budget_owner_login`. GitHub emails the budget owner via their notification settings.
- The workflow run exits non-zero on overrun → red X in the Actions tab.

### 11.5 Manual rerun

Need a fresh report mid-week:

- Actions → **Weekly Usage Report** → Run workflow.
- Optionally scope to one `org` input.

### 11.6 If you change App permissions (re-approval flow)

Whenever the App's permission set widens — for example, adding `organization_plan: read` for the weekly usage report, or `actions: write` so the Admin UI can dispatch hub workflows (`publish-assignment.yml`, `retry-acceptance.yml`, `weekly-usage-report.yml`) directly from the SPA — every already-installed org needs to opt back in.

1. Update the manifest in `frontend/src/views/SetupView.vue` (or directly in the App's GitHub settings if it already exists).
2. Each org owner: open the org's installed-apps page (`github.com/organizations/<org>/settings/installations`) → PXL Classroom Provisioner → click **Review request** and approve the new permissions.
3. Lecturers who were already authenticated keep their previous (narrower) token until it expires (8 h max). Next sign-in mints a token with the new scope.
4. No control-repo or workflow change needed.

Verify with `gh api /app` — `permissions` should reflect the new set. Lecturers can verify their own token's scope at `https://github.com/settings/applications` → PXL Classroom Provisioner.

**Recent re-approval triggers in this project:**
- `organization_plan: read` — Enhanced Billing endpoint, used by the weekly usage report.
- `actions: write` — `workflow_dispatch` from the Admin UI / Usage view. Without it the SPA's "Generate now", "Publish", and "Retry acceptance" buttons return 403 (`Resource not accessible by integration`).

## 11. Verification checklist (after major changes)

Run periodically, especially after touching workflows or App settings.

- [ ] `gh api /app` shows the App's permissions match the SetupView manifest (`actions: write`, `administration: write`, `contents: write`, `metadata: read`, `secrets: write`) **plus** the two manually-added perms (`organization_plan: read`, `starring: write`).
- [ ] `gh api /app/installations` shows the hub installation scoped to `repository_selection: selected, repositories: [pxl-classroom]`.
- [ ] Each participating org's installation shows `repository_selection: all`.
- [ ] `participating-orgs.yml` matches the set of orgs where the App is installed.
- [ ] `gh api /repos/PXL-Digital-Application-Samples/pxl-classroom/branches/main/protection` shows ≥2 approvals + signed commits + `ci.yml` required.
- [ ] No `.github/workflows/` directory exists in any `<org>/pxl-classroom-control` repo.
- [ ] `git grep corsproxy.io` in `frontend/src/` returns no matches.
- [ ] `git grep '@v[0-9]\+ ' .github/workflows/` returns no matches (all third-party actions SHA-pinned).
- [ ] Each participating org has `budget_owner_login` set in `participating-orgs.yml`.
- [ ] App permissions include `organization_plan: read` (required for the weekly usage report).
- [ ] App permissions include `actions: write` (required for `workflow_dispatch` from the Admin UI / Usage view).
- [ ] `limits.yml` exists at hub root and validates against `schemas/limits.schema.json`.
- [ ] Cold-load `https://<pages-host>/pxl-classroom/<org>/a/<sample-id>` lands on AssignmentView.
- [ ] The Instructor Notifications issue exists and is open in each control repo.

## 12. CLI installation (companion tooling)

The `pxl-classroom` CLI in `cli/` is an optional power-user surface for lecturer-side actions that scale poorly through the SPA (CSV roster import; later: audits and bulk grading). Same App, same device-flow auth, same schemas as the Admin Panel.

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
pxl-classroom auth login --client-id <Iv23li…>     # CLIENT_ID from /setup page or PXL_APP_CLIENT_ID secret
# → prints a verification URL + 8-char user code
# → opens the App's authorization page in the browser
# → token cached at ~/.config/pxl-classroom/token (0600)

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

The lecturer's roster (`students/roster.yml`) is schema v2. Either the SPA's Admin Panel → **Roster** tab or the CLI imports it from CSV.

**CSV format** (header row required):

| Column | Required | Notes |
|---|---|---|
| `student_number` | ✔ | Institutional SIS ID; treated as a string (preserves leading zeroes). |
| `full_name`      | ✔ | Display name. |
| `email`          | – | Validated against the `email` format. |
| `class_group`    | – | E.g. `3A`. |
| `github_login`   | – | If known up front; otherwise filled at acceptance. |
| `github_id`      | – | Integer; pinned to survive renames. Usually filled at acceptance. |
| `active`         | – | Boolean (`true`/`false`/`1`/`0`/`yes`/`no`); defaults to `true`. |

Unknown columns are rejected. Duplicate `student_number` values are rejected.

**CLI flow:**

```bash
pxl-classroom roster import --org <org> roster.csv --dry-run    # preview diff
pxl-classroom roster import --org <org> roster.csv              # commit
pxl-classroom roster list   --org <org>                          # tabular view
```

The `--org` value sticks (config remembers it) so subsequent invocations can omit the flag.

**SPA flow:** open `/dashboard/<org>/admin#roster`, drop a CSV (or paste it), preview the added/updated/removed diff, click **Commit roster**. Schema validation runs against the same `schemas/roster.schema.json` the CLI uses — no drift between surfaces.

Both surfaces commit to `<org>/pxl-classroom-control:students/roster.yml`. The CLI uses `lib/gittree.mjs` (rebase-on-non-FF retry); the SPA uses the existing single-file Contents-API `commitFile()` — both safe for one-shot writes.

### 12.5 Auditing an org's install

`pxl-classroom audit` runs read-only health checks against an org's App installation, control repo scaffold, participating-orgs registry, and (with `--assignment`) the per-assignment lockdown/archive state. The SPA shows the same checks in the **System health** panel at the top of the dashboard.

```bash
pxl-classroom audit --org PXLAutomation
pxl-classroom audit --org PXLAutomation --assignment linux-processes-2026
pxl-classroom audit --org PXLAutomation --json    # machine output for CI
```

Exit codes: `0` clean, `1` warnings, `2` failures. The check engine lives in `lib/audit.mjs` and is shared with the SPA — both surfaces use the same code path, only the HTTP carrier differs (Octokit in the CLI, browser fetch in the SPA).

If `app-permissions match manifest` reports drift, re-approve the App in the org → Settings → GitHub Apps → PXL Classroom Provisioner → Configure. The expected permissions are the canonical `EXPECTED_APP_PERMISSIONS` in `lib/audit.mjs`, which `SetupView.vue` also imports — there is only one source of truth.

### 12.6 Tagged submissions

`collect/` lists `refs/tags/submit/*` on each student repo in addition to the default-branch snapshot. When a matching tag is found, a `tagged-submission` observation is written alongside the snapshot, and `report.mjs` prefers the tagged SHA for classification.

Tag format students copy from the template README:

```bash
git tag submit/$(date -u +%Y-%m-%dT%H:%M:%SZ)-$(git rev-parse --short HEAD) && git push origin --tags
```

The system never requires the tag — untagged submissions still land via the snapshot path. The timestamp inside the tag name is `declared_at` (observed-not-authoritative); the `observed_at` written by `collect/` is the time the hub saw the tag and is what classification uses.

The lecturer dashboard's **Submit tag** column on `AssignmentDetailView` shows the latest tag per student, and the student `AssignmentView` shows a "Submission tagged at …" banner once `collect/` has seen the tag.

### 12.7 Feedback PRs

Enable `feedback_pr: true` on the assignment (the Admin Panel's **Guardrails** section has a checkbox; manual YAML also works). Provisioning then creates and protects a `pxl-baseline` branch on each new student repo.

Open the actual draft PRs lazily — at provisioning time, `main` and `pxl-baseline` point at the same SHA and GitHub refuses with 422 "No commits between …".

```bash
pxl-classroom feedback open --assignment linux-processes-2026                  # opens for all students with commits ahead of pxl-baseline
pxl-classroom feedback open --assignment linux-processes-2026 --login alice    # one student
pxl-classroom feedback open --assignment linux-processes-2026 --dry-run        # preview without committing

pxl-classroom feedback list --assignment linux-processes-2026                  # PR URLs + open review-comment counts
```

The CLI is idempotent — re-runs skip students whose record already has `feedback_pr_number`. The Admin Panel's `AssignmentDetailView` shows a **Feedback PR** column when the assignment opts in; "— pending" means provisioning created the baseline but no PR exists yet (student hasn't pushed, or you haven't run `feedback open`).

Lecturer workflow: leave inline review comments on the PR like any GitHub PR. Comments persist as the student keeps pushing — the PR head tracks `main`. The student cannot delete `pxl-baseline` (App-level protection outranks repo admin).

### 12.8 Bulk submission download

`pxl-classroom download` clones each preserved submission out of `<org>/pxl-classroom-archive` (the archive-backed evidence layer, immune to post-deadline rewrites of the student repo).

```bash
pxl-classroom download --org PXLAutomation \
                       --assignment linux-processes-2026 \
                       --dir ./submissions \
                       --concurrency 4
```

- Resumable: a re-run skips students whose checkout already matches the archive SHA.
- Writes `./submissions/_manifest.json` with `{login, archive_sha, archive_branch, archive_branch_url, downloaded_at}` rows for plagiarism tools / local CI.
- The SPA's **Download manifest** button on `AssignmentDetailView` exports the manifest alone (no clone), and **Copy CLI command** pre-fills the `download` invocation for paste.

### 12.9 Lecturer-side autograder

Configure tests on the assignment YAML (the Admin Panel surfaces a banner when an `autograde` block is present):

```yaml
autograde:
  enabled: true
  tests:
    - id: compile
      type: run
      command: "make"
      timeout_s: 30
      points: 10
    - id: tests-pass
      type: run
      command: "make test"
      timeout_s: 120
      points: 40
    - id: io-1
      type: io
      command: "./a.out"
      stdin: "3 4\n"
      expected_stdout: "7"
      timeout_s: 5
      points: 5
```

Run the grader **on your machine** — never on the platform:

```bash
pxl-classroom grade --org PXLAutomation \
                    --assignment linux-processes-2026 \
                    --runner docker \
                    --concurrency 2

pxl-classroom grade --assignment linux-processes-2026 --login alice --dry-run    # one student, no commit
```

Defaults: `--runner docker` (recommended; `--network=none`, read-only mount, 512 MB memory, per-test wall-clock timeouts), or `--runner host` for trusted code (POSIX only — uses `/bin/sh`).

Results land in `<org>/pxl-classroom-control:grading/<assignment-id>/<login>.json` (validated against `schemas/grading-result.schema.json`) plus `summary.json` driving the **Autograder** panel on `AssignmentDetailView`. The panel is read-only — there is no "Run" button on the SPA, on purpose.
