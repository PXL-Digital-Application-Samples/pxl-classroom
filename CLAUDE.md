# CLAUDE.md

Working conventions for `PXL-Digital-Application-Samples/pxl-classroom`.

**This file is instructions only.** What the system *is* → [ARCHITECTURE.md](ARCHITECTURE.md). How to operate it → [RUNBOOK.md](RUNBOOK.md). How it looks → [DESIGN.md](DESIGN.md). **Why any rule below exists** — what broke, what was measured — → [LESSONS.md](LESSONS.md), searchable by the rule's own wording. Read the lesson before changing or arguing with a rule; nearly every one is here because it already went wrong.

## Git

- **No pull requests.** Commit and push directly to `main`. Never branch "to be safe".
- End commit messages with the standard `Co-Authored-By` trailer.
- **Push with `$env:GITHUB_TOKEN=""; git push origin main`** (PowerShell) — a dummy token in the environment otherwise fails the auth.
- **No backticks in a double-quoted `git commit -m`.** The shell substitutes them before git sees the string and the fragment vanishes silently; `main` blocks force-push so it cannot be amended. Use single quotes for any `-m` containing a backtick, `$` or `!`.

## Working style

- Be terse and concrete. Do things rather than explain them; give exact values and clicks when the user must act.
- Don't ask for command approval — permissions bypass in `.claude/settings.local.json`.
- **NEVER edit a file through a shell heredoc.** No `python3 - <<'EOF'`, no `cat > file <<'EOF'`, no `node -e`. Use **Edit** for targeted replacements and **Write** for whole files: the shell and the interpreter both process escapes before the code runs, so regexes and string literals are silently mangled. If a repo-wide sweep is genuinely unavoidable, **Write** the script to a real file, run it, delete it. Bash stays correct for reading, searching, git and tests.
- **A scripted transform must be verified by something that does not share its logic.** A checker built from the same function as the transform validates its own bug.

## Linting

- **`npm run lint` is the only lint command, and CI runs exactly it.** `scripts/lint.mjs` owns all three checks (eslint, `scripts/workflow-lint.mjs`, actionlint + shellcheck); `ci.yml` calls nothing else.
- **actionlint and shellcheck are pinned identically** — a release asset fetched into gitignored `.tools/` and verified against a SHA-256 in `scripts/lint.mjs`. Never from npm, never by piping a script from a branch into bash. A tool that cannot be obtained, or a platform with no pinned digest, **fails** the run. There is no skip flag.
- **Keep every `run:` block under 3500 bytes.** Over ~4 KB actionlint deadlocks on Windows while CI stays green. Split the step; do not raise the cap.
- A genuine shellcheck false positive gets `# shellcheck disable=SC<code>` with a comment saying why.

## Documentation

- **ARCHITECTURE.md, RUNBOOK.md, ADMIN.md and INSTALL.md describe the system as it IS.** A past incident belongs in LESSONS.md, never in them.
- **The operational docs are split by audience, and a procedure goes where its reader is.** `RUNBOOK.md` is the lecturer's (publishing, deadlines, grading, a student who is stuck); `ADMIN.md` is the administrator's (onboarding an org, budgets, App permissions, incidents); `INSTALL.md` is the one-time institutional setup. A procedure filed under the wrong audience is invisible — "Invitation Exposure is failing" sat inside the *Claim keypair* setup subsection for months.
- When architecture or procedure changes, update `ARCHITECTURE.md`, `RUNBOOK.md` and this file **in the same commit**. A new rule here gets its story in `LESSONS.md` in that same commit.
- **A reference table lives in exactly one section; everywhere else links to it.** Every doc defect found in the 2026-08-31 audit was one fact written twice with one copy updated — a permission table that had drifted four ways, tokens spelled as dark-only hex, "one GitHub App" after there were two. Before writing a list down, check whether it already exists somewhere.
- **Section numbers are a public API — count the references before renumbering one.** Code comments, tests and workflow YAML cite them (`§4.3.2` has 62 references), and a reference to a section that no longer exists renders as ordinary text. Sweep on an exact string, then verify against the headings the documents actually declare.
- Do not add top-level planning, progress or review documents — the project stopped using them. `OPEN-ITEMS.md` is the one exception and is not a plan: it is a standing register of known infrastructure gaps, every entry carrying the command that says whether it is still open. Nothing goes in it that a procedure could state instead, and an entry is closed from evidence, never from memory.

