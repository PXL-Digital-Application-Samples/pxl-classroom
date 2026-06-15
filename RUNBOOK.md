# PXL Classroom — Lecturer Runbook

This guide covers day-to-day operations for lecturers managing assignments via the PXL Classroom system.

## Creating an Assignment

1. **Create the Template Repository:**
   - In your organization, create a new repository prefixed with `template-` (e.g., `template-automation-pe-1`).
   - Mark it as a **Template Repository** in GitHub Settings.
   - Add any starter code, `.github/workflows` for autograding, and assignment instructions here.

2. **Define the Assignment:**
   - Go to your private control repository (e.g., `pxl-classroom-control`).
   - In the `assignments/` directory, create a YAML file (e.g., `automation-pe-1.yml`):
     ```yaml
     schema_version: 1
     title: "Automation Practice Enterprise 1"
     description: "Build an automation pipeline."
     state: "published"
     opens_at: "2026-06-01T08:00:00Z"
     deadline_at: "2026-06-15T23:59:00Z"
     max_acceptances: 250
     repository_name_pattern: "automation-pe-1-{github_login}"
     ```

3. **Publish:**
   - Commit and push the file.
   - Run the **Publish Assignment** workflow manually via GitHub Actions.
   - This creates a public **Broker Repository** that students will star to accept the assignment.
   - Share the assignment URL from the Dashboard with your students.

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

## Edge Cases

- **Student deleted their repository:** The system will flag this in the Notifications issue. To resolve it, go to the `repositories/` folder in the control repo, delete their JSON record, and ask the student to accept the assignment again.
- **Granting an extension:** Go to the `overrides/` folder in the control repo. Create a JSON file for the student (e.g., `automation-pe-1/studentlogin.json`) and override their deadline.
- **System Failure:** If provisioning fails due to GitHub outages, the system will log it. You can trigger the **Process Queue** workflow to retry pending acceptances.
