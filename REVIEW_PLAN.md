# PXL Classroom — Fix Plan (REVIEW_PLAN.md)

Companion to: `REVIEW.md` (2026-06-15)
Status: Drafted 2026-06-15 — ready for execution
Owner: TBD
Target: v1.0 GA (currently mis-labeled "released" in `PROGRESS.md` — see Wave 7)

> **This is a full rewrite of an earlier draft of this plan.** The earlier draft was sequenced around fixing the per-org control-repo model in place. After the Actions-minutes audit (REVIEW.md follow-up discussion), we picked a structural change: move all trusted workflows to a now-public central `pxl-classroom` repo, so private-org minutes are no longer consumed by the system itself. That ripple changes the secrets:write story, the validation story, and the Pages-data story all at once. The plan below reflects that.

---

## TL;DR

Fourteen decisions and one architectural shift collapse the fix list from 31 items into seven coherent waves:

1. **Public-flip + workflows-move-to-center** (the big move). Resolves the Actions-budget problem and the secrets:write problem in one stroke. Per-org control repos become pure data.
2. **Action scripts stay unchanged** — central workflows checkout the per-org control repo into a workspace, run the existing scripts, push back. Saves 3 days of script rewriting.
3. **Single App, two installations.** PXLAutomation install has full provisioning scope; PXL-Digital-Application-Samples install is repo-scoped to `pxl-classroom` only and used solely by brokers for dispatch.
4. **SPA-side ajv** validates assignment YAML before commit; no more on-push workflow trigger in control repos.
5. **Multi-org Pages output** served from `pxl-classroom` itself at `/data/<org>/assignments.json`. `deploy-frontend.yml` and `regenerate-dashboard.yml` share the `pages` concurrency group, both write via Actions-source.
6. **`participating-orgs` branch** holds the org registry with lighter protection — avoids the Setup-Org-vs-main-branch-protection collision.
7. **Operational student-CI controls** — spending limit, alerts, runbook policy — accept the cost rather than restrict students.
8. **Plus all P0/P1/P2 fixes** from REVIEW.md, restructured to land in the new architecture.

Total effort: **~10 working days** for one engineer end-to-end, ~7 calendar days with two engineers in parallel where possible. Wave 1 and Wave 2 are gating; Waves 3–7 can be sequenced flexibly.

---

## Locked decisions

| # | Question | Decision | Source |
|---|---|---|---|
| **D1** | Secrets:write fix | **Move workflows to public pxl-classroom (mitigation B).** Dissolves the secrets:write problem entirely — no App-key injection into per-org control repos because no workflows live there. | This rewrite |
| **D2** | Acceptance pipeline | **Keep queued** (`acceptance-handler.yml` + `process-queue.yml`). Delete the dead synchronous one. | Earlier picklist |
| **D3** | Notifications | **Wire all seven** categories named in REQUIREMENTS. | Earlier picklist |
| **D4** | Test scope | **Smoke + critical units** — yaml, report, scan + e2e-smoke. | Earlier picklist |
| **D5** | Repo visibility | **Make `pxl-classroom` public.** Branch protection on `.github/workflows/` (PR + ≥2 reviews + signed commits), secret scanning enabled, push protection on. | This rewrite |
| **D6** | Config validation | **In the SPA** (client-side ajv against pxl-classroom-hosted schemas). Direct git-CLI edits are unvalidated — acceptable for advanced users. | This rewrite |
| **D7** | Dispatcher App | **Reuse Provisioner App** with a second installation on PXL-Digital-Application-Samples scoped to `pxl-classroom` only. | This rewrite |
| **D8** | Student CI cost | **Operational** — per-org spending limit + budget alerts at 50% / 80% / 100%. Documented in RUNBOOK. | This rewrite |
| **D9** | process-queue cron | **5 min → 30 min** (mitigation C). Less critical now that minutes are free, but reduces noise. | Earlier picklist (C) |
| **D10** | collect-activity cron | **Smart scheduling** (mitigation D) — only assignments in their open window; 15-min only ±2h around their own deadlines; 6h otherwise. | Earlier picklist (D) |
| **D11** | Public Pages data | **Served from `pxl-classroom` Pages** at `/data/<org>/...`. The earlier proposed per-org `pxl-classroom-public-<org>` mirror repos are dropped. | This rewrite |
| **D12** | Pages deployment writer model | **Both `deploy-frontend.yml` and `regenerate-dashboard.yml` deploy through Actions-source `actions/deploy-pages`**, sharing the `pages` concurrency group. GitHub Pages can serve only one source — Actions-source is the chosen one, both workflows write to it. | Re-check pass |
| **D13** | `participating-orgs.yml` location | **Long-lived `participating-orgs` branch** with lighter protection (1 approval, no signed-commits requirement). Setup-Org commits directly. Cron workflows fetch via `actions/checkout` with `ref: participating-orgs`. Avoids the branch-protection collision with `main`. | Re-check pass |
| **D14** | Student URL structure | **Routes change from `/a/:assignmentId` to `/:org/a/:assignmentId`**. Multi-org Pages requires the org in the URL — global slugs are not safe across orgs. Affects router, broker-published links, Admin "Copy accept link", and the public assignment listing on `/`. | Re-check pass |

---

## End-state architecture (after Wave 2)

```
PXL-Digital-Application-Samples/pxl-classroom        PUBLIC, free Actions
├── .github/workflows/
│   ├── acceptance-handler.yml      repository_dispatch [acceptance]
│   ├── process-queue.yml           cron 30min + workflow_dispatch
│   ├── collect-activity.yml        cron smart (6h normal / 15m near deadline / skip closed)
│   ├── finalize-deadline.yml       per-deadline cron + workflow_dispatch     ← gains a cron
│   ├── reconcile-registry.yml      cron daily + workflow_dispatch            ← gains a cron
│   ├── publish-assignment.yml      workflow_dispatch
│   ├── regenerate-dashboard.yml    repository_dispatch [regenerate] + workflow_dispatch
│   ├── retry-failed.yml            workflow_dispatch
│   ├── export-report.yml           workflow_dispatch
│   ├── setup-org.yml               workflow_dispatch
│   ├── verify-org-perms.yml        workflow_dispatch
│   ├── deploy-frontend.yml         push frontend/**
│   ├── ci.yml                      pull_request, push
│   └── e2e-smoke.yml               schedule weekly + PR label
├── lib/  yaml.mjs  gh.mjs  store.mjs   (shared helpers)
├── frontend/  src/                       (Vue SPA + client-side ajv)
├── provisioning/  acceptance/  collect/
├── lockdown/  preserve/  report/
├── pages/  registry/  notify/
├── schemas/                              (served as Pages assets to the SPA)
├── tests/                                (node --test)
├── participating-orgs.yml                (source of truth for collect/reconcile crons)
└── docs/spikes/                          (kept; world-readable)

PXLAutomation/pxl-classroom-control                    PRIVATE per org, DATA ONLY
├── assignments/  students/  acceptances/
├── repositories/  observations/  lockdowns/
├── overrides/  errors/  reports/
└── README.md                              (no .github/workflows/ at all)

PXLAutomation/broker-<assignment-id>                   PUBLIC per assignment
└── .github/workflows/acceptance-trigger.yml           dispatches to pxl-classroom

PXLAutomation/pxl-classroom-archive                    PRIVATE per org
└── refs/heads/preserved/<assignment-id>/<login>       preserved submission SHAs

App: "PXL Classroom Provisioner"                       single App
  Permissions: Admin:RW, Contents:RW, Metadata:R, Account/Starring:RW (Device Flow)
  Installations:
    - PXLAutomation, etc.: All repositories
    - PXL-Digital-Application-Samples: Selected → pxl-classroom only
                                       (used by brokers for dispatch)
```

### Trust boundary recap

- The **public broker** mints a token for the **PXL-DAS installation** of the single App. The token's permissions are the App's permissions (Admin:RW etc.), but the install scope limits it to `pxl-classroom` only. **Therefore a compromised broker workflow has Admin:RW on `pxl-classroom` and nothing else.** Branch protection + signed-commits requirement + push-protection on `pxl-classroom`'s `.github/workflows/` is what makes that bounded — without those, a malicious workflow could rewrite the central code and pivot. **Wave 1 lands those protections before the public flip.**
- The **per-org provisioning workflows** mint a token for the lecturer's org install — full provisioning scope on that org alone. The App key lives only in `pxl-classroom` secrets; it is never injected into a per-org repo.
- **Students and lecturers** continue to authenticate to the SPA via device flow against the same App's OAuth surface, getting a user-to-server token with Account/Starring only.

---

## How central workflows operate against per-org data

This is the implementation insight that keeps the rewrite small. The action scripts (provisioning, accept, collect, lockdown, preserve, report, reconcile, notify, generate, scan) stay almost unchanged. The pattern in every central workflow is:

```yaml
jobs:
  do-the-thing:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<sha>     # pxl-classroom — for the action code
      - uses: actions/create-github-app-token@<sha>
        id: token
        with:
          app-id: ${{ secrets.PXL_APP_ID }}
          private-key: ${{ secrets.PXL_APP_PRIVATE_KEY }}
          owner: ${{ inputs.org }}        # mint for the target org
      - uses: actions/checkout@<sha>
        with:
          repository: ${{ inputs.org }}/pxl-classroom-control
          token: ${{ steps.token.outputs.token }}
          path: control
      - uses: ./acceptance                # local composite, reuses existing script
        with:
          # …existing inputs…
          data-dir: control               # filesystem mode, points to the checkout
      - name: Commit + push to control repo
        working-directory: control
        run: |
          git config user.name "pxl-classroom[bot]"
          git config user.email "pxl-classroom[bot]@users.noreply.github.com"
          git add . && git diff --cached --quiet || git commit -m "…"
          git push
```

