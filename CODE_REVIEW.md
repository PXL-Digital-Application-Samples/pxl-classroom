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

### 4.1 [MED] `roster.mjs` diff uses `JSON.stringify` equality — sensitive to key order

`cli/src/commands/roster.mjs:147`:

```js
if (JSON.stringify(prev) !== JSON.stringify(entry)) updated.push({ before: prev, after: entry });
```

- `prev` comes from `yamlParse(roster.yml)`, key order = source-file order.
- `entry` comes from `csvToRoster`, key order = `KNOWN_COLUMNS` Set iteration order (`student_number, full_name, email, class_group, github_login, github_id, active`).

If the YAML file was last written by a hand-edit (or by an older CLI version) that reordered the fields, every student appears as `updated` with no actual data change. Result: a noisy diff and an unnecessary commit that rewrites the whole roster file each import — burning Contents-API budget and polluting `git log`.

Fix: normalize before compare. Either pick a canonical key order on read, or replace the comparator with a deep-equal over a key-sorted projection (`isEqual(stable(prev), stable(entry))`).

### 4.2 [LOW] `cli/src/lib/octokit.mjs:17` — `request: { retries: 3 }` is dead config

```js
return new Octokit({ auth: t, userAgent: USER_AGENT, request: { retries: 3 } });
```

`@octokit/rest` does NOT bundle `@octokit/plugin-retry`. The `retries` option is only honored when the retry plugin is loaded into the Octokit instance (or when using `Octokit` from `@octokit/core` with the plugin attached). With the plain `@octokit/rest` import here, this option is silently ignored — there is no retry on 429, no backoff on transient 5xx.

Fix: either drop the option (and document that retries are not in scope), or add `@octokit/plugin-retry` to `cli/package.json` deps and wire it via `Octokit.plugin(retry)`. The latter aligns CLI behavior with the workflow scripts' `scripts/lib/gh.mjs` retry policy (§6.5).

### 4.3 [LOW] `runner-host.mjs` spawns `/bin/sh` unconditionally — fails opaquely on Windows

`cli/src/lib/runner-host.mjs:47` and L51 use `cmd: "/bin/sh", args: ["-c", test.command]`. On Windows, this is `ENOENT`, surfaced through the `child.on("error", ...)` path as a noisy spawn failure. The host runner is documented as POSIX-only (test file `cli/tests/runner-host.test.mjs:8` even skips on Windows), but a Windows lecturer running `pxl-classroom grade --runner=host` will see `spawn /bin/sh ENOENT` rather than a clear "use --runner=docker on Windows" hint.

Fix: in `runHost`, guard `if (platform() === "win32") throw new Error("host runner is POSIX-only; use --runner=docker on Windows")` at entry.

### 4.4 [LOW — DRY] `resolveOrg` is duplicated across all five command files

`audit.mjs:20-29`, `roster.mjs:28-37`, `feedback.mjs:23-32`, `download.mjs:24-33`, `grade.mjs:30-35` — five copies of the same 9-line "flag → config.last_org → save-on-use" helper, with verbatim wording in three of them.

Extract to `cli/src/lib/org.mjs`. Tiny DRY win, but keeps CLAUDE.md's "one source of truth per cross-surface concern" principle consistent inside the CLI itself.

### 4.5 [LOW — DRY] `fetchAssignment` / `fetchReport` duplicated across commands

- `fetchAssignment(octokit, {org, assignmentId})` exists verbatim in `grade.mjs:50-55` and `feedback.mjs:34-40`.
- `fetchReport(octokit, {org, assignmentId})` exists in `grade.mjs:57-62` and `download.mjs:52-58`.

Same fix — extract to `cli/src/lib/control-repo.mjs` (e.g. `getAssignment`, `getReport`, `listRepoRecords`).

### 4.6 [OK] Docker sandbox flags (`runner-docker.mjs:24-29`)

Strong configuration, matches `ARCHITECTURE.md §11.6` precisely:

```
docker run --rm --init --network=none
           --read-only --tmpfs /tmp:rw,size=64m
           --memory=512m --pids-limit=256
           --workdir /workspace
           -v <workdir>:/workspace:ro
```

- `--network=none` — no exfiltration / dependency fetch during grading.
- `--read-only` rootfs + explicit `/tmp` tmpfs — student tests can write scratch but not persist.
- Workspace mount is `:ro` — student code cannot mutate the lecturer's filesystem.
- `--memory=512m` + `--pids-limit=256` — bounded fork bombs and OOMs.
- `--init` for proper PID-1 signal forwarding to nested processes.
- Nested timeouts: inner `timeout ${test.timeout_s}s` + outer Node `setTimeout(SIGKILL, timeoutMs + 5000)` gives a hard kill if `timeout` itself misbehaves.

