# Provisioning

The repository provisioner handles student repository creation and role grants. It is exposed in two reusable units:

- **Composite action** - `provisioning/action.yml` + `provision.mjs`. Carries its own logic (reached via `$GITHUB_ACTION_PATH`), mints the per-org **GitHub App installation token**, and executes the provisioning operations. Third-party actions are pinned to full commit SHAs.
- **Reusable workflow** - `.github/workflows/provision.yml` (`workflow_call`). Enforces the **`concurrency`** guard (one in-flight provision per org+repo to prevent duplicate repositories), sets minimal workflow `permissions`, and exposes typed inputs, secrets, and outputs.

> Why both: composite actions cannot declare `concurrency`, and preventing duplicate repository creation during acceptance bursts is a core requirement - so the concurrency guard lives in the caller workflow.

## What it does (idempotent)

1. Validates inputs against strict allowlists (org/repo names, GitHub login, permission levels).
2. Verifies that the template repository exists and has template mode enabled.
3. If the target repo already exists -> **reuses** it (no duplicates); otherwise creates it as a private repository from the template.
4. Grants the student their configured permission level (default `admin`) - creating an invitation if outside collaborator.
5. If `feedback_pr: true` is configured, creates and protects the `pxl-baseline` branch.
6. If student-side autograding is configured (`execution_environment: github_actions`), injects `.github/workflows/autograding.yml`.
7. Emits outputs `repo_id`, `repo_url`, `repo_name`, `outcome`, and step summary.

`outcome` ∈ `created | reused | dry-run:ok | fail:validation | fail:auth | fail:template-missing | fail:not-a-template | fail:create | fail:grant`.

## Calling it

```yaml
jobs:
  call:
    uses: PXL-Digital-Application-Samples/pxl-classroom/.github/workflows/provision.yml@main
    with:
      org: PXLAutomation
      template_owner: PXLAutomation
      template_repo: template-automation-pe-1
      target_repo: linux-processes-janepxl
      student_login: janepxl
      # student_permission: admin   # optional
      # repo_private: true          # optional
    secrets:
      app_client_id: ${{ secrets.PXL_APP_CLIENT_ID }}
      app_private_key: ${{ secrets.PXL_APP_PRIVATE_KEY }}
```

## Requirements

- The GitHub App is **installed on the target org** with repository administration and contents write permissions.
- Secrets `app_client_id` / `app_private_key` are provided by the caller workflow.
