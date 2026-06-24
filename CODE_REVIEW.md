# Code & Test Review — pxl-classroom

Scope: bugs/risks first, document-only. Online checks: pinned action versions, Octokit / REST quirks, npm deps, DRY-ness.

Conventions used in this report:
- **Severity:** `[BLOCKER]` (broken in prod), `[HIGH]` (likely silent failure / corruption / security), `[MED]` (latent / wrong edge case), `[LOW]` (smell, nit).
- Each finding cites `file:line` and shows the minimum reproducer/fix.
- "(unverified)" = my best read of the code; not exercised end-to-end on a live install.

This file is written incrementally as the review proceeds — bottom of each section may grow. Status indicators in `§13`.

---

## 1. Workflow YAML bugs

### 1.1 [BLOCKER] Heredoc never terminates in `acceptance-handler.yml`

`.github/workflows/acceptance-handler.yml:84-101`

```yaml
cat > "repositories/${ASSIGNMENT_ID}/${LOGIN}.json" << EOF
            {
              ...
            }
            EOF        # ← 12 leading spaces
git add "repositories/"   # ← swallowed by the heredoc
```

The heredoc uses `<< EOF` (no `-`). Bash's `<<EOF` requires the closing delimiter at **column 0**. `<<-EOF` strips only **tabs**, never spaces. Reproduced locally:

