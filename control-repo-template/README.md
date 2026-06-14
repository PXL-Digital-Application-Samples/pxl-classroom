# PXL Classroom — Control Repository Template

This is the template for per-organization control repositories.

## Directory structure

```
assignments/          # Assignment definitions (YAML)
students/             # Student roster (YAML)
acceptances/          # Per-assignment acceptance records (JSON)
repositories/         # Per-assignment repository records (JSON)
observations/         # Per-assignment observation snapshots (JSON)
reports/              # Generated deadline reports + dashboard (JSON/CSV)
overrides/            # Lecturer overrides (JSON, append-only)
errors/               # Error records (JSON)
public/               # GENERATED public metadata for Pages (privacy-scanned)
schemas/              # JSON Schemas (versioned)
.github/workflows/    # Thin caller workflows
```

## Setup

1. Create a new private repo in your org from this template
2. Set repo secrets:
   - `PXL_APP_ID` — GitHub App ID
   - `PXL_APP_PRIVATE_KEY` — GitHub App private key (PEM)
   - `DISPATCH_APP_ID` — Dispatcher App ID (or same as PXL_APP_ID)
   - `DISPATCH_APP_PRIVATE_KEY` — Dispatcher App private key
3. Copy workflows from `workflows/` to `.github/workflows/`
4. Create a `students/roster.yml` with your student list
5. Create an assignment in `assignments/<id>.yml`
6. Run the "Publish assignment" workflow

## Data model

All stored data is:
- Machine-readable (JSON/YAML)
- Schema-versioned (`schema_version: 1`)
- Reviewable in Git
- Recoverable from Git history
- Separated into source data and generated data

See `schemas/` for full JSON Schema definitions.