One observation: `dockerRun` interpolates `test.timeout_s` directly into the inner shell: `` `timeout ${test.timeout_s ?? 30}s sh -c …` `` (`runner-docker.mjs:72, 79`). `test.timeout_s` comes from assignment YAML, which is schema-validated (`schemas/assignment.schema.json` autograde block, exercised by `cli/tests/phase-c-schemas.test.mjs`) — so the value is constrained to a positive integer, no injection vector. If the schema ever relaxes to a string, this becomes shell injection. Defense-in-depth: cast `Number(test.timeout_s)` before interpolating.

### 4.7 [OK] Token handling

- `cli/src/lib/config.mjs:42-47` writes both token and config at `0600` on POSIX. Windows is documented as "user-profile ACL best-effort" (`config.mjs:7-9`). Acceptable.
- `download.mjs:85-86` and `grade.mjs:67-71` use `https://x-access-token:${token}@github.com/...` URLs for git operations. Token never lands on the argv (where it would appear in `ps`). The URL is rebuilt on every `fetchOne` (`download.mjs:85`: `git remote remove origin` → re-add), so a rotated token wins each call and stale tokens don't persist in the local repo's git config.
- `auth.mjs:60-66` — `requireToken()` throws cleanly on no token.

### 4.8 [OK] Worker pool concurrency in `grade.mjs` and `download.mjs`

Both implement the same shared-cursor + bounded `Promise.all(Array.from({length: n}, worker))` pattern (`grade.mjs:175-231`, `download.mjs:93-105`). Correct, no off-by-one, results array indexed by original queue position. The pattern is duplicated between the two files — minor DRY candidate, but not large enough to warrant extraction.

### 4.9 [OK] `feedback.mjs` 422 disambiguation