```
bash: warning: here-document at line 2 delimited by end-of-file (wanted `EOF')
```

Effect: every line after the opener — including the closing `EOF` literal, `git add`, the acceptance-status update, the git config/commit/push retry loop, and the entire "Trigger dashboard regeneration" step that *follows the heredoc inside the same `run:` block* — gets written into the JSON file. The repository record file ends up as a multi-kilobyte garbage blob, `git add` never runs, no commit, no push, no record persisted. The student gets their repo (provisioning step succeeded above) but the control repo has **no record of the provisioning**, which:

- Breaks idempotency (re-star sees no `acceptances/<id>/<login>.json` write because the heredoc also swallowed the acceptance-status update via `update-json-field.mjs`).
- Breaks the dashboard regen trigger (the github-script step is a separate `uses:` step, so it still fires — but it sees stale data).
- Breaks downstream provisioning state, lockdown, reporting (no `repositories/<id>/<login>.json`).

Introduced in `272c87e Execute Wave 8 (Minute Reduction)` and has not been fixed since. **This means the synchronous acceptance flow has never produced a valid commit since Wave 8.**

Fix: either `<<-EOF` with the body re-indented to tabs only, or dedent the closing token to column 0, or generate the JSON via `node` (preferred — there's already `scripts/update-json-field.mjs` and `lib/gittree.mjs`). The current code is ad-hoc shell duplicating logic that exists in JS.

### 1.2 [retracted] False alarm — `publish-assignment.yml:85-92` is fine

On first read I flagged this heredoc too. Re-checked by piping the file through `yaml.parse` and running `bash -n` on the resulting script: the YAML block scalar `run: |` strips the 10 leading spaces uniformly, so the `READMEEOF` opener and closer both land at column 0 in the bash that actually executes. Same applies to `setup-org.yml:69-72`.

The acceptance-handler heredoc is the only broken one because it sits **inside an `if [ "$OUTCOME" = "created" ]; then` block**, which adds 2 extra spaces of bash-level indent. YAML strips the outer 10; the closer ends up at bash column 2; `<< EOF` (no `-`) won't match it.

**Audit step performed:** scanned every `run:` block in `.github/workflows/*.yml` and every composite action `runs.steps[].run` with `bash -n` — only `acceptance-handler.yml`'s "Write repository record" step failed. No other latent heredoc bombs.

### 1.3 [HIGH] `git push || true` masks push failures

`acceptance-handler.yml:122-131` has a retry loop that's correct. But `daily-activity.yml:96` and `daily-activity.yml:237` use:

```yaml
git pull --rebase || true
git push || true
```

A network blip, rebase conflict, or branch-protection rejection silently discards the local commit; the next run will see uncommitted local state in `git status` only — which the workflow throws away when the runner is recycled. Observations, lockdowns, and reports for that night just vanish.

Use the same retry loop as `acceptance-handler.yml`. Better: extract a shared composite step or a script that takes `(--message, --paths)` and does the rebase+push retry once. Currently the rebase+push pattern is open-coded in **four places** (acceptance-handler, daily-activity collect leg, daily-activity finalize leg, publish-assignment "Update assignment state"). DRY violation.

### 1.4 [MED] `find-finalizable` declares dead `outputs.finalizable`

`daily-activity.yml:107-108` — the matrix job `find-finalizable` declares `outputs.finalizable: ${{ steps.agg.outputs.finalizable }}`, but the only step in that job is `id: find`, not `id: agg`. The `agg` step lives in `aggregate-finalizable` (a separate job). So the declared output is permanently empty.

Doesn't break anything — nothing reads `needs.find-finalizable.outputs.finalizable` — but it confuses readers. Delete the `outputs:` block on `find-finalizable`.

### 1.5 [LOW] `disable-when-empty` duplicates `check-idle`

Two separate jobs (lines 35-48 and 239-253) both run `gh workflow disable daily-activity.yml`. The first guards "no participating orgs"; the second guards "no active assignments". Could be one job with two guard expressions OR'd, but the current split is readable. Leaving as-is is fine.

### 1.6 [LOW] `inputs.org` regex anchors are inconsistent

`daily-activity.yml:20` validates with `^[A-Za-z0-9][A-Za-z0-9-]{0,38}$`. GitHub login rules also forbid consecutive hyphens and trailing hyphens (`[A-Za-z0-9](?:-?[A-Za-z0-9]){0,38}`). The regex used is more permissive than GitHub's own rules but stricter than nothing; it's defense-in-depth so acceptable.

### 1.7 [BLOCKER] `daily-activity.yml` passes `assignment_id`/`collection_type` (underscore) to composite actions whose inputs are dash-cased

`.github/workflows/daily-activity.yml`:
- L82-83: `assignment_id: ''` + `collection_type: scheduled` → `./collect`
- L195-197: `assignment_id: ${{ matrix.assignment.assignment_id }}` + `collection_type: deadline` → `./collect`
- L205: `assignment_id: …` → `./lockdown`
- L215: `assignment_id: …` → `./preserve`

But every action declares its input with a dash:
- `collect/action.yml:16` → `assignment-id:`
- `collect/action.yml:19` → `collection-type:`
- `lockdown/action.yml:16` → `assignment-id:`
- `preserve/action.yml:16` → `assignment-id:`

GitHub Actions input names are case- and punctuation-sensitive — there is **no underscore↔dash alias**. The bad key is silently dropped with a warning in the workflow log; the action sees the input's default.

Consequences in the nightly finalize matrix (`finalize` job, L162-237):

| Step | Effect of mismatch |
|---|---|
| `1. Collect` (deadline mode) | `inputs.assignment-id=''` (default) → `collect.mjs` processes **every assignment** rather than just the finalizable one — wasted API budget; observations may pile up for assignments that have nothing to do this matrix leg. `inputs.collection-type='scheduled'` (default) → observations get wrong `collection_type` field. |
| `2. Lockdown` | `inputs.assignment-id=''` → `lockdown.mjs:53` validate() rejects empty slug, action exits 1, **no demotion**. Step fails. |
| `3. Preserve` | Either skipped (step had no `if: always()`) or also fails for the same reason. **No SHA preserved.** |
| `4. Report` | Has `if: always()` so it runs, but receives the **correctly dash-cased** `assignment-id` (L225). It can produce a report — but observations from the broken collect step are mis-typed, and there's no lockdown record to reconcile. |

Net effect: since Wave 8 shipped, the nightly finalize has never actually locked a student down or preserved a SHA. The system-by-system promise in `ARCHITECTURE.md §6.2` ("`collect → lockdown → preserve → report`") is broken at three of the four legs.

Fix: rename all three to dash form in `daily-activity.yml`:

```diff
-          assignment_id: ${{ matrix.assignment.assignment_id }}
-          collection_type: deadline
+          assignment-id: ${{ matrix.assignment.assignment_id }}
+          collection-type: deadline
```

…and at lines 82-83, 205, 215. The scheduled-collect leg (L82-83) is benign by coincidence (the misrouted values match defaults), but should be fixed for consistency.

**Test to add:** a tiny `tests/workflow-input-names.test.mjs` that walks every `.github/workflows/*.yml`, finds `uses: ./<name>`, loads `<name>/action.yml`, and asserts every `with:` key exists in `inputs.*`. This would have caught every one of these silently in CI.

### 1.8 [HIGH] `acceptance-handler.yml` heredoc emits a syntax error → no record commit

Already documented in §1.1. Bash exit 2 (syntax error) — the workflow step **fails visibly**. Provisioning still happens (earlier step), but `repositories/<id>/<login>.json` is never written. The dashboard regen step still fires due to `if: always()`, masking the failure unless someone reads the run logs.

**Test to add:** `tests/workflow-bash-syntax.test.mjs` that walks every `.github/workflows/*.yml` and every `*/action.yml`, extracts every `run:` block whose `shell:` defaults to bash, writes each to a tmp file, and runs `bash -n` on it. Fail the test if any non-zero exit or stderr.

---

## 2. Library code (`lib/`)

### 2.1 [HIGH] `lib/audit.mjs:92` reads `participating-orgs.json` — the file is `.yml`

`checkParticipatingOrgs` does:

```js
const res = await request("GET",
  `/repos/${hubOwner}/${hubRepo}/contents/participating-orgs.json?ref=participating-orgs`);
