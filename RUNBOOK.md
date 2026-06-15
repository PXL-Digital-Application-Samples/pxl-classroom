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
2. Fill the App Manifest form. The form pre-fills the correct permissions:
   - Repository: Administration RW, Contents RW, Metadata R.
   - Account: Starring RW.
   - Device Flow: enabled.
3. Submit. GitHub redirects you through an App-creation handshake. At the end you have a new App named **PXL Classroom Provisioner** and you are shown its App ID and a generated private key (PEM).

### 1.3 Set hub secrets

In `pxl-classroom` → Settings → Secrets and variables → Actions:

| Secret | Value |
|---|---|
| `PXL_APP_ID` | App ID from §1.2 |
| `PXL_APP_PRIVATE_KEY` | full PEM body from §1.2, including BEGIN/END lines |
| `VITE_GITHUB_CLIENT_ID` | App's Client ID (shown on the App settings page) |

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

### 2.4 Register the budget owner

Edit `participating-orgs.yml` on the `participating-orgs` branch — add or update the entry:

```yaml
orgs:
  - login: PXLAutomation
    budget_owner: jane.doe@pxl.be
    spending_limit_eur: 100
```

Schema: `schemas/participating-orgs.schema.json`.

---

## 3. Per-org budget policy

Each participating org must have:

- A named human **budget owner** (email).
- A configured **Actions spending limit** (≥ recommended floor in §2.3).
- **Billing alerts** at 50% / 80% / 100% routed to the budget owner.

The budget owner's responsibility: decide whether to raise the limit when alerts fire, or to let CI pause. They are the on-call for Actions cost.

The hub side has no per-org cost. Everything billed lives in the participating org and is bounded by the limit there.

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
3. Update `PXL_APP_ID` (unchanged) and `PXL_APP_PRIVATE_KEY` (new PEM) in the hub's repo secrets.
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

---

## 10. Verification checklist (after major changes)

Run periodically, especially after touching workflows or App settings.

- [ ] `gh api /app` shows the minimum permission set: `administration: write, contents: write, metadata: read`. No `secrets` permission.
- [ ] `gh api /app/installations` shows the hub installation scoped to `repository_selection: selected, repositories: [pxl-classroom]`.
- [ ] Each participating org's installation shows `repository_selection: all`.
- [ ] `participating-orgs.yml` matches the set of orgs where the App is installed.
- [ ] `gh api /repos/PXL-Digital-Application-Samples/pxl-classroom/branches/main/protection` shows ≥2 approvals + signed commits + `ci.yml` required.
- [ ] No `.github/workflows/` directory exists in any `<org>/pxl-classroom-control` repo.
- [ ] `git grep corsproxy.io` in `frontend/src/` returns no matches.
- [ ] `git grep '@v[0-9]\+ ' .github/workflows/` returns no matches (all third-party actions SHA-pinned).
- [ ] Each participating org has `budget_owner` and `spending_limit_eur` set in `participating-orgs.yml`.
- [ ] Cold-load `https://<pages-host>/pxl-classroom/<org>/a/<sample-id>` lands on AssignmentView.
- [ ] The Instructor Notifications issue exists and is open in each control repo.
