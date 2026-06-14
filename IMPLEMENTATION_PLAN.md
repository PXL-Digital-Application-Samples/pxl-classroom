# PXL Classroom — Implementation Plan (v1)

Status: Active
Derived from: `REQUIREMENTS.md` (v1.0, Approved) and `SPIKES_PLAN.md` (all six spikes pass)
Last updated: 2026-06-14

## 1. Approach

Build a **pilot vertical slice** first: one complete assignment lifecycle —
accept → provision → work → deadline + lock-down → preserve → report — for a
single course in **`PXLAutomation`**, then harden and scale to all orgs. This
de-risks integration early and yields a usable system fast.

Every architectural risk is already proven against real PXL orgs by the spikes;
this plan turns those proofs into durable components.

### Decisions locked for v1
- **Pilot org:** PXLAutomation (templates exist, App installed, heavy Classroom user).
- **Frontend:** one combined, role-gated Vue SPA on public GitHub Pages.
- **Acceptance:** public broker → `repository_dispatch` → **private control repo** provisions (keeps roster/logs private).
- Plus all `REQUIREMENTS.md` resolved decisions (Team-only, never Enterprise; snapshot evidence + lock-down; device-flow + Account/Starring; per-org control repos + runtime-fetch dashboard; single private control repo per org; 2-year retention; archive = branch in private repo).

## 2. Architecture

Four layers (from REQUIREMENTS → Multi-organization architecture):

| Layer | What | Where |
|---|---|---|
| Credentials | one GitHub App, installed per org; per-install scoped tokens | App owned centrally |
| Code | shared reusable workflows + composite actions + scripts | **this repo** (`PXL-Digital-Application-Samples/pxl-classroom`) |
| Data + execution | per-org control repo holds data and runs thin caller workflows | one **private control repo per org** |
| Dashboard | one public Vue SPA; private data fetched at runtime with the viewer's own token | dedicated **public frontend repo** + Pages |

### End-to-end flow
```
Student → Vue SPA (device-flow auth, GitHub App user token w/ Starring)
       → stars PUBLIC broker repo (PUT /user/starred)            [Spike 2+3]
broker watch:started workflow → validates actor (login + immutable id)
       → repository_dispatch {assignment, login, id} → PRIVATE control repo  (UNTESTED hop — prove first in Phase 1)
control repo acceptance-handler → roster match → enqueue provisioning
       → reusable provision workflow (App installation token)    [Spike 1 ✓ built]
       → private repo from template + grant student admin (idempotent)
       → registry updated; SPA polls and shows the repo link
... student works ...
control repo scheduled collector → snapshots submission ref       [Spike 4]
at deadline → lock-down (App demotes admin→read) + final snapshot  [Spike 4 ✓]
       → preserve candidate SHA to private archive repo           [Spike 5 ✓]
control repo generators → public assignment metadata → Pages (privacy-scanned) [Spike 6 ✓]
Lecturer → same SPA → picks an owned org (App installed) → reads control-repo data at runtime
```

### Trust boundaries
- Student repos are **not** authoritative; students have admin (for Actions/runners/secrets exercises) until the deadline.
- The **public broker** holds no roster and ideally no repo-admin power — see §7 (dispatcher credential).
- All authoritative data lives in the **private control repo**; students never have write to it.

## 3. Repositories & infrastructure

| Repo / resource | Visibility | Purpose | Status |
|---|---|---|---|
| `pxl-classroom` (this) | private | shared code: reusable workflows, composite actions, scripts | exists |
| `pxl-classroom-app` (frontend) | **public** | combined Vue SPA, GitHub Pages | **to create** |
| control repo per org, e.g. `pxl-classroom-control` | private | assignments, roster, registry, observations, reports | **to create (template)** |
| broker repo per assignment, e.g. `broker-<assignment-id>` | **public** | star target; `watch:started` handler | **automated** |
| archive repo per org, e.g. `pxl-classroom-archive` | private | preserved submission commits | **to create** |
| **Provisioning GitHub App** | — | provisioning + lock-down + collection + preservation; Account/Starring + Device Flow for the browser | exists (spike App `pxl-classroom-provisioner`) — finalize perms |
| **Dispatcher GitHub App** (optional, recommended) | — | minimal: only `repository_dispatch`/contents-write to control repo, for public brokers | **decide (§7)** |

App permission set (confirmed): Repo **Administration RW, Contents RW, Metadata R**; user **Account/Starring RW**; **Device Flow** enabled.

## 4. Shared codebase units (this repo)

Each is a composite action and/or reusable workflow; per-org control repos call them. Build on the spike artifacts.