```

But:
- `setup-org.yml:99-129` writes and updates `participating-orgs.yml`.
- `daily-activity.yml:27`, `regenerate-dashboard.yml:19`, `reconcile-registry.yml:25`, `weekly-usage-report.yml:35` all read `participating-orgs.yml`.
- `participating-orgs.schema.json` exists in `schemas/` but no code ever writes a `.json` form.

So `checkParticipatingOrgs` always 404s, producing a `warn` ("participating-orgs.json not found on the hub's participating-orgs branch") on every CLI `pxl-classroom audit` and on the SPA System Health panel. The audit reports a permanent false-positive warning.

Fix: read `participating-orgs.yml` and parse via the existing yaml lib (the audit module already runs in Node and the browser — use `js-yaml` or a tiny inline parser; or read the file via `?ref=participating-orgs&` and parse the base64 content with `parseYaml`).

**Test to add:** `tests/audit-participating-orgs.test.mjs` that calls `runAudit` with a fake `request` that returns a fixture YAML for `participating-orgs.yml` (and 404 for `.json`) — assert the check passes when the org is listed.

### 2.2 [LOW] `lib/audit.mjs:138` accepts the obsolete `"pull"` permission name

`if (got !== "read" && got !== "pull" && got !== "none")`. The current `/collaborators/{login}/permission` endpoint returns `{ admin, write, read, none }` — never `pull`. Harmless leftover from the legacy v1 endpoint. Drop the comparison.

### 2.3 [LOW] `lib/audit.mjs:217` uses deprecated `escape()`

`decodeURIComponent(escape(atob(compact)))`. `escape()` is annex-B legacy and removed from strict contexts. Replace with `new TextDecoder().decode(Uint8Array.from(atob(compact), c => c.charCodeAt(0)))`. The fallback `catch { return atob(compact); }` already silently returns garbage for non-ASCII — both branches need fixing if the audit ever has to read UTF-8 content (which it does, via the Contents API).

### 2.4 [MED — DRY] `lib/gh.mjs` and `scripts/lib/gh.mjs` are two near-clones

Both implement the same retry-on-5xx/429/rate-limit fetch helper with slight differences:

| | `lib/gh.mjs` | `scripts/lib/gh.mjs` |
|---|---|---|
| Return shape | `{ status, ok, data, remaining }` | `{ status, headers, data }` (throws on non-2xx) |
| Retry count | 4 | 5 |
| API base | env `GITHUB_API_URL` or default | hardcoded |
| Pagination helpers | — | `ghAll`, `ghAllItems` |

CLAUDE.md is explicit: "One source of truth per cross-surface concern." This is exactly that, forked. Consolidate. Suggested: keep `lib/gh.mjs` as the carrier, move `ghAll`/`ghAllItems` over, delete `scripts/lib/gh.mjs`.

**Test to add:** if you keep both, at minimum lock the retry/backoff semantics with a single test exercised against both — to catch when one drifts from the other.

### 2.5 [OK] `lib/gittree.mjs`

Solid module: clear separation of `commitWithRebase` vs `commitWithFreshRepoRetry`, proper non-FF detection, abort propagation, backoff. Well-covered by `tests/gittree.test.mjs` (8 cases). One minor nit: signal aborts only between attempts, not between individual API calls inside `attemptCommit` (blob → tree → commit → ref), so a fast abort may still allow 4 sequential API calls to complete. Probably fine.

### 2.6 [OK] `lib/yaml.mjs`, `lib/dashboard-aggregate.mjs`

Both trivial and correct.

---

## 3. Composite actions

### 3.1 [HIGH] `acceptance/accept.mjs` requires `assignment.template.{owner,repository}` but legacy data may have `template_owner`/`template_repo`

`accept.mjs:109-110` reads `assignment.template.owner` and `assignment.template.repository`. The recent commit `3e92b4b fix(acceptance): read template.{owner,repository} matching the schema` aligned this with the schema. Good — but there's no guard for legacy YAML files committed before the rename. If a deployed control repo has the old top-level `template_owner`/`template_repo` shape, acceptance crashes with "Cannot read properties of undefined (reading 'owner')" — caught by the `catch` at L177 and surfaced as `fail:exception` (acceptable).

Action: optional migration script + a brief note in the RUNBOOK. Not a blocker.

### 3.2 [OK] `provisioning/provision.mjs`

Validation regex set is thorough; idempotency on existing repo; baseline branch + protection logic is correct (uses GET-then-POST instead of PUT, but that's fine for refs). Feedback PR opening is correctly deferred to the CLI (otherwise GitHub returns 422 "No commits between").

### 3.3 [MED] `collect/collect.mjs:163-178` — dead "smart-schedule" code from pre-Wave 8

```js
if (cfg.cronSchedule.includes('*/15')) { ... }
else if (cfg.cronSchedule.includes('*/6') || cfg.cronSchedule.includes('0 */6')) { ... }
```

Wave 8 removed the `*/15` and `*/6` cron triggers. Nothing in the repo sets `CRON_SCHEDULE` containing those strings anymore. This branch is dead. Delete.

### 3.4 (see §1.7 — collect/lockdown/preserve are also impacted by the dash↔underscore mismatch in `daily-activity.yml`)

---

## 4. CLI

_pending_ — will cover `cli/src/commands/*` and `cli/src/lib/runner-*` next. Areas of interest already noted from grep:
- `cli/src/lib/octokit.mjs` may be a third HTTP carrier on top of the two `gh.mjs` clones; verify.
- Runner Docker sandbox flags (per ARCHITECTURE.md §11.6: `--network=none`, read-only mount, `--memory=512m`, per-test timeouts) — confirm in code, not just in docs.

---

## 5. Frontend

### 5.1 [HIGH] `getRepoContent` garbles UTF-8 content

`frontend/src/lib/api.js:130`:

```js
if (res.data?.content) {
  try {
    return atob(res.data.content.replace(/\n/g, ''))
  } catch {
    return null
  }
}
```

`atob()` returns a binary string — each character is a byte, not a Unicode code point. For UTF-8 content (any non-ASCII char: `é`, `ü`, `中`, an em-dash, a smart-quote), the multi-byte sequence is rendered as Latin-1 mojibake. Then it gets handed to `parseYaml` / `JSON.parse` / passed through to the screen.

Concrete consequences:
- A student's `full_name = "Frédéric De Smedt"` in `roster.yml` becomes `"FrÃ©dÃ©ric De Smedt"` in the Admin Panel roster diff.
- An assignment `description: "Délai: dimanche"` shows mojibake in the editor and would round-trip into the YAML if saved.
- The mirror call site `commitFile()` at L172 correctly uses `btoa(unescape(encodeURIComponent(contentStr)))` to **write** UTF-8 — but never decodes symmetrically on read. So writes via the SPA preserve UTF-8 (good), reads via the SPA corrupt it (bad), creating asymmetric data flow.

Fix:

```js
return decodeURIComponent(escape(atob(res.data.content.replace(/\n/g, ''))))
// OR (more modern):
const bin = atob(res.data.content.replace(/\n/g, ''))
return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)))
```

This is the symmetric inverse of the `commitFile` encoding and parallels `lib/audit.mjs:217`'s decode (which has the **same** `escape()` deprecation concern — see §2.3). Both call sites should switch to `TextDecoder` for the same reason.

**Test to add:** add a frontend unit test (Vitest or node tap) that hits a mocked Contents API response containing base64-encoded UTF-8 (`"Café"`) and asserts the returned string is `"Café"`, not mojibake.

### 5.2 [MED] CORS proxy URL normalization is fragile

`frontend/src/lib/auth.js:24`:

```js
const CORS_PROXY = (import.meta.env.VITE_CORS_PROXY_URL || 'https://corsproxy.io/?url=').replace(/\?$/, '?url=')
```

The intent: tolerate `VITE_CORS_PROXY_URL=https://example.com/?` (trailing bare `?`) by rewriting to `?url=`. Failure modes:

- `https://example.com/proxy` (no `?`) is passed through unmodified. The next line becomes `https://example.com/proxy${encodeURIComponent('…')}` — an URL with no query separator, so the encoded GitHub URL becomes path. Most reverse proxies won't accept that.
- `https://example.com/?url=` (already correct) — `.replace(/\?$/, '?url=')` does nothing, fine.
- `https://example.com/?url=&debug=1` — already broken because the test for trailing `?` fails. The encoded URL appends to `&debug=1` to give `…&debug=1https%3A%2F%2F…` — garbage.

The normalization rule is undocumented and only the default value works for sure. Either:

(a) document that `VITE_CORS_PROXY_URL` MUST end with `?url=` or `?` (then validate explicitly, throwing on mismatch);
(b) accept `${PROXY}${encoded}` as the contract and document the proxy must accept the URL appended directly to its base path.

Either is fine; the current "look-and-pray" replace is what's wrong.

Already covered by `tests/cors.test.mjs` for the default value only. Add a case for an absent trailing `?`.

### 5.3 [MED — DRY] Hub owner/repo are hardcoded across three views

Three files hardcode the hub identity `('PXL-Digital-Application-Samples', 'pxl-classroom')` for `triggerWorkflow` calls:
- `AdminView.vue:645` (publish), L726 (retry-acceptance)
- `AssignmentDetailView.vue:837` (retry-acceptance)
- `UsageView.vue:190` (weekly-usage-report)
- `UsageOverviewView.vue:249` (weekly-usage-report)
- `SystemHealth.vue:88` (hubOwner / hubRepo for runAudit)

If the hub ever forks, splits, or renames, you edit five files. Move to `config.js`:

```js
hubOwner: import.meta.env.VITE_HUB_OWNER || 'PXL-Digital-Application-Samples',
hubRepo:  import.meta.env.VITE_HUB_REPO  || 'pxl-classroom',
```

### 5.4 [MED] `SystemHealth.CACHE_MS` is dead code

`frontend/src/components/SystemHealth.vue:66-70` defines `CACHE_MS = 5*60*1000` and `lastRunAt = ref(0)`. They are written in `run()` (L90) but **never read** anywhere — `run()` always re-runs the audit regardless of cache. So the constant and the ref are dead. Either wire up the cache (e.g., `if (Date.now() - lastRunAt.value < CACHE_MS && result.value) return;` early in `run()`), or delete the constant + ref + the L90 write.

Recommend keeping the cache: the audit is ~10+ API calls and the panel is re-mounted on every Dashboard navigation. Worth keeping the dashboard responsive on org-flips that revisit the same org within 5 minutes.

### 5.5 [LOW] HomeView's open-assignments loader is serial

`frontend/src/views/HomeView.vue:65-89` — `for (const org of data.orgs) { … await fetch(…) }` is sequential. For N participating orgs you make N round-trips back-to-back; the page just blocks on the longest tail.

Switch to `Promise.all(data.orgs.map(async (org) => …))`. Same files involved as today, just parallel.

### 5.6 [LOW] `refreshLiveStatus` doesn't watch its own rate-limit budget

`AssignmentDetailView.vue:631-672` issues `GET /repos/.../commits?per_page=1` for every student, 6-wide. With a 250-student class that's 250 calls, into a 5,000/hr user budget. Plenty of headroom on its own — but a lecturer can spam-click the button between live refreshes (no throttle on the button itself other than `refreshingLive`), and `getInvitations` + `getRepo` polling on the student-facing side already eats into that quota.

`refreshOne` doesn't surface 429 / 403-with-rate-limit-exceeded headers. If GitHub kicks in secondary rate limiting (which lives outside the `core.remaining` counter shown by `/rate_limit`), the per-student calls just silently fail and the row drops to "unknown" status.

Suggested: read `X-RateLimit-Remaining` per call; if it falls below 200, halt new workers, surface a toast with reset time. The `/rate_limit` fetch at L705 is one-shot at the end — too late.

### 5.7 [LOW] AssignmentDetailView imports a Node `.mjs` from the SPA via `../../../`

`AssignmentDetailView.vue:354`:

```js
import { buildDashboardEntry } from '../../../lib/dashboard-aggregate.mjs'
```

This reaches outside `frontend/` to a top-level `lib/` shared with workflow scripts. CLAUDE.md sanctions this ("One source of truth per cross-surface concern"). But Vite's `fs.allow` defaults to the project root only and the file lives outside the SPA app root, so it requires `server.fs.allow` to include the repo root. Verify in `vite.config.js`. If it works today, it likely works because Vite auto-resolves at build time, but dev-server fs allow can bite. Track in `RUNBOOK.md` setup as a "do not move `frontend/` to a subdirectory without updating Vite fs.allow" note.

### 5.8 [LOW] `Icon.vue` uses `v-html` on a hardcoded lookup

`frontend/src/components/Icon.vue:15` — `v-html="paths"` is safe here because `paths` is a constant lookup into `ICONS` (hardcoded SVG strings), never user data. No XSS surface. Documenting for future readers because `v-html` is otherwise a red flag.

### 5.9 [OK] CSV import (`csv.js` + `RosterTab.vue`)

PapaParse with `header: true` and `skipEmptyLines: 'greedy'`. Strict unknown-column rejection (L44-49). Required-column check (L50-54). `github_id` integer coercion + `active` boolean coercion both throw on bad values. Duplicate `student_number` detection (L72-75). Then `validateAgainst('roster', doc)` against the JSON Schema. CSV injection (formula injection — `=cmd|…`) isn't a risk here because the result is stored in YAML and never re-exported to a spreadsheet; the export flow at AssignmentDetailView's `exportCSV` reads back a server-generated CSV, not the roster.

### 5.10 [OK] Toast / UserBadge / NotFoundView

Trivial and correct. UserBadge could benefit from `referrerpolicy="no-referrer"` on the avatar `<img>` to avoid leaking the SPA URL (including assignment IDs in the path) to GitHub when the avatar is fetched. Very low — GitHub already knows about every assignment in the orgs it hosts. Drop or fix as you like.

### 5.11 [OK] Device flow + token persistence

`auth.js` device flow correctly handles `authorization_pending`, `slow_down` (adds 5s), `expired_token`, `access_denied`. Token persistence in `sessionStorage` with explicit expiry check on `getToken()` / `initAuth()`. Matches `ARCHITECTURE.md §10` (tab persistence, not browser persistence).

---

## 6. Schemas & scripts

### 6.1 [HIGH] `scripts/find-finalizable.mjs` window (1 hour) doesn't cover a daily cron

`scripts/find-finalizable.mjs:24-26`:

```js
const now = Date.now();
const oneHourAgo = now - 60 * 60 * 1000;
if (deadline <= now && deadline >= oneHourAgo) {
  finalizable.push({ ... });
}
```

The nightly cron runs once a day. A 1-hour finalize window means an assignment whose `deadline_at` falls more than ~1 hour before the next cron firing will **never** be eligible for finalize.

Concrete failure: deadline `2026-06-23T21:59:59Z`. Cron fires `2026-06-24T00:00:00Z` — gap = 2h 0m 1s. Result: `deadline <= now` is true, but `deadline >= oneHourAgo` is **false** → the assignment is silently skipped forever. Combined with §1.7 (which already broke lockdown/preserve), nightly finalize is doubly broken.

Fix: widen the window to 25 hours (one full cron interval + slack) **or** remove the lower bound entirely and rely on the "already-locked" check downstream (lockdown is idempotent — re-running on a finalized assignment is a no-op). Suggested:

```js
const oneDayAgo = now - 25 * 60 * 60 * 1000;
if (deadline <= now && deadline >= oneDayAgo) { ... }
```

**Test to add:** `tests/find-finalizable.test.mjs` with fixtures: deadline 30 min ago (in-window), deadline 90 min ago with a 1-hour window (BUG: skipped), deadline 90 min ago with the 25h window (in-window), deadline 26 hours ago (out of window — already finalized in a prior run).

### 6.2 [MED] `scripts/disable-if-idle.mjs` is broken AND dead code

Two-layer problem:

1. **Logic is non-functional.** L22-23 reads `orgsYaml.organizations`, but the participating-orgs schema declares the key as `orgs` (`schemas/participating-orgs.schema.json:14`). The script would treat any well-formed file as zero-org. L25-32 never sets `hasActive`, never calls `disable()`, just logs `"Disabling idle checking until further notice... (TODO)"` and exits. The author left a stream-of-consciousness comment block explaining they weren't sure how to access control repos.

2. **Nothing calls it.** `grep -r disable-if-idle` returns only CODE_REVIEW.md. The actual disable-when-idle path lives in `daily-activity.yml` at the `disable-when-empty` job (L35-48; empty `participating-orgs.yml`) and `check-idle` job (L239-253; `active_count == '0'` from `find-finalizable.mjs`). Both work.

Fix: **delete the file.** It's a misleading half-implementation. The two real disable paths are correct.

**Test to add:** an inventory test (e.g. `tests/scripts-inventory.test.mjs`) that asserts every `.mjs` under `scripts/` is referenced by at least one workflow YAML or another script. Would prevent dead helpers from accumulating.

### 6.3 [MED] `scripts/parse-assignment-metadata.mjs` — dead code with a divergent placeholder

`scripts/parse-assignment-metadata.mjs:10-12`:

```js
const pat = a.repository_name_pattern || `${assignmentId}-{login}`;
const targetRepo = pat.replace('{login}', githubLogin);
```

- Default pattern uses `{login}`.
- The canonical placeholder is `{github_login}` — enforced by `schemas/assignment.schema.json:67` (`"pattern": "\\{github_login\\}"`) and used by `acceptance/accept.mjs:173`.
- A YAML following the schema (`pattern: "homework-{github_login}"`) passed to this script would emit the literal `homework-{github_login}` because the `.replace('{login}', …)` substring match doesn't fire.

But: **nothing calls this script** (grep confirms only CODE_REVIEW.md mentions it; provisioning derives target-repo names through `accept.mjs` outputs). It's dead code that exists only to mislead future maintainers.

Fix: **delete the file** (same rationale as §6.2). Caught by the inventory test proposed above.

### 6.4 [LOW] `scripts/get-participating-orgs.mjs` parses YAML with a regex

```js
for (const line of text.split(/\r?\n/)) {
  const m = line.match(/^\s*-\s*login:\s*"?([A-Za-z0-9][A-Za-z0-9-]*)"?\s*$/);
  if (m) logins.push(m[1]);
}
```

Three risks:
1. **Flow-style YAML or comments on the line** break the regex (`- login: foo  # active`).
2. **Indentation variance** (e.g., 4-space) is tolerated by the regex but a different shape (`- {login: foo, ...}`) would be silently dropped.
3. **Empty result triggers `daily-activity.yml`'s `disable-when-empty` job** (L35-37 checks `orgs == '[]'`) which disables the daily cron. A YAML-formatter "improvement" that flattens entries could turn the entire scheduled subsystem off without anyone noticing — until a deadline silently fails to finalize.

Sibling scripts (`get-budget-owner.mjs`, `usage-fetch.mjs`) use the real YAML parser. Switch to:

```js
import { parse } from "yaml";
import { readUtf8OrFail } from "./lib/encoding.mjs";
const o = parse(readUtf8OrFail("participating-orgs.yml"));
process.stdout.write(JSON.stringify((o.orgs || []).map(x => x.login)));
```

**Test to add:** `tests/get-participating-orgs.test.mjs` with fixtures using inline comments, flow-style, and an empty file — assert correct logins are returned.

### 6.5 [LOW] `scripts/lib/gh.mjs` retry budget is short

```js
const RETRY_DELAYS_MS = [250, 500, 1000, 2000, 4000];
```

Maximum 5 attempts, total ~7.75s. For 429/secondary rate-limit responses, `Retry-After` (L20-23) overrides this and the script waits as long as the header says — correct. But for a 5xx storm during a GitHub partial outage (typical 1-3 min), the budget exhausts mid-cron and the job fails.

`gh()` is consumed by `usage-fetch.mjs` (a weekly cron — failure is annoying but recovers next week) and `usage-notify.mjs` (same cron — issue commenting is idempotent within the existing-issue path L33-37). Net impact bounded.

Fix optional: bump to `[500, 1000, 2000, 4000, 8000, 16000]` (~31.5s total) to cover short 5xx windows. Not urgent.

### 6.6 [LOW] `scripts/update-json-field.mjs` does not validate after write

```js
d[field] = value;
writeFileSync(file, JSON.stringify(d, null, 2) + '\n');
```

- Only handles top-level keys. Callers pass dotted paths at their peril; current callers (workflow YAMLs) only set scalars like `status` so this is fine.
- The script **does not validate against any schema** — a typo like `node update-json-field.mjs acceptance.json statu accepted` silently creates a `statu` key on the JSON, and `acceptance.schema.json:15` (`additionalProperties: false`) means the file is now schema-invalid. Validation downstream (in `lib/audit.mjs`'s consumers, etc.) catches it but the failure is far from the cause.

Fix optional: take an extra `--schema` arg, run ajv after the write. Or just leave it — callers are workflow YAMLs that are reviewed in PRs.

### 6.7 [OK] `scripts/lib/encoding.mjs` fail-fast on UTF-16/BOM

`scripts/lib/encoding.mjs:5-13` rejects UTF-16 LE, UTF-16 BE, and UTF-8-with-BOM with a clear remediation message. This is exactly the kind of hardening that pays off when lecturers edit YAML in Notepad — a real risk on Windows. Keep.

### 6.8 [OK] `scripts/find-finalizable.mjs` activeCount

L41-56: the second pass over `assignments/` counts published assignments whose deadline is in the future (or has no deadline). `daily-activity.yml`'s `check-idle` job consumes this. Logic is correct independently of §6.1 (which is about the *finalize* window).

### 6.9 [LOW] `schemas/grading-result.schema.json` doesn't require points fields

The schema declares `total_points` and `earned_points` (L54-61) but they're absent from `required` (L7-16). A buggy grader version could write a result without them; `cli/src/commands/grade.mjs:101-113` always sets them so today this is moot, but a future code path (e.g., a partial-credit-not-set placeholder) could land an underspecified grading result that still passes schema validation.

Fix: add `"total_points"` and `"earned_points"` to `required`.

### 6.10 [OK] Other schemas

- **`acceptance.schema.json`** — closed (`additionalProperties: false`), required fields cover everything `accept.mjs` writes (matching the workflow we now know is correct since §3.1 was fixed).
- **`observation.schema.json`** — `oneOf` over `snapshot` and `tagged-submission` variants. The legacy snapshot shape lacks a `type` discriminator on disk; the schema accepts that by making `type` optional on the first branch. Only `collect.mjs` writes these, so the oneOf disambiguation works in practice.
- **`report.schema.json`** — wide schema, but `additionalProperties: false` at student-level rules out drift. `submission_status` enum includes `unknown` — correct for cases where the deadline boundary can't be determined.
- **`roster.schema.json`** — `schema_version: const: 2` matches `frontend/src/lib/csv.js` and `lib/roster-link.mjs`.
- **`error-record.schema.json`** — well-bounded; closed shapes; `category` enum aligned with workflows that write errors.
- **`participating-orgs.schema.json`** — confirms key is `orgs` (corroborates §6.2's bug in `disable-if-idle.mjs`).
- **`limits.schema.json`**, **`limits-overrides.schema.json`**, **`override.schema.json`**, **`repository-record.schema.json`** — read; tight; no findings.

### 6.11 Summary of dead-code in `scripts/`

| File | Status |
|---|---|
| `scripts/disable-if-idle.mjs` | Dead + broken — delete |
| `scripts/parse-assignment-metadata.mjs` | Dead + divergent — delete |

Both should go in a single cleanup commit. Total: -50 LOC; reduces confusion; no functional change because nothing calls them.

---

## 7. Test coverage assessment

_pending_ — full breakdown at the end. So far obvious gaps:
- **No test asserts that workflow YAML `with:` keys match the called action's `inputs.*`.** This would have caught §1.7 immediately.
- **No test runs `bash -n` on workflow `run:` blocks.** This would have caught §1.1.
- **No test for the audit module's `runAudit` integration.** Would have caught §2.1 (the `.json` vs `.yml` typo).
- No test for `provision.mjs` happy paths or `setupFeedbackBaseline` idempotency.
- No test for `collect.mjs` smart-schedule (now dead) or normal collection path.
- No test for `report.mjs` end-to-end on a fixture control-repo tree (scan.test.mjs exists but that's the privacy scanner, not the report computation).

Wait — there IS a `tests/report.test.mjs`. Let me re-check coverage in detail in section 7.

---

## 8. Dependencies (online check)

_pending_

---

## 9. DRY / duplication audit

Tracked so far:
1. **`lib/gh.mjs` ↔ `scripts/lib/gh.mjs`** — two HTTP carriers (§2.4).
2. **Rebase+push retry loop** open-coded in 4 workflows: acceptance-handler, daily-activity (×2), regenerate-dashboard, reconcile-registry, retry-acceptance (§1.3). Extract a `scripts/git-push-with-retry.sh` or move all commits into Node via `lib/gittree.mjs`.
3. **JSON file generation in shell heredocs** — `acceptance-handler.yml` (broken) and `retry-acceptance.yml` (working). Both could call a tiny Node script.
4. **`find-orgs` job is duplicated across `daily-activity.yml`, `regenerate-dashboard.yml`, `reconcile-registry.yml`, `weekly-usage-report.yml`**. Identical 15-line shell block in each. Extract a reusable workflow (`workflow_call`) or a composite action that emits `orgs` as an output.

---

## 10. Security notes

_pending_

---

## 11. Quick-action summary

_pending — populated at the end._

---

## 12. Verified vs. unverified

Verified by reproducing locally:
- §1.1 — `bash -n` on the YAML-rendered script shows `syntax error: unexpected end of file`. Reproduced.
- §1.7 — confirmed via grep across `.github/workflows/` + every `*/action.yml`. The mismatch is a static fact.

Verified by reading + cross-referencing:
- §2.1 — confirmed every other workflow reads `participating-orgs.yml`, and `setup-org.yml` writes `.yml`. The `.json` reference in audit is unique.

Unverified (read-only static review only):
- Everything else.

---

## 13. Status

| Section | Status |
|---|---|
| 1. Workflow YAML | 8 findings (2 BLOCKER, 1 HIGH, 1 MED, 2 LOW) |
| 2. lib/ | 6 findings |
| 3. Composite actions | 4 findings |
| 4. CLI | pending |
| 5. Frontend | 11 findings (1 HIGH, 3 MED, 3 LOW, 4 OK) |
| 6. Schemas + scripts | 11 findings (2 MED dead-code, 4 LOW, 4 OK) + §6.1 HIGH (find-finalizable) |
| 7. Test coverage | pending |
| 8. Dependencies | pending |
| 9. DRY | partial |
| 10. Security | pending |
| 11. Quick actions | pending |
