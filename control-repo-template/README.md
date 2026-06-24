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

## Optional: tagged submissions

Students may tag a submission to bind a sortable, server-side timestamp to a specific commit. The hub's `collect/` action lists these tags as a separate evidence layer and the report prefers them over the default-branch tip when both are present.

Tag format — copy/paste this into course materials or a Make target:

```bash
git tag submit/$(date -u +%Y-%m-%dT%H:%M:%SZ)-$(git rev-parse --short HEAD) && git push origin --tags
```

The system does not mandate tagging — observations on the default-branch tip remain authoritative when no tag exists. The declared timestamp inside the tag name is *observed*, not authoritative: classification on/late uses the time `collect/` saw the tag, not the student-supplied string.