---

## Credentials and workflow safety

Breaking one of these has cost this project a real incident. They are not style.

- **No value is composed into a script, anywhere.** `${{ }}` is substituted into the script *text* before bash or the JS parser sees it, so the question is never "is this attacker-reachable" but "is this a literal I wrote". Everything else goes through `env:`. Applies to composite `action.yml` too.
- **No attacker-controlled text may reach a shell on a broker.** A broker is public and holds a credential; the issue *body* is never read there — the hub fetches and validates it.
- **Hub credentials only run from `main`.** Every job reading `PXL_APP_PRIVATE_KEY`, `PXL_INVITE_SIGNING_KEY`, `PXL_CLAIM_PRIVATE_KEY` or `PXL_BROKER_PRIVATE_KEY` declares `environment: provisioning`. Never put them in workflow- or job-level `env:`. They are environment secrets with **no repository-level copy**.
- **Every dispatchable workflow that reads a hub credential rejects a `[bot]` actor as its first step** — unless another workflow legitimately dispatches it, or a guarded job sits upstream in its `needs:` graph.
- **The provisioning App's key never reaches a broker.** Brokers hold the *broker* App's key: hub repo only, `contents: write` only. Publishing fails closed if it is unset rather than falling back.
- **Every action is pinned to a SHA**, never a tag. App tokens are minted with `client-id`, never `app-id`.
- **Credentials never appear in a git command line or a remote URL.** Use `http.<host>/.extraheader`, and unset it in a `trap … EXIT` — `git config` writes the header into `.git/config` exactly as an embedded credential would, so the on-disk copy is the residual and the step that dies mid-push must not be the one that leaves it behind.
- **`.tools/`, `.claude/` and `.env*` stay gitignored.** GitHub push protection blocks provider tokens, but not the P-256 keys this system mints.
- **Two entry points run with NO `npm ci`** — `scripts/verify-invite-token.mjs` on the broker and `scripts/scaffold-control-repo.mjs` in `setup-org.yml`. A bare specifier anywhere in either import graph is a total outage, not a slow start. `#deployment` is the live trap.
- **`git add <dir>/` is fatal when the directory is absent** — exits 128 and stages nothing, *including the pathspecs that did match*. `mkdir -p` immediately before it, within four lines. **`|| true` is not the fix, it is the worse failure**: the step then stages nothing, `diff --cached --quiet` is true, and it exits 0 reporting "no changes". `git add -A` is safe — no pathspec to miss.
- **`gh` writes API errors to stdout.** Guard on the exit code, then validate the shape; `--jq` prints the string `null` for a missing field.
- **Narrowing a GitHub App permission is instant; restoring one needs every org owner to approve.** Check the code, not the changelog, before removing one.

## Rules that keep being rediscovered

