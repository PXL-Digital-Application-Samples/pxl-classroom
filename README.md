# PXL Classroom

![PXL Classroom logo](assets/images/pxl_classroom_logo.png)

A GitHub-native replacement of GitHub Classroom. Built entirely on GitHub Pages + GitHub Actions + a single GitHub App. No server, no database, no external dependency.

Targets specifically **GitHub Team for Education**. Never depends on GitHub Enterprise.

## What it does

- **Assignment distribution.** Lecturers define an assignment from a private template repository in the Admin Panel; one acceptance URL is shared with students.
- **Student acceptance.** A student opens the URL, authenticates with GitHub device flow, clicks Accept. A private repository is created from the template and the student is granted admin — synchronously, no queue.
- **Submission reporting.** A single nightly workflow collects activity, finalizes deadlines (lock-down + preserve + report), and regenerates the dashboard.
- **Zero idle minutes.** When no class is active, the nightly workflow disables itself. The system sits dormant and bills nothing until a new assignment is published.

## Architecture at a glance

```mermaid
graph LR
    Hub[pxl-classroom<br/>PUBLIC hub<br/>workflows + SPA + actions]
    ControlA[org-A/pxl-classroom-control<br/>PRIVATE data only]
    ControlB[org-B/pxl-classroom-control<br/>PRIVATE data only]
    Broker[broker-&lt;assignment&gt;<br/>PUBLIC, one per assignment]
    Pages[GitHub Pages SPA]

    Student[Student] --> Pages
    Pages -->|star| Broker
    Broker -->|dispatch| Hub
    Hub --> ControlA
    Hub --> ControlB
    Lecturer[Lecturer] --> Pages
    Pages -.reads at runtime.-> ControlA
```

One central public hub holds all logic. Per-organization private control repositories hold data, no workflows. A single GitHub App is installed per participating org for short-lived tokens. The browser SPA reads each org's data at runtime with the viewer's own token.

## Documentation

- **[`ARCHITECTURE.md`](ARCHITECTURE.md)** — full technical specification: topology, trust model, data model, workflows, actions, flows, constraints.
- **[`RUNBOOK.md`](RUNBOOK.md)** — operational procedures: initial setup, onboarding an org, creating assignments, monitoring, edge cases, recovery.

## Where things live

| Layer | Path |
|---|---|
| Central workflows | `.github/workflows/` |
| Composite actions | `acceptance/`, `provisioning/`, `collect/`, `lockdown/`, `preserve/`, `report/`, `pages/`, `notify/`, `registry/` |
| Shared libraries | `lib/yaml.mjs`, `lib/gh.mjs` |
| Scripts (extracted from workflow inline JS) | `scripts/` |
| Frontend SPA | `frontend/` |
| Data schemas | `schemas/` |
| Control-repo scaffold | `control-repo-template/` |
| Unit tests | `tests/` |

Live service: https://pxl-digital-application-samples.github.io/pxl-classroom/
