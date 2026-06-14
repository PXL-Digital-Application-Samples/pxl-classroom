# CLAUDE.md

Working conventions for this repo (`PXL-Digital-Application-Samples/pxl-classroom`).

## Git
- **No pull requests.** Commit and push directly to `main`. Never open a PR, never branch "to be safe."
- End commit messages with the standard `Co-Authored-By` trailer.

## Working style
- Be terse and concrete. Do things rather than explain them; give exact values/clicks when the user must act.
- Don't ask for command approval — permissions are set to bypass in `.claude/settings.local.json`.

## Progress tracking
- Implementation progress is tracked in `PROGRESS.md` — update it as tasks complete.
- Implementation plan lives in `IMPLEMENTATION_PLAN.md`.

## Project facts
- Target platform: **GitHub Team for Education. Never GitHub Enterprise.**
- This repo is the shared codebase / spike host. Spikes live in `spikes/`; plan in `SPIKES_PLAN.md`; requirements in `REQUIREMENTS.md`.
- Provisioning uses a per-org GitHub App (`pxl-classroom-provisioner`), repo secrets `SPIKE_APP_ID` / `SPIKE_APP_PRIVATE_KEY`.
