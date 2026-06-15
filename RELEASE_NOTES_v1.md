# PXL Classroom v1.0 Release Notes

PXL Classroom v1.0 marks the General Availability of the system.

## Major Changes in v1.0

### 1. Hub-and-Spoke Architecture
The architecture has been completely rewritten to use a central hub model. All GitHub Action workflows now run centrally from the `pxl-classroom` public repository. Per-organization control repositories are now purely data stores containing no workflow files or secrets. This drastically reduces maintenance, as updating the system no longer requires synchronizing YAML files across every participating organization.

### 2. Single Page Application (SPA) UI
The frontend has been modernized into a fast Vue.js SPA.
- **Admin Panel**: Instructors can now create assignments, publish broker repositories, and grant deadline extensions directly from the UI without touching Git or YAML files. It includes real-time YAML preview before committing.
- **Dashboard**: Features improved search, filtering by status (accepted, missing, late), and robust polling with device-code phishing warnings.

### 3. Automated Setup
- Organization provisioning is now 100% automated via the **Setup Organization** workflow.
- GitHub App creation is fully automated via an App Manifest at the `/setup` route.

### 4. Automated Notifications & Reliability
- The system automatically creates a `PXL Classroom — Instructor Notifications` issue in the control repository and updates it with warnings (e.g., deleted repositories, late pushes, provisioning failures).
- Workflows are hardened with explicit concurrency controls to gracefully handle burst rate limits during massive classroom acceptances.
- Failed acceptances are automatically retried via the `Process Queue` workflow.

### 5. Automated Deadlines & Preservation
- The `finalize-deadline` workflow runs automatically at the deadline, lock-downs student repositories by demoting them to read-only, and creates a shallow clone of the final state to preserve it indefinitely.
- The `collect-activity` workflow continuously monitors repository state, caching git histories locally to speed up reporting.

## Documentation
- The [Lecturer Runbook](RUNBOOK.md) has been updated with detailed instructions for the new Admin Panel and Budget Policy configuration.
- The architecture documentation in [README](README.md) and [REQUIREMENTS](REQUIREMENTS.md) reflects the new centralized model.
