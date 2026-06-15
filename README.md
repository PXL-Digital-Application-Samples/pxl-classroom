# PXL Classroom

PXL Classroom is a fully serverless, highly-scalable GitHub Action-based classroom automation system designed specifically for higher-education environments using GitHub Teams for Education.

Unlike GitHub Classroom, this system uses private, per-organization **Control Repositories** as the single source of truth, ensuring absolute privacy of student rosters and data. 

## Architecture

1. **GitHub App:** A central GitHub App handles secure repository provisioning and lock-downs using short-lived installation tokens.
2. **Frontend Dashboard:** A static Vue.js SPA hosted on GitHub Pages. Lecturers use it to monitor progress, while students use it to "Accept" assignments via the GitHub Device Flow. Data is fetched *at runtime* directly from the control repo—no backend database is required.
3. **Shared Codebase (This Repository):** Contains all the composite actions and scripts (`provisioning`, `collect`, `report`, etc.) that orchestrate the platform.
4. **Control Repository:** A private repository per organization that stores assignments, roster definitions, student JSON records, and runs the thin caller workflows.

## IT Administrator Setup

This setup is split into two parts: **Central Infrastructure** (done once for the entire university) and **Organization Setup** (done once per GitHub Organization). No local cloning or terminal commands are required.

### Part 1: Central Infrastructure (Done Once)

1. **Deploy the Frontend Dashboard:**
   - The dashboard only needs to be deployed **once** globally. 
   - You can host the `frontend/` directory on any static host (like Vercel, Netlify, or GitHub Pages).

2. **Create the GitHub App:**
   - Go to your personal or organizational **Settings > Developer Settings > GitHub Apps > New GitHub App**.
   - **Name:** PXL Classroom Provisioner (or similar)
   - **Homepage URL:** The URL of your deployed Frontend Dashboard.
   - **Callback URL:** Same as the Homepage URL.
   - **Device Flow:** Ensure **"Enable Device Flow"** is checked (this allows students to login without passwords).
   - **Permissions:**
     - **Repository:** Administration (Read & write), Contents (Read & write), Metadata (Read-only), Secrets (Read & write)
     - **User:** Starring (Read & write)
   - Save the App, then generate a **Private Key** and note the **App ID**.
   - Add the App ID (`PXL_APP_ID`) and Private Key (`PXL_APP_PRIVATE_KEY`) as **Repository Secrets** in your main `pxl-classroom` codebase repository.

### Part 2: Organization Setup (Done per Org)

1. **Install the GitHub App:**
   - Go to the GitHub App's public page and click **Install**. Select the target organization (e.g., `PXLAutomation`).

2. **Run the Automated Setup:**
   - Go to the **Actions** tab of your main `pxl-classroom` codebase repository.
   - Select the **Setup Organization** workflow.
   - Click **Run workflow**, enter the target organization name, and click Run.
   - *This fully automates creating the private control repository, copying all the template files, and securely injecting the required Action Secrets into the new organization.*

## Lecturer Usage

See the [Lecturer Runbook](RUNBOOK.md) for day-to-day operations, creating assignments, and handling student edge-cases.