The acceptance composite action that exists today already accepts `data-dir`. The collect / lockdown / report scripts already accept `DATA_DIR` env. Same pattern works for all of them. **No script rewrite — only YAML moves + a new "checkout the target control repo" step.**

The Contents-API alternative was considered and rejected: it would require rewriting every action script to do REST writes instead of filesystem writes, for no functional gain. Git push is one write against the secondary rate limit per workflow run, same as a Contents API PUT.

---

## Sequencing — seven waves

```
Wave 1 — Foundation (2 days, behavior-neutral)
   ├─ F1  YAML library
   ├─ F2  Shared gh() helper
   ├─ F3  Test scaffolding (tests/ + ci.yml)
   ├─ F4  Pages SPA 404 shim                                [P0-3]
   ├─ F5  Branch protection on .github/workflows/, secret scanning,
   │       push protection on pxl-classroom — BEFORE public flip
   ├─ F6  Add second App installation on PXL-DAS, scoped to pxl-classroom
   └─ F7  App owner drops secrets:write from App config       NEW

Wave 2 — The architecture move (1.5 days)
   ├─ A1  Update broker workflow template to dispatch to pxl-classroom
   │       with org+assignment in payload
   ├─ A2  Move + rewrite acceptance-handler.yml into pxl-classroom
   ├─ A3  Move + rewrite process-queue.yml
   ├─ A4  Move + rewrite collect-activity.yml + smart cron (D10)
   ├─ A5  Move + rewrite finalize-deadline.yml + per-deadline cron
   ├─ A6  Move + rewrite reconcile-registry.yml + daily cron
   ├─ A7  Move + rewrite publish-assignment.yml, retry-failed.yml,
   │       export-report.yml, regenerate-dashboard.yml
   ├─ A8  Rewrite Setup-Org for the new model
   │       (no secrets injection; pushes to participating-orgs branch)
   ├─ A9  Drop control-repo-template/workflows/  AND
   │       control-repo-template/.github/workflows/ entirely
   ├─ A10 Flip pxl-classroom to public
   └─ A11 Re-publish existing brokers to update dispatch target   NEW

Wave 3 — P0 functional + cron tuning (1 day)
   ├─ P0-4  Wire preserve into finalize-deadline (naturally)
   ├─ P0-5  Fix publish workflow filename + target
   ├─ P0-7  Apply lecturer overrides in report.mjs
   ├─ P0-8  Read template from assignment in process-queue
   ├─ P0-10 Read repository_name_pattern in SPA
   └─ D9    process-queue cron 5min → 30min

Wave 4 — Security + pinning (0.5 days)
   ├─ P0-1  Remove corsproxy.io
   ├─ P1-7  SHA-pin every third-party action
   └─ (P0-2 dissolved — no secrets:write needed in App manifest)

Wave 5 — SPA modernization (1.5 days)
   ├─ V0  Router URL change /a/:id → /:org/a/:id              NEW
   │       (broker URL + Admin copy-link + HomeView)
   ├─ V1  Client-side ajv (frontend/src/lib/validate.js)
   ├─ V2  Fetch schemas from pxl-classroom Pages
   ├─ V3  Validate before commit in Admin UI
   ├─ V4  Org picker via App-installation enumeration
   ├─ V5  Fetch public data from /data/<org>/assignments.json
   ├─ P1-8  Drop fake-assignment fallback
   ├─ P1-9  Public assignment listing on /
   ├─ P1-10 WCAG-AA contrast
   ├─ P1-11 Delete orphaned components
   ├─ P1-12 Centralize date formatting
   └─ P1-13 Toast replacing alert()

Wave 6 — Reliability & notifications (1.5 days)
   ├─ P1-4  Wire notify to all 7 categories
   ├─ P1-5  Per-{assignment, login} concurrency
   ├─ P1-6  Dashboard.json size handling
   └─ P2-2  Document the broker-dispatch boundary

Wave 7 — Tests, ops, docs (1.5 days)
   ├─ P2-1  Smoke + critical unit tests
   ├─ OPS1  Spending limit + alert setup per org (RUNBOOK)
   ├─ OPS2  Budget owner per org documented
   ├─ P2-3  Shallow clone in preserve
   ├─ P2-4  Cap polling in SPA
   ├─ P2-5  Device-code phishing warning
   ├─ P2-6  Delete AGENTS.md + GEMINI.md
   ├─ P2-7  Move node -e snippets to scripts/
   ├─ P2-8  Admin UI YAML preview
   ├─ P2-11 Minor items (§4.6 REVIEW.md)
   └─ P2-10 Doc updates (PROGRESS, REQUIREMENTS, IMPLEMENTATION_PLAN, README, RUNBOOK, CLAUDE.md)
```

Effort code: **XS** ≤ 30 min · **S** ≤ 2 h · **M** ≤ 4 h · **L** ≥ 1 day

---

## Wave 1 — Foundation

### F1 — Replace minimal YAML parsers with the `yaml` package

Same as before-the-rewrite plan. Five copies of broken parser-lite across `acceptance/accept.mjs:60–114`, `collect/collect.mjs:81–96`, `pages/generate.mjs:29–57`, `report/report.mjs:31–60`, `lockdown/lockdown.mjs:85–99`.

**Plan:**

1. `lib/yaml.mjs`:
   ```js
   import { parse } from "yaml";
   import { readFile } from "node:fs/promises";
   export async function loadYaml(path) { return parse(await readFile(path, "utf8")); }
   ```
2. Top-level `package.json`:
   ```json
   { "name": "pxl-classroom-actions", "private": true, "type": "module",
     "dependencies": { "yaml": "^2.4.0", "ajv": "^8.16.0", "ajv-formats": "^3.0.0" } }
   ```
3. Each composite `action.yml` runs `npm ci --omit=dev --prefix "$GITHUB_ACTION_PATH/.."` before the script.
4. Action scripts replace inline parsers with `import { loadYaml } from "../lib/yaml.mjs"`.
5. The SPA gets `yaml` and `ajv` in `frontend/package.json` too — needed for V1/V2.

**Verification:** `tests/yaml.test.mjs` (Wave 7) parses every fixture, including the array-shaped `students/roster.yml`.

**Depends on:** none. **Blocks:** P0-7, P0-8, V1.

**Effort:** L (4 h).

### F2 — Shared `gh()` helper

Six action scripts each carry a slightly different `gh()`. `notify.mjs` has none — silent failure on transient API errors is the actual bug.

**Plan:** `lib/gh.mjs` with one canonical `gh(method, path, body, opts)` honoring `x-ratelimit-remaining` and `retry-after`. All scripts import from there.

**Effort:** M (3 h). **Depends on:** none.

### F3 — Test scaffolding

Same plan as the earlier draft:

```
tests/
  fixtures/
    valid-assignment.yml
    invalid-assignment-missing-template.yml
    roster-array.yml
    public-clean.json
    public-leaky.json
  yaml.test.mjs
  report.test.mjs
  scan.test.mjs
.github/workflows/ci.yml
```

`ci.yml` runs `npm ci --omit=dev && node --test tests/` on PR + push. e2e-smoke comes in Wave 7.

**Effort:** M (3 h).

### F4 — Pages SPA 404 shim (was P0-3)

Promoted from P0 list into Wave 1 — without it, every deep-link cold-load 404s and the rest of the SPA work is moot. Standard rafgraph/spa-github-pages shim:

1. `frontend/public/404.html` — copies path into a query param and redirects.
2. `frontend/index.html` — `<script>` block before the SPA mount that decodes the query param back into a route.

**Effort:** S (30 min). **Verification:** cold-load `/pxl-classroom/a/sample-assignment` lands on AssignmentView with the right prop.

### F5 — Lock down `pxl-classroom` BEFORE flipping public

This is non-negotiable. Once the repo is public, anyone with merge rights can rewrite a workflow file and the next broker dispatch executes their code with Admin:RW on `pxl-classroom`. The protections must precede the visibility flip.

**Plan:**

1. **Branch protection on `main`:**
   - Require pull requests
   - Require at least 2 approvals
   - Require status checks to pass (`ci.yml`)
   - Require signed commits
   - Restrict who can push (only the admin team)
   - Block force-pushes
   - Block deletions
2. **Path-scoped extra protection on `.github/workflows/**`:** require an additional `actions-codeowners` review. Configure CODEOWNERS:
   ```
   /.github/workflows/   @PXL-DigitalAppSamples-admins
   /provisioning/        @PXL-DigitalAppSamples-admins
   /acceptance/          @PXL-DigitalAppSamples-admins
   /lockdown/            @PXL-DigitalAppSamples-admins
   /preserve/            @PXL-DigitalAppSamples-admins
   /lib/                 @PXL-DigitalAppSamples-admins
   ```
