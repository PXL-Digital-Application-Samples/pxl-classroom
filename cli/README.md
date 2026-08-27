# `pxl-classroom` CLI

Command-line companion for PXL Classroom - for lecturer-side operations where
clicking through the Admin Panel scales poorly. Same GitHub App, same
device-flow auth, same schemas as the SPA.

Command groups:

| Command | Purpose |
|---|---|
| `auth login \| status \| logout` | Device-flow authentication, cached token |
| `roster import \| list` | CSV roster import with diff preview (`--dry-run`) |
| `roster promote \| unlink` | Fold acceptances or claim bindings into the roster; remove a claim binding |
| `audit` | Read-only install health checks (exit 0/1/2 for CI) |
| `sync-starter` | Smart starter code update sync (auto-merge to main + PR fallback) |
| `feedback open \| list` | Draft Feedback PRs per student (idempotent) |
| `download` | Bulk-fetch preserved submissions from the archive repo |
| `grade` | Run autograde tests against preserved SHAs (docker/host) |
| `teams seed \| unseed \| list \| sources` | Carry an existing grouping into a group assignment |

See RUNBOOK §12 for per-command how-tos.

## Install

From a clone of the hub repo:

```bash
cd pxl-classroom
npm install        # installs CLI workspace deps
npm link --workspace=cli
pxl-classroom --help
```

A `gh extension install` distribution may follow later; the npm-link form is
the supported path.

## First-run

You'll need the PXL Classroom App's client ID (an `Iv…` string). Find it on
the App's settings page under "About", on the `/setup` completion screen right
after creating the App, or in the hub's repo secrets as `PXL_APP_CLIENT_ID`.

```bash
pxl-classroom auth login --client-id Iv23li…
# -> prints a verification URL + 8-character code
# -> opens the App's authorization page in your browser
# -> token cached at ~/.config/pxl-classroom/token (0600)
```

After the first login the client ID is remembered:

```bash
pxl-classroom auth status   # who am I, when did I auth, where is the token?
pxl-classroom auth logout   # wipe the cached token (config preserved)
```

Set `PXL_APP_CLIENT_ID` in your shell to skip the `--client-id` flag.

## Carrying groups forward (`teams`)

Group membership is stored per assignment, so a second group assignment would
otherwise make students re-form the same teams. `teams seed` copies an existing
grouping into a target assignment; students then confirm the group they already
work in with one click.

```bash
pxl-classroom teams sources --org PXLAutomation
pxl-classroom teams seed --org PXLAutomation   --from linux-processes-2026 --to linux-networking-2026 --dry-run
```

`--dry-run` prints the plan and writes nothing. Drop it to apply: every team
lands in one commit and `regenerate-dashboard.yml` is dispatched so the teams
become visible to students (`--no-publish` skips that, and they stay hidden).

- `--from-roster` uses the roster's `team_slug` / `team_name` columns instead of
  a previous assignment - the bootstrap case, before any group assignment exists.
- `--yes` applies without prompting when the plan has warnings. Without a TTY and
  without `--yes`, a plan with warnings exits non-zero rather than guessing.
- Exit code 2 means the plan was refused outright: a team larger than the target's
  maximum team size, a repository name pattern shared with the source (which would
  hand students the previous assignment's repositories), or a pattern with no
  `{team_slug}`.

`pxl-classroom teams list --assignment <id>` prints the manifests, marking which
teams were seeded and from where.

Seeded the wrong source? `teams unseed` reverses it:

```bash
pxl-classroom teams unseed --org PXLAutomation --assignment linux-networking-2026 --dry-run
```

It deletes, in one commit, only the teams that came from a seed, own no
repository, and have no member with an acceptance record - anything a student
has already joined is listed as kept. The removability rule is the same
`planUnseed` the web UI's "Undo seed" button uses.

## Configuration

| Location | Purpose |
|---|---|
| `~/.config/pxl-classroom/config.json` (POSIX) | client_id, last-used org. JSON, 0600. |
| `~/.config/pxl-classroom/token`              | OAuth user token + scopes. JSON, 0600. |
| `%APPDATA%\pxl-classroom\…` (Windows)        | Same files, Windows-native location. |

`XDG_CONFIG_HOME` is honored.

## Design notes

- HTTP via `@octokit/rest`. The same multi-file commit primitive backing the
  CLI lives at `../lib/gittree.mjs` and accepts an Octokit-style request fn
  so the same module can later be reused by workflow scripts and the SPA.
- Schemas are read from `../schemas/` - no fetch, no drift versus the SPA.
- Ctrl-C exits immediately (exit code 130). Long operations (`grade`,
  `download`) are resumable - results are written per student, so a re-run
  picks up where the interrupted run stopped.
