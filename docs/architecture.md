# PXL Classroom Architecture

PXL Classroom uses a **hub-and-spoke** architecture to orchestrate assignments across multiple GitHub organizations.

## The Broker-Dispatch Boundary

The system is split into two distinct repository types:

1.  **The Hub (`pxl-classroom`)**: The central execution engine. It contains all GitHub Actions workflows, Node scripts, and the frontend web application. It acts as the "broker" that coordinates activity.
2.  **The Spokes (`pxl-classroom-control`)**: One control repository per participating organization. These contain only state (JSON/YAML data files) and no logic. They act as "databases" for each org.

### Why this boundary?

*   **Logic Centralization:** By keeping all logic in the hub, we can update features, fix bugs, and refine workflows in one place without needing to push workflow updates to dozens of individual organization repositories.
*   **State Isolation:** By storing state in individual org-specific `pxl-classroom-control` repositories, we guarantee data isolation. Organization A cannot see Organization B's student roster, repository lists, or grades.
*   **Security:** The central hub acts via a GitHub App installation in each spoke organization. The permissions are strictly scoped to what the App needs.

### How it works

1.  **Workflows** run in the central `pxl-classroom` repository.
2.  They mint short-lived **GitHub App installation tokens** for the target organization.
3.  They checkout the target organization's `pxl-classroom-control` repository.
4.  They run local node scripts (`/provision`, `/collect`, `/report`) against the control repository's data.
5.  If state changes are made (e.g., a student's repository is provisioned), the workflow commits and pushes the JSON updates directly back to the target organization's `pxl-classroom-control` repository.

This boundary ensures high reliability and a single source of truth for execution logic while maintaining strict data separation.