3. **Secret scanning + push protection** enabled in Settings → Code security.
4. **Workflow permissions**: set repo default to `read` for `GITHUB_TOKEN`; each workflow explicitly opts into write where needed.
5. **Disable Actions write permissions for forks** (otherwise a PR from a fork could exfiltrate the App key in a workflow modification — though signing + reviews already block this, defense in depth).
6. **Light protection on the `participating-orgs` branch** (per D13): require 1 approval, no signed-commits requirement, no CODEOWNERS, no status-check requirement. This is where `participating-orgs.yml` lives. Setup-Org commits directly to this branch; cron workflows fetch it at `ref: participating-orgs`. The branch never gets merged into `main` — it's a deliberately decoupled metadata store.

**Verification manifest:** create a checklist in `.github/SETUP_CHECKLIST.md` that an admin runs through before A10 (the flip).

**Effort:** S (1 h, all in the GitHub Settings UI + writing the checklist).

### F6 — Add second App installation on PXL-DAS

The single App "PXL Classroom Provisioner" already exists (installed on PXLAutomation). Install it again on `PXL-Digital-Application-Samples`, with "Selected repositories: pxl-classroom" scope. The App's permissions are unchanged (Admin:RW etc., applied to whatever repos each install scopes to).

**Action:** manual in the GitHub UI. Document the steps in `RUNBOOK.md`.

**Verification:** `gh api /app/installations` (with App-level JWT) returns two installations; the PXL-DAS one shows `repository_selection: selected` and `repositories: [pxl-classroom]`.

**Effort:** XS (15 min).

### F7 — Drop `secrets:write` from the existing App's permissions

A subtlety the earlier draft missed: SetupView's manifest edit (V-time) only affects *future* App creations. The **existing** Provisioner App's permission set is configured in the App's settings UI, not in the manifest. Until the App owner edits the existing App, every installation still carries `secrets:write`.

**Plan:**

1. App owner: GitHub → Settings → Developer settings → GitHub Apps → PXL Classroom Provisioner → Permissions & events.
2. Repository permissions → Secrets: change from "Read & write" to "**No access**".
3. Save changes. Permission decreases do NOT require existing installations to re-approve (GitHub auto-downgrades), but the install's permissions snapshot is visible at `/orgs/<org>/settings/installations` for the lecturer to confirm.
4. Document in `RUNBOOK.md` under "Initial App setup": new App registrations must NOT include `secrets:write`.

**Verification:** `gh api /app` returns `permissions` without `secrets` (or with `secrets: null`). `gh api /orgs/PXLAutomation/installation` shows the same for the install.

**Effort:** XS (5 min in the App settings UI).

---

## Wave 2 — The architecture move

This wave is the heart of the rewrite. Order matters: do the central workflows + setup script first, verify they work, then flip public.

### A1 — Update broker workflow template

Today's broker dispatches to `<vars.CONTROL_ORG>/<vars.CONTROL_REPO>` (per-org). The new model dispatches to `PXL-Digital-Application-Samples/pxl-classroom` always.

`acceptance/broker-workflow.yml`:
```yaml
name: Acceptance trigger
on:
  watch:
    types: [started]
permissions: { contents: read }
concurrency:
  group: accept-${{ github.actor }}
  cancel-in-progress: false
jobs:
  dispatch:
    runs-on: ubuntu-latest
    if: github.event.action == 'started'
    steps:
      - name: Validate actor
        id: validate
        shell: bash
        run: |
          [[ -n "${{ github.actor }}" && -n "${{ github.event.sender.id }}" ]] \
            || { echo "::error::Missing actor"; exit 1; }
          echo "actor=${{ github.actor }}"       >> "$GITHUB_OUTPUT"
          echo "actor_id=${{ github.event.sender.id }}" >> "$GITHUB_OUTPUT"
      - name: Mint dispatcher token
        id: token
        uses: actions/create-github-app-token@<sha>
        with:
          app-id: ${{ secrets.PXL_APP_ID }}
          private-key: ${{ secrets.PXL_APP_PRIVATE_KEY }}
          owner: PXL-Digital-Application-Samples       # the PXL-DAS install
          repositories: pxl-classroom                  # explicit scope guard
      - name: Dispatch to central pxl-classroom
        shell: bash
        env:
          GH_TOKEN: ${{ steps.token.outputs.token }}
        run: |
          gh api --method POST \
            "/repos/PXL-Digital-Application-Samples/pxl-classroom/dispatches" \
            -f "event_type=acceptance" \
            -f "client_payload[org]=${{ vars.CONTROL_ORG }}" \
            -f "client_payload[assignment_id]=${{ vars.ASSIGNMENT_ID }}" \
            -f "client_payload[github_login]=${{ steps.validate.outputs.actor }}" \
            -f "client_payload[github_id]=${{ steps.validate.outputs.actor_id }}" \
            -f "client_payload[workflow_run_url]=${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}"
```

