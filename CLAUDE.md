# CLAUDE.md

Working conventions for this repo (`PXL-Digital-Application-Samples/pxl-classroom`).

## Git
- **No pull requests.** Commit and push directly to `main`. Never open a PR, never branch "to be safe."
- End commit messages with the standard `Co-Authored-By` trailer.

## Working style
- Be terse and concrete. Do things rather than explain them; give exact values/clicks when the user must act.
- Don't ask for command approval — permissions are set to bypass in `.claude/settings.local.json`.

## Canonical documentation
- **`ARCHITECTURE.md`** — full technical specification (topology, trust model, data model, workflows, actions, flows, constraints). This is the single source of truth for *what the system is*.
- **`RUNBOOK.md`** — operational procedures (setup, onboarding, monitoring, edge cases, recovery).
- **`README.md`** — short orientation + links.
- *Authoritative AI Memory Rule:* when architecture or operational procedure changes, update `ARCHITECTURE.md`, `RUNBOOK.md`, and this file in the same commit. Do not introduce new top-level planning/progress/review documents — the project no longer uses them.

## Project facts (load-bearing — read ARCHITECTURE.md for detail)
- Target platform: **GitHub Team for Education. Never GitHub Enterprise.**
- **Hub-and-spoke:** all workflows live in the central public `pxl-classroom` hub. Per-org control repos hold data only and contain no workflow files.
- **Minimal-minutes (Wave 8):** synchronous provisioning (no queue), one nightly `daily-activity.yml` cron that disables itself when no assignment is active, event-driven dashboard regen. The system bills zero minutes when idle.
- **Admin Panel is the source of truth for lecturer actions** — assignment YAML and override JSON are generated and committed via the SPA + Contents API. Manual YAML editing is supported but not the primary path.
- **`pxl-classroom` CLI is the parallel lecturer surface** (in `cli/`) — same App, same device-flow auth, same schemas as the SPA. Owns the workflows that scale poorly through clicks: CSV roster import, install audits, feedback-PR orchestration, bulk submission download. The SPA links to it via "Copy CLI command" affordances. For **autograding**, the system supports two paths: lecturer-local (via CLI) or student-side (`github_actions`, synced via SPA).
- **Central GitHub App** is created via the App Manifest form at the SPA's `/setup` route. Frontend deploys automatically via `deploy-frontend.yml`.
- **VITE_CORS_PROXY_URL**: If overridden, must explicitly end with `?url=` or `?` (which is auto-rewritten) for the device-flow proxy.
- **Scripting Note:** do not use inline `node -e` scripts in workflow YAML. Extract to `scripts/`.
- **One source of truth per cross-surface concern.** `lib/audit.mjs` exports `EXPECTED_APP_PERMISSIONS` consumed by both CLI and `SetupView.vue`; `lib/gittree.mjs` is HTTP-stack-agnostic and shared by CLI, scripts, and SPA. Don't fork these.
- **Git Push Rule:** Always use `$env:GITHUB_TOKEN=""; git push origin main` when pushing to this repository to avoid authentication failures caused by dummy tokens in the environment.
