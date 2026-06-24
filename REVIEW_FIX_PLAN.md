# REVIEW_FIX_PLAN — pxl-classroom

Companion to `CODE_REVIEW.md`. Closes every finding (2 BLOCKER, 6 HIGH, 7 MED, 18 LOW, 14 test gaps, 7 DRY clusters) plus the dep/CI wiring follow-ups. Both `CODE_REVIEW.md` and this plan are deleted in the final phase per `CLAUDE.md`'s "no top-level planning/progress docs" rule.

## Operating contract

- **Phasing:** by area, in the order of `CODE_REVIEW.md` §1–§8. Severity is preserved *within* each phase (BLOCKER → HIGH → MED → LOW), but a phase ships as a coherent unit rather than crossing area boundaries.
- **Tests:** all production fixes land first; tests (§7.5 P0–P3) are batched into **Phase 9**. Each fix commit must keep `npm test` green; new regression tests for that fix are written in Phase 9 against the fixed code (no TDD-flip mid-phase).
- **DRY:** each cluster is folded into the commit for one of its callers — the cluster anchor noted per phase. E.g., the `resolveOrg` extraction (§4.4) lands inside the §4.1 roster-diff commit; hub owner/repo extraction (§5.3) lands inside the §5.1 UTF-8 decode commit.
- **Commits:** direct to `main` (CLAUDE.md). One commit per `§N.N` finding unless explicitly grouped below. `Co-Authored-By` trailer on every commit.
- **Verification per commit:** `npm test` green; `node --check` on edited `.mjs`; `bash -n` on edited workflow `run:` blocks (manual until Phase 9 lands the lint). Workflow changes get spot-checked in the `Actions` tab on the next event that triggers them.
- **Architecture docs:** any change that contradicts `ARCHITECTURE.md` or `RUNBOOK.md` updates them in the **same commit** (CLAUDE.md "Authoritative AI Memory Rule"). Two explicit doc updates are scheduled: §3.1 legacy-template note (RUNBOOK) and §5.7 Vite `fs.allow` note (RUNBOOK).

## Online check results (June 2026)

Verified live during plan authoring; used to size dep bumps.

| Item | Current | Repo state | Action |
|---|---|---|---|
| `actions/checkout` | v7.0.0 SHA `9c091bb…` | Pinned correctly in `ci.yml`, floating in `cli-ci.yml` | Pin `cli-ci.yml` to the same SHA |
| `actions/setup-node` | v6.4.0 SHA `48b55a0…` | Pinned correctly in `ci.yml`, floating `@v4` in `cli-ci.yml` | Pin `cli-ci.yml` to the same SHA |
| Node.js LTS | v24 (Active LTS); v26 Current, pre-LTS | `node-version: 24` in both CIs | Keep — auto-memory rule "Node 24 / latest stable" satisfied |
| `@octokit/rest` | 22.0.1 | CLI uses `^21.0.2` | Bump to `^22.0.1` to unlock plugin-retry@8 wiring (see §4.2) |
| `@octokit/plugin-retry` | 8.1.0 (needs `@octokit/core` ≥ 7) | Not in deps | Add at `^8.1.0` after the `@octokit/rest` bump |
| `@octokit/auth-oauth-device` | `^7.1.1` | Same | Keep |

If the `@octokit/rest` v22 bump surfaces breakage during Phase 4 smoke-testing, fall back to "drop the dead `retries: 3` option" path (no plugin wiring, no major bump). Decision deferred to that phase.

---

## Phase 1 — Workflow YAML (`CODE_REVIEW.md` §1)

Targets the two BLOCKERs that have left the synchronous acceptance + nightly finalize broken since Wave 8. DRY cluster #2 (rebase+push retry loop) is folded into §1.3.

1. **§1.1 BLOCKER — heredoc never terminates in `acceptance-handler.yml`.**
   - Extract the JSON write to `scripts/write-repository-record.mjs` (CLAUDE.md "Scripting Note: do not use inline `node -e` scripts in workflow YAML"). Inputs: `--assignment-id`, `--login`, `--org`, `--target-repo`, `--repo-id`, `--repo-url`, `--baseline-sha`, `--run-url`, `--data-dir`. Writes to `<data-dir>/repositories/<id>/<login>.json`, validates against `schemas/repository-record.schema.json` via `validateAgainst()` before write.
   - Replace lines 80–103 of `acceptance-handler.yml` with two `run:` lines: `node ../scripts/write-repository-record.mjs …` then `git add repositories/`.
   - `bash -n` the modified step to confirm.