`openDraftPr` (`feedback.mjs:65-88`) handles two distinct 422 cases differently:
- `"No commits between"` → returns `null` (student hasn't pushed yet — pending state, not an error).
- `"already exists"` → refetches the existing PR via `GET /repos/{owner}/{repo}/pulls?head=...&state=open` and returns its number/URL.

This is exactly the right shape for an idempotent "open or recover" semantic and is the kind of distinction Octokit's default error path does not give you.

---

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

### 7.1 Current footprint

`npm test` (`.github/workflows/ci.yml:25`) runs only the root `tests/*.test.mjs` glob on `ubuntu-latest`, Node 24. CLI tests live in `cli/tests/*.test.mjs` and are run by a separate workflow (`cli-ci.yml`) gated on a path filter — see §7.3 below for the gap that creates.

| Suite | Covers | Quality |
|---|---|---|
| `tests/yaml.test.mjs` | `lib/yaml.mjs` (nested templates, arrays, type coercion) | Targeted regression suite — guards the case that broke when minimal parsers were replaced. |
| `tests/scan.test.mjs` | `pages/scan.mjs` privacy scanner (clean + leaky fixtures) | Spawns the real script — exercises the same entry point the workflow does. |
| `tests/cors.test.mjs` | `frontend/src/lib/auth.js` URL strings | **Lexical-only.** Greps for endpoint URLs and the `VITE_CORS_PROXY_URL` token. Does NOT exercise the device-flow state machine. |
| `tests/gittree.test.mjs` | `lib/gittree.mjs` | Thorough: happy path, multi-file delete-via-null, non-FF rebase, 422 disambiguation, 404 propagation lag, AbortController. Highest-quality suite in the repo. |
| `tests/report.test.mjs` | `report/report.mjs` | Multi-scenario truth table (on-time / late / override-applied / no-submission). Real child-process spawn against a synthetic fixture tree. |
| `cli/tests/roster-csv.test.mjs` | CSV → roster shape + schema | Schema-validation-only; the network-bound `roster import` command is not exercised. |
| `cli/tests/runner-host.test.mjs` | `cli/src/lib/runner-host.mjs` | Skipped on Windows (spawns `/bin/sh`). On CI (ubuntu-latest) runs five smoke cases. |
| `cli/tests/phase-c-schemas.test.mjs` | assignment.autograde + feedback_pr + grading-result schema validation | Schema-only; does not run the grade pipeline. |

### 7.2 Untested production code (high-value gaps)

**Trust-boundary code that is currently entirely untested:**

1. **`acceptance/accept.mjs`** — runs in the private control repo under repository_dispatch and is the validation gate for every student acceptance. Nothing exercises:
   - The `SLUG` and `LOGIN` regexes (L43-44) — a regression here lets malformed dispatch payloads through.
   - The 9 `fail:*` / `rejected:*` exit categories.
   - Idempotency (re-accept after `<login>.json` already exists, L100-115).
   - `max_acceptances` cap math.
   - `deriveRepoName` placeholder substitution (this is the canonical `{github_login}` consumer that §6.3 diverged from).
   - `template.{owner,repository}` reads (the fix from §3.1 has no regression test).

   This is the second-most consequential script after `lib/gittree.mjs` and has zero coverage.

2. **`scripts/find-finalizable.mjs`** (the §6.1 HIGH finding) — no regression test asserting the finalize window matches the cron cadence. A test driving the script with a fixture tree of assignments at varying deadline ages would have caught this and would prevent its return.

3. **`scripts/find-pending.mjs`** — drives the daily-activity reconcile pass. No test.

4. **`scripts/parse-acceptance.mjs`** — converts repository_dispatch payload to `GITHUB_OUTPUT`. No test for malformed payload handling.

5. **`scripts/usage-fetch.mjs`** — ISO week computation (L116-122), billing API pagination (`ghAllItems` L63-67), and the repo → org → global override resolution chain. Wrong output here misroutes budget alerts. No test.

6. **`scripts/get-participating-orgs.mjs`** — the §6.4 LOW regex YAML parser. A test asserting it returns the same logins as `loadYaml(...).orgs.map(o => o.login)` on a representative fixture would (a) verify equivalence today and (b) catch the silent failure mode that triggers the `disable-when-empty` cron-disable.

7. **`lib/audit.mjs`** — `EXPECTED_APP_PERMISSIONS` is declared in CLAUDE.md as the one source of truth consumed by both CLI and `SetupView.vue`. No test asserts:
   - The CLI command imports it (not a fork).
   - `SetupView.vue` (or whatever wires the SPA's setup screen) imports it (not a fork).
   - The constant shape matches what `runAudit` actually checks against.

8. **`lib/dashboard-aggregate.mjs`** — aggregates report data for the Pages dashboard. No test.

9. **`lib/gh.mjs` and `scripts/lib/gh.mjs`** — retry/backoff with `Retry-After` honoring. No test asserts that a `Retry-After: 30` response causes a 30s wait, nor that 5xx triggers the backoff curve. The two carriers are also not tested for equivalence (the §2.4 DRY finding).

10. **`lib/encoding.mjs` / `scripts/lib/encoding.mjs`** — fail-fast on BOM / UTF-16 (§6.7 marked OK). No test verifies the rejection paths.

11. **`cli/src/commands/audit.mjs`** — install audit walk. No test.

12. **`cli/src/commands/grade.mjs`** — Phase C lecturer-side autograder. No test for:
    - `checkoutArchive` SHA-mismatch guard (`cli/src/commands/grade.mjs:73-75`).
    - The `Promise.all(... worker)` student-level concurrency pool against a fixture queue.
    - Schema validation of grading results (the `validateAgainst("grading-result", ...)` call at L199-202 — schema itself is tested, the wiring is not).
    - The dry-run vs commit path.

13. **`cli/src/commands/feedback.mjs`** and **`cli/src/commands/download.mjs`** — Phase C, no tests.

14. **`cli/src/lib/runner-docker.mjs`** — Docker sandbox flags (network-disabled, read-only mounts, memory caps). Security-critical and untested. A test that spawns `docker --version` and otherwise mocks the spawn could at least assert the argv shape.

### 7.3 CI wiring gaps

- **`cli/tests/*.test.mjs` does not run on the `main` CI workflow.** `ci.yml` runs `node --test tests/*.test.mjs` only. CLI tests live behind `cli-ci.yml` which is path-filtered to `cli/**`, `lib/gittree.mjs`, `schemas/**`, `.github/workflows/cli-ci.yml`. So changes outside those paths that nevertheless affect CLI behavior (e.g., `lib/yaml.mjs`, `lib/audit.mjs`, `scripts/**`) will not run CLI tests. Fix: either merge into `ci.yml` (run both globs in one job) or widen the path filter / drop it.

- **`cli-ci.yml` uses floating tags** — `actions/setup-node@v4`, `actions/checkout@v7.0.0`. Inconsistent with `ci.yml` which uses pinned SHAs and is the project's stated discipline. Pin both to the same SHA. Also: `setup-node@v4` is the older major; `ci.yml` uses `v6.4.0`. Align.

- **`ci.yml` triggers on `pull_request:`** even though CLAUDE.md says "No pull requests. Commit and push directly to `main`." This is dead trigger surface — harmless, but worth deleting for clarity. (Unless PRs are used for forks/dependabot — verify before removing.)

- **No `bash -n` job on workflow YAML.** Would have caught §1.1 (heredoc structure error) before reaching production. One-line CI step: render every workflow's `run:` block and pipe it to `bash -n`.

- **No `actionlint`.** Same problem space as §1.1 / §1.7 — type checking for workflow YAML. The project relies on hand-reading.

### 7.4 Cross-surface invariants that should be inventory tests

These are tests-of-conventions rather than tests-of-functions. Each catches a *class* of bug — not just the live instance — so they pay for themselves over time.

1. **Every `scripts/*.mjs` is referenced by at least one workflow or another script.** Would have caught §6.2 and §6.3 (two dead scripts). Implementation: grep workflow YAML + `scripts/` + `acceptance/`; assert every `.mjs` file appears somewhere.

2. **Every workflow `with:` key matches the called action's `inputs.*` schema.** Would have caught §1.7. Implementation: parse every workflow YAML, for each `uses: ./.github/actions/<name>` resolve `action.yml` and diff the `with:` keys against `inputs:` keys.

3. **Every `run:` block in workflow YAML parses with `bash -n`.** Would have caught §1.1.

4. **Every script that writes a JSON file validates it against its schema before write.** Would have caught §6.6 (`update-json-field.mjs` writes without validation). Implementation: lint pass over `scripts/` that flags `writeFile(...JSON.stringify...)` without a prior `validateAgainst(...)` call.

5. **`EXPECTED_APP_PERMISSIONS` is imported by both `cli/src/commands/audit.mjs` and `frontend/src/views/SetupView.vue`.** Encodes the one-source-of-truth invariant from CLAUDE.md. Implementation: grep both files for the import.

6. **`lib/gittree.mjs` has exactly one canonical implementation; `cli/src/lib/gittree.mjs` is a thin adapter (≤30 lines).** Today this holds (the CLI file is 26 lines; verified). A guard test asserting the adapter doesn't grow would prevent re-forking.

7. **YAML produced by `frontend/src/views/AssignmentDetailView.vue` "Save" passes `validateAgainst("assignment", ...)`.** No test today asserts the SPA's serializer can't emit YAML the schema rejects.

8. **The set of assignment YAML fields `accept.mjs` reads is a subset of the schema's `properties`.** Defensive — would catch field renames that break acceptance.

### 7.5 Specific test additions to plan (priority order)

| Priority | Test | Catches | Cost |
|---|---|---|---|
| P0 | `tests/accept.test.mjs` — full truth table for `acceptance/accept.mjs` | All 9 fail/reject categories; idempotency; cap; `{github_login}` substitution | ~150 LOC fixture builder + 8-10 cases |
| P0 | `tests/find-finalizable.test.mjs` — deadline-window truth table | §6.1 regression | ~50 LOC |
| P0 | Inventory test #1 (every script referenced) | §6.2 §6.3 + future dead code | ~30 LOC |
| P0 | Inventory test #2 (workflow `with:` ↔ action `inputs:`) | §1.7 + future | ~50 LOC |
| P0 | `bash -n` lint over workflow `run:` blocks | §1.1 + future heredoc bugs | ~30 LOC |
| P1 | `tests/usage-fetch.test.mjs` — ISO week + override resolution | budget misroute regressions | ~100 LOC |
| P1 | `tests/get-participating-orgs.test.mjs` — regex parser equivalence | §6.4 silent failure | ~30 LOC |
| P1 | `cli/tests/grade.test.mjs` — checkoutArchive SHA guard + queue worker pool | grading drift, archive substitution | ~100 LOC |
| P1 | `tests/audit.test.mjs` — `EXPECTED_APP_PERMISSIONS` shape + `runAudit` against a mocked installation | §2.1 + future audit bugs | ~80 LOC |
| P1 | Wire `cli/tests/*` into `ci.yml` or merge workflows | CI wiring §7.3 | trivial |
| P2 | `tests/gh.test.mjs` — retry curve + Retry-After honoring (×2 carriers) | retry drift, §2.4 equivalence | ~80 LOC |
| P2 | `tests/encoding.test.mjs` — BOM / UTF-16 rejection paths | regression in fail-fast | ~30 LOC |
| P2 | `tests/dashboard-aggregate.test.mjs` — aggregation truth table | dashboard rendering drift | ~100 LOC |
| P3 | `tests/cors.test.mjs` upgrade — mock fetch, drive the device-flow state machine | catches more than lexical drift | ~100 LOC rewrite |
| P3 | `cli/tests/runner-docker.test.mjs` — argv shape assertion | sandbox flag drift (security) | ~50 LOC |

**Estimated total to close P0+P1:** ~12 new test files, ~700 LOC, mostly fixture/scaffolding. The trust-boundary tests (`accept.test.mjs`, `find-finalizable.test.mjs`) and the three inventory tests are the highest leverage — each prevents an entire bug class, and together they would have caught five of this review's findings.

---

## 8. Dependencies (online check)

Reviewed `package.json` files at the root, `cli/`, and `frontend/`. Online lookups were not performed live during this pass; "current" below is relative to the assistant's January 2026 knowledge cutoff.

### 8.1 [LOW] `cli/package.json` engines floor lags the project's Node target

`cli/package.json:11-13`:
```json
"engines": { "node": ">=20" }
```

CLAUDE.md / auto-memory: "Always target Node 24 / latest stable." Root CI (`.github/workflows/ci.yml:19`) and `cli-ci.yml:23` both set `node-version: 24`. The engines floor at 20 means a contributor on Node 20 will not be alerted to Node 24-only syntax. Bump to `">=24"`.

Also: root `package.json` and `frontend/package.json` declare no `engines` block at all. Add `"engines": { "node": ">=24" }` to both for consistency.

### 8.2 [LOW] Version drift in shared deps across workspaces

| Dep | root `package.json` | `cli/package.json` | `frontend/package.json` |
|---|---|---|---|
| `ajv` | `^8.16.0` | `^8.20.0` | `^8.20.0` |
| `ajv-formats` | `^3.0.0` | `^3.0.1` | `^3.0.1` |
| `yaml` | `^2.4.0` | `^2.9.0` | `^2.9.0` |

`npm` workspaces dedupe the resolved version, so today this is harmless. But the root caret floors are stale and a future install resolving `yaml@2.5.x` (within root's `^2.4.0`) into a deduplication corner could silently downgrade CLI/frontend. Bump root floors to match.

### 8.3 [LOW] `cli-ci.yml` uses floating action tags

Already cross-referenced from §7.3 — surfaced here under deps for the same reason:
- `actions/setup-node@v4` (cli-ci.yml:21) — should be the same pinned-SHA `v6.4.0` used in `ci.yml:17`.
- `actions/checkout@v7.0.0` (cli-ci.yml:20) — tag form. Pin to SHA.

### 8.4 [OK] Other production dep choices

- `@octokit/rest@^21.0.2` (CLI) — current major. Note however that `@octokit/plugin-retry` is NOT a transitive dep, which interacts with §4.2.
- `@octokit/auth-oauth-device@^7.1.1` — current.
- `commander@^12.1.0` — current major series.
- `papaparse@^5.4.1` — current.
- `vue@^3.5.34`, `vue-router@^4.6.4` — current 3.x / 4.x.
- `@vitejs/plugin-vue@^6.0.6`, `vite@^8.0.12` — current at knowledge cutoff. (Vite 8 was the active major as of Jan 2026.)
- Pinned-by-SHA root CI actions (`actions/checkout@9c091bb…` v7.0.0; `actions/setup-node@48b55a0…` v6.4.0) are current and pinned correctly.

No outdated security-flagged deps spotted. Reviewer should still run `npm audit --omit=dev` before any release; not done in this pass.

---

## 9. DRY / duplication audit

1. **`lib/gh.mjs` ↔ `scripts/lib/gh.mjs`** — two HTTP carriers (§2.4).
2. **Rebase+push retry loop** open-coded in 4 workflows: acceptance-handler, daily-activity (×2), regenerate-dashboard, reconcile-registry, retry-acceptance (§1.3). Extract a `scripts/git-push-with-retry.sh` or move all commits into Node via `lib/gittree.mjs`.
3. **JSON file generation in shell heredocs** — `acceptance-handler.yml` (broken) and `retry-acceptance.yml` (working). Both could call a tiny Node script.
4. **`find-orgs` job is duplicated across `daily-activity.yml`, `regenerate-dashboard.yml`, `reconcile-registry.yml`, `weekly-usage-report.yml`**. Identical 15-line shell block in each. Extract a reusable workflow (`workflow_call`) or a composite action that emits `orgs` as an output.
5. **`resolveOrg`** is duplicated across 5 CLI command files (§4.4).
6. **`fetchAssignment` / `fetchReport`** duplicated between CLI commands (§4.5).
7. **Hub owner/repo** hardcoded across 5 Vue views (§5.3).
8. **Worker-pool concurrency pattern** duplicated between `cli/src/commands/grade.mjs:175-231` and `cli/src/commands/download.mjs:93-105`. Identical shared-cursor pattern — could move to `cli/src/lib/concurrency.mjs`. Not large enough to merit extraction on its own, but worth folding in if any third call site lands.

---

## 10. Security notes

Threat model: the system processes student-controlled GitHub repos and lecturer-controlled YAML. The interesting boundaries are (a) the acceptance handler (validates dispatch payloads), (b) the autograder (executes untrusted student code), (c) the device-flow OAuth, (d) the privacy scanner on Pages output, and (e) workflow permission scopes.

### 10.1 Trust-boundary validation (acceptance)

`acceptance/accept.mjs:43-44` regex-validates `assignment_id` (`SLUG`) and `github_login` (`LOGIN`) before any filesystem or git operation. Strict character classes, no anchors-missing pitfalls. The path concatenation at L72 (`join(dataDir, "assignments", \`${assignmentId}.yml\`)`) cannot escape its parent because the SLUG regex forbids `/`, `.`, `..`. **No test exercises the rejection paths (§7.2 #1) — this is the highest-leverage missing test in the repo.** A bug that loosens these regexes would be invisible until exploited.

### 10.2 Autograder sandbox (`runner-docker.mjs`)

Strong defense-in-depth (§4.6): `--network=none`, `--read-only`, workspace `:ro`, `--memory=512m`, `--pids-limit=256`, nested timeouts. The host runner (`runner-host.mjs`) has **no sandbox** and is documented as such ("No sandboxing. Use --runner=docker for untrusted student code." — L4). Worth re-asserting in `RUNBOOK.md` that `--runner=host` is for trusted (lecturer-authored) test code only.

`shQuote` in `runner-docker.mjs:103-104` correctly escapes single-quote POSIX strings; `test.command` is from the lecturer's schema-validated assignment YAML, not the student. No injection vector today; if the schema ever accepts a string `timeout_s`, the inner `timeout ${test.timeout_s}s` interpolation becomes injectable (§4.6 closing note).

### 10.3 OAuth device flow + CORS proxy

`frontend/src/lib/auth.js:24` defaults `CORS_PROXY` to `https://corsproxy.io/?url=`. The proxy sits in front of `github.com/login/oauth/access_token` — meaning the operator of corsproxy.io can observe every lecturer's access token in the response body. The repo correctly documents this with the `tests/cors.test.mjs` regression guard and via `VITE_CORS_PROXY_URL` override, but `RUNBOOK.md` should explicitly state:

> The default CORS proxy is a third-party service. The proxy MUST be operated by a party you trust with App-installation access tokens. For institutional deployments, configure `VITE_CORS_PROXY_URL` to a self-hosted instance.

CLAUDE.md auto-memory says "Never propose self-hosting infrastructure" as a hard constraint — so this guidance must remain advisory and the public Pages SPA will keep its corsproxy.io default. **The trust assumption needs to be documented explicitly, not assumed.**

Token scope: the App's installation tokens are bounded by `EXPECTED_APP_PERMISSIONS` (`lib/audit.mjs`). The CLI uses user-OAuth tokens via device flow — different scope, separately revocable. Both flow through the same proxy under the default config.

### 10.4 Privacy scanner (`pages/scan.mjs`)

Tested (`tests/scan.test.mjs`) against clean + leaky fixtures; blocks roster fields, emails, tokens, institutional IDs from public Pages output. Tested entry point matches workflow. Solid.

### 10.5 Workflow permissions

`ci.yml:8-9` declares `permissions: contents: read` — minimum surface. Did not audit every other workflow's `permissions:` block in detail; recommend a separate pass to verify each workflow scopes write surface to the minimum it needs (e.g., `contents: write` only on jobs that commit; never `id-token: write` unless OIDC is intended).

### 10.6 Token handling in CLI (§4.7) — confirmed OK

0600 cache file POSIX, URL-embedded git auth (never argv), token rotated on each git op.

### 10.7 Misc

- `v-html` in `Icon.vue` (§5.8): constant SVG lookup, no XSS surface.
- `atob()` UTF-8 corruption (§5.1): semantic bug, not a direct security issue, but it does mean diffs displayed in the Admin Panel can misrepresent what's about to be committed.
- `escape()` in `lib/audit.mjs:217` (§2.3): deprecated annex-B function. Not a security hole per se but indicates the audit decoder will return mojibake on UTF-8, which could mask warnings about content with non-ASCII names.

**Net assessment:** no critical security holes. The biggest exposure is the *untested* validation regex at the acceptance trust boundary (§10.1) — if it ever weakens, no test will catch it. Address via §7.5 P0 `accept.test.mjs`.

---

## 11. Quick-action summary

### BLOCKERS — fix immediately

| # | File | Action |
|---|---|---|
| §1.1 | `.github/workflows/acceptance-handler.yml:84-101` | Replace `<< EOF`/12-space-indented closer with `<<-EOF`+tabs, OR move JSON write to `scripts/write-repository-record.mjs`. Acceptance flow has been silently broken since Wave 8. |
| §1.7 | `.github/workflows/daily-activity.yml:82-83,195-197,205,215` | Rename `assignment_id:` / `collection_type:` to `assignment-id:` / `collection-type:` in `with:` blocks. Lockdown + preserve have been no-ops since Wave 8. |

### HIGH — silent failure or corruption

| # | File | Action |
|---|---|---|
| §1.3 | `daily-activity.yml:96, 237` | Replace `git push \|\| true` with the retry loop from `acceptance-handler.yml`. |
| §1.8 | (CI) | Add `bash -n` lint step over every `run:` block. |
| §2.1 | `lib/audit.mjs:92` | Read `participating-orgs.yml` (not `.json`); parse via `yamlParse`. |
| §3.1 | `acceptance/accept.mjs` | Optional migration note for legacy `template_owner`/`template_repo`. |
| §5.1 | `frontend/src/lib/api.js:130` | Replace `atob(content)` with `TextDecoder`-based decode (symmetric with `commitFile`). |
| §6.1 | `scripts/find-finalizable.mjs:24-26` | Widen finalize window from 1h to 25h. |

### MEDIUM

| # | File | Action |
|---|---|---|
| §2.4 | `lib/gh.mjs` ↔ `scripts/lib/gh.mjs` | Consolidate to one carrier; move `ghAll`/`ghAllItems` to `lib/gh.mjs`. |
| §3.3 | `collect/collect.mjs:163-178` | Delete dead smart-schedule branches. |
| §4.1 | `cli/src/commands/roster.mjs:147` | Stable-key diff comparator. |
| §5.2 | `frontend/src/lib/auth.js:24` | Document `VITE_CORS_PROXY_URL` contract; validate explicitly. |
| §5.3 | 5 Vue views | Move hub owner/repo to `frontend/src/config.js`. |
| §5.4 | `SystemHealth.vue:66-90` | Wire up `CACHE_MS` (recommended) or delete the dead constant. |
| §6.2 | `scripts/disable-if-idle.mjs` | Delete (dead + broken). |
| §6.3 | `scripts/parse-assignment-metadata.mjs` | Delete (dead + divergent). |
| §6.9 | `schemas/grading-result.schema.json:7-16` | Add `total_points`, `earned_points` to `required`. |

### LOW — housekeeping

| # | File | Action |
|---|---|---|
| §1.4 | `daily-activity.yml:107-108` | Drop unused `outputs.finalizable`. |
| §2.2 | `lib/audit.mjs:138` | Drop obsolete `"pull"` permission compare. |
| §2.3 | `lib/audit.mjs:217` | Replace `escape()` with `TextDecoder`. |
| §4.2 | `cli/src/lib/octokit.mjs:17` | Remove dead `retries: 3` or wire `@octokit/plugin-retry`. |
| §4.3 | `cli/src/lib/runner-host.mjs` | Windows-platform guard with friendly error. |
| §4.4 | All CLI commands | Extract `resolveOrg` to `cli/src/lib/org.mjs`. |
| §4.5 | `feedback.mjs` / `download.mjs` / `grade.mjs` | Extract `fetchAssignment` / `fetchReport`. |
| §5.5 | `HomeView.vue:65-89` | Parallelize org loader. |
| §5.6 | `AssignmentDetailView.vue:631-672` | Honor `X-RateLimit-Remaining` per call. |
| §5.7 | `AssignmentDetailView.vue:354` | RUNBOOK note on Vite `fs.allow` for cross-root import. |
| §5.8 | `Icon.vue` | Comment on safe `v-html` use. |
| §6.4 | `scripts/get-participating-orgs.mjs` | Replace regex YAML parse with `yaml.parse`. |
| §6.5 | `scripts/lib/gh.mjs:2` | Bump retry budget to ~31.5s total. |
| §6.6 | `scripts/update-json-field.mjs` | Optional post-write schema validation. |
| §8.1 | `cli/package.json:12` + root + frontend | Engines floor `>=24`. |
| §8.2 | root `package.json` | Bump ajv / yaml floors to match CLI/frontend. |
| §8.3 | `cli-ci.yml:20-21` | Pin actions by SHA. |

### Tests (from §7.5, copied for convenience)

- **P0:** `tests/accept.test.mjs`, `tests/find-finalizable.test.mjs`, inventory tests #1 + #2, workflow `bash -n` lint.
- **P1:** `tests/usage-fetch.test.mjs`, `tests/get-participating-orgs.test.mjs`, `cli/tests/grade.test.mjs`, `tests/audit.test.mjs`, wire `cli/tests/*` into `ci.yml`.
- **P2/P3:** retry-policy parity, encoding rejection paths, dashboard aggregation, CORS state-machine, Docker argv shape.

---

## 12. Verified vs. unverified

**Verified by reproducing locally:**
- §1.1 — `bash -n` on the YAML-rendered script shows `syntax error: unexpected end of file`.
- §1.7 — confirmed via grep across `.github/workflows/` + every `*/action.yml`. The mismatch is a static fact.

**Verified by reading + cross-referencing:**
- §2.1 — every other workflow reads `participating-orgs.yml`; `setup-org.yml` writes `.yml`; the `.json` reference in `lib/audit.mjs` is unique.
- §3.1 — confirmed via git log (commit `3e92b4b`) that the `template.{owner,repository}` shape is the schema-aligned form.
- §4.1 — confirmed `KNOWN_COLUMNS` is a `Set` (`roster.mjs:58-61`); insertion order matches the declared order but does not match arbitrary YAML field order.
- §4.2 — confirmed `@octokit/rest@21` does not bundle `@octokit/plugin-retry` (verified at the `@octokit/rest` index module level — only `paginateRest` and `restEndpointMethods` are loaded by default; retry is a separate package not present in `cli/package.json` deps).
- §6.1 — math is direct: 1h window vs 24h cron interval → 23h gap where finalizable assignments are skipped.
- §6.2 — `grep -r disable-if-idle` returns only CODE_REVIEW.md; participating-orgs schema confirms `orgs`, not `organizations`.
- §6.3 — `grep -r parse-assignment-metadata` returns only CODE_REVIEW.md; assignment schema requires `{github_login}`, not `{login}`.
- §7.3 — `ci.yml:25` glob is `tests/*.test.mjs` only; `cli-ci.yml:6-9` paths filter is `cli/**`, `lib/gittree.mjs`, `schemas/**`, `.github/workflows/cli-ci.yml`.
- §8.4 — dep currency assessed against assistant's January 2026 knowledge cutoff; `npm audit` not executed.

**Unverified (read-only static review only):**
- Most workflow execution claims (§1.3, §1.4 functional impact, §3.3 dead-branch unreachable in prod).
- §5.1 mojibake claim follows directly from the `atob` semantics but was not exercised against the live SPA.
- §5.4 "always re-runs" claim was read from `SystemHealth.vue` not exercised.
- §5.6 secondary rate limit behavior described from GitHub docs, not reproduced.
- §6.4 silent failure path of `disable-when-empty` triggered by regex-parse empty result — logic is direct but not reproduced.
- All §10 boundary claims rest on schema + regex inspection, not on hostile fuzzing.

---

## 13. Status

| Section | Status |
|---|---|
| 1. Workflow YAML | 8 findings (2 BLOCKER, 3 HIGH, 1 MED, 2 LOW) |
| 2. lib/ | 6 findings (1 HIGH, 1 MED, 2 LOW, 2 OK) |
| 3. Composite actions | 4 findings (1 HIGH, 1 MED, 2 OK) |
| 4. CLI | 9 findings (1 MED, 4 LOW, 4 OK) |
| 5. Frontend | 11 findings (1 HIGH, 3 MED, 3 LOW, 4 OK) |
| 6. Schemas + scripts | 11 findings (1 HIGH, 2 MED, 4 LOW, 4 OK) |
| 7. Test coverage | 8 suites mapped, 14 gaps inventoried (5 P0, 5 P1, 3 P2, 2 P3) |
| 8. Dependencies | 4 findings (3 LOW + 1 OK) |
| 9. DRY | 7 duplication clusters |
| 10. Security | 7 boundary notes; no critical holes |
| 11. Quick actions | full punch list |
| 12. Verified/unverified | catalogued |

**Headline totals:** 2 BLOCKER, 6 HIGH, 7 MED, 18 LOW, 14 OK confirmations, 14 test-coverage gaps, 7 DRY clusters. Two of the BLOCKERs (§1.1 + §1.7) mean the synchronous acceptance + nightly finalize have not worked end-to-end since Wave 8 shipped. Fix those two first; everything else is improvement on a working baseline.
