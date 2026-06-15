# PXL Classroom

PXL Classroom is a fully serverless, highly-scalable GitHub Action-based classroom automation system designed specifically for higher-education environments using GitHub Teams for Education.

Unlike GitHub Classroom, this system uses private, per-organization **Control Repositories** as the single source of truth, ensuring absolute privacy of student rosters and data. 

## Architecture

1. **GitHub App:** A central GitHub App handles secure repository provisioning and lock-downs using short-lived installation tokens.
2. **Frontend Dashboard:** A static Vue.js SPA hosted on GitHub Pages. Lecturers use it to monitor progress, while students use it to "Accept" assignments via the GitHub Device Flow. Data is fetched *at runtime* directly from the control repo—no backend database is required.
3. **Shared Codebase (This Repository):** Contains all the composite actions and scripts (`provisioning`, `collect`, `report`, etc.) that orchestrate the platform.
4. **Control Repository:** A private repository per organization that stores assignments, roster definitions, student JSON records, and runs the thin caller workflows.

## IT Administrator Setup

1. **Deploy Frontend:**
   - Deploy the `frontend/` directory to GitHub Pages (or Vercel, Netlify).
2. **Install the GitHub App:**
   - Create a GitHub App with the following permissions:
     - Repository: Administration (RW), Contents (RW), Metadata (R)
     - User: Account/Starring (RW)
   - Enable **Device Flow** in the App settings.
   - Install the App in the target organization.
3. **Create the Control Repository:**
   - Create a private repository in the target organization (e.g., `pxl-classroom-control`).
   - Copy the contents of `control-repo-template/` into it.
   - Add the App ID (`PXL_APP_ID`) and Private Key (`PXL_APP_PRIVATE_KEY`) as Action Secrets.

## Lecturer Usage

See the [Lecturer Runbook](RUNBOOK.md) for day-to-day operations, creating assignments, and handling student edge-cases.