2. **§1.7 BLOCKER — dash/underscore mismatch in `daily-activity.yml`.**
   - Rename `assignment_id:` → `assignment-id:` and `collection_type:` → `collection-type:` at L82-83, L195-197, L205, L215.
   - Cross-check every other `uses: ./<action>` in `daily-activity.yml`, `acceptance-handler.yml`, `publish-assignment.yml`, `regenerate-dashboard.yml`, `reconcile-registry.yml`, `weekly-usage-report.yml`, `setup-org.yml` against the matching `*/action.yml` `inputs:` schema and fix any other drift surfaced.

3. **§1.3 HIGH — `git push || true` masks push failures + DRY cluster #2.**
   - Create `scripts/git-push-with-retry.sh` (POSIX sh): `MAX_RETRIES=5`, jittered sleep 2–6 s, `git pull --rebase` between attempts, `set -e`, exits non-zero only after the budget is exhausted. Mirrors the loop already in `acceptance-handler.yml:119–132`.
   - Rewrite `daily-activity.yml:95–96` and `:236–237` to call the script.
   - Rewrite `acceptance-handler.yml:119–132` to call the script too (replaces inline copy — DRY).
   - Cross-check `publish-assignment.yml`, `regenerate-dashboard.yml`, `reconcile-registry.yml`, `retry-acceptance.yml` for the same pattern; route any open-coded copy through the script.

4. **§1.8 HIGH — `bash -n` lint gap.** Implementation deferred to **Phase 8** alongside the workflow-input inventory; flagged here so it isn't lost.

5. **§1.4 MED — dead `outputs.finalizable` on `find-finalizable`.** Delete `daily-activity.yml:107–108` `outputs:` block; the consumer reads `aggregate-finalizable.outputs.finalizable`.

6. **§1.6 LOW — `inputs.org` regex.** Tighten to `^[A-Za-z0-9](?:-?[A-Za-z0-9]){0,38}$` in `daily-activity.yml:20` (and audit every other workflow with `inputs.org`/`inputs.target_org` for the same loose anchor — at minimum `setup-org.yml`).

7. **§1.5 LOW — `disable-when-empty` vs `check-idle`.** Reviewer marked "leaving as-is is fine." **No change.** Drops out of plan.

8. **§1.2 retracted.** No-op.

DRY cluster #4 (`find-orgs` job duplicated across 4 workflows) is large enough to warrant its own commit — schedule it at the end of Phase 1 as a reusable workflow (`.github/workflows/_find-orgs.reusable.yml`, `workflow_call`, emits `orgs` JSON output). Replace the open-coded job in `daily-activity.yml`, `regenerate-dashboard.yml`, `reconcile-registry.yml`, `weekly-usage-report.yml` with `uses: ./.github/workflows/_find-orgs.reusable.yml`.

DRY cluster #3 (JSON-write heredocs in `acceptance-handler.yml` + `retry-acceptance.yml`) is partly resolved by §1.1 above. If `retry-acceptance.yml` still has an open-coded JSON-via-heredoc, route it through the new `write-repository-record.mjs` (or a sibling) in the §1.1 commit.

---

## Phase 2 — `lib/` (§2)

DRY cluster #1 (lib/gh.mjs ↔ scripts/lib/gh.mjs) anchored at §2.4.

1. **§2.1 HIGH — `lib/audit.mjs:92` reads `participating-orgs.json` but the file is `.yml`.**
   - Switch the request to `participating-orgs.yml?ref=participating-orgs`.
   - Replace the `JSON.parse(raw)` at L102 with `parseYaml(raw)` (import from `lib/yaml.mjs`).
   - Update the failure messages (L94, L97, L104, L108) to say `participating-orgs.yml`.
   - The `lib/yaml.mjs` parser already works in Node and browser contexts (no Node-only deps). Confirm SPA bundle still tree-shakes cleanly.

