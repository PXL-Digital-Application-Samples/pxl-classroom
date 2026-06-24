# Feature Proposal: GitHub Actions Autograding

## Overview
Currently, PXL-Classroom supports lecturer-side autograding via the `pxl-classroom grade` CLI command. This proposal outlines adding **Student-Side Autograding via GitHub Actions** so students receive immediate feedback upon pushing code to their assignment repositories.

Based on our analysis of GitHub Classroom and Classroom 50, we will implement the **Classroom 50 Model**, utilizing a **Pull-based** sync strategy, and defaulting to **Private** tests to ensure maximum security and academic integrity.

---

## 1. Architectural Approach: The "Classroom 50" Model

Instead of injecting test configurations directly into student repositories (which GitHub Classroom does, allowing students to modify the workflow to `exit 0` and cheat), we will use **reusable GitHub Actions workflows**.

- **Mechanism:** The student's repository receives a minimal workflow file that calls a reusable workflow housed in the teacher's template/configuration repository.
- **Execution:** When the student pushes code, their workflow triggers the reusable workflow. The reusable workflow securely fetches the hidden tests from the teacher's repository and evaluates the student's code.
- **Pros:** Highly secure. Students cannot see or modify the actual grading logic or tests.

---

## 2. Implementation Plan

### 2.1 Schema Updates (`schemas/assignment.schema.json`)
Extend the `autograde` object to support execution environments and test visibility.

```json
"autograde": {
  "type": "object",
  "properties": {
    "enabled": { "type": "boolean", "default": false },
    "execution_environment": {
      "type": "string",
      "enum": ["lecturer_local", "github_actions"],
      "default": "lecturer_local",
      "description": "Where the tests are executed."
    },
    "visibility": {
      "type": "string",
      "enum": ["public", "private"],
      "default": "private",
      "description": "If 'private', uses a reusable workflow to hide tests in the control repo."
    },
    "tests": { ... } // Existing test definitions
  }
}
```

### 2.2 CLI Updates (`pxl-classroom`)
- **`pxl-classroom provision`**:
  - If `execution_environment` is `github_actions`, the CLI injects `.github/workflows/autograding.yml` into the student repo.
  - **For Private Tests (Classroom 50 style):** This workflow will be a minimal stub that uses `uses: <org>/<control-repo>/.github/workflows/grade.yml@main` (a reusable workflow). The CLI will also ensure the control repository has the reusable `grade.yml` and test definitions configured.
- **`pxl-classroom grade` (Pull-Based Sync)**:
  - Update to fetch the latest GitHub Actions run status/Checks API for each student repository using the GitHub API. It will parse this data instead of running tests locally.

### 2.3 UI Updates (Frontend)
- **Assignment Creation/Edit View (`AssignmentDetailView.vue`)**:
  - Add a toggle: **"Enable GitHub Actions Autograding"**.
  - Add a dropdown: **"Test Visibility"** (Public/Injected vs Private/Classroom 50 style).
- **Lecturer Dashboard (`AdminView.vue` / Grading View)**:
  - Add a "CI Status" column (Passing/Failing/Pending) for each student's repository, pulling from the GitHub Checks API.
  - Add a "Sync Grades from GitHub" button to trigger the CLI pull.

---

## 3. Verification Plan

- **Automated Tests:** Add tests for schema validation, `provision.mjs` workflow injection, and `grade.mjs` GitHub API parsing.
- **Manual Verification:** Create a test assignment, provision a dummy student repo with `github_actions` enabled, push code, and ensure the reusable workflow correctly triggers and the CLI successfully pulls the grade.
