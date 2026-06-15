# PXL Classroom — Lecturer Runbook

This guide covers day-to-day operations for lecturers managing assignments via the PXL Classroom system.

## Creating an Assignment

1. **Create the Template Repository:**
   - In your organization, create a new repository prefixed with `template-` (e.g., `template-automation-pe-1`).
   - Mark it as a **Template Repository** in GitHub Settings.
   - Add any starter code, `.github/workflows` for autograding, and assignment instructions here.

2. **Define the Assignment:**
   - Go to your PXL Classroom Dashboard and click the **Admin Panel** button.
   - Fill out the "Create New Assignment" form (Title, ID, Deadlines, Max Acceptances) and click **Create Assignment YAML**. The UI will automatically generate and commit the file to your private control repository.

3. **Publish:**
   - In the Admin Panel, click the **Run Publish Workflow** button.
   - This creates a public **Broker Repository** that students will star to accept the assignment.
   - Share the assignment URL from the Dashboard with your students.
   - **Note on Scale:** During massive classes (e.g., 250+ students accepting simultaneously), the system queues provisioning to prevent GitHub rate-limiting. Students may see a "Setting up..." screen for 3-5 minutes. This is normal and intentional.

## Monitoring Progress

1. **Dashboard:**
   - Visit the public dashboard (e.g., `https://[org].github.io/pxl-classroom/dashboard`).
   - Sign in with your GitHub account.
   - Select your organization.
   - You can monitor the number of accepted, on-time, and late submissions.

2. **System Alerts:**
   - The control repository has an issue named `PXL Classroom — Instructor Notifications`.
   - The system automatically updates this issue with any anomalies, such as students deleting their repositories, making late pushes, or provisioning failures.
   - Use this as your daily checklist to handle edge cases.

## Organization Setup & Budget Policy

Before using PXL Classroom, each organization must be registered in the central system.

1. **Register Organization:**
   - The system administrator will add your organization to the `participating-orgs.yml` file on the `participating-orgs` branch of `pxl-classroom`.
   - Your entry must include `login`, `budget_owner` (email address), and `spending_limit_eur`.

2. **Set up GitHub Actions Spending Limit:**
   - Go to your organization's **Settings > Billing and plans > Spending limit**.
   - Set the Actions spending limit to match or slightly exceed your `spending_limit_eur` to prevent unexpected overages.
   - Configure billing alerts so the `budget_owner` is notified if usage approaches the limit.

3. **Install GitHub App:**
   - Install the PXL Classroom Provisioner App in your organization.

## Edge Cases

- **Student deleted their repository:** The system will flag this in the Notifications issue. To resolve it, go to the `repositories/` folder in the control repo, delete their JSON record, and ask the student to accept the assignment again.
- **Granting an extension:** Go to your PXL Classroom Dashboard, click the **Admin Panel** button, and use the "Grant Deadline Extension" form. Enter the assignment ID, student login, and the new deadline. The UI will automatically commit the extension file.
- **System Failure:** If provisioning fails due to GitHub outages, the system will log it. You can trigger the **Process Queue** workflow to retry pending acceptances.
- **Finalizing Deadlines:** This is fully automated. The system automatically preserves student repositories, computes lateness, and closes out submissions shortly after the deadline passes.