2. **§2.4 MED + DRY cluster #1 — two HTTP carriers.**
   - Promote `lib/gh.mjs` to canonical. Port `ghAll` and `ghAllItems` from `scripts/lib/gh.mjs` over, preserving the existing `{status, ok, data, remaining}` return shape (callers in `lib/` and the SPA depend on it).
   - Add an opt-in `throwOnError: true` mode to match `scripts/lib/gh.mjs`'s contract (throws on non-2xx). All script callsites pass this flag during migration; behavior unchanged.
   - Reconcile retry counts on the way: take the longer budget from §6.5 (`[500, 1000, 2000, 4000, 8000, 16000]`, ~31.5 s).
   - Delete `scripts/lib/gh.mjs`. Rewrite every script that imports from it (`scripts/usage-fetch.mjs`, `scripts/usage-notify.mjs`, any others surfaced by grep) to import from `lib/gh.mjs`.

3. **§2.3 LOW — `escape()` in `atobSafe` (`lib/audit.mjs:217`).**
   - Replace with `new TextDecoder().decode(Uint8Array.from(atob(compact), c => c.charCodeAt(0)))`.
   - Drop the `catch { return atob(compact); }` mojibake fallback — `TextDecoder` does not throw on the inputs we send it; if base64 itself is malformed, let the outer caller's `try/catch` see it.

4. **§2.2 LOW — obsolete `"pull"` permission compare (`lib/audit.mjs:138`).** Delete the `&& got !== "pull"` clause.

5. **§2.5 / §2.6 OK.** No-op.

§6.5 (retry budget bump) is folded into §2.4 above. §2.3 fix is mirrored in §5.1 (frontend `atob`) — keep the wording identical for the symmetry.

---

## Phase 3 — Composite actions (§3)

1. **§3.1 HIGH — legacy `template_owner`/`template_repo` shape.**
   - Add a one-paragraph note to `RUNBOOK.md` under "Migrating legacy assignments": describe the schema rename and link to a one-shot migration recipe (`yq` or a tiny `scripts/migrate-template-fields.mjs`). Same commit per CLAUDE.md memory rule.
   - No code change in `accept.mjs` itself — the existing `catch` at L177 surfaces `fail:exception`, which is correct for unmigrated YAML; the runbook note is the fix.

2. **§3.3 MED — dead smart-schedule branches (`collect/collect.mjs:163–178`).**
   - Delete the `if (cfg.cronSchedule.includes('*/15'))` and `else if (… '*/6' …)` branches and any state they set. Verify by grep that nothing downstream reads the values the dead branches were producing.

3. **§3.4** — cross-reference to §1.7, already addressed in Phase 1.

4. **§3.2 OK.** No-op.

---

## Phase 4 — CLI (§4)

DRY clusters #5 and #6 (`resolveOrg`, `fetchAssignment`/`fetchReport`) folded here. §4.6 OK retains the defensive `Number(test.timeout_s)` cast.

1. **§4.1 MED — `roster.mjs` `JSON.stringify` diff is key-order-sensitive.**
   - Add `cli/src/lib/stable.mjs` (≤20 LOC) exporting `stableStringify(obj)` — key-sorted JSON. Replace `JSON.stringify(prev) !== JSON.stringify(entry)` (`roster.mjs:147`) with `stableStringify(prev) !== stableStringify(entry)`.

2. **§4.2 LOW — dead `request: { retries: 3 }`.**
   - Default plan: bump `cli/package.json` `@octokit/rest` to `^22.0.1`, add `@octokit/plugin-retry@^8.1.0`. In `cli/src/lib/octokit.mjs`, `import { Octokit } from "@octokit/rest"; import { retry } from "@octokit/plugin-retry"; const RetryOctokit = Octokit.plugin(retry);` and replace the `new Octokit({…, request: { retries: 3 }})` call with `new RetryOctokit({…})`.
   - Smoke-test: `node cli/bin/pxl-classroom.mjs --help`; `npm test` in `cli/`. If the v22 bump surfaces import/type breakage, fall back to deleting the `request: { retries: 3 }` line and documenting "CLI does not retry on rate-limit; rerun the command" in a one-line comment.

3. **§4.3 LOW — Windows guard in `runner-host.mjs`.**
   - At the top of `runHost`, add `if (process.platform === "win32") throw new Error("host runner is POSIX-only — use --runner=docker on Windows");`.

4. **§4.4 LOW + DRY cluster #5 — `resolveOrg` duplicated 5 times.**
   - Add `cli/src/lib/org.mjs` exporting `resolveOrg({ flag, config, save = false })` matching the most thorough of the existing five copies (the one in `audit.mjs` and `roster.mjs` are identical — start from those).
   - Rewrite imports in `audit.mjs`, `roster.mjs`, `feedback.mjs`, `download.mjs`, `grade.mjs`.
   - Run all CLI tests; smoke `--help`.

