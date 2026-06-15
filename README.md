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
   - Go to the **Actions** tab of your `pxl-classroom` repository and run the **Deploy frontend to Pages** workflow.
   - Go to **Settings > Pages** and ensure it is set to deploy from GitHub Actions.
   - *This will automatically build and host the dashboard.*

2. **Automated GitHub App Setup:**
   - Open your newly deployed dashboard and navigate to the `/setup` route (e.g., `https://<org>.github.io/pxl-classroom/setup`).
   - Click **Create GitHub App**. This will automatically generate the App with the correct Device Flow, Callback URLs, and Permissions pre-configured!
   - Click **Create** at the bottom of the GitHub page.

3. **Add Secrets:**
   - After creation, GitHub will provide an **App ID**, a **Client ID**, and a **Private Key** (which downloads as a `.pem` file).
   - Go to **Settings > Secrets and variables > Actions** in your `pxl-classroom` codebase repository.
   - Add these three Repository Secrets:
     - `PXL_APP_ID` (Value: your App ID)
     - `PXL_APP_PRIVATE_KEY` (Value: contents of the `.pem` file)
     - `VITE_GITHUB_CLIENT_ID` (Value: your Client ID)
   - Re-run the **Deploy frontend to Pages** workflow so the dashboard picks up your new `Client ID`.

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