| Unit | From spike | Status |
|---|---|---|
| `provisioning/` action + `provision.yml` reusable workflow | Spike 1 | ✅ **built** (SHA-pinned, concurrency, outputs) |
| `acceptance/` — validate dispatch payload, roster-match, enqueue | Spike 3 | to build |
| `collect/` — snapshot submission ref(s), write observation | Spike 4 (`deadline.mjs` snapshot) | to build |
| `lockdown/` — demote student admin→read at deadline + final snapshot | Spike 4 (`deadline.mjs` ✓) | adapt |
| `preserve/` — copy candidate SHA → archive, verify hash | Spike 5 (`preserve.sh` ✓) | adapt |
| `pages/` — generate public JSON + run privacy scanner, deploy | Spike 6 (`scan.mjs` ✓) | adapt |
| `report/` — compute deadline report, CSV/JSON export | — | to build |
| `registry/` — repair/reconcile registry vs GitHub state | — | to build |
| `notify/` — instructor tracking issue + workflow summaries, deduped | — | to build |

All third-party actions **SHA-pinned**; all scripts validate untrusted inputs against allowlists; no secrets in logs.

## 5. Control repository data model

Per-org private repo. Schema-versioned, machine-readable, Git-reviewable, source vs generated separated.

```
assignments/<id>.yml         # definition (schema_version, template, opens/deadline, refs, state)
students/roster.yml          # student_id, display_name, class_group, github_login, github_id, active
acceptances/<id>/<login>.json# accepted-at, actor login+id, star event ref
repositories/<id>/<login>.json # repo_id (immutable), name, url, created_at, provision run id, access state
observations/<id>/<login>/*.json # observation_at, ref, sha (append-only)
reports/<id>.json            # computed: on-time SHA, late activity, uncertainty, preservation status
reports/dashboard.json       # GENERATED private aggregate for the lecturer dashboard (one fetch, not N files)
overrides/<id>/<login>.json  # append-only lecturer overrides w/ reason
errors/<id>.json             # provisioning/collection failures
public/                      # GENERATED public metadata for Pages (privacy-scanned)
schemas/                    # JSON Schemas, versioned
.github/workflows/          # thin callers of shared units
```

Distinguish **facts** (from GitHub), **observations** (timestamped), **calculated** values, and **overrides**. Overrides are append-only and never erase evidence. Retention: current + previous academic year, then archive (§REQUIREMENTS Retention).

## 6. Trusted workflows in the control repo (thin callers)

| Workflow | Trigger | Calls | Notes |
|---|---|---|---|
| validate-config | PR / manual | schema validation | block merge on invalid |
| publish-assignment | manual | creates broker repo, sets state=published | dry-run capable |
| acceptance-handler | `repository_dispatch` | `acceptance/` → `provision.yml` (matrix, throttled) | idempotent; §7 |
| collect-activity | schedule (6h; 15m ±2h of deadline) + manual | `collect/` | stores cursor; detects gaps |
| finalize-deadline | schedule at deadline + manual | `lockdown/` + `preserve/` + `report/` | records uncertainty |
| regenerate-dashboard | after data change + manual | `pages/` (+ privacy scan) | atomic publish; keep last-good |
| retry-failed / repair-registry | manual | `provision/`, `registry/` | resume after partial failure |
| archive-assignment / export-report | manual | `report/` | CSV + JSON, schema-versioned |

Every run records: run URL, actor, op, assignment, student/repo, times, outcome, GitHub IDs, error category.

## 7. Acceptance pipeline (broker → dispatch → control)

1. **Publish** creates a **public broker repo** `broker-<assignment-id>` with a `watch:started` workflow on its default branch.
2. **Student stars** the broker (SPA calls `PUT /user/starred` with the device-flow user token — Account/Starring permission). [Spike 3 ✓: fires with actor + immutable `sender.id`.]
3. **Broker workflow** validates the actor and emits `repository_dispatch` (`event_type: acceptance`, payload `{assignment_id, github_login, github_id}`) to the **private control repo**. It does the minimum and logs nothing identifying beyond the (already public) star.
4. **Control-repo acceptance-handler** gates the actor against the assignment's **eligible-`github_login` allowlist** (pre-populated roster — see *Eligibility gate*), binds the GitHub account (login + immutable id) to that roster entry, checks the registry for an existing repo (idempotent), and enqueues provisioning. A star carries only GitHub identity — there is no student-supplied key — so eligibility must come from the pre-populated roster, not from the event.
5. **Provisioning** runs via the built reusable workflow, **throttled** (see §11) and **concurrency-guarded** per org+repo. Re-acceptance (unstar→restar re-fires — Spike 3) resolves to the same repo via the registry; never duplicates.
6. **Student SPA** polls the student's own visible resources with their own token — `GET /repos/{org}/{deterministic-name}` and `GET /user/repository_invitations` — **never the private registry** — and shows the repo link / pending state.

