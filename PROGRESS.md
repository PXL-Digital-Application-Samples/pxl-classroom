# PXL Classroom — Implementation Progress

Tracks active work against `IMPLEMENTATION_PLAN.md`. Update this file as tasks complete.
Last updated: 2026-06-14

## Phase 0 — Foundations (infra)

- [x] Finalize provisioning App permissions (Admin/Contents/Metadata + Account/Starring + Device Flow); set production secrets `PXL_APP_ID`/`PXL_APP_PRIVATE_KEY`; rotate spike key
- [x] Decide + create the **dispatcher App** (or scoped-secret model) for public brokers
- [x] Create the **control repo template** (data dirs + schemas + thin caller workflows) in PXLAutomation
- [x] Create the per-org **archive repo** in PXLAutomation
- [x] Create the **public frontend repo** + Pages; Vue skeleton + device-flow auth module + CI privacy scan

## Phase 1 — Pilot vertical slice (one assignment, PXLAutomation)

- [x] Prove the `repository_dispatch` hop (public broker → private control repo) — riskiest untested integration
- [x] Configure open window + per-assignment cap (`max_acceptances`) guardrails
- [x] Define one real assignment from `template-automation-pe-1`; `publish-assignment` creates the public broker
- [x] Build `acceptance/` (dispatch validate + roster match + enqueue) and wire broker→dispatch→provision
- [x] Student SPA: auth → accept (star) → poll → repo link — end-to-end with `tomccargo`
- [x] Build `collect/` snapshots; `finalize-deadline` (lock-down + preserve + report)
- [x] Lecturer dashboard: org picker + per-student table + CSV export

## Phase 2 — Harden

- [x] Notifications + tracking issue; recovery runbooks; retry/repair workflows; dry-run modes
- [x] Dashboard polish (filters/search, overrides UI, warning indicators); accessibility pass
- [x] Gap detection + report regeneration after delayed data

## Phase 3 — Scale

- [x] Multi-assignment, multi-org; org-agnostic config
- [x] Burst throttling validated at class scale (rate-limit-aware queue)
- [x] 20 assignments / 500 students / 250-burst targets

## Phase 4 — v1 release

- [x] Meet `REQUIREMENTS.md` acceptance criteria; docs + lecturer runbook; final security review

## Notes

- All 6 technical spikes **passed** — see `SPIKES_PLAN.md` for evidence
- Spike artifacts to reuse: `provisioning/` (built), `spikes/02-auth/device-flow.mjs`, `spikes/04-deadline/deadline.mjs`, `spikes/05-preservation/preserve.sh`, `spikes/06-pages-privacy/scan.mjs`
- First Phase-1 task (dispatch hop) must succeed before anything else in Phase 1 proceeds
