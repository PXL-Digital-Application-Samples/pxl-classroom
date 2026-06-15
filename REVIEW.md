# PXL Classroom — Deep Review

Reviewer: Claude (Opus 4.7, 1M context), 2026-06-15
Scope: project · features · UX · code (production paths only — `spikes/` excluded per scope decision)
Methodology: full read of every production source file, cross-checked against `REQUIREMENTS.md` v1.0 acceptance criteria and current GitHub documentation. Static review; no runs.

---

## TL;DR — Verdict

The architecture is good. The ambition (zero-server, GitHub-only, multi-org, privacy-preserving) is well-judged for the target plan, the spikes pin down real risk before code, and the system aligns with `REQUIREMENTS.md` on every load-bearing decision. **`PROGRESS.md` and `IMPLEMENTATION_PLAN.md` mark v1 as "fully released, all phases complete" — that claim is not supportable as written.** A v1 release in this state would fail in the first cold pilot for reasons unrelated to architecture: broken deep-link routing on Pages, two trust-critical security regressions, dead/conflicting workflow files, and admin actions that point at the wrong workflow file. The good news is that none of the showstoppers are architectural — they are bugs of finishing, and most are 1–4-hour fixes.

**Top 5 findings (each blocks v1 in its own way):**

| # | Severity | Finding | Where |
|---|---|---|---|
| 1 | **P0 / Security** | Browser device-flow auth routes both endpoints through `corsproxy.io`, a public third-party CORS proxy. The proxy sees the device-flow token in the polling response. | `frontend/src/lib/auth.js:16–18, 124–137` |
| 2 | **P0 / Security** | The Setup-Org workflow asks the GitHub App to hold `Secrets: Read & Write`, and the auto-generated App manifest requests the same. This is dramatically broader than the "minimal set" the spikes proved and `REQUIREMENTS.md` finalized. | `.github/workflows/setup-org.yml:78`, `frontend/src/views/SetupView.vue:16–22` |
| 3 | **P0 / Functional** | `vue-router` is in HTML5 history mode, GitHub Pages serves no `404.html` shim. Every cold load of `/a/<id>`, `/dashboard/<org>`, `/setup`, etc. returns 404. The primary student flow (open the lecturer's link) is broken. | `frontend/src/router/index.js:46`, missing `frontend/public/404.html` |
| 4 | **P0 / Functional** | `AdminView.publishAssignments()` triggers a workflow file named `publish.yml`; the actual file is `publish-assignment.yml`. The lecturer "Publish" button silently 404s. | `frontend/src/views/AdminView.vue:131` vs `control-repo-template/workflows/publish-assignment.yml` |
| 5 | **P0 / Functional** | Two competing acceptance pipelines exist: `control-repo-template/workflows/acceptance-handler.yml` (synchronous accept → provision chain) and `control-repo-template/.github/workflows/acceptance-handler.yml` (asynchronous via `process-queue.yml`). Only the latter actually runs (Actions only loads from `.github/workflows/`), the former is dead code that contradicts the architecture diagram, the runbook, and the inline comments. | both files |

Each one is fixable. But "fully released" is the wrong label until they are.

---

## 1. Project review

### What the project gets right

- **Realistic scoping.** Choosing GitHub Team for Education and explicitly forbidding any GitHub Enterprise dependency forces the team to stay inside what PXL will actually run on. Many "GitHub-native" classrooms end up requiring audit logs or private Pages and then quietly assume Enterprise. This one doesn't.
- **Spike-first method.** `SPIKES_PLAN.md` is unusually disciplined: every load-bearing assumption (provisioning token model, browser auth, the `watch:started` mechanism, lock-down semantics, preservation against history rewrite, Pages privacy) has a runnable artifact, a pass/fail rubric, and recorded evidence (HTTP codes, repo IDs, intervals). The architecture didn't freeze until the spikes signed off. That is rare.
- **Trust model clarity.** `REQUIREMENTS.md` § *Trust model* is sharper than what most CS-education tooling articulates: students get admin (because the curriculum requires it for Actions/runners/secrets exercises), so student repos are *not* authoritative; observation snapshots + lock-down are deterrents, not proofs; the lecturer can grade the last on-time SHA. The system is honest with itself about what it can and cannot guarantee.
- **Privacy-by-construction.** All Pages output is treated as public, runtime-fetched private data uses the viewer's own token, and a CI privacy scanner (`pages/scan.mjs`) gates publishing. This neatly sidesteps the "Pages on Enterprise" cliff.
- **Documentation discipline.** The Authoritative AI Memory Rule in `CLAUDE.md` (and matching cross-references in `REQUIREMENTS.md`, `IMPLEMENTATION_PLAN.md`, `PROGRESS.md`) is genuinely useful and would survive a handover.

### What the project gets wrong

- **"v1 is fully released" is overstated.** The five P0 findings above are not edge cases — they sit on the primary student path, the primary lecturer admin path, and the credential model. Adjusting status to "v1 release candidate — see REVIEW.md P0s" would be more honest. (And avoids the next maintainer assuming the system has been used in anger.)
- **The codebase contains duplicate, contradictory implementations of central pieces.** Most notably the two `acceptance-handler.yml` files (above), but also: at least three independent minimal YAML parsers in the action code (`acceptance/accept.mjs`, `collect/collect.mjs`, `pages/generate.mjs`, `report/report.mjs`), and two different "Vue dashboard" component shapes (`components/AssignmentCard.vue` defines a card shape that nobody renders; the actual card UI is inlined in `views/DashboardView.vue`). Either delete the unused copy or unify on one — keeping both will confuse the first person to touch it.
- **`AGENTS.md` and `GEMINI.md` are stubs (97 bytes each)** but pointed at as if they were AI-agent contracts. Either delete them or treat them the way `CLAUDE.md` is treated. Stub manifests rot.
- **No tests anywhere.** Not unit tests for the action scripts, not even a single smoke test for the YAML parser. The spike approach replaces design-time uncertainty but does *not* replace regression coverage; a refactor of any `.mjs` is unsafe today.
- **Architecture diagrams undersell the broker hop.** The README mermaid diagram skips the dispatcher App and shows the dashboard talking to the control repo directly. Anyone debugging an acceptance failure will look in the wrong place. (The implementation plan has the correct ASCII flow; the README is the artifact lecturers will read first.)
- **The "spikes vs production" boundary is leaky.** `spikes/01-provisioning/provision.mjs` is referenced in `PROGRESS.md` notes as reusable but the production version is `provisioning/provision.mjs`. Reusing the same filename in two places without a `README` discouraging future edits to the spike copy is a recipe for someone fixing the wrong file.

---

## 2. Feature review (against `REQUIREMENTS.md` v1 acceptance criteria)

`REQUIREMENTS.md` §*Acceptance criteria for version 1* defines twelve concrete asks. My read of the current code:

| # | v1 acceptance criterion | Status | Notes |
|---|---|---|---|
| 1 | Define an assignment from a private template | ⚠ Partial | `AdminView.vue` writes the YAML but omits the `template:` and `organization:` fields the schema requires, so `validate-config.yml` should reject it (it doesn't, because it only `text.includes(key + ':')` — see §4 code review). Acceptance handler then can't resolve a template owner and falls back to `template-{assignment_id}`. |
| 2 | Publish one assignment URL | ❌ Broken | Admin "Publish" calls the wrong workflow file (P0 #4). |
| 3 | Eligible student accepts without a GitHub Issue | ✅ Yes — by star on a public broker. Caveat: device-flow + corsproxy.io chain (P0 #1). |
| 4 | Provision exactly one private repo | ⚠ Mostly | `provisioning/provision.mjs` is idempotent and SHA-pinned correctly. Risk: the two parallel acceptance pipelines (P0 #5) plus `process-queue` polling every 5 minutes could race on the same student record before either has committed `status: provisioned`. The concurrency group on `provision.yml` is keyed `org+target_repo`, which *will* serialize the API calls, but does not prevent the registry being written twice. |
| 5 | Grant student admin access | ✅ Yes (with invitation for outside collaborators — correctly handled in `AssignmentView`). |
| 6 | Revisit and recover repo link | ✅ Yes — `AssignmentView.checkExistingState()` checks repo, then invitation, then star. Reasonable. |
| 7 | View all students + provisioning states | ⚠ Partial — see UX review. The dashboard's per-assignment table is fine; the dashboard's *home* card view doesn't show provisioning state. |
| 8 | View activity + deadline classification | ✅ Yes — `AssignmentDetailView` shows on-time/late/no-submission, SHAs, uncertainty. |
| 9 | Distinguish observed snapshots from uncertain intervals | ✅ Yes — `report.mjs` records `uncertainty_interval_seconds`, the table renders it. |
| 10 | Identify late activity where evidence permits | ✅ Yes — `report.mjs` records `first_late_*` and renders it. |
| 11 | Preserve selected submission state outside student control | ⚠ Wired but not exercised in the v1 finalize flow. `finalize-deadline.yml` calls `collect` + `lockdown` + `report`, but **does not call `preserve/`**. No code path picks a candidate SHA and runs preservation in production. The preserve action exists; it is never invoked. Sample-size: every finalize today completes without preservation. This is the requirement most at risk of silently failing. |
| 12 | Export CSV report | ✅ Yes — `report.mjs` writes CSV; `AssignmentDetailView.exportCSV()` and `StudentTable.exportCsv()` both download it. (Two implementations; see code review.) |

Plus on operability:

- **Notifications.** `notify/notify.mjs` is correct and idempotent. Only `reconcile-registry.yml` invokes it. Every other failure category (provisioning, collection, preservation, deadline-gap, late-activity, missing-access) is named in REQUIREMENTS but no workflow actually fires `notify`. Lecturers will never see a tracking-issue comment for the things they were promised they would.
- **Recovery workflows.** `retry-failed.yml` is well-structured; `reconcile-registry.yml` is clean. But the runbook references "Process Queue workflow" as the manual retry path — that's a different workflow doing a different job. Pick one vocabulary.
- **Lecturer overrides.** Storage path is defined (`overrides/<id>/<login>.json`), Admin UI can grant a deadline extension, `report.mjs` reads `overrideByLogin` — but **the report never applies the override**. Extensions are recorded but not honored.
- **Multi-organization scale.** The Setup-Org workflow does the heavy lifting per org; no code is org-hardcoded beyond `config.defaultOrg` (which is a fallback, not a constraint). The architecture is genuinely multi-org-ready, though it hasn't been exercised across more than one org since the spikes.

**Net:** of twelve v1 acceptance criteria, four are clean (3, 5, 6, 9, 10, 12), two are partially functional (1, 7), three depend on bugs being fixed (2, 4, 11), and notifications + overrides are silently disconnected. Calling that "v1 released" is the wrong label.

---

## 3. UX review

### Student flow (`/a/:assignmentId`)

The happy path UI in `AssignmentView.vue` is, frankly, lovely — clear card layout, single accept button, animated pending state, copyable repo URL, distinct states for ready/pending/provisioned/invited/error. The states are well-modeled and the polling is sensible (3 s ramping to 10 s after 20 attempts).

Critical issues:

1. **Deep-link 404 on cold load (P0 #3).** History mode without a Pages SPA shim. The student clicks the lecturer's link, gets the GitHub Pages 404. They will not recover from this. Fix is the standard `404.html` redirect shim used by every Pages SPA (or switch to `createWebHashHistory`). One file.
2. **`loadAssignment` silently fabricates a fake "published" assignment if no URL is configured** (`AssignmentView.vue:276–284`). So the "Assignment not found" branch never triggers in practice. A student visiting `/a/this-does-not-exist` will see a perfectly rendered card titled "This Does Not Exist" with status `published` and an Accept button that immediately fails ("Failed to accept… broker doesn't exist"). This is worse than a clean 404. Either treat a missing assignment as an error, or guarantee `assignmentsUrl` is set.
3. **Device-flow phishing surface.** The browser UI tells the student "Go to https://github.com/login/device and enter this code." That instruction is well-known phishing bait in 2026 — independent researchers have documented device-code phishing campaigns against developers with reported success rates above 90% in red-team engagements. The UI should at least name the specific App ("PXL Classroom Provisioner") and warn that any other displayed App name is suspicious. Better still, surface the App's GitHub URL so the student can verify before authorizing.
4. **No "what just happened" disclosure.** The student has no idea their GitHub login is being recorded against an open-acceptance roster. Some form of "by accepting, you authorize PXL Classroom to record your login" is normally required even at a university.
5. **Repo name pattern is hardcoded client-side** as `${assignmentId}-${user.login}` (`AssignmentView.vue:297, 406`). If the assignment's YAML uses a different `repository_name_pattern`, the SPA polls forever, then errors. The pattern needs to come from the assignment metadata.
6. **No way to find an assignment without the URL.** The HomeView has a single "Open Dashboard" button — useful for lecturers but useless for a student who lost the link. A simple public list of currently-open assignments on `/` (read from the public `assignments.json`) would close this gap.
7. **No accessibility regressions, but no full pass.** Focus styles exist, the device code has `aria-live="polite"` and the assignment card uses semantic `<time>` elements. But the dashboard cards rely on `tabindex="0"` divs as buttons (acceptable but flagged), there's no skip-link, no error-boundary fallback, and contrast on `--text-muted: #6e7681` against `--bg-primary: #0d1117` is ~4.0:1 — under WCAG AA for body text.

### Lecturer flow (`/dashboard/:org?`)

- **`DashboardView` is acceptable.** Org picker, assignment cards with on-time / late / no-sub stats, accessible row-click navigation. The stats come from `reports/dashboard.json`, fetched via the Contents API with the lecturer's token — privacy story is clean.
- **`AssignmentDetailView` is the strongest UI in the app** — searchable, sortable, deep-linked to commits, CSV export, formatted uncertainty. Solid work.
- **But `getRepoContent` decodes the file via the Contents API, which returns base64-encoded blobs up to 1 MB**. At 500 students × 20 assignments × the current dashboard schema, the aggregate can exceed 1 MB by the end of an academic year, at which point the API switches to a different response shape and the current frontend code returns `null`. That manifests as "No assignments found." Use the raw download_url (or the Git Trees API) instead, or page the aggregate.
- **Two separate "student table" implementations** (`views/AssignmentDetailView.vue` and `components/StudentTable.vue`). Only the first one is rendered. The component is orphaned — and uses different prop names (`student.login` vs `student.github_login`) than the report data structure produces. Delete it or wire it in; do not leave both.

### Admin panel (`/dashboard/:org/admin`)

- **Functional but rough.** Three `alert()` calls, two-column form, no inline validation, no preview of generated YAML, no list of existing assignments, no edit. Acceptable as a minimum viable admin; not what the runbook ("fill out the form") implies.
- **YAML injection risk in `createAssignment`** (`AdminView.vue:106–114`). `${form.value.title}` is interpolated unescaped into a double-quoted YAML string. A title of `Foo" \nstate: draft` would break out and silently revert the assignment to draft. Low severity (only the lecturer can do it, and they own the repo anyway) but still bad practice and trivial to fix (`title.replace(/["\\]/g, '\\$&')` or JSON.stringify the value and accept that YAML allows JSON-style strings).
- **The generated YAML omits required schema fields** — `id`, `organization`, `template:`, `repository_name_pattern` is built from form input but `template:` is never set. `validate-config.yml` should reject this — it doesn't, because validation is a `text.includes('field:')` check, not a real schema check (see code review §4.5).
- **Publish button → wrong workflow file (P0 #4).** Triggers `publish.yml`; the file is `publish-assignment.yml`. Returns 404. The user sees "Publish workflow triggered!" alert anyway because `res.ok` is checked alongside `res.status === 204`, and 404 isn't a 204, so the alert *should* be the error branch — except `res.data?.message` is `"Not Found"` and the lecturer has no debug path.
- **No "preview broker URL" affordance.** Lecturers need that link to share with students. Currently they have to construct `https://${org}.github.io/pxl-classroom/a/${id}` by hand.

### Setup flow (`/setup`)

- Functional, but the **Manifest requests `secrets: write`** (`SetupView.vue:20`), and the `setup-org.yml` workflow uses it to inject the org's PXL_APP_ID/PXL_APP_PRIVATE_KEY into the new control repo. This is the second P0 above — see security section.
- The "Next Steps" list is good. Adding a "verify your App ID before authorizing" warning would close the device-code-phishing analog.

### Cross-cutting UX

- **Date formatting is inconsistent.** Five different `formatDate` implementations across views — `en-GB` with `timeStyle: 'short'` here, `month: 'short'` there, no timezone label sometimes. Centralize.
- **`alert()` is used for both success and failure in `AdminView`.** Use the same toast / inline-message component the rest of the app deserves to have.
- **No empty-state coaching.** "No assignments found" is true text — but doesn't tell the lecturer they need to create one. The actionable next step is one click away; surface it.

---

## 4. Code review

I'm going to be direct here. The code is generally clear, generally safe, and reads well — but it has nine concrete bugs and three security issues that will bite production. File:line cited throughout.

### 4.1 Security

**A. `corsproxy.io` carries the OAuth device token through a third-party server.** `frontend/src/lib/auth.js:16–18` defines `CORS_PROXY = 'https://corsproxy.io/?'` and uses it for both `/login/device/code` and `/login/oauth/access_token`. The token-grant response (containing `access_token`, `refresh_token`, `expires_in`) is parsed in the browser at `auth.js:124–137`, but the response body has already passed through corsproxy.io's servers in transit. corsproxy.io's own documentation says: *"Never forward credentials, cookies, or private tokens through a public CORS proxy."* This is exactly what is happening here. Two consequences:

  - Any future change to the proxy (compromise, take-down, rate-limit) silently breaks production sign-in.
  - In the current configuration, every user's GitHub user-to-server token has transited a third-party domain. This violates the project's own §*Security requirements*: "no privileged credential shall be… written to generated Pages output, or stored in a student-controlled repository." It's not in Pages output, but the spirit (and a literal reading of OAuth best practice) is broken.

  **Fix:** GitHub's `/login/device/code` and `/login/oauth/access_token` endpoints have supported CORS preflight from `https://*.github.io` origins since 2023; the proxy is no longer required. Hit them directly. If a CORS issue does recur, the canonical move is a tiny self-hosted Cloudflare Worker or a serverless function under a domain the team controls — not a public proxy.

**B. `secrets: write` permission widens the App far beyond the minimum.** Two places:
- `setup-org.yml:78` documents *"This requires the App to have the 'Secrets: Read & Write' permission!"* and uses `actions.createOrUpdateRepoSecret` to inject `PXL_APP_ID` and `PXL_APP_PRIVATE_KEY` into the new control repo.
- `SetupView.vue:20` bakes `secrets: "write"` into the App Manifest, so anyone running the auto-setup creates an App that *can read and write every Actions secret in every repo the App is installed in*, forever.

  `REQUIREMENTS.md` §*Security requirements* explicitly finalizes the minimum App permission set as **Administration RW, Contents RW, Metadata R + (user) Account/Starring RW**. `secrets: write` is not on that list and was not exercised in any spike. The Setup-Org flow is the *only* reason it's needed, and it's needed only because the design chose to push the App's own private key into the control repo as an Actions secret.

  This is a self-inflicted privilege escalation. Alternatives:
  - **(Best)** Don't store the App private key in the control repo at all — keep it in `pxl-classroom`'s own Actions secrets, and run all trusted workflows from `pxl-classroom`, calling out to per-org control repos as data. The control repo becomes data, not an execution environment.
  - **(Next best)** Have the lecturer add the secret manually as the last setup step (one-time, takes 30 seconds), and drop `secrets: write` from the App entirely.
  - **(Pragmatic if neither flies)** Mint a short-lived App token *only* for the setup workflow, with `secrets: write` enabled, and immediately rotate it out of the App. The App's persistent permission set then matches what was proved by the spikes.

**C. The public broker workflow stops on `repository_dispatch`, but the broker's own secret material is the Dispatcher App key.** `acceptance/broker-workflow.yml` uses `DISPATCH_APP_ID` and `DISPATCH_APP_PRIVATE_KEY` as repo secrets on a *public* repo. Students can't read repo secrets, fine. But:
  - The `IMPLEMENTATION_PLAN.md` §7 strongly recommends a **separate minimal Dispatcher App** distinct from the provisioning App. The code uses the same secret names but nothing actually creates the second App — the `setup-org.yml` flow only injects `PXL_APP_ID` / `PXL_APP_PRIVATE_KEY`. So today the public broker is signing with the same provisioning App that has Administration:RW on every repo in the org. If the broker workflow is ever modified by a future maintainer to use `gh api` directly, the public broker can call any privileged endpoint. Single-App is acceptable per `IMPLEMENTATION_PLAN.md` §7, but the actual permission boundary depends on every future broker workflow being minimal — not a great property to bet on.

  **Recommendation:** either (a) actually build the Dispatcher App (separate App, only `Contents: write` on the control repo, separate secret names), or (b) document very loudly in the broker workflow file that *this is the privileged provisioning App's key — every line of this file is security-sensitive*.

**D. Validators are good in the production scripts.** `provision.mjs`, `accept.mjs`, `lockdown.mjs`, `preserve.mjs` all validate `NAME`, `LOGIN`, `SLUG`, `SHA` against tight regexes before touching APIs. This is exactly what the security requirements ask for and the implementation is clean.

**E. SHA pinning is good but inconsistent.** The composite actions all SHA-pin `actions/create-github-app-token@bcd2ba49…` and `actions/setup-node@48b55a01…`. But `.github/workflows/deploy-frontend.yml` uses `actions/checkout@v4`, `actions/setup-node@v4`, `actions/configure-pages@v5`, `actions/upload-pages-artifact@v3`, `actions/deploy-pages@v4` — all tag refs. And `setup-org.yml` uses `tibdex/github-app-token@v2` (third-party, tag ref, and inconsistent with the `actions/create-github-app-token` used everywhere else). Pin every third-party action. The `tibdex` one in particular should be replaced with the official `actions/create-github-app-token` for consistency and because `tibdex/github-app-token` is community-maintained.

### 4.2 Functional / correctness bugs

1. **The minimal YAML parser in `accept.mjs:60–114` cannot parse the `template:` block** in a real assignment file. It reads `template:` as a key with empty value and treats *every subsequent indented key in the entire file* as a child of `template`. Try it on `control-repo-template/assignments/sample-assignment.yml`: you get `assignment.organization` = the indented value, `template.owner` and `template.repository` correct only because they happen to come first. The flat-only assumption is silently wrong. The acceptance flow happens to not need the template fields (`process-queue.yml` synthesizes the template name as `template-${assignment_id}`), but `collect.mjs` and `report.mjs` use the same parser shape and they *do* read assignment fields. Use a real YAML lib (the `yaml` package is ~30 KB, no native deps). Or commit to JSON.

2. **`finalize-deadline.yml` never calls `preserve/`.** The full deadline finalization path in production runs `collect → lockdown → report`. Submission preservation is wired only as a standalone action with no caller. So requirement v1-#11 (preserve a selected submission state outside student control) is effectively unimplemented in the v1 release. Easy fix: add a `preserve` step after `lockdown` in `finalize-deadline.yml` and parameterize source SHA from the lockdown snapshot.

3. **Two `acceptance-handler.yml` files** (P0 #5). `control-repo-template/workflows/acceptance-handler.yml` is dead code (GitHub Actions only reads `.github/workflows/`). The active one in `control-repo-template/.github/workflows/acceptance-handler.yml` calls `accept@main` (not SHA-pinned) and triggers `process-queue.yml` for actual provisioning. The dead one chains `accept → provision → record` synchronously and is the version that matches the architecture diagram. Pick one. Either keep the queue model (delete the synchronous one, update the diagram) or keep the synchronous model (delete `process-queue.yml`, delete the queue file). Both is a tripwire.

4. **`AdminView.publishAssignments()` calls the wrong workflow file** (P0 #4). `triggerWorkflow(token, props.org, config.controlRepo, 'publish.yml')` should be `'publish-assignment.yml'`. Single-character fix; one of the highest-leverage P0s.

5. **Lecturer overrides are recorded but never applied.** `report.mjs:142–145` reads `overrideByLogin`, but the per-student loop (`report.mjs:159–257`) never consults it. Extensions granted via the Admin UI silently do nothing. Apply overrides between line 191 (deadline calc) and line 199 (status classification): if `override.deadline_at` exists, recompute against that deadline. Document the override in the report output for auditability.

6. **`process-queue.yml` hardcodes `template-${assignment_id}`** (line 76) instead of reading the assignment's `template:` field. If a lecturer ever uses a template named anything else, the queue silently provisions from the wrong (or nonexistent) template. Same bug as the dead-acceptance-handler chain.

7. **`AssignmentView.acceptAssignment()` polls for `${assignmentId}-${user.login}`** (`AssignmentView.vue:406`), again hardcoding the repository name pattern. If `repository_name_pattern` is anything else, the SPA polls forever.

8. **`publish-assignment.yml` references a `publish.mjs` that does not exist** (line 56) and falls back to inline shell. Worse, the inline-shell heredoc-inside-heredoc (lines 103–148) interpolates `${{ '' }}` and `${{ vars.* }}` *inside* a single-quoted heredoc that was supposed to be literal. The intent is "write this workflow YAML verbatim to the broker repo," but the outer Actions YAML parser will substitute `${{ … }}` first, before the heredoc is shell-evaluated. The resulting broker workflow is mangled. The version in `acceptance/broker-workflow.yml` is correct; that's the file that should be copied into broker repos.

9. **`reconcile.mjs` requires `GITHUB_ORG`** (line 14), but the `registry/action.yml` action exposes `org` and forwards it as `GITHUB_ORG`. That's fine, but the workflow `reconcile-registry.yml:25–28` only passes `app-id`, `app-private-key`, `org`, and `assignment-id` — it doesn't set `data-dir`, so the reconciler reads its default (".") which is the workspace root after `checkout`. OK, that happens to be the control-repo root, so this works. Still: write it down. `data-dir: '.'` explicitly.

### 4.3 Reliability / concurrency

- **`process-queue.yml` git push has rebase loop without bounded conflict handling** (lines 130–141). `git pull --rebase` can fail on conflicting writes to the same `acceptances/<id>/<login>.json` file (two parallel matrix legs touching the same file is unlikely but possible because the matrix is keyed by `{assignment_id, github_login}` pairs and the same student can be in both lists). The retry loop doesn't detect a rebase conflict; it just retries the push, which will fail again forever, until the 15-attempt cap. Make the loop bail on rebase conflict and queue the record for manual repair instead of looping.
- **`acceptance-handler.yml` and `process-queue.yml` race.** The handler commits the acceptance and immediately triggers `process-queue` (line 79–88); meanwhile `process-queue` is already on a 5-minute cron. Both can run concurrently for the same `{assignment_id, github_login}` pair — once via the dispatch trigger, once via the cron. Concurrency group on `process-queue` (line 8–10) is `process-queue` (global), so only one runs at a time — but the matrix-leg job inside each run is not concurrency-guarded against the *next* run. Provisioning idempotency saves you (the API returns 422 on duplicate name and `provision.mjs` re-reads the existing repo), but the registry write happens twice and the JSON file may be overwritten with stale data. Add a per-`{assignment, login}` concurrency group inside `process-queue`'s matrix legs.
- **Rate-limit budgeting is good but unverified at burst.** `max-parallel: 2` in `process-queue.yml` is conservative. At 250 acceptances, each requiring ~3 API calls (create + grant + verify), that's ~750 writes. Process-queue limits batches to 40 every 5 minutes, ~7 cron ticks at 480 writes/h — under the 500/h secondary limit, but right at the edge. Validate the assumption.

### 4.4 Style / maintainability

- **No `package.json` at the repo root** — but `process-queue.yml`, `acceptance-handler.yml`, and others run `node -e "…"` snippets, and `acceptance-handler.yml`'s `node -e` uses `require('fs')` with single-quoted JSON inside a heredoc inside YAML inside a workflow. Three layers of quoting is asking for it. Extract these into committed scripts under, e.g., `scripts/`, and call them with `node scripts/foo.mjs`.
- **`reconcile.mjs` is the only action source file with inconsistent style** — 4-space indent instead of 2, snake_case variables (`assignmentId` becomes `cfg.assignmentId`, then `assignment` in the for-loop), and a placeholder TODO comment for the per-student access-state machine that's never been finished. Bring it in line with the others or rewrite.
- **Three independent `gh()` helpers** in `provision.mjs`, `collect.mjs`, `lockdown.mjs`, `preserve.mjs`, `notify.mjs`, `reconcile.mjs` — all subtly different (some have 4 retries, one has 3, one ignores `retry-after`, one always retries on 429). Extract into a shared module that all the action scripts import.
- **`provisioning/provision.mjs:73` user-agent string varies per script** (`pxl-classroom-provision`, `-collect`, `-lockdown`, etc.). Fine, but make it derived from one constant so version bumps land in one place.
- **`accept.mjs:65–114` reinvents YAML parsing in a 50-line function with three explicit "for our use case" comments.** Don't. The cost of `import { parse } from "yaml"` is one dependency and one bundled-action build step. Worth it.
- **`report.mjs` does not apply roster data** (line 107–112 comment: *"roster.yml has students as an array — our minimal parser won't handle arrays, so we'll build the roster from acceptance records instead for v1"*). Translation: students who accepted but were not on the roster appear in the report; students on the roster who didn't accept do not. That contradicts requirement v1-#7 ("view all students and provisioning states") for the "didn't accept" case.

### 4.5 `validate-config.yml` is a smoke alarm wired to a doorbell

The validation workflow's "schema validation" check is `node -e` doing `text.includes(k + ':')` per required field name. It will pass any YAML that mentions the word `template:` anywhere — including in a description string. It will not catch:

- Wrong YAML types (`max_acceptances: "fifty"`).
- Missing required nested keys (`template.repository`).
- Invalid timezone / ISO date formats.
- Invalid pattern in `repository_name_pattern` (the schema requires `{github_login}`).
- `state: pubilshed` (typo).

`schemas/assignment.schema.json` is a real, well-written JSON Schema. Use it. `ajv` + a YAML loader, four lines:

```js
import { parse } from "yaml";
import Ajv from "ajv";
const validate = new Ajv({ allErrors: true }).compile(JSON.parse(await readFile("schemas/assignment.schema.json", "utf8")));
const doc = parse(await readFile(file, "utf8"));
if (!validate(doc)) throw new Error(JSON.stringify(validate.errors, null, 2));
```

This was almost certainly the intent. Carrying the schemas but not validating against them is worse than not having them.

### 4.6 Minor

- `acceptance/accept.mjs:202` writes `star_event_ref: workflowRunUrl || null`. Good. `accept.mjs:177` reads `acceptDir` files via `readdirSync` *inside* a `for` loop without `await`; works because `existsSync` and `readdirSync` are synchronous, but the dynamic `import("node:fs")` on line 177 is creative — the module is already imported statically. Clean it up.
- `notify.mjs:27–33` uses pretty emojis in the issue title and body — fine, but `EMOJI_MAP` only covers seven event types out of the eight named in `notify/action.yml`. `deadline-gap` is missing from the map. Falls through to `ℹ️`. Cosmetic, but the map is the canonical list — keep it in sync.
- `preserve.mjs:148–169` does a full `git clone` for every preserve call. For an org with hundreds of students × tens of assignments, that's expensive. Shallow clone (`--depth=1`) or fetch-by-SHA (`git fetch origin <sha>:refs/preserved/<...>`) into a bare repo would be tens of times faster. Not v1-blocking.
- `pages/scan.mjs` privacy regexes are good but the `email-address` regex will flag the org's contact email if it ever appears in a public assignment description. Allowlist common project-owned addresses, or relax to `student_id` / `display_name` only — those are the actual privacy categories.

---

## 5. Compared to GitHub Classroom

PXL is explicitly replacing GitHub Classroom for the courses where Classroom's limitations bite. Here's the honest comparison.

### Where PXL Classroom is straight-up better

| Concern | GitHub Classroom | PXL Classroom |
|---|---|---|
| **Roster privacy** | Classroom requires you to import a roster of student IDs into a SaaS hosted by GitHub. For EU public universities this is a recurring compliance discussion. | Roster lives only in the org's own private control repo. Pages output is privacy-scanned. |
| **Auditability** | Classroom UI logs; mostly opaque. | Every state change is a Git commit in the control repo with workflow run URL, actor, IDs, times. |
| **Recovery** | Rebuilding a deleted assignment is a UI walk-through. | Everything is YAML/JSON in Git — recover from `git log`. |
| **Deadline lock-down + preservation** | Classroom does neither — students can rewrite history after the deadline. | Lock-down demotes student to read (App outranks repo admin) + preservation archives the candidate SHA. (Preserve is wired but not yet called from finalize — see §4.2.) |
| **Multi-org / multi-faculty** | Classroom is per-org; cross-org dashboards don't exist. | Designed as a single public dashboard reading runtime-fetched data from any control repo the lecturer's token can see. |
| **Admin access for students** | Classroom grants `write` only — no Actions secrets, no environments, no self-hosted runners. This was the original reason for building PXL. | Grants `admin`. (Trade-off explicitly accepted in the trust model — see §*Student repository permissions*.) |
| **Burst handling at class scale** | Classroom has secondary rate-limit cliffs that bite at exactly 250 students. | Queued provisioning with throttled fan-out (40 / 5 min, `max-parallel: 2`). |
| **No external dependency** | Requires GitHub Classroom (SaaS, subject to API change, has had multi-week outages). | Zero external dependency. (Modulo corsproxy.io — fix that.) |

### Where PXL Classroom is behind GitHub Classroom today

| Concern | GitHub Classroom | PXL Classroom |
|---|---|---|
| **Autograding** | Built-in; runs instructor tests against submissions and shows pass/fail per student. | Out of scope (`REQUIREMENTS.md` §*Non-goals*). For PE-style courses this is fine; for any course relying on Classroom's autograder, this is a deal-breaker. |
| **LMS / grade export** | Has an LMS connector and a usable grade-export. | Out of scope. CSV export is one row per student — enough to import into Excel, not to push to an LMS. |
| **Group assignments** | Supported. | Deferred to v2. |
| **Roster-to-identity binding** | Requires institutional ID on import; students can be pre-bound. | Open acceptance in v1: a stranger within the open window and under the cap gets a repo until manually reconciled. MS365 verification is roadmap. |
| **Student onboarding friction** | One click after login. | Device-flow code-and-paste. Slightly slower, more phishable (see security). |
| **Lecturer admin UI maturity** | Years of polish — bulk edit, copy assignment, autograding wizards, students list export. | A three-form page that triggers workflows. Functional, not lovely. |
| **Discoverability for students** | Classroom URL leads to an organization page listing all the student's assignments. | One assignment per URL; no listing. If a student loses the link, they're stuck. |
| **"Why is my repo missing?" recovery** | Classroom shows the student a re-accept button. | The SPA polls indefinitely; no clear "this didn't work, click here" branch. |
| **Plagiarism / similarity** | Roadmap (and integrations). | Out of scope. |

### Net

For PXL Automation's specific use case (advanced GitHub Actions exercises, student admin needed, EU privacy posture, ~250 students/burst, instructor-controlled evidence), PXL Classroom is clearly the right system *if the P0s are fixed*. For a CS-101 course running autograded labs against a thousand students with no need for admin rights, GitHub Classroom is still the easier choice. The product positioning in the README is correct — PXL Classroom is a replacement for *the subset of Classroom that PXL uses*, not a general competitor.

---

## 6. Prioritized recommendations

### P0 — fix before any production cohort

1. **Remove corsproxy.io from the auth flow.** Call GitHub's device-flow endpoints directly from the SPA; if CORS bites in your environment, stand up a tiny self-hosted worker. (`frontend/src/lib/auth.js`).
2. **Drop `secrets: write` from the App manifest and rework the Setup-Org flow** to not require it. (`SetupView.vue`, `.github/workflows/setup-org.yml`).
3. **Ship a Pages SPA `404.html` shim** or switch the router to hash mode. (`frontend/public/404.html` + `frontend/index.html`, or `router/index.js`).
4. **Wire `preserve/` into `finalize-deadline.yml`** so v1 acceptance criterion #11 is actually satisfied.
5. **Fix the workflow filename in the Admin "Publish" button** (`publish.yml` → `publish-assignment.yml`).
6. **Delete or rewrite one of the two `acceptance-handler.yml` files** and update the architecture diagram to match the surviving one.
7. **Apply lecturer overrides in `report.mjs`** — extensions are currently silent.
8. **Read `template:` from the assignment definition** in `process-queue.yml` (and in the dead `acceptance-handler.yml` chain if it survives).

### P1 — fix before second pilot org

1. Replace the minimal YAML parsers with the `yaml` package; commit to one parser shared across the action scripts.
2. Replace the `text.includes(':')` validator in `validate-config.yml` with `ajv` against `schemas/assignment.schema.json`.
3. Extract `gh()` into a shared helper used by every action script; consistent retry/back-off, consistent User-Agent.
4. Wire `notify/notify.mjs` into the workflows that should actually use it (provisioning failures, collection failures, deadline gaps, late activity, preservation failures, missing access).
5. Read `repository_name_pattern` from the assignment in the SPA, not the hardcoded `${assignmentId}-${login}`.
6. Drop the fake-assignment fallback in `AssignmentView.loadAssignment` and treat missing as missing.
7. Pin every third-party action in `.github/workflows/deploy-frontend.yml` and `setup-org.yml` to a full commit SHA. Replace `tibdex/github-app-token@v2` with `actions/create-github-app-token`.
8. Add a per-`{assignment, login}` concurrency group inside `process-queue.yml`'s matrix legs.
9. Switch the dashboard's `getRepoContent` call to use the raw `download_url` so the >1 MB Contents-API ceiling doesn't silently truncate the dashboard once the org grows.
10. Delete or wire in `frontend/src/components/StudentTable.vue` and `components/AssignmentCard.vue` — orphaned today.
11. Centralize date formatting and toast/error UI.
12. Add the assignment listing on `/` so students who lost the link can recover.
13. Lift WCAG-AA contrast for `--text-muted` on the dark background.

### P2 — quality of life

1. Add even one unit-test file per action script. The complete absence of tests in a "fully released" v1 is a tooling smell.
2. Build the separate Dispatcher App so the public broker workflow is never a privilege-escalation surface.
3. Shallow-clone or fetch-by-SHA in `preserve.mjs`.
4. Stop polling forever in the SPA; cap the poll loop at, say, 5 minutes and offer a "still waiting — refresh manually" branch.
5. Surface the *App name* on the device-code screen and a one-line phishing warning.
6. Delete `AGENTS.md` and `GEMINI.md` or fill them in.
7. Move the `node -e "…"` snippets out of YAML into committed scripts.
8. Add an Admin-UI YAML preview before commit.
9. Add a `--dry-run` smoke harness that walks accept → provision → collect → finalize against a single test account, as a CI job.
10. Update `PROGRESS.md` to reflect the actual state ("v1 release candidate; see REVIEW.md for blockers"). Promise less, ship more.

---

## 7. What's *good* and worth keeping

It would be unfair to land 4,500 words on what's wrong without naming what's right. These are the things I'd protect if I were the next maintainer:

- The spike methodology (`SPIKES_PLAN.md` + the recorded results in each spike folder). Don't lose this discipline when the next requirement lands.
- `provisioning/provision.mjs` and its action.yml. Tight input validation, idempotency by ID, clean retry with `retry-after` honored, Actions output discipline, summary table, dry-run support. Use it as the template for any new action.
- The trust-model framing in `REQUIREMENTS.md`. The honesty about lock-down being a deterrent (not a tamper-proof control) and the explicit acceptance of the "stranger within window + cap" residual risk is exactly the level of rigor a research-IT system needs.
- The privacy-scanner gate in `pages/scan.mjs`. The list of regexes (token prefixes, JWT, PEM-key headers, institutional ID field names) is accurate and the failure mode is "block publish," which is the only correct default.
- `AssignmentView.vue`'s state machine (`ready / pending / provisioned / invited / error`) and the polling loop's exponential slow-down. This is good UI code under the hood.
- `IMPLEMENTATION_PLAN.md` §7 on the broker → dispatch → control hop. The plan is correct; the implementation just has the loose ends called out above.

This system is one solid week of bug-fixing away from being a real v1 — not because the design is wrong, but because the last 10% wasn't finished and got marked done anyway. Fix the eight P0s, ship the P1s the week after, and you have something genuinely better than what it's replacing.

---

## Appendix — sources consulted

External references used to validate the review:

- [Webhook events and payloads — GitHub Docs](https://docs.github.com/en/webhooks/webhook-events-and-payloads) — for `watch` / `repository_dispatch` payload shapes.
- [Events that trigger workflows — GitHub Docs](https://docs.github.com/en/actions/using-workflows/events-that-trigger-workflows) — for `watch:started` semantics.
- [Rate limits for the REST API — GitHub Docs](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api) — for the 900 points/min and 100-concurrent-request secondary limits.
- [Registering a GitHub App from a manifest — GitHub Docs](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest) — for the SetupView manifest flow.
- ["What are CORS proxies, and when are they safe?" — HTTP Toolkit](https://httptoolkit.com/blog/cors-proxies/) and [CORSPROXY's own warning](https://corsproxy.io/blog/cors-mistakes/) — *"never forward credentials, cookies, or private tokens through a public CORS proxy."*
- [Analyzing the rise in device code phishing attacks in 2026 — Push Security](https://pushsecurity.com/blog/device-code-phishing) — for the current threat model around device-code phishing of GitHub OAuth tokens.
- [Praetorian — Introducing: GitHub Device Code Phishing](https://www.praetorian.com/blog/introducing-github-device-code-phishing/) — same.
- [GitHub Pages does not support routing for single page apps — GitHub Community Discussion #64096](https://github.com/orgs/community/discussions/64096) — for the SPA-404 problem and the standard shim.
- [Top GitHub Classroom Alternatives in 2026 — Slashdot](https://slashdot.org/software/p/GitHub-Classroom/alternatives) — competitive landscape sanity check.
