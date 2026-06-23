# Extra Features Plan

Implementation plan for the 8 enhancements derived from the classroom50 review. Each feature has a CLI design, a UI equivalent where the lecturer workflow benefits from one, and concrete file/schema touchpoints.

This is a planning artifact, not a runtime spec. When a feature ships, fold its design into `ARCHITECTURE.md` / `RUNBOOK.md` and trim the entry here.

---

## Implementation order

```
Phase A — Carrier
  1. gittree.mjs refactor      (internal, unblocks reliability for later features)
  2. CLI skeleton + auth        (gh extension shell, device flow, App-installation token)
  3. CSV roster import          (CLI + UI — first user-visible win)

Phase B — Evidence
  4. Submit-tag convention      (student protocol + lecturer surfacing)
  5. Audit command              (read-only sanity checks, builds CLI muscle)

Phase C — Pedagogy
  6. Feedback-PR pattern        (per-assignment opt-in)
  7. Bulk submission download   (archive-backed)
  8. Lecturer-side autograder   (local, zero billed minutes)
```

Phase A is the foundation: nothing in Phase B/C is worth doing without a reliable commit primitive (#1) and a CLI carrier (#2). Roster import (#3) ships in both CLI and UI so the lecturer pain point closes immediately.

---

## 1. `lib/gittree.mjs` — consolidated commit primitive

**Why first.** Burst-acceptance reliability, dashboard regen concurrency, every future Contents-API write benefits. Internal refactor; no public surface change.

**Design.** One module exporting two named retry policies:

```js
// lib/gittree.mjs
export async function commitWithRebase(octokit, {
  owner, repo, branch, message, changes, // [{path, content|null}]
  baseTree,                                // reuse unchanged paths
  maxAttempts = 5, baseBackoffMs = 200,
}) { /* optimistic update + rebase on non-FF */ }

export async function commitWithFreshRepoRetry(octokit, {
  owner, repo, branch, message, changes,
  maxAttempts = 8, baseBackoffMs = 500,
}) { /* tolerates 404/409 propagation lag for newly created repos */ }
```

**Patterns to lift from classroom50's `gittree.go`:**

| Pattern | Where it helps us |
|---|---|
| `null` SHA on tree entry = delete | Atomic multi-file delete in one tree create (e.g. clearing stale `observations/` pages) |
| `base_tree` reuse for unchanged paths | Avoid re-uploading blobs in dashboard regen |
| Non-fast-forward detection by message text | Disambiguate 422 (permission/malformed-ref vs. non-FF) |
| `classify404` callback | Split "missing scope" 404 from "repo not yet propagated" 404 |
| Signal-aware root context | `AbortController` wired to `SIGINT` so Ctrl-C unwinds in-flight HTTP |

**Touchpoints.**
- New: `lib/gittree.mjs`, `tests/gittree.test.mjs`
- Refactor: every script in `scripts/` that currently does ad-hoc PUT loops
- Refactor: `pages/generate.mjs`, `report/` action, `acceptance/` action

**Effort.** M (2–3 days including test coverage).

**UI equivalent.** None — internal.

---

## 2. CLI skeleton — `gh pxl-classroom` extension

**Why.** Course setup is bursty and scripted; the SPA scales linearly with clicks, a CLI scales constantly. Lecturers in CS already have `gh`. Carrier for every later command.

**Tech choice.** Node 24 + `commander` + Octokit (same stack as the rest of the repo). Distributed as a `gh` extension: `gh extension install PXL-Digital-Application-Samples/gh-pxl-classroom`. Single binary not needed — Node is the project's lingua franca.

**Repo layout (added to hub root).**

```
cli/
  bin/pxl-classroom.mjs        # entrypoint
  src/
    commands/
      assignment.mjs           # add, list, show, publish
      roster.mjs               # import, list
      extension.mjs            # grant, list, revoke
      audit.mjs                # (see #5)
      download.mjs             # (see #7)
      grade.mjs                # (see #8)
      refresh.mjs              # live-status equivalent
    lib/
      auth.mjs                 # device flow against the Provisioner App
      config.mjs               # ~/.config/pxl-classroom/{token, last-org}
      validate.mjs             # ajv against schemas/ (shared with frontend)
  package.json
  README.md
```

**Auth model.** Device flow against the same App as the SPA, token cached at `~/.config/pxl-classroom/token` with 0600 perms. `--org &lt;login&gt;` flag remembers last value. Token expiry surfaces with `pxl-classroom auth status`.

**Schema reuse.** `cli/src/lib/validate.mjs` imports from `schemas/` so CLI and SPA validate identically — no drift.

**Touchpoints.**
- New: `cli/` tree, `gh-extension.json` manifest, `.github/workflows/cli-ci.yml`
- New: `cli/README.md`
- Docs: `RUNBOOK.md` §"CLI installation"

**Effort.** M (3–4 days for skeleton + auth + one trivial command).

**UI equivalent.** N/A (the CLI *is* the alternative UX).

---

## 3. CSV roster import

**Why.** Biggest lecturer pain point per `RUNBOOK.md`. Hand-edited YAML is error-prone at 80+ students.

### CLI

```bash
pxl-classroom roster import --org PXLAutomation roster.csv
pxl-classroom roster import --org PXLAutomation --dry-run roster.csv  # preview diff
pxl-classroom roster list --org PXLAutomation
```

CSV columns (header row required): `student_number, full_name, email, github_login?`. `github_login` is optional and filled later via overrides.

Behavior: validate every row against `roster.schema.json`, diff against current `students/roster.yml`, present add/update/remove counts, commit via `commitWithRebase`.

### UI (`AdminView.vue` — new "Roster" tab)

- Drag-and-drop or file-picker for `.csv`
- "Paste CSV" textarea alternative
- Live diff preview (added / updated / removed) before commit
- Per-row validation errors highlighted with the schema error message
- Single "Commit roster" button — same lecturer token, same Contents API path as CLI

**Touchpoints.**
- New: `cli/src/commands/roster.mjs`
- New: `frontend/src/components/RosterImport.vue`, `frontend/src/lib/csv.mjs`
- Use: existing `schemas/roster.schema.json`

**Effort.** S (CLI 1 day, UI 1–2 days).

---

## 4. Submit-tag convention

**Why.** Stronger evidence layer without altering the trust model. Tags carry an explicit, sortable, client-config-independent submission timestamp.

**Tag format.** `submit/&lt;ISO-8601-Z&gt;-&lt;short-sha&gt;` — e.g. `submit/2026-10-05T20:34:11Z-a1b2c3d`. Lexicographically sortable. The ISO-Z portion is the *server's* time at the moment the lecturer-supplied helper runs, not the client's git config.

### Student protocol

- Lecturer course materials show: `git tag submit/$(date -u +%Y-%m-%dT%H:%M:%SZ)-$(git rev-parse --short HEAD) && git push origin --tags`
- We do **not** mandate it — observations on the default branch tip remain authoritative.
- Optional `pxl-classroom-helper` one-liner committed into templates for convenience.

### Lecturer surfacing

`collect/` action enhancement: in addition to the default-branch snapshot, list tags matching `^submit/` on each student repo, parse the timestamp, record the *latest* as a separate observation type:

```json
{
  "type": "tagged-submission",
  "observed_at": "2026-10-05T22:00:00Z",
  "tag": "submit/2026-10-05T20:34:11Z-a1b2c3d",
  "declared_at": "2026-10-05T20:34:11Z",
  "tagged_sha": "a1b2c3d..."
}
```

Report classifies a tagged-submission as the **declared** submission; falls back to default-branch tip if absent. `declared_at` is observed (we saw the tag), not authoritative (student set the time string).

### UI

- `AssignmentDetailView`: new column "Submit tag" showing the latest tag + relative time. Icon for tagged vs untagged.
- Per-student panel: full tag history (sorted desc) with copy-SHA buttons.
- Public student `AssignmentView`: "✅ Submission tagged at &lt;time&gt;" indicator after the helper runs.

**Touchpoints.**
- `collect/collect.mjs` — extend to list `refs/tags/submit/*`
- `schemas/observation.schema.json` — add `type: "tagged-submission"` variant
- `report/report.mjs` — prefer tagged over default-branch when present
- `frontend/src/views/AssignmentDetailView.vue` — new column + drawer
- Template README boilerplate (`control-repo-template/` and assignment templates)

**Effort.** S–M. Schema change + collector extension is the bulk.

---

## 5. `pxl-classroom audit`

**Why.** Catches drift between the App's actual permissions and what the manifest declares; verifies lock-down outcomes match what reports claim.

### CLI

```bash
pxl-classroom audit --org PXLAutomation
pxl-classroom audit --org PXLAutomation --assignment linux-processes-2026
pxl-classroom audit --org PXLAutomation --json   # machine output for CI
```

Checks performed (read-only):

| Check | How |
|---|---|
| App installed on org | `GET /orgs/{org}/installation` |
| App permissions match manifest | Compare with `frontend/src/views/SetupView.vue` manifest constant |
| Control repo exists, private, scaffold intact | `GET /repos/{org}/pxl-classroom-control/contents/...` |
| Org in `participating-orgs` branch | Fetch + parse |
| Per-assignment: lockdown record matches repo permission | `GET /repos/{org}/{repo}/collaborators/{login}/permission` |
| Per-assignment: archive branch exists for every reported submission | `GET /repos/{org}/pxl-classroom-archive/branches/preserved/{id}/{login}` |
| Actions spending limit set | (best-effort, may require org owner) |

Exit codes: `0` clean, `1` warnings, `2` failures. JSON mode for `audit` integration into nightly runs.

### UI (`DashboardView.vue` — new "System health" panel)

A small card per org showing the same checks as colored chips. Click → opens drawer with the audit JSON. Click "Re-run" → dispatches a new audit (lecturer token, no workflow needed). Cached for 5 minutes.

**Touchpoints.**
- New: `cli/src/commands/audit.mjs`, `lib/audit.mjs` (shared with SPA)
- New: `frontend/src/components/SystemHealth.vue`
- Schema: none (read-only)

**Effort.** S–M.

---

## 6. Feedback-PR pattern

**Why.** Real code review on student work without compromising student admin or adding Actions runs.

### Provisioning extension

When an assignment has `feedback_pr: true`:

1. After template copy, push a frozen branch `pxl-baseline` pointing at the template's initial SHA.
2. Protect `pxl-baseline` (no force-push, no delete) via App admin.
3. Open a draft PR: head = `main`, base = `pxl-baseline`, title `"&lt;Assignment title&gt; — Feedback"`, body explains the convention.
4. Record `feedback_pr_number` on the repository record.

### Lecturer workflow

Lecturer (org owner) leaves inline review comments on the PR. Comments persist as the student keeps pushing — PR head tracks `main`. Student keeps admin but cannot delete `pxl-baseline` (protection enforced by App, which outranks repo admin).

### CLI

```bash
pxl-classroom feedback open --assignment linux-processes-2026 --login alice
pxl-classroom feedback list --assignment linux-processes-2026  # PR URLs + comment counts
```

### UI

- `AdminView` — assignment editor: toggle "Open Feedback PR on provisioning"
- `AssignmentDetailView` — per-student row: "Feedback PR" column with PR number + open-comment count
- Banner if PR is missing for a student record (drift)

### Assignment schema addition

```yaml
feedback_pr: true                          # default false
feedback_pr_baseline_branch: pxl-baseline  # configurable, rarely changed
```

**Touchpoints.**
- `provisioning/provisioning.mjs` — branch creation, protection, PR open
- `schemas/assignment.schema.json` — two new optional keys
- `frontend/src/views/AdminView.vue` — assignment editor field
- `frontend/src/views/AssignmentDetailView.vue` — new column
- `cli/src/commands/feedback.mjs`

**Effort.** M.

---

## 7. Bulk submission download

**Why.** Lecturer wants `wc -l`, plagiarism tools, local CI — anything off-cluster. Archive-backed so post-deadline rewrites cannot affect what's downloaded.

### CLI (primary)

```bash
pxl-classroom download --org PXLAutomation \
                       --assignment linux-processes-2026 \
                       --dir ./submissions \
                       --concurrency 4
```

Behavior:
1. Read `reports/&lt;id&gt;.json` from control repo for the submission SHA list.
2. For each student, clone `&lt;org&gt;/pxl-classroom-archive` and check out `preserved/&lt;assignment-id&gt;/&lt;login&gt;` into `./submissions/&lt;login&gt;/`.
3. Concurrent with a default of 4 (configurable).
4. Skip already-downloaded students (resumable).
5. Write `./submissions/_manifest.json` with SHA + observation timestamps.

### UI (lighter — manifest only)

The browser can't clone Git, so the UI doesn't try to. Instead `AssignmentDetailView` exposes:
- "Download manifest (JSON)" — list of `{login, archive_sha, archive_branch_url}` rows
- "Copy CLI command" — pre-filled `pxl-classroom download …` for paste

This keeps the SPA honest and points power-users at the CLI for the actual bulk op.

**Touchpoints.**
- New: `cli/src/commands/download.mjs`
- Use: existing archive layout in `<org>/pxl-classroom-archive`
- `frontend/src/views/AssignmentDetailView.vue` — manifest button

**Effort.** S.

---

## 8. Lecturer-side autograder

**Why.** Lets us match classroom50's pedagogical value without the per-push Actions cost that would blow Wave 8 minimal-minutes wide open. The grader runs on the **lecturer's** machine against archived SHAs.

### Assignment schema addition

```yaml
autograde:
  enabled: true
  tests:
    - id: compile
      type: run
      command: "make"
      timeout_s: 30
      points: 10
    - id: tests-pass
      type: run
      command: "make test"
      timeout_s: 120
      points: 40
    - id: style
      type: run
      command: "scripts/style-check.sh"
      timeout_s: 30
      points: 10
```

Test types deliberately mirror classroom50's `io` / `run` / `python` taxonomy so course materials can be ported. Execution model is local-only.

### CLI

```bash
# Grade everyone, results to control repo
pxl-classroom grade --org PXLAutomation \
                    --assignment linux-processes-2026 \
                    --runner docker \           # or "host"
                    --concurrency 2

# Grade one student locally without committing
pxl-classroom grade --assignment linux-processes-2026 --login alice --dry-run
```

Behavior:
1. Resolves the archive SHA list (same path as #7).
2. For each student: clone into a tmp dir, run each test in either a Docker sandbox (recommended) or directly on host, collect `{passed, output, duration_ms}`.
3. Write `grading/&lt;assignment-id&gt;/&lt;login&gt;.json` to the control repo.
4. Append to `grading/&lt;assignment-id&gt;/summary.json` for the UI.

Idempotent and resumable. The grader never touches student repos directly — only archive SHAs.

### UI

- `AssignmentDetailView` — new "Autograde" tab showing latest summary: per-student score, per-test pass/fail, last graded at, who ran it.
- Banner on assignment editor: "Autograding tests configured. Run locally with `pxl-classroom grade …`."
- *No* "Run autograder" button — execution stays off the platform on purpose.

### Schemas

- New: `schemas/grading-result.schema.json`
- Extend: `schemas/assignment.schema.json` with optional `autograde` block

**Touchpoints.**
- New: `cli/src/commands/grade.mjs`, `cli/src/lib/runner-docker.mjs`, `cli/src/lib/runner-host.mjs`
- New: `frontend/src/views/AutogradePanel.vue` (mounted in `AssignmentDetailView`)
- New schema + assignment schema extension

**Effort.** L (largest item; defer until 1–7 land).

---

## UI equivalents summary

| # | Feature | UI surface | Why / why not |
|---|---|---|---|
| 1 | `gittree.mjs` | None | Internal refactor |
| 2 | CLI skeleton | None | The CLI *is* the alternative UX |
| 3 | CSV roster import | **Yes** — `AdminView` Roster tab with diff preview | High-frequency lecturer task; SPA is the natural home |
| 4 | Submit-tag convention | **Yes** — column + drawer in `AssignmentDetailView`; banner in student `AssignmentView` | Evidence needs surfacing or it's invisible |
| 5 | Audit | **Yes** — System health panel in `DashboardView` | Lecturers should not need a terminal to see drift |
| 6 | Feedback PR | **Yes** — assignment editor toggle + per-student column | Configured in editor, surfaced in detail |
| 7 | Bulk download | **Partial** — manifest export + CLI command builder; no in-browser cloning | Browser can't clone; manifest is the honest middle ground |
| 8 | Autograder | **Read-only** — results panel in `AssignmentDetailView`; no "Run" button | Execution is deliberately off-platform; viewing results is fine |

---

## Cross-cutting concerns

**Validation parity.** Every schema validation runs in both CLI (`cli/src/lib/validate.mjs`) and SPA (`frontend/src/lib/validate.js`) from the *same* `schemas/` JSON files. No drift.

**Auth parity.** CLI and SPA use the same device flow against the same App. Token cache locations differ; everything else is identical.

**No new workflows.** Phases A and B add zero new central workflows. Phase C only extends `collect/` (#4) and `provisioning/` (#6). The nightly self-disabling cron remains the only scheduled job.

**Docs discipline.** When a feature ships, fold its design into `ARCHITECTURE.md` and `RUNBOOK.md` in the same commit per CLAUDE.md, and trim its section here. This file should shrink monotonically.

**Out of scope (Wave 8 constraints).**
- Per-push autograder triggers
- Any server-side rendering of grading results
- Any self-hosted runner dependency in the autograder
