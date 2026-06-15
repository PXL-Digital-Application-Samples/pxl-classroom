# REVIEW_PROGRESS

Tracks execution of `REVIEW_PLAN.md`. Updated as items land.

Last updated: 2026-06-15

Status codes: `[x]` done · `[ ]` todo · `[~]` in progress · `[!]` blocked on human · `[-]` skipped / deferred

---

## Wave 1 — Foundation

- [x] F1 YAML lib (package.json + lib/yaml.mjs + action.yml npm-ci + script refactors)
- [x] F2 Shared gh() helper (lib/gh.mjs + script refactors)
- [x] F3 Test scaffold (tests/ + ci.yml) — 8/8 passing locally
- [x] F4 Pages SPA 404 shim
- [!] F5 Branch protection (GitHub Settings — needs admin)
- [!] F6 Second App install on PXL-DAS (GitHub UI — needs admin)
- [!] F7 Drop secrets:write from App config (GitHub UI — needs admin)

## Wave 2 — Architecture move

- [ ] A1 broker-workflow.yml dispatch target → pxl-classroom
- [ ] A2 central acceptance-handler.yml
- [ ] A3 central process-queue.yml
- [ ] A4 central collect-activity.yml + smart cron + per-org concurrency
- [ ] A5 central finalize-deadline.yml + cron
- [ ] A6 central reconcile-registry.yml + daily cron
- [ ] A7 central publish/retry/export/regenerate-dashboard
- [ ] A8 rewritten setup-org.yml (no secrets injection)
- [ ] A9 delete control-repo-template/workflows + .github/workflows
- [!] A10 flip pxl-classroom to public (Settings — needs admin)
- [-] A11 re-publish existing brokers (no live cohort yet — documented procedure)

## Wave 3 — P0 functional + cron tuning

- [ ] P0-4 preserve in finalize-deadline (naturally part of A5)
- [ ] P0-5 fix publish workflow filename in AdminView
- [x] P0-7 apply lecturer overrides in report.mjs — landed in F1 pass + test covers it
- [ ] P0-8 read template from assignment in process-queue
- [~] P0-10 read repository_name_pattern in SPA — generate.mjs emits it; SPA side still TODO
- [ ] D9 process-queue cron 5min → 30min (part of A3)

## Wave 4 — Security + pinning

- [ ] P0-1 remove corsproxy.io
- [ ] P1-7 SHA-pin all third-party actions

## Wave 5 — SPA modernization

- [ ] V0 router URL: /a/:id → /:org/a/:id
- [ ] V1 client-side ajv (frontend/src/lib/validate.js)
- [ ] V2 schemas served from Pages
- [ ] V3 validate before commit in Admin UI
- [ ] V4 org picker via App-installation enumeration
- [ ] V5 fetch public data from /data/<org>/
- [ ] P1-8 drop fake-assignment fallback
- [ ] P1-9 public assignment listing on /
- [ ] P1-10 WCAG-AA contrast
- [ ] P1-11 delete orphaned components
- [ ] P1-12 centralize date formatting
- [ ] P1-13 toast replacing alert()

## Wave 6 — Reliability & notifications

- [ ] P1-4 wire notify to all 7 categories
- [ ] P1-5 per-{org, assignment, login} concurrency in process-queue
- [ ] P1-6 dashboard.json size handling
- [ ] P2-2 broker boundary comment

## Wave 7 — Tests, ops, docs

- [ ] P2-1 smoke + unit tests
- [!] OPS1 per-org spending limits (Billing UI — needs admin per org)
- [ ] OPS2 budget owner enforcement in setup-org
- [ ] P2-3 shallow clone in preserve.mjs
- [ ] P2-4 cap polling in SPA
- [ ] P2-5 device-code phishing warning
- [ ] P2-6 delete AGENTS.md + GEMINI.md
- [ ] P2-7 move node -e snippets into scripts/
- [ ] P2-8 Admin UI YAML preview
- [ ] P2-11 minor items (§4.6 REVIEW.md)
- [ ] P2-10 doc updates

---

## Notes

- **Wave 1 landed.** F1+F2+F3+F4 all in. `lib/yaml.mjs` + `lib/gh.mjs` replace 5 ad-hoc YAML parsers and 6 ad-hoc gh() helpers. Every composite action now runs `npm ci --omit=dev` first. SPA 404 shim in `frontend/public/404.html` + decoder in `frontend/index.html`. CI workflow runs `node --test tests/*.test.mjs` on PR + push. All 8 tests pass locally.
- **Bonus landings in F1 pass:**
  - **P0-7** (apply lecturer overrides) — implemented end-to-end in `report.mjs`, tested via `tests/report.test.mjs`. Override extends per-student deadline; classification respects it; CSV gains `effective_deadline_at` / `override_applied` / `override_reason` columns.
  - **§4.6 nits** — roster now read as an array (yaml lib unlocks this), so report includes not-accepted roster students. Dynamic `import("node:fs")` inside `accept.mjs` loop replaced with top-level static import.
  - **P0-10 partial** — `pages/generate.mjs` now emits `repository_name_pattern` in public assignment metadata. SPA-side use of it (V5) still pending.
- **Blocked items needing human action:**
  - F5: branch protection on pxl-classroom (Settings → Branches)
  - F6: install the App a second time on PXL-Digital-Application-Samples scoped to pxl-classroom only
  - F7: edit existing App config → remove secrets:write
  - A10: flip pxl-classroom to public (after F5 + secret-history scan)
  - OPS1: per-org Actions spending limits (Billing per org)
