# `pxl-classroom` CLI

Command-line companion for PXL Classroom — for lecturer-side operations where
clicking through the Admin Panel scales poorly. Same GitHub App, same
device-flow auth, same schemas as the SPA.

Command groups:

| Command | Purpose |
|---|---|
| `auth login \| status \| logout` | Device-flow authentication, cached token |
| `roster import \| list` | CSV roster import with diff preview (`--dry-run`) |
| `audit` | Read-only install health checks (exit 0/1/2 for CI) |
| `feedback open \| list` | Draft Feedback PRs per student (idempotent) |
| `download` | Bulk-fetch preserved submissions from the archive repo |
| `grade` | Run autograde tests against preserved SHAs (docker/host) |

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
# → prints a verification URL + 8-character code
# → opens the App's authorization page in your browser
# → token cached at ~/.config/pxl-classroom/token (0600)
```

After the first login the client ID is remembered:

```bash
pxl-classroom auth status   # who am I, when did I auth, where is the token?
pxl-classroom auth logout   # wipe the cached token (config preserved)
```

Set `PXL_APP_CLIENT_ID` in your shell to skip the `--client-id` flag.

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
- Schemas are read from `../schemas/` — no fetch, no drift versus the SPA.
- Ctrl-C exits immediately (exit code 130). Long operations (`grade`,
  `download`) are resumable — results are written per student, so a re-run
  picks up where the interrupted run stopped.