- **One page is not the list.** A list endpoint returns a page; a statement about the whole collection needs the walk. Where a walk is capped, the capped case may not report `ok`.
- **A GitHub login is compared and indexed lowercased** — `lib/github-login.mjs`, never a hand-written `.toLowerCase()`. The spelling a lecturer types into a roster CSV and the one GitHub dispatches are the same account; four indexes in `report.mjs` keyed the raw string and a single student became two rows.
- **A "pick ours out of the list" helper returns null when ours is absent.** `|| list[0]` turns "not installed" into somebody else's installation, and "no grading run" into full marks off an unrelated green check.
- **A deployment.yml value is read, never re-spelled.** JavaScript imports `#deployment`; YAML cannot, so `tests/deployment-literals.test.mjs` checks the workflows and the CORS Worker against it.
- **Unreadable is not evidence.** A read that failed yields *no* check, never a green one and never "none found".
- **Absent and empty are different answers.** A truthy check silently re-imposes a rule someone deliberately removed.
- **A schema field spelled wrong compares as a constant.** Report rows are `additionalProperties: false`, so `s.status` (the field is `submission_status`) is `undefined` on every row and `!== 'x'` is always true — which counted a whole roster as having accepted. `===` fails closed and is survivable; `!==` fails open. `tests/report-row-fields.test.mjs` sweeps comparisons against undeclared row fields; a dead `||` fallback is deliberately not flagged.
- **Two conditions that must agree are ONE named boolean.** `report.mjs` guarded `submission_status` with `firstLateSha !== lastOnTimeSha` and, twenty-five lines below, flagged the warning with the weaker `if (firstLateSha)` — so a finished exam cohort read `on-time` while every row also carried "late activity". An observation is a collector run, not a commit: re-reading an untouched repo after the deadline sets the two SHAs equal. `tests/report.test.mjs`.
- **Fail closed.** An unrecognised `roster_mode` is `enforced`; an absent nonce rejects; an absent `lock_down_enabled` is `true`. Never relax one of these to match a form default.
- **Merge, never replace.** A document rebuilt field-by-field from what a form shows drops whatever nobody listed. Read the stored document, spread it, override only what changed — and validate before committing.
- **One source of truth per cross-surface concern.** Don't fork a shared `lib/` module into a second implementation; the tests fail if you do.
- **Identical names over different constants are not a fork.** Two modules may legitimately declare the same name at different sizes — the guard's job is to stop the merge, not perform it.
- **A guard whose anchor was renamed checks nothing, silently.** `indexOf` returns -1 and `slice(-1)` still returns a string, so an absence assertion passes vacuously.
- **A mock that accepts anything tests nothing.** Fixtures validate what the app writes against the real schema — and a fixture must be the shape the app *actually writes*, not one the test invented. A lockdown test built one team-shaped repository record where production writes one per login; a "contract" test reimplemented `buildDoc()` and drifted past the signed-acceptance keypair. Both passed for months against code that could not work.
- **A click handler that copies, opens a window or goes fullscreen must not `await` first.** After an `await` the engine stops *attributing* the call to the handler, so the clipboard write is refused and the pop-up is blocked — in Firefox, while Chrome forgives it, which is how it ships green and breaks in production. Do the synchronous thing inside the gesture; spend the async API only when there is nothing left to lose. `tests/device-flow-clipboard.test.mjs`.
- **Never set a success flag before the operation resolves.** `ok = true` beside an un-awaited promise whose rejection goes to `() => {}` is a UI that lies. It cost sign-in: the device-flow button reported "Copied" over an empty clipboard, so students had no code to paste. Await it, or report failure.
- **A guard that greps for a branch cannot tell it is reachable.** The test for that button asserted an `else toast…` branch existed. It did, and it was dead code. Extract the logic and run it.
- **`.catch()` on a function that resolves is not error handling, it is the look of it.** Everything in `frontend/src/lib/api.js` resolves `{ ok: false, status }` rather than throwing, so a `.catch()` chained to one never runs. Read `.ok`. `tests/button-honesty.test.mjs` sweeps for it.
- **Never re-implement the thing under test in the test.** Import it. If it cannot be imported, that is the defect.
- **Never describe behaviour the system does not have.** A control that promises a queue, a retry or a guarantee nobody implemented is worse than no control.
- **The UI never points a user at the repo's documentation** (DESIGN.md §1.6, `tests/doc-refs.test.mjs`). The runbooks are for whoever operates a deployment; a student who cannot sign in is not that person. Say what happened and who can fix it. Comments are exempt — that is where a `§` reference belongs.
- **Dry-run is sacred.** Every CLI `--dry-run` has zero side effects — no writes, no PRs, no commits.
- **Generated YAML is serialised, never concatenated.** Build an object, hand it to the `yaml` library. One exception, and it is forced: `scripts/register-participating-org.mjs` appends to `participating-orgs.yml` by hand, because `setup-org.yml` deliberately runs with **no `npm ci`** and so cannot have the `yaml` library. It is confined to that one script, both logins are validated against `^[A-Za-z0-9](-?[A-Za-z0-9]){0,38}$` beside the write, and `tests/register-participating-org.test.mjs` parses what it produces with the real `yaml` library and validates it against the schema — which is the check the rule exists to give you.
- **No inline JavaScript in workflow YAML** — `node -e`, `node -p`, `--eval`, `--print`. Extract to `scripts/`. eslint cannot see it, the tests cannot import it, and every value in it arrives by *shell* substitution into the source text.
- **Never compose an archive name or a `preserved/` URL yourself** — `lib/archive-repo.mjs` decides where a preservation *is* versus where a new one *goes*.
- **Every deadline comparison is the deadline for *that student*** — `lib/effective-deadline.mjs` decides, nothing else.
- **`observed_at` is when the collector looked, never when the student acted.** Deadline classification compares the **commit's own** timestamp; the observation time is a fallback for records that predate `commit_date`. Comparing observation time to the deadline marked two students late on a finished exam for committing 6h50m and 54m *before* it — it can only ever err in that direction, and only against students who work up to the deadline. `lock_down_at` was moved off the observation for this same reason; the rule is the field, not the one call site.
- **`max_acceptances` can overshoot, and that is a decision.** Do not "fix" it by serialising every acceptance.
- **A rejection is an outcome, not a failure.** `rejected:*` exits 0; only `fail:*` goes red.