5. **§4.5 LOW + DRY cluster #6 — `fetchAssignment` / `fetchReport`.**
   - Add `cli/src/lib/control-repo.mjs` exporting `getAssignment(octokit, { org, assignmentId })`, `getReport(octokit, { org, assignmentId })`, and (defensive) `listRepoRecords(octokit, { org, assignmentId })`.
   - Rewrite imports in `grade.mjs`, `feedback.mjs`, `download.mjs`.

6. **§4.7 / §4.8 / §4.9 / §4.6 OK.** No code change. §4.6 closing note picked up as defensive `Number(test.timeout_s ?? 30)` cast in `runner-docker.mjs` lines 72 / 79 — fold into §4.3 commit (both files are runner-related).

DRY cluster #8 (worker-pool concurrency in `grade.mjs` and `download.mjs`) — review marks "not large enough to warrant extraction." **Skip.** Re-evaluate if a third caller lands.

---

## Phase 5 — Frontend (§5)

DRY cluster #7 (hub owner/repo hardcoded across 5 Vue views) anchored at §5.1.

1. **§5.1 HIGH + DRY cluster #7 — `getRepoContent` garbles UTF-8 + hub owner/repo hardcoded.**
   - Rewrite `frontend/src/lib/api.js:130`: `const bin = atob(res.data.content.replace(/\n/g, '')); return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));` (symmetric inverse of `commitFile` at L172).
   - Same commit: add `hubOwner` and `hubRepo` to `frontend/src/config.js`, sourced from `VITE_HUB_OWNER` / `VITE_HUB_REPO` with the current defaults. Rewrite every hardcoded `('PXL-Digital-Application-Samples', 'pxl-classroom')` in `AdminView.vue:645`, `:726`, `AssignmentDetailView.vue:837`, `UsageView.vue:190`, `UsageOverviewView.vue:249`, `SystemHealth.vue:88` to read from `config.js`.
   - Manual verification: build the SPA (`cd frontend && npm run build`), serve `dist/`, load `/`, `/dashboard/<org>`, `/dashboard/<org>/<assignment>`. Trigger one workflow dispatch (publish-assignment) to confirm the new `hubOwner`/`hubRepo` actually point at the right repo.

2. **§5.2 MED — CORS proxy URL normalization.**
   - Replace the regex normalization at `frontend/src/lib/auth.js:24` with an explicit contract: `VITE_CORS_PROXY_URL` MUST end in `?url=` or `?` (`?` is auto-rewritten to `?url=`); anything else throws at SPA init.
   - Update `tests/cors.test.mjs` per Phase 9.
   - Document the contract in `RUNBOOK.md` (CORS proxy section) — same commit per the doc rule.

3. **§5.4 MED — `SystemHealth.CACHE_MS` dead.**
   - Wire the cache (recommended path): early-return in `run()` when `Date.now() - lastRunAt.value < CACHE_MS && result.value` and the user didn't click a manual-refresh affordance.
   - Add an explicit "Refresh" button on the panel that bypasses the cache.

