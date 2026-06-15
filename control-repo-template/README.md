# PXL Classroom — Control Repository

This is a **data-only** repository for a single PXL Classroom organization. It contains assignment definitions, roster, acceptances, repository records, observations, reports, and lecturer overrides — all as machine-readable JSON/YAML, schema-versioned, recoverable from Git history.

**There are no workflows here.** All automation runs from the central public `pxl-classroom` hub, which checks this repo out, runs scripts against the data tree, commits changes back, and pushes. Do not add `.github/workflows/` here.

## Directory layout

```
assignments/<id>.yml                # source: assignment definition
students/roster.yml                 # source: roster
acceptances/<id>/<login>.json       # observation: who accepted, when
repositories/<id>/<login>.json      # fact: provisioned repo id, name, url
observations/<id>/<login>/*.json    # observations: snapshots over time
lockdowns/<id>/lockdown-record.json # fact: lock-down outcome at deadline
reports/<id>.json                   # calculated: per-assignment report
reports/dashboard.json              # calculated: aggregate for the SPA
overrides/<id>/<login>.json         # lecturer overrides (append-only)
errors/<id>.json                    # error records
public/                             # GENERATED public metadata for Pages
```

JSON Schemas live in `schemas/` in the hub and are also served from the Pages site for SPA-side validation.

## Setup

This repository is created automatically when a system administrator runs the **Setup Organization** workflow in the hub. Do not create it by hand.

## Managing assignments

Do not edit files manually. Use the **PXL Classroom Dashboard → Admin Panel** to:

- Create assignment definitions (validated against `assignment.schema.json` before commit).
- Publish assignments (creates the broker repo + enables the nightly workflow).
- Grant deadline extensions (commits validated `override.schema.json` files).

See `RUNBOOK.md` in the hub for operational detail.