**Eligibility gate (security — resolves a real hole).** The broker is *public*, so anyone on GitHub could star it. v1 therefore gates acceptance to a **pre-populated eligible-login allowlist** in the roster (pre-association). This is within spec ("reject ineligible unless open acceptance") and consistent with "no institutional check" — it restricts *which* GitHub accounts may accept without verifying the human behind them. **Open acceptance** (no allowlist) is a per-assignment option but MUST add a mitigation (per-assignment count cap, or require the student be a pre-invited outside collaborator), else a stranger can trigger a real provision. Mapping login→real student stays a lecturer reconciliation step; MS 365/Forms verification is a future enhancement.

**Security of the public broker (important):** the broker is public, so its workflow must not hold powerful credentials in logs. Two options:
- **(Recommended) Separate minimal "dispatcher" GitHub App** whose only ability is `repository_dispatch`/contents-write to the control repo. The public broker never holds repo-admin power; the powerful provisioning App stays out of public repos.
- Or reuse the provisioning App with its key as an org secret **scoped to broker repos only**, masked in logs, with a minimal workflow. Acceptable (students can't read secrets or alter workflows) but a larger surface.
Decide in Phase 1; default to the dispatcher App.

## 8. Frontend — combined role-gated Vue SPA (public Pages)

Single Vue app, built with Node tooling, deployed as static assets to a **public** repo's Pages. No server (no Express). All private data fetched **at runtime with the viewer's own token**.

**Auth:** GitHub **device flow** on the App (Spike 2 ✓) — 8h user-to-server token + refresh; in-memory/session only (never localStorage). Reuse `spikes/02-auth/device-flow.mjs` logic in the browser.

**Student view:** open assignment link → device-flow auth → see title/description/dates/state → **Accept** (stars the broker via token) → pending state → poll **own visible resources** (`GET /repos/{org}/{name}` + `GET /user/repository_invitations`, own token — never the private registry) → repo link (copyable). Safe to refresh; idempotent.

**Lecturer view (role-gated):** list orgs the viewer owns where the App is installed (`/user/installations` ∩ owner) → pick org → list assignments (from control-repo public/runtime) → assignment overview + per-student table (login, acceptance, submission status, repo, on-time/late, preservation, warnings, links) → CSV/JSON export. Reads a **private aggregate JSON** the control repo generates (`reports/dashboard.json`) in **one** fetch — not hundreds of per-student contents-API calls — at runtime with the lecturer's token.

**Public Pages JSON:** only public assignment metadata; everything else runtime-fetched. **CI gate:** `pages/scan.mjs` (Spike 6 ✓) blocks deploy if roster/email/token/key leaks. Show generation time; handle stale/last-good data.

**Accessibility (REQUIREMENTS):** keyboard, semantic HTML, focus states, no color-only state, absolute dates + timezone, clear progress/error messages, ≤ (open → auth → one accept → open repo).

## 9. Deadlines, evidence, lock-down, preservation

- **Evidence = central snapshots** (level A): collect submission-ref SHA on schedule, store observation (id/ref/sha/observed_at). Report **uncertainty interval** when exact push time is unknown.
- **Schedules:** 6h normal; 15m from −2h to +2h around a deadline (config defaults, not guarantees); manual finalize.
- **Lock-down at deadline** (Spike 4 ✓): App demotes student admin→read; student can't self-restore; final snapshot; record lock-down time → residual uncertainty = deadline→execution gap.
- **Preserve** (Spike 5 ✓): push candidate SHA to private archive repo branch; verify hash; survives source force-push; no secrets in archive.
- **Late activity:** report observed late pushes/SHAs/refs/force-pushes/visibility changes; never auto-delete; lecturer grades last on-time or chosen state via override.

## 10. Security

- Least privilege; finalized App permission set (§3); short-lived installation tokens; never exposed to student-controlled workflows; never logged; rotatable without touching student repos.
- **Public broker** holds no roster and (recommended) no repo-admin credential — dispatcher App (§7).
- SHA-pin all third-party actions; validate repo names/refs/logins/paths/inputs against allowlists (built into `provision.mjs`); concurrency prevents duplicate provisioning; compare-and-set / idempotent writes.
- **Recovery runbooks** for: compromised App key (rotate), malicious acceptance burst (throttle/pause), accidentally-public student repo, deleted control data (Git history), failed Pages deploy (keep last-good), incomplete provisioning (retry from registry), rate limiting (backoff), GitHub outage (resume from cursor).

## 11. Reliability & scale

- **Burst:** secondary limit is **80 content-writes/min, 500/hr**. A 250-student class ≈ 500 writes (create + grant). → Acceptance-handler **queues and throttles** provisioning (matrix with bounded concurrency, target ≤ ~60 writes/min, backoff on `403 + x-ratelimit-remaining:0` / `Retry-After`), spreads multi-class bursts across time. Never fire 250 at once.
- Tolerate duplicate events, delayed/canceled runs, pagination, transient failures, renames, repeated acceptance, partial provisioning, stale Pages. Bounded exponential backoff. Each sync emits machine-readable result + human summary. One failure never blocks other students. Bulk workflows resume after partial failure.

## 12. Notifications & audit

- Instructor-only **tracking issue** in the control repo + workflow summaries; deduped. Surface: failed provisioning/collection, gap spanning a deadline, missing access, unexpected deletion/transfer, late activity, preservation failure.
- Audit: every state-change records run/actor/op/ids/times/outcome/error-category; config changes via Git commits; generated records carry source revision + generator version.

## 13. Milestones

### Phase 0 — Foundations (infra)
- [ ] Finalize the provisioning App permissions (Admin/Contents/Metadata + Account/Starring + Device Flow); production secrets `PXL_APP_ID`/`PXL_APP_PRIVATE_KEY`; rotate the spike key.
- [ ] Decide + create the **dispatcher App** (or scoped-secret model) for public brokers.
- [ ] Create the **control repo template** (data dirs + schemas + thin caller workflows) and the per-org **archive repo**, both in PXLAutomation.
- [ ] Create the **public frontend repo** + Pages; Vue skeleton + device-flow auth module + CI privacy scan.
- **Done when:** PXLAutomation has a control repo, archive repo, frontend Pages shell, and finalized App.

### Phase 1 — Pilot vertical slice (one assignment, PXLAutomation)
- [ ] **Prove the `repository_dispatch` hop FIRST** (public broker → private control repo): the riskiest *untested* integration. Confirm a star fires the broker workflow, which mints a token and successfully dispatches an event that triggers the control repo's handler. (Spike 3 proved star→watch→actor→secret, **not** this hop.)
- [ ] Pre-populate the pilot roster with eligible `github_login`s (enables the eligibility gate, §7).
- [ ] Define one real assignment (e.g. from `template-automation-pe-1`); `publish-assignment` creates the public broker.
- [ ] Build `acceptance/` (dispatch validate + roster match + enqueue) and wire broker→dispatch→provision.
- [ ] Student SPA: auth → accept (star) → poll → repo link, end-to-end with `tomccargo`.
- [ ] Build `collect/` snapshots; `finalize-deadline` (lock-down + preserve + report).
- [ ] Lecturer dashboard: org picker + this assignment's per-student table + CSV export.
- **Done when:** one student accepts via the SPA, gets a repo, the deadline locks them out, the submission is preserved, and the lecturer sees it + exports CSV — all GitHub-only.

### Phase 2 — Harden
- [ ] Notifications + tracking issue; recovery runbooks; retry/repair workflows; dry-run modes everywhere.
- [ ] Dashboard polish (filters/search, overrides UI, warning indicators); accessibility pass.
- [ ] Gap detection + report regeneration after delayed data.

### Phase 3 — Scale
- [ ] Multi-assignment, multi-org (install App + control/archive repos per org); org-agnostic config.
- [ ] Burst throttling validated at class scale (rate-limit-aware queue); controlled concurrency.
- [ ] 20 assignments / 500 students / 250-burst targets.

### Phase 4 — v1 release
- [ ] Meet `REQUIREMENTS.md` "Acceptance criteria for version 1"; docs + lecturer runbook; final security review.

## 14. Risks & open items
- **Burst near 500 writes/hr** — mitigated by throttled queue; multiple simultaneous classes need spreading.
- **Device-flow extra step** — acceptable per spec; revisit OAuth/PKCE only if UX demands.
- **Lock-down not tamper-proof** — by design; report late activity; preservation is the safety net.
- **Public broker credential surface** — mitigated by the dispatcher App (§7).
- **GitHub outages / scheduled-run lateness** — cursors + resumable collection + manual finalize.
- **Public broker + acceptance** — anyone could star a public broker, so v1 gates to a pre-populated eligible-login allowlist (pre-association); open acceptance needs a per-assignment cap/allowlist. Lecturer reconciles login→student; MS 365/Forms verification is future. (No institutional check in v1.)
- **Untested dispatch hop** — broker→control `repository_dispatch` is proven nowhere yet; it is the first Phase-1 task.

## 15. Reuse map (already built/proven)
- `provisioning/` — production provision action + reusable workflow (✅ built, validated).
- `spikes/02-auth/device-flow.mjs` — device-flow + star (browser auth basis).
- `spikes/04-deadline/deadline.mjs` — snapshot + lock-down (basis for `collect/` + `lockdown/`).
- `spikes/05-preservation/preserve.sh` — preservation (basis for `preserve/`).
- `spikes/06-pages-privacy/scan.mjs` — privacy gate (basis for `pages/` CI check).