Required broker repo variables now: `ASSIGNMENT_ID`, `CONTROL_ORG`. (No `CONTROL_REPO` — it's always `pxl-classroom-control`.) Required secrets: `PXL_APP_ID`, `PXL_APP_PRIVATE_KEY`.

The `publish-assignment.yml` workflow (A7) is what writes these to a freshly created broker.

**Effort:** S (1 h).

### A2 — `acceptance-handler.yml` in `pxl-classroom`

```yaml
name: Accept assignment
on:
  repository_dispatch:
    types: [acceptance]
permissions: { contents: read }
concurrency:
  group: accept-${{ github.event.client_payload.org }}-${{ github.event.client_payload.assignment_id }}-${{ github.event.client_payload.github_login }}
  cancel-in-progress: false
jobs:
  accept:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<sha>
      - run: npm ci --omit=dev
      - uses: actions/create-github-app-token@<sha>
        id: token
        with:
          app-id: ${{ secrets.PXL_APP_ID }}
          private-key: ${{ secrets.PXL_APP_PRIVATE_KEY }}
          owner: ${{ github.event.client_payload.org }}
      - uses: actions/checkout@<sha>
        with:
          repository: ${{ github.event.client_payload.org }}/pxl-classroom-control
          token: ${{ steps.token.outputs.token }}
          path: control
      - uses: ./acceptance
        id: accept
        with:
          app-id: ${{ secrets.PXL_APP_ID }}
          app-private-key: ${{ secrets.PXL_APP_PRIVATE_KEY }}
          org: ${{ github.event.client_payload.org }}
          control-repo: pxl-classroom-control
          data-dir: control
      - if: steps.accept.outputs.outcome == 'accepted'
        working-directory: control
        run: |
          git config user.name "pxl-classroom[bot]"
          git config user.email "pxl-classroom[bot]@users.noreply.github.com"
          git add acceptances/
          git commit -m "Accept ${{ github.event.client_payload.github_login }} for ${{ github.event.client_payload.assignment_id }}" || true
          git push
      - if: steps.accept.outputs.outcome == 'accepted'
        uses: actions/github-script@<sha>
        with:
          script: |
            await github.rest.actions.createWorkflowDispatch({
              owner: context.repo.owner, repo: context.repo.repo,
              workflow_id: 'process-queue.yml', ref: 'main',
              inputs: { org: '${{ github.event.client_payload.org }}' },
            });
```

The `accept.mjs` script is unchanged. The wrapping workflow does the org-scoped checkout/push.

**Effort:** S (1.5 h, including push-retry loop refactor that the old workflow had).

### A3 — `process-queue.yml` in `pxl-classroom`

```yaml
name: Process Provisioning Queue
on:
  schedule:
    - cron: '*/30 * * * *'    # D9 — 5min → 30min
  workflow_dispatch:
    inputs:
      org:
        description: Target org (omit = all participating)
        required: false
        type: string
concurrency:
  group: process-queue-${{ inputs.org || 'all' }}
  cancel-in-progress: false
jobs:
  find-orgs:
    runs-on: ubuntu-latest
    outputs:
      orgs: ${{ steps.list.outputs.orgs }}
    steps:
      - uses: actions/checkout@<sha>
      - id: list
        run: |
          if [ -n "${{ inputs.org }}" ]; then
            echo "orgs=[\"${{ inputs.org }}\"]" >> "$GITHUB_OUTPUT"
          else
            # participating-orgs.yml is the source of truth (see A8)
            ORGS=$(node -e "const {parse} = require('yaml'); const fs=require('fs');
                            const o = parse(fs.readFileSync('participating-orgs.yml','utf8'));
                            process.stdout.write(JSON.stringify(o.orgs||[]));")
            echo "orgs=$ORGS" >> "$GITHUB_OUTPUT"
          fi
  setup:
    needs: find-orgs
    if: needs.find-orgs.outputs.orgs != '[]'
    runs-on: ubuntu-latest
    strategy:
      matrix:
        org: ${{ fromJSON(needs.find-orgs.outputs.orgs) }}
      max-parallel: 4    # avoid hammering rate limits across orgs
      fail-fast: false
    outputs:
      pending: ${{ steps.find.outputs.pending }}
    steps:
      - uses: actions/checkout@<sha>
      - uses: actions/create-github-app-token@<sha>
        id: token
        with:
          app-id: ${{ secrets.PXL_APP_ID }}
          private-key: ${{ secrets.PXL_APP_PRIVATE_KEY }}
          owner: ${{ matrix.org }}
      - uses: actions/checkout@<sha>
        with:
          repository: ${{ matrix.org }}/pxl-classroom-control
          token: ${{ steps.token.outputs.token }}
          path: control
      - id: find
        run: node scripts/find-pending.mjs control
        # Outputs JSON: [{assignment_id, github_login}, …] capped at 40
  provision:
    needs: setup
    if: needs.setup.outputs.pending != '[]'
    # …matrix over pending students, max-parallel: 2 (per-org)…
    # Inside each leg:
    #   1. Checkout pxl-classroom + per-org control repo as above
    #   2. Read assignment to discover template + repository_name_pattern  (P0-8)
    #   3. uses: ./provisioning (unchanged action)
    #   4. Write repository record into control checkout, push
```

The matrix-of-matrices spawns one queue legging per org per pending student, throttled at `max-parallel: 2` per org (existing) and `max-parallel: 4` across orgs (new). Adds per-`{assignment, login}` concurrency (P1-5).

**Effort:** M (3 h) — most of the rewrite weight is here.

### A4 — `collect-activity.yml` with smart cron (D10)

```yaml
name: Collect activity
on:
  schedule:
    - cron: '0 */6 * * *'       # baseline 6h
    - cron: '*/15 * * * *'      # near-deadline tick — script skips if no assignment within ±2h
  workflow_dispatch:
    inputs:
      org: { type: string }
      assignment_id: { type: string }
      collection_type: { type: string, default: scheduled }
jobs:
  find-orgs:
    # …reads participating-orgs branch via ref: participating-orgs…
  collect:
    needs: find-orgs
    strategy:
      matrix:
        org: ${{ fromJSON(needs.find-orgs.outputs.orgs) }}
      max-parallel: 4
      fail-fast: false
    # CRITICAL: per-org concurrency — a tick that stretches under
    # rate-limit backoff must finish before the next tick starts.
    concurrency:
      group: collect-${{ matrix.org }}
      cancel-in-progress: false
    runs-on: ubuntu-latest
    steps:
      # checkout pattern as in A2
```

The `collect.mjs` script gains a smart-schedule helper that:
- Reads `participating-orgs.yml` (or honors the `org` input).
- For each org, reads all assignment YAMLs.
- For the 15-min cron: only acts on assignments whose `now` is within ±2h of `deadline_at` AND state == `published`.
- For the 6h cron: only acts on assignments in their open window (`opens_at < now < deadline_at + grace`) AND state in `{published, closed}`. Skips `draft` / `archived`.
- Iterates per-org with the checkout pattern; writes per-student observations; pushes the data commit per org.

Conservatively cuts steady-state cost ≥80% from the original "every 6h × every assignment × every student" estimate, AND keeps the 15-min tightness around deadlines.

**Effort:** M (3 h).

### A5 — `finalize-deadline.yml` with per-deadline cron (NEW gap)

REVIEW.md missed this — `finalize-deadline.yml` has no cron today; lock-down + preservation literally don't happen unless the lecturer clicks Run. Promoted to P0-equivalent.

**Plan:** a hybrid cron — every 5 minutes (free, central), the workflow checks each org/assignment and runs the finalize sequence **only for assignments whose `deadline_at` is within the last hour AND haven't been finalized yet** (idempotency check via the presence of `lockdowns/<id>/lockdown-record.json`).

```yaml
on:
  schedule:
    - cron: '*/5 * * * *'
  workflow_dispatch:
    inputs:
      org: { required: true, type: string }
      assignment_id: { required: true, type: string }
      dry_run: { type: boolean, default: false }
```

Cron leg evaluates eligibility; manual leg runs unconditionally. The candidate-SHA selection (P0-4 from REVIEW.md) is naturally part of the finalize sequence now: `collect → lockdown → preserve → report`.

`preserve` step gets wired in for the first time. Source SHA per student comes from `lockdowns/<id>/lockdown-record.json`'s `results[].snapshot_sha`. Archive repo = `<org>/pxl-classroom-archive` (auto-created by preserve.mjs).

**Effort:** M (3 h).

### A6 — `reconcile-registry.yml` with daily cron (NEW gap)

Today it's manual-only. Drift detection (deleted repos, repos made public, revoked access) is the only safety net against student misadventure, and it requires a human to remember to run it.

```yaml
on:
  schedule:
    - cron: '0 4 * * *'   # daily, 04:00 UTC
  workflow_dispatch:
    inputs:
      org: { type: string }
      assignment_id: { type: string }
```

Daily reconcile across all participating orgs.

**Effort:** S (1.5 h).

### A7 — Move remaining workflows

Mechanical YAML moves with the checkout pattern from A2:

- `publish-assignment.yml` — workflow_dispatch only. Creates broker repo, sets its variables, pushes broker workflow. Also flips assignment state YAML from `draft` to `published` in the control repo.
- `retry-failed.yml` — workflow_dispatch only. Scans pending acceptances, runs provisioning for failed ones.
- `export-report.yml` — workflow_dispatch only. Runs report action, commits CSV+JSON.
- `regenerate-dashboard.yml` — on `repository_dispatch [regenerate]` + workflow_dispatch. Iterates orgs, generates per-org `public/data/<org>/assignments.json`, runs privacy scanner, deploys.

**Special handling for `regenerate-dashboard.yml` — Pages is single-source** (D12). GitHub Pages can serve from only one source per repo, and `deploy-frontend.yml` already uses `actions/deploy-pages` (Actions-source). So `regenerate-dashboard.yml` cannot commit to a `gh-pages` branch *and* have the SPA still serve from Actions-source. Both workflows must use the same path.

**Plan:**

1. `regenerate-dashboard.yml` builds its own deploy artifact:
   ```yaml
   jobs:
     build:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@<sha>           # pxl-classroom
         - uses: actions/setup-node@<sha>
           with: { node-version: "20" }
         - run: npm ci --omit=dev
         # Rebuild the SPA so the artifact contains the latest UI alongside
         # the new data. ~30s cost per regenerate; acceptable on a public repo.
         - run: |
             cd frontend && npm ci && npm run build
             cd ..
         # Pull per-org data from each control repo and generate JSON
         - run: node pages/regenerate-all.mjs
           # iterates participating-orgs, checks out each control repo with
           # an App-installation token, runs generate.mjs, drops outputs into
           # frontend/dist/data/<org>/
         # Privacy gate on the WHOLE published tree (defense in depth — catches
         # any stale leak from a previous deploy that scanner regressions might
         # have allowed past)
         - run: node pages/scan.mjs frontend/dist
         - uses: actions/configure-pages@<sha>
         - uses: actions/upload-pages-artifact@<sha>
           with: { path: ./frontend/dist }
     deploy:
       needs: build
       runs-on: ubuntu-latest
       environment: { name: github-pages, url: ${{ steps.deployment.outputs.page_url }} }
       steps:
         - id: deployment
           uses: actions/deploy-pages@<sha>
   ```
2. **Both `deploy-frontend.yml` and `regenerate-dashboard.yml` join the `pages` concurrency group** so GitHub Pages serializes them — Pages itself enforces "at most one deployment in flight per environment":
   ```yaml
   concurrency:
     group: pages
     cancel-in-progress: false
   ```
3. Cost per regenerate: ~3 min (SPA rebuild + multi-org data fetch + scan + deploy). Free on a public repo.

The privacy scanner runs against the whole `frontend/dist` tree — both the SPA assets (which shouldn't contain student data) and the freshly generated `data/<org>/...`. Defense in depth against a regression that lets new leaks past the per-file gate or against a stale leak that survived a previous deploy.

**Effort:** M (4 h total for all four — `regenerate-dashboard` is the heaviest of them now).

### A8 — Rewrite Setup-Org

The new Setup-Org is much simpler — no secrets to inject:

```yaml
name: Setup Organization
on:
  workflow_dispatch:
    inputs:
      target_org: { required: true }
jobs:
  setup:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<sha>
      - uses: actions/create-github-app-token@<sha>
        id: token
        with:
          app-id: ${{ secrets.PXL_APP_ID }}
          private-key: ${{ secrets.PXL_APP_PRIVATE_KEY }}
          owner: ${{ inputs.target_org }}
      - name: Create or confirm control repo
        uses: actions/github-script@<sha>
        with:
          github-token: ${{ steps.token.outputs.token }}
          script: |
            const org = '${{ inputs.target_org }}';
            try { await github.rest.repos.get({owner:org, repo:'pxl-classroom-control'}); }
            catch (e) {
              if (e.status !== 404) throw e;
              await github.rest.repos.createInOrg({
                org, name: 'pxl-classroom-control', private: true,
                description: 'PXL Classroom data repo (managed by pxl-classroom). No workflows live here.'
              });
              await new Promise(r => setTimeout(r, 3000));
            }
      - name: Push data scaffold (no workflows)
        run: |
          cd control-repo-template
          git init
          git config user.name "pxl-classroom[bot]"
          git config user.email "pxl-classroom[bot]@users.noreply.github.com"
          # Critical: strip any .github/workflows/ and workflows/ dirs
          rm -rf .github/workflows workflows
          git add . && git commit -m "Initial data scaffold"
          git branch -M main
          git remote add origin https://x-access-token:${{ steps.token.outputs.token }}@github.com/${{ inputs.target_org }}/pxl-classroom-control.git
          git push -u origin main
      - name: Register org on the participating-orgs branch
        # Per D13: participating-orgs.yml lives on a dedicated branch with
        # lighter protection. Setup-Org commits directly here. The default
        # GITHUB_TOKEN has the needed write access; the branch's protection
        # rule allows it through (1 approval, no signed-commits requirement,
        # and the workflow itself is the configured approver).
        run: |
          git config user.name "pxl-classroom[bot]"
          git config user.email "pxl-classroom[bot]@users.noreply.github.com"
          git fetch origin participating-orgs:participating-orgs || \
            git checkout --orphan participating-orgs
          git checkout participating-orgs
          # Make sure the file exists
          [ -f participating-orgs.yml ] || echo "schema_version: 1\norgs: []" > participating-orgs.yml
          # Add the new org if not already present
          node -e "
            const fs = require('fs');
            const { parse, stringify } = require('yaml');
            const f = 'participating-orgs.yml';
            const cur = parse(fs.readFileSync(f, 'utf8'));
            const exists = cur.orgs.find(o => o.login === '${{ inputs.target_org }}');
            if (!exists) {
              cur.orgs.push({
                login: '${{ inputs.target_org }}',
                added_at: new Date().toISOString().slice(0,10),
                budget_owner: '${{ inputs.budget_owner }}',         // new required input
                spending_limit_eur: ${{ inputs.spending_limit_eur || 'null' }}
              });
              fs.writeFileSync(f, stringify(cur));
            }
          "
          git add participating-orgs.yml
          git diff --cached --quiet || git commit -m "Add ${{ inputs.target_org }}"
          git push origin participating-orgs
      - name: Create archive repo
        run: |
          gh repo view "${{ inputs.target_org }}/pxl-classroom-archive" --json name 2>/dev/null \
            || gh repo create "${{ inputs.target_org }}/pxl-classroom-archive" \
                --private --description "PXL Classroom preservation archive"
        env:
          GH_TOKEN: ${{ steps.token.outputs.token }}
      - name: Print next steps
        run: |
          cat <<EOF >> "$GITHUB_STEP_SUMMARY"
          ## ${{ inputs.target_org }} setup complete

          - Control repo: ${{ inputs.target_org }}/pxl-classroom-control (private)
          - Archive repo: ${{ inputs.target_org }}/pxl-classroom-archive (private)
          - Org added to participating-orgs.yml

          ### Manual follow-ups (lecturer)
          1. Go to ${{ inputs.target_org }} → Settings → Billing → Actions
             and set a spending limit. Recommended: €100/month for a class of ~250.
          2. Configure usage alerts at 50% / 80% / 100%.
          3. Confirm the PXL Classroom Provisioner App is installed with "All repositories" scope.
          EOF
```

Setup-Org now also takes two new required inputs: `budget_owner` (email) and `spending_limit_eur` (integer). These populate `participating-orgs.yml` and become preconditions for declaring the org pilot-ready. Without a named budget owner the workflow refuses (per OPS2).

**Effort:** M (3 h).

### A9 — Delete control-repo-template workflows

Both `control-repo-template/workflows/` and `control-repo-template/.github/workflows/` go away entirely. The template now has only data dirs + README + schemas. Update README:

```md
# PXL Classroom — Control Repository

This is a DATA repository. There are no workflows here.

All workflows that read or write this repo run from
`PXL-Digital-Application-Samples/pxl-classroom` (public).

Do not add `.github/workflows/` to this repo. The schema validator
in the SPA will reject any commits that try to.
```

(Optional: add a tiny CODEOWNERS rule that blocks any `.github/workflows/**` path. Belt-and-braces against a future maintainer.)

**Effort:** XS (10 min).

### A10 — Flip `pxl-classroom` to public

**Pre-flight checklist** (the SETUP_CHECKLIST.md from F5):

- [ ] Branch protection on `main` (2 reviews + signed commits + status checks)
- [ ] CODEOWNERS in place
- [ ] Secret scanning + push protection enabled
- [ ] GITHUB_TOKEN default = read
- [ ] No secrets in commit history (run `gitleaks` or `truffleHog` against full history)
- [ ] All `.env`, private keys, `.pem` files in `.gitignore` and not in history
- [ ] Test the full pipeline against a sandbox org with the central workflows BEFORE the flip (workflows-in-private-repo dress rehearsal)
- [ ] PXL-DAS second installation in place (F6)

Then in Settings → General → Danger Zone: Change visibility → Public.

**Verification:** any random GitHub user can `git clone https://github.com/PXL-Digital-Application-Samples/pxl-classroom` and not find anything sensitive. `gh secret list` requires repo admin.

**Effort:** S (1 h including a full git-history secret scan).

### A11 — Re-publish existing brokers to update dispatch target

`acceptance/broker-workflow.yml` (A1) is the *template* used by `publish-assignment.yml` to seed each broker's `.github/workflows/acceptance-trigger.yml`. Existing brokers carry the OLD copy that dispatches to per-org control repos. After A2–A10 land, the per-org control repos no longer have an `acceptance-handler.yml` to receive those dispatches — so existing brokers silently break.

**Plan:**

1. List every existing broker repo: `gh api /orgs/<org>/repos --jq '.[] | select(.name | startswith("broker-")) | .name'` for each participating org.
2. For each broker, run the new `publish-assignment.yml` in re-publish mode (workflow_dispatch with `assignment_id` and an explicit `repuhblish: true` input that skips the "create repo" step and only updates the workflow file + variables).
3. Verify: each broker's `.github/workflows/acceptance-trigger.yml` now contains the new `gh api .../dispatches` target pointing at `PXL-Digital-Application-Samples/pxl-classroom`.

If there are no live cohorts yet (which is the case today per `PROGRESS.md`'s actual state — pilot hasn't run), this step is a no-op against an empty broker list. Keep it as a documented procedure so re-publishing is a one-command operation when the first cohort exists.

**Effort:** S (1 h to add the `republish: true` mode to `publish-assignment.yml` + run for any existing brokers).

---

## Wave 3 — P0 functional + cron tuning

Many of the REVIEW.md P0s land naturally as part of Wave 2 — but a few need explicit Wave 3 attention.

### P0-4 — Preserve in finalize-deadline

Already wired by A5. **Verification:** after a finalize-deadline run, the archive repo contains `refs/heads/preserved/<id>/<login>` for every student with a snapshot SHA.

### P0-5 — Publish workflow filename

In `frontend/src/views/AdminView.vue:131`:
```diff
- const res = await triggerWorkflow(token, props.org, config.controlRepo, 'publish.yml')
+ const res = await triggerWorkflow(token, 'PXL-Digital-Application-Samples', 'pxl-classroom', 'publish-assignment.yml',
+                                   { org: props.org, assignment_id: form.value.id })
```

Note: the SPA now triggers the central workflow, not the per-org control workflow. Pass the org as an input.

The `triggerWorkflow` helper in `lib/api.js` already supports inputs but currently always uses `ref: 'main'` and no inputs. Update its signature.

**Effort:** S (45 min).

### P0-7 — Apply lecturer overrides in `report.mjs`

In the per-student loop, before deadline-classification, substitute the per-student deadline if an override exists. Add `effective_deadline_at`, `override_applied`, `override_reason` to the per-student output. Add columns to the CSV header. **Effort:** M (2 h). Tested by `tests/report.test.mjs`.

### P0-8 — Read template from assignment

Now natural because the YAML parser actually works (F1). In the `process-queue` matrix leg, after checkout, parse `control/assignments/${assignment_id}.yml` and pass `template.owner`, `template.repository`, and `repository_name_pattern` to the provisioning action. **Effort:** S (1 h).

### P0-10 — Read `repository_name_pattern` in SPA

`pages/generate.mjs:88–101` adds `repository_name_pattern` to the public emission. `AssignmentView.vue:297, 406` derives the expected name from the pattern. **Effort:** S (45 min).

### D9 — process-queue cron 5min → 30min

Already in A3's YAML. Trivial.

---

## Wave 4 — Security + pinning

### P0-1 — Remove corsproxy.io

Same as in the earlier draft. Try direct calls first; if CORS bites, deploy a self-hosted Worker. **Effort:** S (1 h, +2 h for the Worker fallback if needed).

### P1-7 — SHA-pin every third-party action

Walk all `.github/workflows/*.yml` (now in `pxl-classroom` after Wave 2). Pin every `@v*` reference to a full commit SHA. Replace `tibdex/github-app-token@v2` with `actions/create-github-app-token`. **Effort:** S (1 h).

P0-2 (secrets:write rework) — **dissolved**. There is no `secrets:write` request anywhere in the new architecture.

---

## Wave 5 — SPA modernization

### V0 — Student URL gets the org in it

Per D14. Today: `/a/:assignmentId`. Multi-org Pages means two orgs can ship assignments with the same slug (`intro`, `pe-1`). Without org in the URL, `loadAssignment` has to guess which org owns the slug — fragile. Fix the URL.

**Plan:**

1. `frontend/src/router/index.js`: change `path: '/a/:assignmentId'` → `path: '/:org/a/:assignmentId'`. The component now also receives `org` as a prop.
2. `frontend/src/views/AssignmentView.vue`: read `org` from props instead of `assignment.organization || config.defaultOrg`. Drop the `defaultOrg` fallback entirely.
3. `frontend/src/views/AdminView.vue`: "Copy accept link" composes `${origin}${BASE_URL}${org}/a/${id}`.
4. `frontend/src/views/HomeView.vue` (P1-9, same wave): the open-assignments list links each entry to `/${org}/a/${id}` from the public index's per-entry `org` field.
5. `publish-assignment.yml`'s workflow summary (A7) prints the new URL pattern with the org included.
6. The broker's README (templated when the broker is created) shows the new acceptance URL with org.

**Backward compatibility:** old `/a/:assignmentId` URLs published before this change still 404 (the SPA shim from F4 will route them to the SPA, which then sees an unknown route). Acceptable — no live cohort yet; if any broker URL is in circulation, A11 re-publishes them.

**Verification:** the e2e-smoke test (Wave 7) uses the new URL pattern.

**Effort:** S (1.5 h, mostly mechanical).

### V1 — Client-side ajv (`frontend/src/lib/validate.js`)

```js
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const ajv = addFormats(new Ajv({ allErrors: true }));
const cache = new Map();

export async function validateAgainst(schemaName, doc) {
  if (!cache.has(schemaName)) {
    const url = `${import.meta.env.BASE_URL}schemas/${schemaName}.schema.json`;
    const schema = await (await fetch(url)).json();
    cache.set(schemaName, ajv.compile(schema));
  }
  const validate = cache.get(schemaName);
  return { valid: validate(doc), errors: validate.errors };
}
```

### V2 — Serve schemas from Pages

Copy `schemas/*.schema.json` into `frontend/public/schemas/` at build time. Vite picks them up automatically (`public/` is copied verbatim). New step in `deploy-frontend.yml`:
```yaml
- run: cp schemas/*.schema.json frontend/public/schemas/
```

### V3 — Validate before commit in Admin UI

`frontend/src/views/AdminView.vue.createAssignment()`:
```js
import { parse } from 'yaml';
import { validateAgainst } from '../lib/validate.js';

async function createAssignment() {
  // …build YAML string as today…
  const doc = parse(yaml);
  const { valid, errors } = await validateAgainst('assignment', doc);
  if (!valid) {
    toast.error('Validation failed: ' + errors.map(e => `${e.instancePath} ${e.message}`).join('; '));
    return;
  }
  // …existing commit path…
}
```

Same for `grantExtension` against `override.schema.json`.

**Effort for V1+V2+V3:** M (3 h).

### V4 — Org picker via App-installation enumeration

`getInstallations(token)` already exists in `frontend/src/lib/api.js`. The DashboardView uses it. Just verify the SPA filters to installations on orgs where the user is an owner (`/user/memberships/orgs/{org}` → `state == active && role == admin`). **Effort:** XS (already mostly working).

### V5 — Fetch public data from `/data/<org>/assignments.json`

The Pages site at `https://<org>.github.io/pxl-classroom/data/<org>/assignments.json` (replace first `<org>` with `pxl-digital-application-samples`). The SPA HomeView fetches the global index (`/data/index.json` — a list of orgs + their published assignments) and AssignmentView fetches per-org metadata.

Schema:
```json
// /data/index.json
{ "schema_version": 1, "generated_at": "…",
  "orgs": [
    { "login": "PXLAutomation",
      "assignments_url": "/data/PXLAutomation/assignments.json",
      "open_count": 3 } ] }
```

**Effort:** S (1.5 h, mostly in DashboardView + HomeView + AssignmentView).

### P1-8 — Drop fake-assignment fallback

With V5 in place, AssignmentView always has a real public assignments source. The fallback at `AssignmentView.vue:276–284` deletes cleanly. **Effort:** XS (5 min).

### P1-9 — Public assignment listing on `/`

`HomeView.vue` fetches `/data/index.json`, renders open assignments grouped by org. **Effort:** S (1 h).

### P1-10 — WCAG-AA contrast

Same as earlier draft. `frontend/src/style.css` — promote `--text-secondary` to brighter, `--text-muted` to `#8b949e`. **Effort:** S (45 min).

### P1-11 — Delete orphaned components

`frontend/src/components/StudentTable.vue`, `frontend/src/components/AssignmentCard.vue` — both unused. Delete. **Effort:** XS (5 min).

### P1-12 — Centralize date formatting

`frontend/src/lib/format.js`. Five views collapse to one helper. **Effort:** S (1 h).

### P1-13 — Toast replacing alert()

`frontend/src/components/Toast.vue` + `frontend/src/lib/toast.js` composable. Replace six `alert()` calls in AdminView and the ones in V3. **Effort:** M (2 h).

---

## Wave 6 — Reliability & notifications

### P1-4 — Wire notify to all 7 categories

Per D3. Each producer:

| Workflow | Trigger | event-type | dedup-key |
|---|---|---|---|
| `process-queue.yml` matrix leg | `outcome=fail:*` | `provisioning-failed` | `prov-${org}-${id}-${login}` |
| `collect-activity.yml` | `error_count > 0` per org | `collection-failed` | `coll-${org}-${id}-${YYYYMMDD}` |
| `collect-activity.yml` | gap detector (no obs > 24h, deadline within gap) | `deadline-gap` | `gap-${org}-${id}` |
| `finalize-deadline.yml` | preserve outcome ≠ preserved | `preservation-failed` | `pres-${org}-${id}-${login}` |
| `late-activity` job (added to finalize sequence) | obs after deadline with new SHA | `late-activity` | `late-${org}-${id}-${login}` |
| `reconcile-registry.yml` | drift = access revoked | `missing-access` | `acc-${org}-${id}-${login}` |
| `reconcile-registry.yml` | drift = repo deleted | `unexpected-deletion` | `del-${org}-${id}-${login}` |

The notify action's `org` and `control-repo` inputs are already there. The action runs from `pxl-classroom`, talks to the per-org control repo's tracking issue via API.

Fix `notify/notify.mjs:24–32` to add `deadline-gap` to EMOJI_MAP.

**Effort:** L (1 day).

### P1-5 — Per-{org, assignment, login} concurrency in process-queue

Add to the provision matrix leg:
```yaml
concurrency:
  group: prov-${{ matrix.org }}-${{ matrix.student.assignment_id }}-${{ matrix.student.github_login }}
  cancel-in-progress: false
```
**Effort:** XS.

### P1-6 — Dashboard.json size handling

`frontend/src/lib/api.js` gets `getRepoContentRaw` that fetches `download_url` directly. Replace 3 call sites. **Effort:** S (1 h).

### P2-2 — Document broker boundary

Top-of-file comment block in `acceptance/broker-workflow.yml` explaining the security model. Even though the workflow lives in `acceptance/` (under `pxl-classroom`), it's the template that gets pushed into broker repos by `publish-assignment.yml`, so any change here propagates to public brokers. **Effort:** XS (15 min).

---

## Wave 7 — Tests, ops, docs

### P2-1 — Smoke + critical unit tests

Per D4:

- `tests/yaml.test.mjs` — round-trips every fixture, including array-shaped roster.
- `tests/report.test.mjs` — deadline-classification truth table including overrides.
- `tests/scan.test.mjs` — clean fixture passes; leaky one with `gho_…`, an email, a `student_id` field, blocks.
- `tests/e2e-smoke.mjs` — Node script that stars a fixed broker, polls for provisioning, asserts observation, cleans up. Runs in `.github/workflows/e2e-smoke.yml` weekly + on PR label `smoke`.

Required env: `SMOKE_BOT_TOKEN` (PAT of a dedicated bot account), App credentials. **Effort:** L (1 day).

### OPS1 — Per-org spending limit + alerts

Per D8. This is a manual operation per participating org. The Setup-Org workflow's `Print next steps` block (A8) already prints the instructions. RUNBOOK update codifies the policy:

```md
## Per-org Actions budget policy

Each participating org's GitHub Actions budget MUST be configured before
the first student burst. Recommended **floor** values, to raise empirically
after the first cohort produces real consumption numbers:

| Class size | Recommended floor | Headroom estimate         | Alert thresholds |
|---|---|---|---|
| ≤ 50 students  | €60 / month  | ~10,000 min ≈ 200 min/student | 50%, 80%, 100% |
| 51–150 students | €120 / month | ~20,000 min ≈ 130 min/student | 50%, 80%, 100% |
| 151–500 students | €250 / month | ~42,000 min ≈ 80 min/student | 50%, 80%, 100% |

These floors assume **(a)** all included Team minutes (3,000/mo) are exhausted
by overage and the limit pays for the rest, **(b)** Linux 2-core pricing
($0.006/min, ~€0.0055), and **(c)** student CI is the dominant cost — the
pxl-classroom side is free. **Bursty courses (Terraform, container builds)
should raise from there.** A class running a single 30-min `terraform apply`
five times per student per assignment with 4 assignments lands at ~600 min/
student/month — €250 covers 80 of those, not 500. Size the budget against
the actual workload, not the headcount.

What 100% means: GitHub stops Actions on private repos until the next
monthly reset OR the limit is raised. In PXL Classroom's case this stops:

- Student-owned CI runs (visible to student as "queued" forever)
- Nothing on the pxl-classroom side (we run from public; we're unaffected)

What you do at 100%:
1. Confirm with the budget owner whether to raise the limit.
2. If yes: raise it. If no: communicate to students that CI is paused
   until reset, and reassure that the integrity layer (lockdown,
   preservation, reports) continues to run.
```

**Effort:** S (1 h for RUNBOOK; org-side configuration is a per-org human task).

### OPS2 — Budget owner per org

Each participating org must have a named human budget owner before going live. Tracked in `participating-orgs.yml`:

```yaml
schema_version: 1
orgs:
  - login: PXLAutomation
    added_at: 2026-09-01
    budget_owner: jane.doe@pxl.be
    spending_limit_eur: 100
  - login: PXLCloudAndAutomation
    added_at: 2026-09-15
    budget_owner: john.smith@pxl.be
    spending_limit_eur: 60
```

Schema becomes `schemas/participating-orgs.schema.json`. Setup-Org workflow refuses to add an org without a budget owner. **Effort:** S (1 h).

### P2-3 — Shallow clone in preserve

Replace full clone with `git init --bare; git fetch --depth=1 <src> <sha>; git push <dst> <sha>:<ref>`. **Effort:** S (1 h).

### P2-4 — Cap polling in SPA

After 30 attempts (~5 min), show `'timeout'` state with refresh-yourself guidance. **Effort:** S (45 min).

### P2-5 — Device-code phishing warning

Name "PXL Classroom Provisioner" + "If any other App name appears, do NOT enter the code." On both AssignmentView and DashboardView device-code panels. **Effort:** S (30 min).

### P2-6 — Delete AGENTS.md + GEMINI.md

97-byte stubs. Delete. **Effort:** XS.

### P2-7 — Move node -e snippets to scripts/

`scripts/find-pending.mjs` (used by process-queue.yml), `scripts/update-acceptance-status.mjs`, etc. — extract every inline `node -e "…"` from a workflow YAML into a committed script. **Effort:** M (2 h).

### P2-8 — Admin UI YAML preview

Before commit, show generated YAML in a code block. Lecturer sanity-checks before push. **Effort:** S (1 h).

### P2-11 — Minor items from REVIEW.md §4.6

| Item | File | Change |
|---|---|---|
| Dynamic `import("node:fs")` inside loop | `accept.mjs:177` | Top-level static import |
| Email-address regex too broad | `pages/scan.mjs:25` | Drop or allowlist project emails |
| UA inconsistent per script | every action `.mjs` | Already done by F2 |
| `report.mjs` doesn't honor roster | `report.mjs:107–112` | F1's working YAML parser unlocks reading the array roster — include roster students with no acceptance as `acceptance_state: not-accepted` |

**Effort:** M (2 h).

### P2-10 — Documentation updates

End-of-fix housekeeping. Update every doc to match reality.

| Doc | Change |
|---|---|
| `PROGRESS.md` | Replace "v1 fully released, all phases complete" with "v1 GA released YYYY-MM-DD" once Wave 7 closes. Phases 0–4 stay checked; new bullet: "Architecture revised to centralize workflows (see REVIEW.md / REVIEW_PLAN.md)." |
| `REQUIREMENTS.md` §*Security requirements* | Affirm minimum App permission set (Admin RW + Contents RW + Metadata R + Account/Starring RW). Drop any wording implying secrets-write is needed. Add a paragraph: "Workflows run centrally from `pxl-classroom` (public); per-org control repositories hold data only and contain no workflow files." |
| `REQUIREMENTS.md` §*Multi-organization architecture* | Update: "Workflows are centralized in the public `pxl-classroom` repository. Each control repository is a data-only store." |
| `IMPLEMENTATION_PLAN.md` | Add a Phase 5 "Centralization rewrite (Wave 1–7)" with REVIEW_PLAN cross-reference. Mark Phase 4 as superseded for the secrets/workflows section. |
| `README.md` Architecture diagram | Redraw: Pages dashboard → central `pxl-classroom` (workflows) ↔ per-org control repos (data) + student repos. |
| `RUNBOOK.md` | Replace the Setup-Org ceremony. Add the budget policy. Add the budget-owner requirement. Document that `finalize-deadline` is now automatic. |
| `CLAUDE.md` | The Authoritative AI Memory Rule already lists `REQUIREMENTS.md` / `IMPLEMENTATION_PLAN.md` / `CLAUDE.md`. Add `REVIEW.md` and `REVIEW_PLAN.md` to the list. |
| New `RELEASE_NOTES_v1.md` | Once Wave 7 closes, summarize: from RC → GA, the centralization rewrite, the budget policy. |

**Effort:** M (3 h).

---

## Verification — what "done" looks like

A fix is not done until its acceptance check passes. The plan's overall acceptance criteria:

1. **`node --test tests/` passes** locally and on `ci.yml`.
2. **`e2e-smoke.yml` is green** for two consecutive weekly runs against a PXLAutomation sandbox.
3. **App's effective permissions match the minimum** — `gh api /app` returns Repository: `administration: write, contents: write, metadata: read`, no `secrets` key. User-level: `starring: write`. Verified once after F7 lands, then weekly as a `verify-app-perms.yml` cron in pxl-classroom:
   ```yaml
   - run: |
       node -e "
         const want = {administration:'write',contents:'write',metadata:'read'};
         const got = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).permissions;
         for (const k of Object.keys(want)) if (got[k] !== want[k]) { console.error('drift',k,got[k]); process.exit(1); }
         if (got.secrets) { console.error('SECRETS:write present!'); process.exit(1); }
       " < <(gh api /app)
     env: { GH_TOKEN: ${{ steps.jwt.outputs.token }} }
   ```
4. **App on PXL-DAS** is install-scope-limited to `pxl-classroom` only — `gh api /app/installations` shows `repository_selection: selected` and `repositories: [pxl-classroom]`.
5. **Branch protection on `pxl-classroom/main`**: PR + ≥2 approvals + signed commits + status checks required; verified via `gh api /repos/PXL-Digital-Application-Samples/pxl-classroom/branches/main/protection`.
5a. **Branch protection on `pxl-classroom/participating-orgs`**: PR + 1 approval, no signed-commits requirement, no path restrictions — verified the same way.
6. `git grep corsproxy.io` returns no matches.
7. `git grep '@v[0-9]\+\s' .github/workflows/*.yml` returns no matches.
8. `git grep secrets:.write` in `frontend/src/views/SetupView.vue` returns no matches.
9. **No `.github/workflows/` directory exists** in any per-org control repo (`gh api /repos/<org>/pxl-classroom-control/contents/.github/workflows` returns 404 for every participating org).
10. **Cold-load `https://<gh-pages-host>/pxl-classroom/a/sample-assignment`** lands on AssignmentView.
11. The Admin Panel's *Publish* button triggers `publish-assignment.yml` in `pxl-classroom` (gh run list shows the dispatched run).
12. A test override JSON with `deadline_at: <past+24h>` results in `submission_status: on-time` for a student whose last observation was past the original deadline.
13. Inducing each of the 7 notification categories produces exactly one comment per condition on the per-org tracking issue; rerunning the workflow updates instead of duplicating.
14. AssignmentDetailView renders correctly for a `reports/dashboard.json` that exceeds 1 MB.
15. Each participating org has a recorded `budget_owner` and `spending_limit_eur` in `participating-orgs.yml`.
16. `participating-orgs.yml` is up to date with every org that has the App installed (cross-check via `gh api /app/installations`).
17. `PROGRESS.md` honestly reflects state.

---

## What's still open / deferred

| Item | Decision | Reason |
|---|---|---|
| **Institutional verification (MS365 / Entra ID)** | Deferred to v2 | REQUIREMENTS.md §*Student eligibility* defers; v1 accepts the open-acceptance residual risk. |
| **Group assignments** | Deferred to v2 | REQUIREMENTS deferral stands. |
| **Real separate Dispatcher App** | Deferred unless audit demands | D7 reuses one App with two installations. Acceptable trade-off given branch protection + code review on workflow files. Re-evaluate if a security audit asks for harder isolation. |
| **Auto-discover participating orgs via App-level JWT** | Deferred | `participating-orgs.yml` is the source of truth in v1, maintained by Setup-Org. JWT-based discovery is a v1.1 simplification. |
| **Student CI self-hosted runners** | Documented as a course-design choice | Not blocking v1. If overage costs become painful, course materials can opt in to runner exercises. |
| **LMS / grade export** | Out of scope (REQUIREMENTS §*Non-goals*) | — |
| **Plagiarism / similarity** | Out of scope (REQUIREMENTS §*Non-goals*) | — |

---

## Effort summary

| Wave | Items | Effort | Cumulative |
|---|---|---|---|
| 1 — Foundation | F1–F7 | 2.0 d | 2.0 d |
| 2 — Architecture move | A1–A11 | 1.7 d | 3.7 d |
| 3 — P0 functional + cron tuning | P0-4, P0-5, P0-7, P0-8, P0-10, D9 | 1.0 d | 4.7 d |
| 4 — Security + pinning | P0-1, P1-7 | 0.5 d | 5.2 d |
| 5 — SPA modernization | V0–V5, P1-8..P1-13 | 1.7 d | 6.9 d |
| 6 — Reliability & notifications | P1-4, P1-5, P1-6, P2-2 | 1.5 d | 8.4 d |
| 7 — Tests, ops, docs | P2-1, OPS1, OPS2, P2-3..P2-11, P2-10 | 1.5 d | **9.9 d** |

About **10 working days** for one engineer end-to-end. Two engineers can collapse Waves 5+6 into a single calendar week, dropping the calendar time to **~7 working days**.

The plan is sequenced so partial completion still leaves the system better than it started:

- **Stop after Wave 2:** the central architecture is in place; the secrets-write problem is gone; per-org Actions cost is near zero. But the corsproxy.io issue and several functional bugs remain.
- **Stop after Wave 4:** real v1.0 GA. All P0s closed; security clean; integrity layer runs automatically (preserve, finalize-deadline cron, reconcile-registry cron).
- **Stop after Wave 6:** the "lovely" v1: SPA polished, full notifications, multi-org Pages, contrast lifted.
- **Wave 7 closes:** tests in place, budget policy live, docs current, RELEASE_NOTES_v1 published.

---

## Sanity checks — what could still go wrong

1. **`pxl-classroom` public flip is one-way (sort of).** Going back to private is technically possible but the git history is now world-readable for as long as the flip was active. Pre-flip secret-history scan (F5 / A10 checklist) is what makes this safe. If it finds anything, fix before flipping.
2. **The PXL-DAS install carries `Admin:RW` on `pxl-classroom`** even though the broker only fires dispatches. Compromise scenario: a broker workflow is modified to dump the token; with Admin:RW, the dumped token can rewrite `pxl-classroom`'s code. Mitigated by branch protection on workflows + signed commits + secret scanning. If even one of those fails, the blast radius is "the central system." Audit this control before going live.
3. **Cron leg overlap.** With per-30-min process-queue + 6h collect + 15-min near-deadline + daily reconcile, a few of these will tick within seconds of each other. They're all idempotent and the rate-limit budget per org token (5,000 reads/h) is healthy at the steady-state scale. But the first month of pilot should monitor `x-ratelimit-remaining` actively. Add a simple "rate-limit canary" to `notify` if remaining < 500 for ≥3 consecutive observations.
4. **`participating-orgs.yml` is single-writer.** Setup-Org commits via PR. Two simultaneous setups → PR conflict. Acceptable for v1 (human resolves the merge).
5. **Schema-fetch CORS.** SPA fetches `/schemas/*.schema.json` from same Pages origin — no CORS issue. If schemas ever move to a different host, V1's `fetch` will need to handle CORS. Not in scope.
6. **Workflow YAML moves break running workflows in the existing control repo.** During Wave 2, until A10 completes the public flip, the system is in a transitional state: brokers still dispatch to per-org control repos, but those workflows are being deleted. **Either** stage the move with brokers still using the old target for the first week and re-publish brokers in a second pass, **or** do A10 before A1–A9 are in production use (i.e., during a quiet window). Go with the second — pilot only, no live students yet.
7. **Lecturer's spending limit at €0 by default.** The Setup-Org final summary nags about this. Add a `verify-org-budget.yml` workflow that hits the org billing API (requires `billing:read` org perm via the App or a separate token) and fails CI if the limit is unset. Owner: ops.

---

## Appendix — file-by-file inventory of changes

For implementer use. Maps every concrete file edit to its plan item.

| File | Wave | Item | Change |
|---|---|---|---|
| `package.json` (new, root) | 1 | F1 | Add `yaml`, `ajv`, `ajv-formats` |
| `lib/yaml.mjs` (new) | 1 | F1 | Shared YAML parser |
| `lib/gh.mjs` (new) | 1 | F2 | Shared GitHub API helper |
| `lib/store.mjs` (new) | 1 | F2 | Filesystem-backed control-repo helpers (read/write JSON, list dirs) |
| `tests/*` (new) | 1, 7 | F3, P2-1 | All unit + e2e tests |
| `tests/fixtures/*` (new) | 1, 7 | F3, P2-1 | YAML, JSON fixtures |
| `frontend/public/404.html` (new) | 1 | F4 | SPA shim |
| `frontend/index.html` | 1 | F4 | Decoder script |
| `.github/CODEOWNERS` (new) | 1 | F5 | Workflow-folder protection |
| `.github/SETUP_CHECKLIST.md` (new) | 1 | F5, A10 | Pre-flip verification |
| `acceptance/accept.mjs` | 1 | F1 | Replace inline YAML parser; drop dynamic fs import (P2-11) |
| `acceptance/action.yml` | 1 | F1 | Add `npm ci --omit=dev` step |
| `acceptance/broker-workflow.yml` | 2 | A1, P2-2 | New dispatch target + boundary comment |
| `collect/collect.mjs` | 1, 2 | F1, A4 | YAML lib; smart-schedule helper |
| `collect/action.yml` | 1 | F1 | npm ci step |
| `lockdown/lockdown.mjs` | 1 | F1 | YAML lib |
| `preserve/preserve.mjs` | 3, 7 | P0-4, P2-3 | Multi-student mode; shallow clone |
| `notify/notify.mjs` | 1, 6 | F2, P1-4 | Use shared gh(); EMOJI_MAP deadline-gap |
| `pages/generate.mjs` | 1, 3 | F1, P0-10 | YAML lib; emit repository_name_pattern |
| `pages/scan.mjs` | 7 | P2-11 | Email regex |
| `registry/reconcile.mjs` | 1 | F2 | Use shared gh(); style consistency |
| `report/report.mjs` | 1, 3 | F1, P0-7, P2-11 | YAML lib; apply overrides; honor roster |
| `provisioning/provision.mjs` | 1 | F2 | Use shared gh() |
| `.github/workflows/acceptance-handler.yml` (new in pxl-classroom) | 2 | A2 | Central handler |
| `.github/workflows/process-queue.yml` (new in pxl-classroom) | 2, 3, 6 | A3, D9, P1-5 | Central queue + 30min cron + concurrency |
| `.github/workflows/collect-activity.yml` (new in pxl-classroom) | 2 | A4 | Central + smart cron |
| `.github/workflows/finalize-deadline.yml` (new in pxl-classroom) | 2, 3 | A5, P0-4 | Central + cron + preserve wired |
| `.github/workflows/reconcile-registry.yml` (new in pxl-classroom) | 2 | A6 | Central + daily cron |
| `.github/workflows/publish-assignment.yml` (new in pxl-classroom) | 2 | A7 | Central |
| `.github/workflows/retry-failed.yml` (new in pxl-classroom) | 2 | A7 | Central |
| `.github/workflows/export-report.yml` (new in pxl-classroom) | 2 | A7 | Central |
| `.github/workflows/regenerate-dashboard.yml` (new in pxl-classroom) | 2 | A7 | Central + multi-org `/data/` + scanner |
| `.github/workflows/setup-org.yml` | 2 | A8 | Rewritten; no secrets injection |
| `.github/workflows/verify-org-perms.yml` (new) | 2 | A8 verification | Per-org perm check |
| `.github/workflows/ci.yml` (new) | 1, 7 | F3, P2-1 | Unit tests |
| `.github/workflows/e2e-smoke.yml` (new) | 7 | P2-1 | Weekly + PR-label |
| `.github/workflows/deploy-frontend.yml` | 5 | V2 | Copy schemas into public/ |
| `participating-orgs.yml` (new, on `participating-orgs` branch) | 2, 7 | A8, OPS2 | Participating-orgs source of truth. Branch-isolated per D13. |
| `schemas/participating-orgs.schema.json` (new) | 7 | OPS2 | Schema for the above |
| `.github/workflows/verify-app-perms.yml` (new) | 1 | F7 verification | Weekly cron asserting App perms are minimum |
| `.github/workflows/regenerate-dashboard.yml` (new) | 2 | A7 | Central + Actions-source Pages deploy, shares `pages` concurrency |
| `pages/regenerate-all.mjs` (new) | 2 | A7 | Multi-org data fetch + emit driver |
| `frontend/src/router/index.js` | 5 | V0 | `/:org/a/:assignmentId` route |
| `control-repo-template/workflows/` (delete) | 2 | A9 | Dead workflows |
| `control-repo-template/.github/workflows/` (delete) | 2 | A9 | Dead workflows |
| `control-repo-template/README.md` | 2 | A9 | "Data only" notice |
| `frontend/package.json` | 1, 5 | F1, V1 | Add yaml, ajv |
| `frontend/src/lib/validate.js` (new) | 5 | V1 | Client-side ajv |
| `frontend/src/lib/format.js` (new) | 5 | P1-12 | Date helpers |
| `frontend/src/lib/toast.js` (new) | 5 | P1-13 | Toast composable |
| `frontend/src/lib/auth.js` | 4 | P0-1 | Remove corsproxy |
| `frontend/src/lib/api.js` | 6 | P1-6 | Add getRepoContentRaw; update triggerWorkflow signature |
| `frontend/src/views/AdminView.vue` | 3, 5 | P0-5, V3, P1-13 | Fix workflow filename + target; ajv pre-commit; toasts |
| `frontend/src/views/AssignmentView.vue` | 3, 5, 7 | P0-10, P1-12, P2-4, P2-5 | Pattern from assignment; date helper; cap polling; phishing warning |
| `frontend/src/views/DashboardView.vue` | 5, 7 | V4, P1-12, P2-5 | Installation enumeration; date helper; phishing warning |
| `frontend/src/views/AssignmentDetailView.vue` | 6 | P1-6, P1-12 | Raw download URL; date helper |
| `frontend/src/views/HomeView.vue` | 5 | P1-9 | Public assignment listing |
| `frontend/src/views/SetupView.vue` | 4 | (dissolved) | Drop secrets:write from manifest; keep for app-creation convenience |
| `frontend/src/components/StudentTable.vue` | 5 | P1-11 | Delete |
| `frontend/src/components/AssignmentCard.vue` | 5 | P1-11 | Delete |
| `frontend/src/components/Toast.vue` (new) | 5 | P1-13 | Toast component |
| `frontend/src/style.css` | 5 | P1-10 | Contrast |
| `frontend/public/schemas/*.schema.json` (new, copied at build) | 5 | V2 | Schemas served to SPA |
| `AGENTS.md`, `GEMINI.md` (delete) | 7 | P2-6 | Stubs |
| `PROGRESS.md`, `REQUIREMENTS.md`, `IMPLEMENTATION_PLAN.md`, `README.md`, `RUNBOOK.md`, `CLAUDE.md` | 7 | P2-10 | Doc updates |
| `RELEASE_NOTES_v1.md` (new) | 7 | P2-10 | Close-out notes |

Total: **~75 distinct file changes**, of which **~35 are new files**.
