# PXL Classroom - Frontend SPA

The client-side Single Page Application (SPA) for PXL Classroom, hosted statically on GitHub Pages.

## Overview

- **Framework**: Vue 3 (Composition API, `<script setup>`)
- **Bundler**: Vite
- **Routing**: Vue Router (HTML5 history mode with `404.html` redirect shim for GitHub Pages deep links)
- **Styling**: Single dark theme (GitHub-dark palette) defined in `src/style.css`
- **Authentication**: GitHub Device Flow OAuth against the central GitHub App (`PXL Classroom Provisioner`), routed through `VITE_CORS_PROXY_URL`

## Key Views

| Route | View | Description |
|---|---|---|
| `/` | `HomeView` | Role-adaptive portal: student accepted assignments and lecturer dashboard launcher |
| `/:org/a/:assignmentId` | `AssignmentView` | Student acceptance card, status polling, and repository link |
| `/dashboard/:org?` | `DashboardView` | Lecturer dashboard: org selector with live status lights & memory, assignments overview, live state sync, + Assignment shortcut, System Health modal, and embedded Resource Usage & Limits panel |
| `/dashboard/:org/admin` | `AdminView` | Lecturer Admin Panel: assignment editor, publish trigger, deadline extensions, roster management |
| `/dashboard/:org/:assignmentId` | `AssignmentDetailView` | Per-assignment student table, live status refresh, hover identity resolution, Feedback PR status, amber Admin shortcut, Export dropdown menu (CSV, Manifest, CLI), and autograding results |
| `/dashboard/:org/usage` | `UsageView` | Per-organization weekly resource usage breakdown with threshold indicators |
| `/usage` | `UsageOverviewView` | Cross-organization weekly usage aggregator |
| `/setup` | `SetupView` | Initial setup page to register the GitHub App from a manifest and verify install permissions |

## Development

```bash
# From repository root or frontend directory
cd frontend
npm install
npm run dev
```

## Build & Deployment

```bash
npm run build
```

Deploys automatically to GitHub Pages via `.github/workflows/deploy-frontend.yml` on every push to `main` touching `frontend/**`, `lib/**`, or `schemas/**`.
