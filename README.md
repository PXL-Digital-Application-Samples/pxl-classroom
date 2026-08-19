# PXL Classroom

<img src="assets/images/pxl_classroom_logo.png" alt="PXL Classroom Logo" width="200" />

GitHub-native assignment distribution and submission reporting for higher education. Built on GitHub Pages, GitHub Actions, and a single GitHub App. No external server, no external database.

Target platform: GitHub Team for Education (no GitHub Enterprise required).

Links: [Web App](https://pxl-digital-application-samples.github.io/pxl-classroom/) | [ARCHITECTURE.md](ARCHITECTURE.md) | [RUNBOOK.md](RUNBOOK.md)

---

## Highlights

- **Fast Web UI & Dashboard:**
  - Create and publish assignments in seconds via the Admin Panel.
  - Monitor progress with live commit sync
  - 4-tier student identity hover cards
  - one-click deadline extensions
- **Student & Team Self-Service:**
  - One-click repository provisioning in 15-30s.
  - Students can form teams, join groups under capacity limits, or switch teams before deadlines.
- **Dual-Mode Autograding:**
  - Automated feedback on push via GitHub Actions
  - or local CLI grading in sandboxed Docker containers with zero Actions minutes billed.
- **DevOps-Ready Student Admin:**
  - Students get repository Admin rights to manage Secrets, Environments, and Runners
  - backed by automated deadline lockdown and commit archival.
- **Zero Infrastructure:**
  - 100% serverless on GitHub Pages, Actions, and a single GitHub App.
  - Workflows sleep when idle, and weekly audits monitor SKU billing limits.

---

## Feature Comparison

| Feature / Capability | GitHub Classroom (Legacy) | Classroom50 (Fifty Foundation) | PXL Classroom |
| :--- | :--- | :--- | :--- |
| **Architecture & Hosting** | Centralized server & database | Hosted web service + CLI | 100% Serverless (GitHub Pages + Actions + 1 GitHub App) |
| **Infrastructure Costs** | Maintained by GitHub | Free open-source hosted tier | Zero external server or database costs |
| **Idle Minute Management** | Continuous cloud background jobs | Continuous service availability | Zero Idle Minutes (Nightly cron sleeps when inactive) |
| **Resource & Billing Audits** | None (standard GitHub billing page) | None (standard GitHub billing page) | Automated weekly SKU billing audits with @-mention alerts |
| **Student Repository Role** | Write only (Restricted) | Write only (Restricted) | Admin (Enables Secrets, Environments, Runners, OIDC) |
| **Student Self-Service Acceptance** | Web redirect with background queue | Web portal acceptance link | Instant 1-click provisioning (repository ready in 15-30s) |
| **Roster Management** | CSV import or LMS sync (Strict) | Org-level repository roster | Dual-Mode: Enforced roster or Open signup with student caps |
| **Team Formation Self-Service** | Basic team selection from preset list | Basic team repository creation | Full self-service team creation, capacity limits, and team switching |
| **Assignment Creation Flow** | Multi-step web form | Web configuration form | 1-Click publish from web Admin Panel with instant validation |
| **Lecturer Dashboard & UI** | Standard web portal (basic list) | Web portal + terminal views | Real-time web dashboard with live commit sync and student hover cards |
| **CLI Companion Tooling** | `gh classroom` extension (clone, list) | `classroom50` CLI | `@pxl-classroom/cli` (Local Docker grading, bulk clone, audit checks) |
| **Autograding: Cloud Actions** | Runs in student repo on push (`classroom-resources/*`) | Runs in student repo on push (Actions + `check50`) | Automatic Actions grading with score harvesting into dashboard |
| **Autograding: Local Sandboxing**| Not supported natively | Not supported natively (grades live repos) | Sandboxed Local Docker CLI (Zero cloud Actions minutes billed) |
| **Deadline Enforcement** | Soft deadline (manual freeze or stop Actions) | Timestamp logging & manual review | Automated API lockdown (demotes students from Admin to Read) |
| **Submission Archiving** | None (grades live repo HEAD) | None (grades live repo HEAD) | Permanent copy saved to private archive repository |
| **Feedback Pull Requests** | Created on repo creation (breaks on empty commits) | Standard GitHub PR / comments | Clean baseline branch with draft PR opened on first commit |
| **LMS & Grade Export** | LTI 1.3 (Canvas, Moodle, Blackboard) | Basic CSV export | Live CSV and JSON export matching table filters (LTI in v2) |

---

## Quickstart

### 1. Connect Organization

- Open the [Web App](https://pxl-digital-application-samples.github.io/pxl-classroom/).
- Sign in with GitHub device flow.
- Open `/setup` to create and install the GitHub App on your organization.

### 2. Create Assignment

- Open `/dashboard/:org/admin`.
- Configure assignment parameters: title, template repository, opens date, deadline, assignment type (individual/group), and autograding mode.
- Click Save & Publish.

### 3. Student Acceptance

- Distribute the URL `/:org/a/:assignment-id` to students.
- Students sign in and accept. The repository is provisioned immediately.

### 4. Collection and Grading

- Deadlines are finalized automatically by the nightly workflow.
- Submissions are preserved as immutable branches in `<org>/pxl-classroom-archive`.
- View grades in the web dashboard or grade locally via the CLI.

---

## Architecture

```mermaid
graph LR
    Hub[pxl-classroom<br/>PUBLIC Hub<br/>Workflows, SPA, Actions, CLI]
    Control[org/pxl-classroom-control<br/>PRIVATE Data Only<br/>Assignments, Rosters, Reports]
    Archive[org/pxl-classroom-archive<br/>PRIVATE Archive<br/>Preserved SHAs]
    Broker[broker-assignment<br/>PUBLIC Dispatcher]
    SPA[GitHub Pages SPA]
    CLI[pxl-classroom CLI]

    Student[Student] --> SPA
    SPA -->|Star| Broker
    Broker -->|Dispatch| Hub
    Hub --> Control
    Hub --> Archive
    Lecturer[Lecturer] --> SPA
    Lecturer --> CLI
    SPA -.Reads/Writes.-> Control
    CLI -.Reads/Writes.-> Control
    CLI -.Clones.-> Archive
```

---

## CLI Usage

```bash
# Login via GitHub device flow
npx pxl-classroom login

# Bulk download preserved submissions for an assignment
npx pxl-classroom download --org my-org --assignment lab-1

# Run local autograding in sandboxed Docker container
npx pxl-classroom grade --org my-org --assignment lab-1 --runner docker

# Create feedback pull requests
npx pxl-classroom feedback open --org my-org --assignment lab-1
```

---

## Repository Layout

| Path | Description |
|---|---|
| `.github/workflows/` | Hub workflows (acceptance, daily activity, dashboard regen) |
| `acceptance/`, `provisioning/`, `lockdown/`, `preserve/`, `report/` | Composite actions |
| `frontend/` | Vue 3 single page application |
| `cli/` | Companion `@pxl-classroom/cli` package |
| `lib/` | Shared utility modules (yaml, gh, gittree, audit) |
| `schemas/` | JSON schemas for assignments, rosters, teams, reports, grading |
| `control-repo-template/` | Template scaffold for new organization control repos |
| `tests/`, `cli/tests/` | Unit and integration test suites |