## Frontend

- **Theming is token-only.** Every colour is declared once in `frontend/src/style.css`'s `:root` as `light-dark(...)`. No colour literal anywhere else, and no `var(--token, #fallback)`.
- **If more than one component uses a class, it belongs in `style.css`.** Scoped styles cannot reach slot content, and an undeclared class renders unstyled with no build error.
- **An isomorphic module takes configuration as a parameter and never imports it.** A static `node:` builtin import in the SPA's graph is a blank page that `npm run build` will not catch.
- **A route nothing links to does not ship.** Exactly two exemptions exist (`invitation`, `not-found`); the list may not grow without writing down why.
- **A published field is a public field.** Anything in an assignment's `title`/`description` reaches GitHub Pages; `lib/public-text.mjs` is the one judge.
- **A prop the child never declared is a DOM attribute, not configuration.** It falls through silently, and a same-named computed inside the child keeps winning — the Sandbox asked `<TeamsTable>` for the autograde variant twice and previewed the plain one. Drive the child's own inputs; `vue/no-undef-properties` and friends are errors now.
- **A wrapper that holds a modal may not carry a transform.** `transform`, `filter`, `perspective`, `will-change` or `contain` on ANY ancestor makes it the containing block for `position: fixed` descendants, so `.modal-overlay { inset: 0 }` sizes to that ancestor and the dialog renders `scrollY` pixels off-screen — a button that looks dead. `fade-in` is the trap: it ends on `translateY(0)` with `animation-fill-mode: forwards`, and an identity transform is still a transform. `tests/e2e/47-modal-in-viewport.spec.mjs`.
- **Nothing throws at module scope** in a file the SPA imports — a throw there is a blank page.
- **One primary button per view** (DESIGN.md §1.2), and never invent a `.btn-` variant that DESIGN.md does not define.

## Shape of the system

Detail in [ARCHITECTURE.md](ARCHITECTURE.md); these are the facts that change how you write code here.

- **Target platform is GitHub Team for Education. Never Enterprise.**
- **Hub-and-spoke.** All workflows live in the public `pxl-classroom` hub. Per-org control repos hold data only and contain **no** workflow files.
- **Minimal-minutes.** Synchronous provisioning, one nightly cron that disables itself when nothing is active, event-driven dashboard regeneration. The system bills zero minutes when idle — do not add polling or marker-file triggers.
- **Two GitHub Apps.** *Provisioner* does the work and is installed on every org; *Broker* does one dispatch and is installed on the hub repo alone. Never widen the broker App.
- **Sign-in needs a CORS proxy and there is no third-party substitute.** The PXL-owned Worker is **primary**; whatever answers sees the access token.
- **Everything institution-specific is in `deployment.yml`, and it is data.** A fork edits that file and nothing else.
