# CLAUDE.md

Working conventions for this repo (`PXL-Digital-Application-Samples/pxl-classroom`).

## Git
- **No pull requests.** Commit and push directly to `main`. Never open a PR, never branch "to be safe."
- End commit messages with the standard `Co-Authored-By` trailer.

## Working style
- Be terse and concrete. Do things rather than explain them; give exact values/clicks when the user must act.
- Don't ask for command approval — permissions are set to bypass in `.claude/settings.local.json`.

## Progress tracking
- Implementation progress is tracked in `PROGRESS.md` — **v1 is fully released and all phases are marked complete.**
- Implementation plan lives in `IMPLEMENTATION_PLAN.md` — **marked complete.**
- *Authoritative AI Memory Rule:* When requirements or architecture change (like the shift from manual YAML to the Admin Panel UI, or the shift from manual org setup to the automated Setup Action), update `REQUIREMENTS.md`, `IMPLEMENTATION_PLAN.md`, and this file immediately.

## Project facts
- Target platform: **GitHub Team for Education. Never GitHub Enterprise.**
- **Architecture Note (Hub-and-spoke):** All workflows are centralized in the main `pxl-classroom` hub repository. Control repositories are purely data stores and contain no workflows.
- **Architecture Note (Assignments):** We do not use manual GitOps/YAML for assignment creation anymore. The system is driven by an **Instructor Admin Panel UI** built into the Vue SPA frontend, which uses the GitHub REST API to automatically generate YAML/JSON.
- **Architecture Note (Organization Setup):** We do not use manual repo creation or dragging-and-dropping of template files. Provisioning new organizations is 100% automated via the **Setup Organization GitHub Action** in the main repository.
- **Architecture Note (Central Infra):** The central GitHub App is created via an automated **App Manifest** form located at the dashboard's `/setup` route. The dashboard itself deploys automatically via the `deploy-frontend.yml` action.
- **Scripting Note:** Do not use inline `node -e` scripts in GitHub Actions YAML. Extract all JavaScript logic to standalone files in `scripts/`.
- This repo is the shared codebase / spike host. Spikes live in `spikes/`; plan in `SPIKES_PLAN.md`; requirements in `REQUIREMENTS.md`.
