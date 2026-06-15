# PXL Classroom — Control Repository Template

This is the template for per-organization control repositories.

## Directory structure

```
assignments/          # Assignment definitions (YAML)
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

1. Your IT Administrator creates this repository automatically by running the **"Setup Organization"** GitHub Action from the main `pxl-classroom` codebase.
2. The `PXL_APP_ID` and `PXL_APP_PRIVATE_KEY` repository secrets are securely injected during that automated setup.

## Managing Assignments

**Do not edit files manually.** 

Go to your **PXL Classroom Dashboard** and click **Admin Panel**. From there, you can:
- **Create Assignments:** Fills out `assignments/*.yml` automatically.
- **Publish Assignments:** Automatically triggers the `.github/workflows/publish.yml` workflow.
- **Grant Extensions:** Automatically generates the override JSON files.

## Data model

All stored data is:
- Machine-readable (JSON/YAML)
- Schema-versioned (`schema_version: 1`)
- Reviewable in Git
- Recoverable from Git history
- Separated into source data and generated data

See `schemas/` for full JSON Schema definitions.
