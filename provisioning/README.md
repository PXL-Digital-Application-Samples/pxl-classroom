# Provisioning (production)

The production version of the Spike 1 provisioner, as the two reusable units the multi-org architecture calls for:

- **Composite action** — `provisioning/action.yml` + `provision.mjs`. Carries its own code (reached via `$GITHUB_ACTION_PATH`), mints the per-org **GitHub App installation token**, and runs the provisioner. Third-party actions are pinned to full commit SHAs.
- **Reusable workflow** — `.github/workflows/provision.yml` (`workflow_call`). Owns the **`concurrency`** guard (one in-flight provision per org+repo → no duplicate repos), `permissions`, and typed inputs/secrets/outputs. It calls the action.

> Why both: a composite action can't declare `concurrency`, and duplicate-provision prevention is a hard requirement — so the guard lives in the workflow. (Architecture allows "reusable workflows **or** a published action"; this uses both, each for what it's good at.)

## What it does (idempotent)

1. Validate inputs against strict allowlists (org/repo names, GitHub login, permission).
2. Verify the template exists and is a template.
3. If the target repo already exists → **reuse** it (no duplicate); else create it private from the template.
4. Grant the student their role (default `admin`) — an invitation for outside collaborators.
5. Emit outputs `repo_id`, `repo_url`, `repo_name`, `outcome` and a step summary.

`outcome` ∈ `created | reused | dry-run:ok | fail:validation | fail:auth | fail:template-missing | fail:not-a-template | fail:create | fail:grant`.

## Calling it

```yaml
jobs:
  call:
    uses: PXL-Digital-Application-Samples/pxl-classroom/.github/workflows/provision.yml@v1
    with:
      org: PXLAutomation
      template_owner: PXLAutomation
      template_repo: template-automation-pe-1
      target_repo: linux-processes-janepxl
      student_login: janepxl
      # student_permission: admin   # optional
      # repo_private: true          # optional
    secrets:
      app_id: ${{ secrets.PXL_APP_ID }}
      app_private_key: ${{ secrets.PXL_APP_PRIVATE_KEY }}
```

See `.github/workflows/provision-caller-example.yml` for a manual (`workflow_dispatch`) caller used for validation (it reads the `SPIKE_APP_*` secrets).

## Requirements

- The GitHub App is **installed in the target org**, with permissions **Administration RW, Contents RW, Metadata R** (the confirmed provisioning set).
- Secrets `app_id` / `app_private_key` provided by the caller.

## Versioning

The reusable workflow pins the composite action to a tag (`@v1`). Cut a new tag when the action changes; callers pin the workflow to a tag/SHA too. Third-party actions inside the composite action are SHA-pinned (checkout v6.0.3, create-github-app-token v3.2.0, setup-node v6.4.0).
