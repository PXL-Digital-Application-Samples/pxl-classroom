# Group Assignments Architecture & Implementation Plan (TEAMS-PLAN)

A comprehensive architectural specification and implementation plan to introduce **Group Assignments (M:1 Student-to-Repository mapping)** to PXL Classroom, designed with strict non-destructive isolation so existing individual assignments, workflows, schemas, and UI views remain completely unaffected.

---

## 1. Context & Architectural Benchmarks

### Comparison: GitHub Classroom vs. CS50 vs. PXL Classroom

| Architectural Area | GitHub Classroom | CS50 / Classroom 50 | PXL Classroom Proposed Design |
| :--- | :--- | :--- | :--- |
| **Team Formation** | **Self-Service / Dynamic**: Students create or join teams on accept link. | **Pre-Assigned / Manifest**: Lecturer maps groups or students declare partners in submission. | **Dual Mode**: Supports both `self-service` (student join/create) and `pre-assigned` (roster-driven). |
| **Data Storage** | Central PostgreSQL Database. | CS50 submit50 / check50 database & git refs. | **Git-backed Control Repo**: Authoritative data lives in `<org>/pxl-classroom-control/teams/<id>/<team-slug>.json`. |
| **Provisioning** | 1st student triggers template generation; 2nd+ students get collaborator invite. | Single repository with multi-user push permissions. | **Idempotent App Provisioning**: 1st student generates repo from template; subsequent members receive `PUT /collaborators/{login}` with admin role. |
| **Permissions** | Write / Maintain access. | Push access. | **Admin access** granted to all team members (preserving PXL's core requirement of teaching Actions/secrets). |
| **Lockdown & Preservation** | Demotes team access. | Freezes submit branch. | Demotes **all** team members from `admin` to `pull`; preserves branch `preserved/<id>/<team-slug>` in archive repo. |

---

## 2. Key Design Decisions & Resolved Policy

### Q1: Team Creation vs. Capacity Policy
- **Creation Rule:** Students are permitted to create a team immediately even if it currently has fewer members than `min_team_size` (e.g. 1 member in a team requiring 2).
- **Lecturer Visibility:** Under-capacity teams are highlighted with an amber warning badge (`Under capacity: 1/2 members`) on the lecturer's assignment dashboard, giving lecturers complete visibility ahead of deadlines without blocking students from starting work.

### Q2: Team Switching Policy
- **Switching Rule:** Team switching is **always allowed**.
- **Student UX:** Students who have already joined a team can select "Switch Team" or "Leave Team" in `GroupAcceptanceCard.vue`.
- **Backend Clean-up:**
  - Student is removed from `teams/<id>/<old-team>.json`.
  - Old repo collaborator access is revoked (`DELETE /repos/{org}/{old-repo}/collaborators/{login}`).
  - Student is added to `teams/<id>/<new-team>.json` and granted collaborator access on the new repo (`PUT /repos/{org}/{new-repo}/collaborators/{login}`).
  - If a team becomes empty (0 members), it is marked `vacant: true` in the team manifest.
- **Lecturer Override:** Lecturers can also reassign or move any student between teams via a "Move Student" action in the `TeamsTable` on `AssignmentDetailView`.

### Implementation Phasing
- **Phase 1 (Self-Service Model First):** Implement full dynamic student team creation, team joining, broker event dispatch, idempotent collaborator provisioning, and UI isolation.
- **Phase 2 (Roster Pre-Assignment Fast-Follow):** Extend `students/roster.yml` and CSV import with optional `team_slug`/`group_id` columns, automatically mapping students to designated teams upon acceptance.

### Broker Acceptance Mechanism for Self-Service Group Assignments
Single-student assignments use a GitHub **Star Event** on the public broker repo (`PUT /user/starred/<org>/broker-<id>`) to trigger `watch:started`. However, GitHub Star events **cannot carry custom payloads** (e.g. `team_slug`).
For group assignments:
1. **Self-Service Mode (Public Broker Issue Trigger):** The student's device-flow token creates a lightweight issue on the public broker repository (`POST /repos/{org}/broker-{id}/issues` with title `join:{team_slug}` or `create:{team_name}`). The broker workflow triggers on `issues: [opened]`, validates the student actor, dispatches the payload to the hub, and closes the issue immediately.
2. **Pre-Assigned Mode (Star Trigger):** When teams are mapped in `students/roster.yml`, the existing Star trigger works with 0 changes because server-side `accept.mjs` looks up the student's assigned `team_slug`.

### Additive Directory in Control Scaffold
Introducing `teams/` in the control repository directory layout requires updating `CONTROL_SCAFFOLD_DIRS` in `lib/control-layout.mjs`, `scripts/scaffold-control-repo.mjs`, `lib/audit.mjs`, and `tests/scaffold.test.mjs`.

---

## 3. Architecture & Data Flow

```mermaid
graph TD
    subgraph UI_Layer["1. Isolated UI Layer"]
        AV[AssignmentView.vue] -->|type === 'individual'| IAC[IndividualAcceptanceCard.vue]
        AV -->|type === 'group'| GAC[GroupAcceptanceCard.vue]
        ADV[AssignmentDetailView.vue] -->|Segmented Control| TT[TeamsTable.vue]
        ADV -->|Segmented Control| ST[StudentsTable.vue]
        AdminV[AdminView.vue] --> GroupSettings[Group Configuration Panel]
    end

    subgraph Data_Layer["2. Control Repo Data Model"]
        CR["<org>/pxl-classroom-control/"]
        CR --> A_DIR["assignments/<id>.yml (type: group)"]
        CR --> T_DIR["teams/<id>/<team-slug>.json"]
        CR --> ACC_DIR["acceptances/<id>/<login>.json (team_slug link)"]
        CR --> R_DIR["repositories/<id>/<team-slug>.json"]
        CR --> OBS_DIR["observations/<id>/<team-slug>/*.json"]
        CR --> REP_DIR["reports/<id>.json (team & student aggregated)"]
    end

    subgraph Engine_Layer["3. Actions & Backend Pipeline"]
        Dispatch[acceptance-handler.yml] --> Accept[acceptance/accept.mjs]
        Accept -->|concurrency: accept-org-id-team| Prov[provisioning/provision.mjs]
        Prov -->|1st member| CreateRepo[Generate from Template]
        Prov -->|2nd+ member| AddCollab[PUT /collaborators/{login}]
        Nightly[daily-activity.yml] --> Lock[lockdown/lockdown.mjs (demote all members)]
        Lock --> Pres[preserve/preserve.mjs (archive team ref)]
    end
```

---

## 4. Proposed Changes Across Components

### Component 1: Schema & Data Models

- **`schemas/assignment.schema.json`**:
  - Add `assignment_type`: enum `["individual", "group"]`, default `"individual"`.
  - Add `group_config` object:
    - `max_team_size`: integer, minimum 2 (default 3).
    - `min_team_size`: integer, minimum 1 (default 1).
    - `formation_mode`: enum `["self-service", "pre-assigned"]` (default `"self-service"`).
    - `allow_team_creation`: boolean (default `true`).
    - `team_name_prefix`: string (pattern `^[a-z0-9-]*$`).
  - Update `repository_name_pattern` validation: Allows `{team_slug}` or `{github_login}`.
- **`schemas/team.schema.json` (NEW)**:
  - Defines schema for `teams/<assignment-id>/<team-slug>.json` containing `team_slug`, `team_name`, `members`, `max_members`, `created_at`, `created_by`, `repo_name`, `repo_id`.
- **`schemas/acceptance.schema.json`**: Add optional `team_slug` property.
- **`schemas/repository-record.schema.json`**: Add optional `team_slug` and `members` array.

---

### Component 2: Core Scaffold & Library Utilities

- **`lib/control-layout.mjs`**: Add `"teams"` to `CONTROL_SCAFFOLD_DIRS`.
- **`scripts/scaffold-control-repo.mjs`**: Generate `teams/` directory with `.gitkeep` when scaffolding new org control repos.
- **`lib/audit.mjs`**: Add scaffold audit verification for `teams/`.

---

### Component 3: Acceptance & Provisioning Pipeline

- **`acceptance/accept.mjs`**:
  - Detect `assignment.assignment_type === 'group'`.
  - In `pre-assigned` mode: resolve `student -> team_slug` from `students/roster.yml` or `students/teams.yml`.
  - In `self-service` mode: validate `team_slug` and `team_name`. Create new `teams/<id>/<team-slug>.json` if new, or append to `members` if existing and within `max_team_size`.
  - Derive `target_repo` using `assignment.repository_name_pattern.replace('{team_slug}', team_slug)`.
  - Output `team_slug`, `target_repo`, `is_first_member: true|false`.
- **`.github/workflows/acceptance-handler.yml`**:
  - Update concurrency group: `concurrency: accept-${{ github.event.client_payload.org }}-${{ github.event.client_payload.assignment_id }}-${{ github.event.client_payload.team_slug || github.event.client_payload.github_login }}`.
  - Pass `team-slug` to `provisioning` composite action.
  - Write `repositories/<id>/<team-slug>.json` for group assignments.
- **`provisioning/provision.mjs`**:
  - When target repository already exists, skip template generation (`POST /generate`) and execute collaborator addition (`PUT /repos/{org}/{repo}/collaborators/{studentLogin}`) with configured role (`admin`).

---

### Component 4: Nightly Lifecycle (Lockdown, Preservation, Reporting)

- **`lockdown/lockdown.mjs`**:
  - Iterates `repositories/<id>/` records.
  - If record contains `members` (group repo), demotes **all team members** to `pull`.
  - Captures one frozen `snapshot_sha` per repository.
- **`preserve/preserve.mjs`**:
  - Preserves candidate SHA as `refs/heads/preserved/<assignment-id>/<team-slug>` in `<org>/pxl-classroom-archive`.
  - Preserves once per team repo instead of N times.
- **`report/report.mjs`**:
  - Aggregates team records into `reports/<id>.json` with both `teams: [...]` and `students: [...]`.
  - Adds `team_slug` and `team_name` columns to CSV export `reports/<id>.csv`.
- **`pages/generate.mjs`**:
  - Emits sanitized public team state `public/data/<org>/teams/<assignment-id>.json` (team slug, team name, member count) with zero private roster fields.

---

### Component 5: Isolated Frontend UI Components

- **`frontend/src/components/GroupAcceptanceCard.vue` (NEW)**:
  - Encapsulated component handling team search, team creation, team joining, member preview, and provisioning polling.
- **`frontend/src/views/AssignmentView.vue`**:
  - Conditional branch: renders `GroupAcceptanceCard.vue` when `assignment.assignment_type === 'group'`, otherwise renders existing individual acceptance card unchanged.
- **`frontend/src/components/TeamsTable.vue` (NEW)**:
  - Lecturer table component showing team rows, member hover tooltips, repo links, commit counts, submission statuses, and lockdown flags.
- **`frontend/src/views/AssignmentDetailView.vue`**:
  - Top segmented tab toggle: `[ 👥 Teams (12) ] | [ 👤 Students (36) ]`.
- **`frontend/src/views/AdminView.vue`**:
  - Assignment Type radio selector (`Individual` vs `Group`).
  - Collapsible Group Configuration panel with validation.

---

### Component 6: CLI Companion Tools

- **`cli/src/commands/download.mjs`**:
  - Supports downloading group submissions preserved under `preserved/<assignment-id>/<team-slug>`.
- **`cli/src/commands/grade.mjs`**:
  - Runs grading containers against team archive SHAs.

---

## 5. Comprehensive Side-Effects & Mitigation Matrix

| Potential Side Effect | Area Affected | Risk Level | Mitigation & Design Guarantee |
| :--- | :--- | :--- | :--- |
| **Race Conditions during concurrent team joins** | Workflow Execution | High | GitHub Actions `concurrency: accept-${org}-${assignment}-${team_slug}` queues concurrent joins to the same team sequentially, preventing over-capacity joins. |
| **Breaking existing individual assignment schemas** | `schemas/assignment.schema.json` | Medium | Schema sets `assignment_type: { enum: ["individual", "group"], default: "individual" }`. Existing YAMLs without this field default to `individual` with 100% backward compatibility. |
| **Scaffold integrity check failure** | `lib/audit.mjs` & `tests/scaffold.test.mjs` | Medium | `CONTROL_SCAFFOLD_DIRS` in `lib/control-layout.mjs` updated in unison with `scripts/scaffold-control-repo.mjs` and `control-repo-template/`. |
| **Privacy leak on public Pages data** | `pages/scan.mjs` & Pages build | High | `public/data/<org>/teams/<id>.json` only publishes `team_slug`, `team_name`, and `member_count`. Roster metadata is never written to public Pages data. `pages/scan.mjs` fails build if violated. |
| **Broken archive preservation git unpack** | `preserve/preserve.mjs` | Medium | Preserves full object history for `<team-slug>` branch using non-shallow fetch (`--no-tags`), preventing `remote unpack failed`. |
| **Nightly matrix leg timeouts** | `daily-activity.yml` | Low | Group assignments reduce repository count by $1/N$ (e.g. 60 students in teams of 3 = 20 repos), making nightly runs ~66% faster and cheaper. |
| **Student UI confusion between individual & group** | `AssignmentView.vue` | Low | Rendered as completely distinct UI cards; individual assignments never see team join/create controls. |

---

## 6. Verification Plan

### Automated Tests
1. **Schema Validation Tests:**
   - Command: `node --test tests/assignment-roundtrip.test.mjs cli/tests/phase-c-schemas.test.mjs`
2. **Scaffold & Audit Tests:**
   - Command: `node --test tests/scaffold.test.mjs tests/audit.test.mjs`
3. **Acceptance & Provisioning Unit Tests:**
   - Command: `node --test tests/accept.test.mjs`
4. **Lockdown & Preservation Unit Tests:**
   - Command: `node --test tests/lockdown-retry.test.mjs tests/preserve-archive-push.test.mjs`
5. **Frontend Build & Privacy Scanner Tests:**
   - Command: `node --test tests/scan.test.mjs tests/public-data-contract.test.mjs && npm --prefix frontend run build`

### Manual Verification
1. **Admin Panel:** Create a group assignment in draft state, configure `max_team_size: 3`, and verify schema validation.
2. **Student Acceptance (Self-Service):**
   - Student A navigates to accept URL, creates `"Team Phoenix"`, and verifies repo generation.
   - Student B navigates to accept URL, selects `"Team Phoenix"`, clicks Join, and verifies collaborator access.
   - Student C and D attempt to join to verify capacity enforcement at 3 members.
3. **Lecturer Detail View:** Verify "Teams" tab displays Team Phoenix with both members, and "Students" tab lists both students with their team badge.
4. **Nightly Lockdown:** Run simulated lockdown and verify both Student A and Student B are demoted to `pull`, with submission preserved under `preserved/<assignment-id>/team-phoenix`.