4. **§5.5 LOW — serial open-assignments loader (`HomeView.vue`).**
   - Replace the `for (const org of data.orgs) { await fetch(…) }` loop with `await Promise.all(data.orgs.map(async (org) => …))`. Preserve per-org error isolation (catch around the body so one slow/failing org doesn't kill the others).

5. **§5.6 LOW — `refreshLiveStatus` doesn't watch its rate-limit budget.**
   - In `refreshOne`, read `res.headers.get('X-RateLimit-Remaining')`. If below 200, set a shared `halted` ref that workers check between iterations and surface a toast: "GitHub rate limit approaching — refresh halted. Resets at <ISO>."
   - Replace the one-shot `/rate_limit` fetch at L705 with reading the headers from the most recent `refreshOne` response.

6. **§5.7 LOW — cross-root import in `AssignmentDetailView.vue:354`.**
   - Verify `frontend/vite.config.js` `server.fs.allow` includes the repo root. If not, add it.
   - Add a one-paragraph note to `RUNBOOK.md` under "Setup": "Do not move `frontend/` to a subdirectory without updating `vite.config.js` `server.fs.allow` — `lib/dashboard-aggregate.mjs` is imported from outside the SPA root."

7. **§5.8 LOW — `v-html` in `Icon.vue`.**
   - Add a one-line comment above the `v-html` directive: `<!-- safe: paths is a static lookup, never user data -->`.

8. **§5.10 — `referrerpolicy="no-referrer"` on avatar `<img>`.** Add to the `UserBadge.vue` avatar element; one-line change.

9. **§5.3 / §5.9 / §5.11 OK.** §5.3 absorbed into §5.1 above. §5.9 / §5.11 no-op.

---

## Phase 6 — Schemas & scripts (§6)

1. **§6.1 HIGH — `find-finalizable.mjs` window.**
   - Widen the lower bound from `now - 60 * 60 * 1000` to `now - 25 * 60 * 60 * 1000` at `scripts/find-finalizable.mjs:24`. Update the comment from "within the last hour" to "within the last 25 hours (one full cron interval + slack)".

2. **§6.2 MED — delete `scripts/disable-if-idle.mjs`.** Dead + broken. Single-file `rm`. Confirm with a final `grep -r disable-if-idle` that only this plan + `CODE_REVIEW.md` reference it.

3. **§6.3 MED — delete `scripts/parse-assignment-metadata.mjs`.** Dead + divergent. Same as §6.2.

4. **§6.9 MED — `grading-result.schema.json` missing `required` entries.** Add `"total_points"` and `"earned_points"` to the `required` array at `schemas/grading-result.schema.json:7-16`.

5. **§6.4 LOW — regex YAML parser in `get-participating-orgs.mjs`.**
   - Rewrite to: `import { parse } from "yaml"; import { readUtf8OrFail } from "./lib/encoding.mjs"; const o = parse(readUtf8OrFail("participating-orgs.yml")); process.stdout.write(JSON.stringify((o.orgs || []).map(x => x.login)));`.
   - Preserve the stdout JSON-array shape (consumed by the `find-orgs` workflow job).

6. **§6.6 LOW — `update-json-field.mjs` no post-write validation.**
   - Add optional `--schema <name>` flag; if present, load `schemas/<name>.schema.json`, run `validateAgainst()`, exit non-zero on failure (file is still rewritten, so the caller sees the issue immediately on next run). All current invocations from workflow YAML are reviewed in the same commit; pass `--schema acceptance` etc. where appropriate.

7. **§6.5 LOW.** Folded into §2.4 above.

8. **§6.7 / §6.8 / §6.10 OK.** No-op.

---

## Phase 7 — Dependencies (§8)

1. **§8.1 LOW — engines floor.**
   - `cli/package.json`: `"engines": { "node": ">=24" }`.
   - Root `package.json`: add `"engines": { "node": ">=24" }`.
   - `frontend/package.json`: add `"engines": { "node": ">=24" }`.

2. **§8.2 LOW — shared dep floor drift.**
   - Root `package.json`: bump `ajv ^8.16.0 → ^8.20.0`, `ajv-formats ^3.0.0 → ^3.0.1`, `yaml ^2.4.0 → ^2.9.0` to match `cli/` and `frontend/`.
   - Run `npm install` at root; commit the resulting `package-lock.json`.

3. **§8.3 LOW — floating tags in `cli-ci.yml`.** Already covered in Phase 8 (§7.3 CI wiring) — kept here for traceability.

§4.2's `@octokit/rest` v22 + plugin-retry@8 bump (Phase 4) is the only other dep movement.

---

## Phase 8 — CI wiring (§7.3 + §1.8 lint)

Lints come last because they exist primarily to catch regressions during Phases 1–7 if any slip back in.

1. **CLI tests merged into the main CI workflow.**
   - Rewrite `ci.yml` `Run unit tests` step to run both globs: `node --test tests/*.test.mjs cli/tests/*.test.mjs`.
   - Delete `cli-ci.yml` entirely (its path-filter no longer serves a purpose). Reduces CI surface and eliminates the SHA-pinning drift of §8.3.

2. **`bash -n` lint over workflow `run:` blocks.**
   - Add a `lint-workflows` job to `ci.yml`. Step: `node scripts/workflow-lint.mjs` — walks `.github/workflows/*.yml` and `*/action.yml`, extracts each `run:` block whose effective shell is bash, writes to a tmp file, runs `bash -n`. Fails on any non-zero exit or stderr.
   - This is the §1.8 lint test mentioned in `CODE_REVIEW.md`; the runtime lint replaces a unit test.

3. **`pull_request` trigger surface.**
   - CLAUDE.md says "No pull requests." Verify with `gh pr list --state open --repo PXL-Digital-Application-Samples/pxl-classroom` (and history `gh pr list --state all --limit 20`) that there are no PRs in flight before deleting the `pull_request:` trigger from `ci.yml:4`. If any open, leave as-is and add a one-line comment instead.

4. **`actionlint` integration.**
   - Add `actionlint` to the lint job (download official binary in CI, pin its SHA). Same job as `bash -n`. Catches the §1.7 dash/underscore mismatch class as a primary defense; the unit inventory test (Phase 9) becomes a backstop.

5. **Per-workflow `permissions:` audit (§10.5).**
   - Walk every `.github/workflows/*.yml`. Confirm each has an explicit top-level `permissions:` block, scoped to the minimum (most: `contents: read`; commit-emitting jobs add `contents: write`; nothing requests `id-token: write` unless OIDC is intended). Add missing blocks; tighten any over-broad ones.

---

## Phase 9 — Tests (§7.5 — ALL P0–P3)

Per the operating contract: all production fixes have shipped. This phase adds the regression nets.

### P0 (5 tests — the trust-boundary + invariants safety net)

1. **`tests/accept.test.mjs`** — full truth table for `acceptance/accept.mjs`:
   - All 9 `fail:*` / `rejected:*` exit categories.
   - `SLUG` + `LOGIN` regex rejection paths (negative fixtures: `../foo`, `foo/bar`, leading dash, etc.).
   - Idempotency: re-accept after `<login>.json` exists returns `already-accepted` without writing.
   - `max_acceptances` cap math at boundary.
   - `deriveRepoName` `{github_login}` substitution + `{login}` legacy mis-match.
   - `template.{owner,repository}` reads happy path + legacy `template_owner` failure.
   - Target: ~150 LOC fixture builder + 10 cases. The single highest-leverage missing test in the repo (§10.1).

2. **`tests/find-finalizable.test.mjs`** — deadline-window truth table:
   - Deadline 30 min ago → in-window.
   - Deadline 90 min ago → in-window (regression for §6.1).
   - Deadline 24 h ago → in-window.
   - Deadline 26 h ago → out-of-window (already finalized).
   - `lockdowns/<id>/lockdown-record.json` exists → skip (idempotency).
   - `state != 'published'` → not counted in `activeCount`.

3. **`tests/scripts-inventory.test.mjs`** — every `scripts/*.mjs` is referenced by at least one workflow YAML, action YAML, another script, or `package.json`. Would have caught §6.2 + §6.3.

4. **`tests/workflow-input-names.test.mjs`** — every `with:` key on a `uses: ./<action>` invocation in `.github/workflows/*.yml` matches a key in the target `*/action.yml`'s `inputs:`. Would have caught §1.7.

5. **`tests/workflow-bash-syntax.test.mjs`** — covered by Phase 8's runtime lint (a `node --test` wrapper that calls the same `scripts/workflow-lint.mjs`). Listed here for completeness.

### P1 (5 tests — high-value gaps)

6. **`tests/usage-fetch.test.mjs`** — ISO week computation + repo→org→global threshold override resolution chain.

7. **`tests/get-participating-orgs.test.mjs`** — equivalence to `parseYaml(...).orgs.map(o => o.login)` on representative fixtures (post-§6.4 rewrite this becomes a regression net for the parser swap).

8. **`cli/tests/grade.test.mjs`** — `checkoutArchive` SHA-mismatch guard, worker-pool queue order, `validateAgainst("grading-result", ...)` wiring, dry-run vs commit paths.

9. **`tests/audit.test.mjs`** — `EXPECTED_APP_PERMISSIONS` shape; `runAudit` against a mocked installation (happy path + missing perm + missing scaffold + missing org from `participating-orgs.yml` — last one is the regression for §2.1).

10. **CI wiring** — already merged in Phase 8. Listed in §7.5 P1 row 9 for traceability.

### P2/P3 (5 tests — defense-in-depth)

11. **`tests/gh.test.mjs`** — retry curve + `Retry-After` honoring. Single-carrier post-§2.4 consolidation.

12. **`tests/encoding.test.mjs`** — UTF-16 LE/BE/BOM rejection paths in `scripts/lib/encoding.mjs`.

13. **`tests/dashboard-aggregate.test.mjs`** — `buildDashboardEntry` truth table.

14. **`tests/cors.test.mjs` rewrite** — mock fetch, drive the device-flow state machine; cover the §5.2 explicit-contract throw path and the proxy-URL-with-no-trailing-`?` case.

15. **`cli/tests/runner-docker.test.mjs`** — argv shape assertion (verifies `--network=none`, `--read-only`, `--memory=512m`, `--pids-limit=256`, `--tmpfs /tmp:rw,size=64m`, workspace `:ro`, `--init` are all present). Defense for §4.6 if anyone touches the sandbox flags.

### Cross-surface invariants (§7.4 — folded into the P0 inventory tests)

- "Every `scripts/*.mjs` referenced" — covered by test #3.
- "Every workflow `with:` key matches action `inputs:`" — covered by test #4.
- "Every `run:` parses with `bash -n`" — covered by Phase 8 lint + test #5.
- "Every script writing JSON validates against its schema before write" — added lint pass to `scripts/workflow-lint.mjs` in Phase 8 (greps for `writeFile.*JSON.stringify` not preceded by `validateAgainst`).
- "`EXPECTED_APP_PERMISSIONS` imported by both `cli/src/commands/audit.mjs` and `frontend/src/views/SetupView.vue`" — covered by test #9.
- "`cli/src/lib/gittree.mjs` ≤ 30 lines (adapter only)" — add as one assertion inside test #4 (workflow-input-names is the closest invariant-test file).
- "SPA-serialized YAML passes `validateAgainst('assignment', …)`" — add to a small `tests/assignment-roundtrip.test.mjs` that imports the SPA's serializer (if exported) or feeds representative shapes from `AdminView.vue` through the schema. Tag as **P3 stretch**; skip if the serializer is not module-exportable.
- "`accept.mjs` reads a subset of `assignment.schema.json` properties" — fold one assertion into test #1.

---

## Phase 10 — Final cleanup

1. `git rm CODE_REVIEW.md REVIEW_FIX_PLAN.md`.
2. Verify `git grep -E "CODE_REVIEW|REVIEW_FIX_PLAN"` returns nothing.
3. Commit message: `docs: remove CODE_REVIEW + REVIEW_FIX_PLAN after closure`.
4. Final `npm test` run on `main` to confirm green.

---

## Risk register

- **§1.1 (write-repository-record.mjs):** the new script becomes load-bearing for every acceptance. Pair the fix commit with `tests/accept.test.mjs` (P0 #1) being **brought forward** into Phase 1 if the BLOCKER feels risky to ship un-netted. (Default plan: write the test in Phase 9 against the fixed code; bring it forward only if the Phase 1 commit author judges the risk warrants it.)
- **§1.7 (dash/underscore):** the misrouted defaults at L82-83 were *accidentally* benign because they matched the action defaults. The fix changes from "wrong inputs but benign defaults" to "correct inputs" — confirm `collect.mjs` handles `assignment-id=''` + `collection-type='scheduled'` the same way it did pre-fix (which the review confirms it does).
- **§2.1 (yaml participating-orgs):** the change drops a (false) warning from System Health. No worse than today if the fetch fails for any other reason.
- **§4.2 (`@octokit/rest` v22 bump):** moderate-risk dep major. Fall-back path documented above. Smoke-test all five CLI command paths after the bump.
- **§5.1 (UTF-8 decode):** changes what the Admin Panel renders for any base64 content. Visually verify roster, override, and report views after deploy.
- **Phase 8 (`actionlint` introduction):** likely to surface additional findings beyond this review. Triage as discovered; do not let scope-creep block the lint job from landing.

---

## Done definition

- All commits from Phase 1 through Phase 10 are on `main`.
- `npm test` green on every commit.
- `CODE_REVIEW.md` and `REVIEW_FIX_PLAN.md` are removed from the tree (Phase 10).
- One acceptance event runs end-to-end on a real org and produces a valid `repositories/<id>/<login>.json` in the control repo (BLOCKER §1.1 closure proof).
- One nightly `daily-activity.yml` run completes a `finalize` matrix leg with `lockdown` + `preserve` outputs both non-empty (BLOCKER §1.7 closure proof).
- `ARCHITECTURE.md`, `RUNBOOK.md`, `CLAUDE.md` reflect all behavioral changes; no orphan references to removed scripts or docs.
