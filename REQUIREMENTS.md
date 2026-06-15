# PXL Classroom Requirements

Status: Approved (technical spikes complete)  
Version: 1.0  
Project name: PXL Classroom  
Last updated: 2026-06-14

## Purpose

PXL Classroom is a GitHub-native assignment distribution and submission-reporting system intended to replace the subset of GitHub Classroom used at PXL.

The system shall let a lecturer define an assignment from a private GitHub template repository, distribute one acceptance link to students, provision one private repository per student, grant the student sufficient repository permissions for advanced GitHub Actions exercises, and provide an administrative overview of repository and submission activity.

PXL Classroom does not provide autograding.

## Product goals

PXL Classroom shall:

- provide a student experience similar to accepting a GitHub Classroom assignment;
- require only GitHub-hosted services;
- use GitHub Pages for the web interface;
- use GitHub Actions for all trusted automation;
- use GitHub repositories as persistent storage;
- create organization-owned private assignment repositories from private templates;
- grant each student administrator access to their assignment repository;
- preserve an instructor-controlled record of assignment configuration and observed submission state;
- report activity before and after an assignment deadline;
- remain usable without an always-running server or external database;
- provide direct links from reports to students, repositories, commits, and relevant GitHub pages.

## Non-goals

The initial product shall not:

- provide autograding;
- execute instructor tests against submissions;
- provide plagiarism detection;
- prevent every possible form of late modification;
- treat Git commit author or committer dates as authoritative submission times;
- require AWS, Azure, Cloudflare, Firebase, Supabase, or another external cloud service;
- require a separately hosted API or database;
- use GitHub Issues as the normal student assignment-acceptance interface;
- use forks or double forks as the primary assignment-repository model;
- reproduce every GitHub Classroom feature;
- manage learning-management-system grades;
- guarantee tamper-proof evidence against a malicious organization owner.

## Platform constraints

The complete production system shall run using only:

- GitHub organizations;
- GitHub repositories;
- GitHub Pages;
- GitHub Actions;
- GitHub REST or GraphQL APIs;
- GitHub Apps, OAuth mechanisms, or personal access tokens where GitHub requires them;
- GitHub-hosted or lecturer-managed self-hosted runners.

PXL Classroom shall never depend on GitHub Enterprise (Cloud or Server). The target organization runs GitHub Team for Education and will not be upgraded to GitHub Enterprise; therefore no GitHub Enterprise capability shall be a dependency, an option, or a fallback anywhere in the system.

All authoritative application data shall be stored in one or more instructor-controlled GitHub repositories.

No privileged credential shall be embedded in the static frontend, committed to source control, written to generated Pages output, or stored in a student-controlled repository.

## Actors

### Lecturer

A lecturer is an authorized administrator of PXL Classroom.

PXL Classroom shall support multiple co-lecturers per classroom. Administrative authorization shall derive from GitHub organization ownership, not from a single hard-coded identity. Any organization owner is automatically an authorized lecturer with full access to the control repository, the broker repositories, and every student repository, because organization owners hold administrator access to all organization-owned repositories. A co-lecturer who is not an organization owner may instead be granted access through control-repository collaboration or team membership.

All co-lecturers shall have equivalent administrative capability; auditability shall record which lecturer initiated each state-changing action (see "Auditability").

A lecturer shall be able to:

- create and edit assignment definitions;
- associate an assignment with a private template repository;
- configure opening and deadline times;
- configure eligible students;
- provision or reprovision student repositories;
- inspect assignment and student activity;
- run recovery and synchronization workflows;
- export reports;
- archive assignments;
- view provisioning and collection failures.

### Student

A student is a GitHub user eligible for at least one assignment.

A student shall be able to:

- open one assignment link;
- identify or authenticate themselves through GitHub;
- accept an assignment;
- see provisioning progress;
- open the resulting private repository;
- administer the resulting repository;
- use GitHub Actions, repository secrets, environments, environment secrets, and self-hosted runners;
- revisit the assignment page and recover the repository link.

### PXL Classroom automation

PXL Classroom automation is trusted automation running from an instructor-controlled repository.

It shall:

- validate assignment acceptance;
- create repositories from templates;
- grant repository access;
- maintain the registry;
- collect repository state and activity;
- calculate deadline reports;
- generate static dashboard data;
- detect and report inconsistent or suspicious state;
- operate idempotently.

## Trust model

Student assignment repositories are not authoritative data stores.

Students require administrator access to support:

- adding repository and environment secrets;
- creating and configuring environments;
- adding self-hosted runners;
- enabling and configuring GitHub Actions.

A repository administrator may change settings, disable Actions, rewrite Git history, move or delete tags and branches, rename or delete the repository, or alter workflows. PXL Classroom shall therefore assume that any state stored only inside a student repository may be modified by the student.

The instructor-controlled control repository is authoritative for:

- assignment definitions;
- roster and eligibility data;
- student-to-GitHub-account associations;
- assignment acceptance records;
- repository IDs and expected names;
- opening and deadline times;
- synchronization checkpoints;
- observations collected from GitHub;
- calculated submission reports;
- error and recovery state.

Students shall not have write access to the control repository.

## High-level architecture

PXL Classroom shall consist of:

- one private control repository per participating organization;
- a single shared codebase of trusted GitHub Actions workflows, reused across organizations through reusable workflows or a published action, not forked per organization;
- one GitHub App, installed separately into each participating organization, providing per-installation scoped credentials for privileged automation;
- a single GitHub Pages static application serving all organizations;
- one or more private template repositories per organization;
- private organization-owned student repositories;
- an acceptance-trigger mechanism implemented entirely through GitHub;
- generated JSON data consumed by the static application.

The default repository model shall be independent repositories generated from templates, not forks.

Because access-controlled GitHub Pages is unavailable on the target plan, all GitHub Pages output is public. Private per-user state — for students and lecturers alike — shall not be pre-generated into Pages data; it shall be fetched at runtime by the requesting user's own authenticated GitHub token.

## Multi-organization architecture

PXL Classroom shall support many organizations and many lecturers. A lecturer may create classrooms in any organization they own where the GitHub App is installed.

The architecture separates four layers:

- Credentials: one GitHub App is installed per organization by that organization's owner. Each installation yields a scoped token usable only within that organization. There is no single credential spanning all organizations.
- Code: a single shared codebase provides the trusted workflows, reused across organizations through reusable workflows or a published action. Organizations are not normally forked; forking is an opt-in only for an organization that requires hard isolation.
- Data and execution: each organization stores its own classrooms, roster, observations, and reports in a control repository inside that organization, and runs its own workflows there. No organization's private data is stored where another organization's lecturers can read it.
- Dashboard: a single public GitHub Pages application serves all organizations. After a lecturer authenticates, it lists the organizations they own where the App is installed, then lists classrooms per organization, fetching each organization's control-repository data at runtime with the lecturer's own token.

Because GitHub repository permissions are all-or-nothing, per-organization control repositories are required: a shared control repository would expose every organization's private roster and reports to every lecturer who could read it.

In the remainder of this document, "the control repository" refers to the control repository of the relevant organization.

## Control repository

Each participating organization has one control repository. The control repository is provisioned entirely automatically via the **Setup Organization** GitHub Action; administrators do not manually create the repository or manually inject secrets. The control repository shall contain, directly or through generated branches:

```text
assignments/
students/
acceptances/
repositories/
observations/
reports/
schemas/
workflows/
public/
```

The exact file layout may change, but stored data shall be:

- machine-readable;
- schema-versioned;
- reviewable in Git;
- recoverable from Git history;
- deterministic where practical;
- separated into source data and generated data.

Generated Pages data shall contain only information appropriate for its visibility level.

Sensitive roster data shall not be published through a public GitHub Pages site.

## Assignment definition

Each assignment shall have a stable, URL-safe identifier.

An assignment definition shall contain at least the following fields (note: this YAML is automatically generated by the Instructor Admin Panel UI; manual editing is not required):

```yaml
schema_version: 1
id: linux-processes-2026
title: Linux Processes
description: Short student-facing description
organization: pxl-classroom
template:
  owner: pxl-classroom
  repository: template-linux-processes
repository_name_pattern: linux-processes-{github_login}
opens_at: 2026-09-21T06:00:00Z
deadline_at: 2026-10-05T21:59:59Z
timezone: Europe/Brussels
submission_ref: refs/heads/main
student_permission: admin
acceptance_mode: self-service
late_policy: report
state: published
```

Assignment definitions shall support at least these states:

- draft;
- published;
- closed;
- archived.

A published assignment shall not be silently changed in ways that alter historical deadline interpretation.

Changes to a published assignment's deadline shall be recorded in Git history and surfaced in the administrative interface.

All stored timestamps shall use UTC. The user interface shall display times in the configured assignment timezone, defaulting to `Europe/Brussels`.

## Template repositories

A lecturer shall be able to select a private repository as an assignment template within the chosen organization.

Each assignment shall store an explicit, authoritative reference to its template repository (owner and repository). This explicit reference is the source of truth and shall track the template's immutable repository ID where practical, so a template rename does not break the link.

To assist selection, the dashboard shall additionally auto-discover candidate template repositories in the chosen organization using a configurable name prefix, defaulting to `pxl-template-`. Prefix-based discovery is a convenience for the template picker only; it shall not override the explicit per-assignment reference.

PXL Classroom shall validate before publication that:

- the template repository exists;
- the trusted automation can read it;
- the repository is marked as a template where required by the selected API;
- the destination organization is accessible;
- the target repository-name pattern is valid;
- required workflow and configuration files are present, when configured.

Repository generation shall create an independent repository history.

Template changes after a student repository has been created shall not automatically alter that repository in version 1.

## Student eligibility and roster

PXL Classroom shall support a roster stored in the control repository.

A roster entry shall have a stable institutional identifier and may initially omit a GitHub username.

Example:

```yaml
schema_version: 1
students:
  - student_id: "0123456"
    display_name: Student Name
    class_group: 3A
    github_login: null
    active: true
```

The system shall support either:

- pre-associated GitHub usernames; or
- self-service association during assignment acceptance.

The system shall reject acceptance by an ineligible GitHub account unless the assignment explicitly permits open acceptance.

A GitHub account shall not be associated with multiple active students without lecturer intervention.

Until institutional verification is added, PXL Classroom cannot cryptographically prevent a student from associating with another student's roster entry. The lecturer shall be able to detect and correct mis-associations through review and overrides.

Version 1 shall not perform institutional identity verification. A student authenticates with GitHub and self-associates their GitHub login with a roster entry during acceptance; the lecturer reconciles GitHub logins to real students afterward. Version 1 deliberately accepts the residual risk that a student associates the wrong roster entry and relies on lecturer review and overrides to correct it.

Stronger institutional verification is a planned future enhancement, not part of version 1. A likely approach binds the GitHub account to a verified PXL Microsoft 365 identity (Outlook / Entra ID) or a Microsoft Forms step in the PXL tenant. Because that introduces a non-GitHub dependency, it is an explicit, deliberate exception to the GitHub-only constraint, to be designed when promoted.

## Student-facing web application

The student-facing application shall be a static web application hosted by GitHub Pages.

The frontend may be built with standard static-site tooling — for example a Vue (or comparable) single-page application compiled with Node.js build tools — and deployed as static assets. It shall not require a running server runtime: GitHub Pages serves only static files, and PXL Classroom has no always-running server. Logic that would otherwise need a server shall run either in the browser against the GitHub API using the user's own token, or in trusted GitHub Actions workflows. A server framework that requires a running process, such as Express used as a deployed backend, shall not be used. The same constraint applies to the administrative dashboard, which is also a static Pages application.

For an assignment link, the application shall display:

- assignment title;
- assignment description;
- opening time;
- deadline;
- current assignment state;
- authenticated or detected GitHub username;
- acceptance status;
- repository-provisioning status;
- repository link when ready;
- actionable error messages.

The student-facing application shall not display GitHub Issues as the normal acceptance workflow.

The normal student flow shall be:

1. Open the assignment URL.
2. Authenticate or establish GitHub identity.
3. Confirm assignment acceptance.
4. Wait while GitHub Actions provisions the repository.
5. Open the repository.

The student shall not be asked to create or paste a personal access token.

The student shall not need write access to the control repository.

Because GitHub Pages output is public on the target plan, the application shall not read per-student private state from pre-generated Pages data. It shall obtain the student's own acceptance status, repository link, and repository state at runtime using the student's authenticated GitHub token, which is authorized only for the student's own resources.

The application shall be safe to refresh or reopen during provisioning.

Repeated acceptance attempts shall resolve to the same repository and shall not create duplicates.

## Browser authentication

The implementation shall use a GitHub-supported authentication flow that can operate from a static frontend without exposing privileged credentials.

Candidate flows are:

- GitHub device authorization flow;
- GitHub OAuth or GitHub App user authorization with PKCE, subject to a documented threat assessment;
- no frontend API token, with a GitHub-hosted interaction used only as the identity-bearing acceptance signal.

The selected flow shall:

- identify the current GitHub user;
- request the minimum possible permissions;
- avoid long-lived browser token storage;
- avoid local storage for access and refresh tokens;
- clear in-memory or session credentials after acceptance where practical;
- protect OAuth state and PKCE verifier values against cross-site request forgery and code interception;
- document the implications of a public-client client secret if one is shipped in the static application.

Device flow shall be treated as a candidate, not an automatic default, because it adds an extra GitHub verification step and has app-impersonation and phishing considerations.

The authentication flow shall be finalized only after a working technical prototype.

## Acceptance trigger

Because a static frontend cannot safely hold organization-level repository-administration credentials, student acceptance shall emit a GitHub-hosted event that triggers trusted GitHub Actions automation.

Version 1 has selected one trigger mechanism: an assignment-specific acceptance broker repository activated by a repository star and the GitHub Actions `watch: started` event. This selection is subject to the mandatory acceptance-event spike; if that spike fails, the project falls back to pre-provisioned mode.

The selected mechanism is an assignment-specific acceptance broker repository:

- PXL Classroom creates or configures one broker repository per assignment.
- The frontend performs a narrowly authorized student action against that repository.
- The GitHub event identifies the authenticated student.
- A trusted workflow validates the event and provisions the private assignment repository.

A repository star and the GitHub Actions `watch: started` event are the selected mechanism because GitHub triggers a workflow when a repository is starred.

The acceptance mechanism shall satisfy all of these requirements:

- no external service;
- no GitHub Issue required from the student;
- no student write access to the control repository;
- authenticated GitHub actor in the trigger payload;
- assignment identity derivable without trusting arbitrary student input;
- retryable and idempotent processing;
- validation against the roster or assignment eligibility rules;
- resistance to duplicate or replayed requests;
- a deterministic way for the frontend to discover the resulting repository;
- documented behavior if a student manually repeats or reverses the triggering GitHub action.

Confirmed mechanism details:

- The `watch: started` workflow shall live on the broker repository's default branch.
- A repeated identical star while already starred is a no-op (no event), but unstarring and then restarring re-fires `watch: started` (confirmed by Spike 3). The provisioning workflow shall therefore be idempotent against repeated `watch: started` events, keyed on control-repository registry state, rather than assume a single delivery per student.
- The broker repository shall be public so that any authenticated eligible student can star it without prior organization membership. Star activity on a public repository is itself public; this exposure is accepted.
- The provisioning workflow shall handle a class-wide burst of stars within Actions concurrency and secondary rate-limit constraints.

The star-based trigger shall be validated by the mandatory acceptance-event spike before implementation freeze, confirming:

- the workflow triggers for a star created through the REST API;
- the workflow receives the expected actor identity;
- repository secrets are available to the trusted workflow;
- organization Actions policies do not suppress the event;
- unstar and restar behavior is understood;
- the browser authentication token can receive only the required permissions;
- public visibility and student activity exposure are acceptable;
- workflow concurrency behaves correctly under a class-wide burst.

If the star-based trigger fails these criteria, the project shall select another GitHub-only event or use pre-provisioned repositories.

## Pre-provisioned mode

PXL Classroom shall support pre-provisioning as a valid assignment mode. Self-service star-based acceptance is the selected primary mode; pre-provisioning is the supported fallback if the acceptance-event spike fails.

In pre-provisioned mode:

- GitHub usernames are known before distribution;
- trusted automation creates all repositories;
- students receive or discover their repository through the static frontend;
- acceptance means acknowledging or opening an existing repository;
- no dynamic repository-creation trigger is required.

Pre-provisioned mode shall be usable as the fallback if self-service acceptance cannot be implemented safely with GitHub-only services.

## Repository provisioning

For each valid acceptance, PXL Classroom shall:

- calculate a deterministic repository name;
- check for an existing registry entry by assignment and student;
- check for an existing repository by stored GitHub repository ID and expected name;
- create a private organization-owned repository from the configured private template when necessary;
- grant the student administrator access;
- preserve lecturer and automation access;
- record the immutable GitHub repository ID;
- record the repository URL and current name;
- record provisioning timestamps and workflow run identifiers;
- update generated dashboard data.

Granting administrator access to a student who is not an organization member creates a repository invitation that the student must accept before access becomes effective. PXL Classroom shall treat such access as pending until accepted and shall surface invitation state in the dashboard. (Confirmed by Spike 1: the grant returns an invitation for an outside collaborator.)

Repository creation shall be idempotent.

A retry after a partial failure shall continue from recorded state rather than create another repository.

The repository ID, not only the repository name, shall be used as the primary external identifier because repositories can be renamed.

PXL Classroom shall detect and report when a repository is:

- renamed;
- transferred;
- archived;
- unarchived;
- made public;
- deleted or inaccessible;
- missing the expected student administrator;
- missing the expected PXL Classroom automation access.

The system shall attempt automated repair only for explicitly safe and documented cases.

## Student repository permissions

Students shall receive administrator access to their assignment repository.

This is required so students can:

- enable and configure GitHub Actions;
- create repository secrets;
- create environments;
- create environment secrets;
- add self-hosted runners;
- inspect and modify repository settings needed by course exercises.

The system shall prominently document that administrator access prevents PXL Classroom from guaranteeing that repository state has not been changed after a deadline.

No privileged PXL Classroom credential shall be available to workflows in a student-controlled repository.

The built-in `GITHUB_TOKEN` in a student repository shall not be treated as an authority for central PXL Classroom state.

Student repositories shall not receive a token that can write to the control repository or administer other student repositories.

## Deadlines and submission semantics

An assignment shall have a configured deadline instant.

PXL Classroom shall not use a Git commit's author date or committer date as authoritative proof that work was submitted before the deadline.

The primary submission ref shall be configurable per assignment and default to `refs/heads/main`.

The desired submission determination is:

> The valid submission is the latest state of the configured submission ref known by GitHub to have been pushed no later than the assignment deadline.

The target plan is GitHub Team for Education. GitHub does not expose per-push event evidence to PXL Classroom on this plan, so the system establishes submission state by observation. PXL Classroom defines two evidence levels and labels which it uses:

### Evidence level A: trusted central snapshots

Trusted control-repository workflows shall periodically snapshot each managed repository's configured submission ref.

The collector shall:

- run on a regular schedule;
- increase collection frequency around deadlines;
- record GitHub API observation time;
- record repository ID, ref, and observed SHA;
- record API and permission errors;
- make no claim that a change occurred exactly at the commit's embedded date;
- classify the result as observed state, not definitive push time.

The deadline report shall clearly state the uncertainty interval when the exact push time cannot be established.

For example:

```text
Last observed on-time SHA: abc123
Observed at: 21:57:10
First observed later SHA: def456
Observed at: 22:02:43
Exact push time: unavailable
```

### Evidence level B: best-effort repository metadata

If reliable central snapshots are not available, the system may report current repository history and GitHub metadata, but shall clearly label it as non-authoritative and shall not imply that commit dates prove submission time.

Version 1 shall implement evidence level A (trusted central snapshots) as its primary and required mechanism. Evidence level A shall be reinforced by deadline lock-down, which removes a student's ability to modify the submission at the deadline and so tightens the uncertainty interval (see "Deadline lock-down").

## Deadline collection

Scheduled GitHub Actions workflows are not guaranteed to start at the exact scheduled minute.

Therefore, PXL Classroom shall not define the valid submission as simply the branch head observed by one workflow that starts after the deadline.

The collector shall:

- operate continuously enough to establish useful observations;
- store its last successful collection cursor or timestamp;
- be safe to rerun manually;
- detect collection gaps;
- warn when a gap crosses a deadline;
- regenerate reports after delayed data becomes available;
- never silently convert uncertain evidence into a definitive result.

Recommended initial schedules are:

- normal collection every six hours;
- every fifteen minutes from two hours before until two hours after a deadline, where GitHub scheduling and usage limits permit;
- a manual lecturer-triggered synchronization and finalization workflow.

These frequencies are configuration defaults, not guaranteed execution times.

## Deadline lock-down

At each assignment deadline, trusted automation shall reduce a student's ability to modify the submission by revoking the student's write and administrator access to the assignment repository.

Because assignment repositories are organization-owned and the trusted automation acts through the GitHub App rather than through the student's own permissions, a student demoted at the deadline cannot restore their own access.

Lock-down shall:

- be a per-assignment configurable behavior, defaulting to enabled;
- demote the student from administrator to read access at the deadline;
- preserve lecturer and automation access;
- record the repository ID, the observed SHA, and the lock-down time;
- capture a final submission snapshot at lock-down time;
- be idempotent and safe to rerun;
- record failures without blocking other students.

Lock-down reduces the uncertainty interval of evidence level A to the gap between the deadline instant and the actual execution of the lock-down workflow. Because scheduled workflows do not start at the exact scheduled minute, that gap shall be recorded and reported rather than assumed to be zero.

Lock-down is a deterrent, not a tamper-proof control. Consistent with the trust model, a student who prepares before the deadline may retain alternative write paths, for example by adding another collaborator, registering a deploy key, or forking the repository. PXL Classroom shall therefore continue to report observed late activity and shall not present lock-down as proof of submission integrity.

A lecturer shall be able to extend a deadline or restore a student's access through a recorded override.

## Late activity

PXL Classroom shall reduce, through deadline lock-down, the likelihood of post-deadline modification, but shall not guarantee that students cannot push after the deadline.

PXL Classroom shall report, where evidence permits:

- whether activity was observed after the deadline;
- the number of observed late pushes or state changes;
- the first observed late activity time;
- the latest observed late activity time;
- affected refs;
- the before and after SHAs when available;
- force pushes or history rewrites when detectable;
- changes to the default branch;
- repository renames, archival, visibility changes, or deletion;
- uncertainty caused by collection gaps.

Late activity shall not automatically delete, revert, or block student work.

The lecturer shall be able to grade using the last on-time submission state or another explicitly selected state.

## Submission preservation

When PXL Classroom determines or observes a candidate deadline SHA, it shall preserve an instructor-controlled reference to that state where technically possible.

The preservation mechanism may be:

- an instructor-controlled archive repository;
- a Git bundle committed or uploaded to an instructor-controlled repository;
- an archive branch or tag in a repository students cannot administer;
- another GitHub-hosted immutable-enough representation.

Recording only a SHA is insufficient for long-term preservation if the corresponding object may become unreachable and eventually disappear from the student repository.

The preservation process shall:

- record the source repository ID;
- record the source ref;
- record the selected source SHA;
- verify that the object can be fetched;
- preserve its reachable history or documented subset;
- verify the preserved object hash;
- record failures without overwriting the original evidence.

The archive shall not contain secrets, Actions logs, environment secrets, or runner credentials.

## Dashboard

The administrative dashboard is the single public GitHub Pages application serving all organizations. It shall not read private data from pre-generated public files; it shall fetch each organization's private control-repository data at runtime using the authenticated lecturer's own GitHub token, which is scoped to the organizations that lecturer owns. The dashboard shall let the lecturer choose an organization they own where the App is installed, and shall list classrooms per organization.

For a chosen organization and classroom, the administrative dashboard shall provide an assignment overview containing at least:

- assignment name;
- opening time;
- deadline;
- assignment state;
- assignment type (individual; group assignments are planned for version 2);
- template repository;
- a copyable assignment acceptance link;
- number of eligible students;
- number accepted;
- number provisioned;
- number with observed activity;
- number with an on-time candidate submission;
- number submitted and number not submitted, where submitted means observed submission activity beyond the starter code, whether on-time or late;
- number with late activity;
- number with warnings or errors.

For each student, the dashboard shall provide:

- institutional identifier, subject to access controls;
- display name, subject to access controls;
- GitHub login;
- acceptance state;
- a submission status label derived from observed evidence (for example: on-time, late, or no submission observed);
- repository name and URL;
- immutable repository ID;
- invitation or access state where available;
- repository creation time;
- latest observed default branch;
- latest observed SHA;
- last on-time candidate SHA;
- first and latest late activity;
- count of observed commits or pushes, with the metric clearly labeled;
- preservation status;
- warning indicators;
- synchronization status;
- links to relevant GitHub commits, Actions runs, and repository settings.

Commit count and push count shall be distinct metrics.

The dashboard shall not present a commit count as a measure of work quality.

The dashboard shall support searching and filtering students within an assignment, for example by GitHub login, acceptance state, submission status, or warning state.

The dashboard shall not present an autograding-based pass or grade metric, because PXL Classroom does not autograde. Per-student status shall instead reflect acceptance, provisioning, observed on-time and late activity, preservation, and warnings.

## Visibility and privacy

All GitHub Pages output published by PXL Classroom is world-readable. The design treats every Pages site as public and shall not rely on any access-restricted Pages mechanism, which GitHub offers only on Enterprise and which PXL will never have.

Public Pages output shall not contain:

- institutional student identifiers;
- student names unless explicitly approved;
- private repository names when their disclosure is undesirable;
- private repository URLs;
- claim tokens;
- GitHub access tokens;
- workflow secrets;
- raw audit events containing unnecessary personal or network information.

Pre-generated Pages data shall therefore contain only public assignment metadata. All private state — per-student and per-organization — shall be fetched at runtime using the requesting user's own authenticated token rather than pre-generated into shared Pages data. The administrative dashboard may therefore be served as a public GitHub Pages application, because it holds no private data at rest and reads private control-repository data only at runtime with the lecturer's own token.

The frontend shall not rely on obscurity, hashed usernames, or unguessable filenames as an authorization mechanism.

## Administrative workflows

PXL Classroom shall provide an Instructor Admin Panel UI within the static dashboard to perform privileged administration (creating assignments, publishing, granting extensions) via the GitHub REST API. 

While the system is driven by this UI, the underlying actions map to manually triggerable workflows or direct Git commits. The required workflows include:

- validate configuration;
- publish assignment;
- provision assignment;
- synchronize repositories;
- collect activity;
- finalize deadline report;
- regenerate dashboard;
- retry failed provisioning;
- repair registry;
- archive assignment;
- export report.

Workflow inputs shall be validated.

Administrative workflows shall support dry-run mode where practical.

A workflow shall not commit generated changes when validation fails.

## Static data generation

Trusted workflows shall generate the JSON consumed by the Pages application. Because GitHub Pages output is public, this generated JSON shall contain only public assignment metadata and shall not contain per-student private data.

Generated output shall:

- have an explicit schema version;
- include a generation timestamp;
- be deterministic for unchanged source data;
- avoid secrets and unauthorized personal data;
- be written atomically or published through a safe deployment process;
- preserve the last known good site when generation fails.

The frontend shall handle stale data and display the generation time.

## Notifications

PXL Classroom shall provide GitHub-native notifications for significant events.

At minimum, the lecturer shall be able to discover:

- failed repository provisioning;
- failed activity collection;
- a collection gap spanning a deadline;
- missing repository access;
- unexpected repository deletion or transfer;
- late activity after a deadline;
- failure to preserve a candidate submission.

Notification channels may include:

- failed workflow status;
- workflow summaries;
- a dedicated instructor-only tracking issue;
- GitHub notifications generated from a private control repository.

Issues may be used internally for lecturer notifications, but shall not be the normal student assignment-acceptance interface.

Notification generation shall be deduplicated to avoid repeated alerts for the same condition.

## Security requirements

PXL Classroom shall follow least privilege.

The trusted automation credential shall:

- be stored only as an Actions secret or GitHub App private key secret in the control repository or organization;
- receive only the permissions required for provisioning, membership, metadata collection, and archival;
- use short-lived installation tokens where possible;
- never be exposed to pull requests or workflows controlled by students;
- never be printed to logs;
- be rotatable without modifying student repositories.

The GitHub App permission set required for provisioning is confirmed by Spike 1 to be: Repository **Administration** (read/write), **Contents** (read/write), and **Metadata** (read). This set is sufficient to create a repository from a private template and grant a student administrator access. All later spikes (collection, lock-down, preservation) ran within this set; no further permissions were required. Finalized minimum set: Administration RW, Contents RW, Metadata R.

For the browser acceptance flow, the same App additionally requires the user-level Account **Starring** (read/write) permission with Device Flow enabled. This is exercised only by the user-to-server (device-flow) token, which stars the broker and cannot use the App's installation (provisioning) permissions. Confirmed by Spikes 2–3.

All third-party Actions shall be pinned to a full commit SHA in security-sensitive workflows.

Untrusted assignment, roster, and event values shall not be interpolated into shell commands without safe encoding and validation.

Repository names, refs, usernames, paths, and workflow inputs shall be validated against strict allowlists or formats.

Concurrency controls shall prevent duplicate provisioning for the same assignment and student.

All write operations shall be idempotent or protected by compare-and-set style checks.

The project shall define recovery steps for:

- compromised automation credentials;
- malicious acceptance bursts;
- accidentally public student repositories;
- deleted control data;
- failed Pages deployment;
- incomplete provisioning;
- API rate limiting;
- GitHub service outages.

## Reliability requirements

The system shall tolerate:

- duplicate GitHub events;
- delayed workflow execution;
- canceled workflow runs;
- API pagination;
- transient API failures;
- GitHub rate limiting;
- repository renames;
- repeated acceptance attempts;
- partially completed provisioning;
- stale generated Pages data.

Retries shall use bounded exponential backoff where appropriate.

Every synchronization workflow shall produce a machine-readable result and a human-readable workflow summary.

A failed record shall not prevent unrelated students from being processed.

Bulk workflows shall support resuming after partial failure.

## Auditability

Every state-changing automation run shall record:

- workflow run URL or identifier;
- initiating actor;
- operation type;
- assignment ID;
- affected student or repository;
- start and completion time;
- outcome;
- relevant GitHub resource IDs;
- error category where applicable.

Source configuration changes shall occur through Git commits.

Generated records shall identify the source revision and generator version.

The project shall distinguish:

- facts returned by GitHub;
- observations made at a specific time;
- calculated values;
- lecturer overrides.

Lecturer overrides shall require a reason and shall not erase original evidence.

## Retention

PXL Classroom shall retain raw observations and generated reports in the control repository for the current and previous academic year. Data older than two academic years shall be archived out of the active control repository and may then be removed from it, provided the archive remains recoverable.

Archival shall preserve the Git history needed to audit past assignments and shall not destroy preserved submission evidence.

Retention boundaries shall be expressed in whole academic years.

## Lecturer overrides

The lecturer shall be able to record an override for:

- GitHub username association;
- acceptance state;
- repository association;
- deadline extension;
- accepted submission SHA;
- late-status interpretation;
- exemption from an assignment;
- report annotation.

Overrides shall be append-only or versioned through Git history.

The dashboard shall visibly identify overridden values.

## Reporting and export

The lecturer shall be able to export assignment data as at least:

- JSON;
- CSV.

Exports shall include a schema version and generation timestamp.

CSV export shall include one row per student and direct GitHub links where applicable.

Reports shall distinguish exact timestamps from observation timestamps and uncertain intervals.

## Accessibility and usability

The static application shall:

- work on current desktop and mobile browsers;
- be keyboard accessible;
- use semantic HTML;
- provide visible focus states;
- provide text alternatives for non-text content;
- avoid relying on color alone for state;
- provide clear progress and failure messages;
- survive page refresh during acceptance;
- provide a copyable repository URL;
- use absolute dates and include the timezone.

The primary student acceptance flow should require no more than:

- opening the link;
- authenticating with GitHub if needed;
- one explicit acceptance confirmation;
- opening the repository.

An additional device-flow verification step is acceptable only if required by the selected secure GitHub-only authentication design.

## Performance and scale

The initial target scale shall be configurable but should support at least:

- 500 active students;
- 20 active assignments;
- 10,000 managed repositories over the lifetime of an organization;
- a class-wide acceptance burst of 250 students;
- bulk synchronization without exceeding normal GitHub API rate limits.

Provisioning may be asynchronous.

The frontend shall immediately acknowledge acceptance and display a pending state.

The normal target is for a repository to become available within five minutes, excluding GitHub service delays. This is a service objective, not a guarantee.

Bulk workflows shall use controlled concurrency to avoid API abuse and secondary rate limits.

## Compatibility

Version 1 shall target GitHub.com organizations on GitHub Team with the available GitHub Education upgrade.

PXL Classroom shall never depend on GitHub Enterprise. PXL will not have GitHub Enterprise, so no GitHub Enterprise feature shall be a dependency, an option, or a fallback. The design shall use only capabilities available on GitHub Team for Education. Capabilities that GitHub restricts to Enterprise — including organization audit-log API access, `git.push` audit events, and access-controlled (private) GitHub Pages — are permanently out of scope and shall not be relied upon.

At startup and during validation, the system shall detect or test required capabilities and present actionable failures.

## Technical spikes required before implementation freeze

The following prototypes are mandatory before the architecture is considered final.

### Student authentication spike

Demonstrate a static GitHub Pages application that:

- identifies the GitHub user;
- uses the minimum required permission;
- does not require the student to paste a PAT;
- does not expose a privileged credential;
- works after a page refresh or gives a clear restart path;
- documents token lifetime and storage.

Compare device flow with OAuth or GitHub App PKCE.

### Acceptance-event spike

Demonstrate that a browser action can:

- produce a GitHub event carrying the student actor;
- trigger a trusted workflow;
- retain workflow secret access;
- identify the assignment;
- support duplicate-safe processing;
- work under realistic organization Actions settings.

This spike shall validate the selected mechanism: starring a public assignment broker repository and handling `watch: started`. Implementation freeze depends on its success; failure forces the pre-provisioned fallback.

### Provisioning spike

Demonstrate a control-repository workflow that:

- authenticates using the per-organization GitHub App installation token;
- creates a private repository from a private template;
- grants a test student administrator access;
- records the repository ID;
- produces a status record;
- succeeds on a safe retry without duplication;
- runs the same way in two different organizations using the same GitHub App installed in each.

### Deadline-evidence spike

On the actual organization, demonstrate that trusted automation can:

- take central periodic snapshots of a repository's configured submission ref;
- record observation time, repository ID, ref, and observed SHA;
- perform deadline lock-down by revoking a test student's write and administrator access at a mock deadline through the GitHub App;
- confirm the student cannot restore their own access after demotion;
- capture a final snapshot at lock-down time;
- quantify the residual uncertainty interval between the mock deadline and lock-down execution.

### Submission-preservation spike

Demonstrate that trusted automation can:

- fetch a selected SHA from a private student repository;
- preserve it in an instructor-controlled GitHub repository;
- verify the preserved hash;
- retain it after the source branch is force-pushed.

### Pages privacy spike

Determine what data can safely be served, given that all GitHub Pages output is public.

Demonstrate that administrative roster and private repository data are not exposed publicly.

## Acceptance criteria for version 1

Version 1 is acceptable when a lecturer can:

- define an assignment from a private template;
- publish one assignment URL;
- allow an eligible student to accept without using a GitHub Issue;
- provision exactly one private organization-owned repository;
- grant the student administrator access;
- revisit the assignment and recover the repository link;
- view all students and provisioning states;
- view repository activity and deadline classification;
- distinguish observed submission snapshots from uncertain intervals;
- identify late activity when evidence permits;
- preserve a selected submission state outside student control;
- export a CSV report;
- operate and recover the system using only GitHub and GitHub Actions.

## Resolved decisions

The following decisions are resolved:

- The system targets GitHub Team for Education and shall never depend on GitHub Enterprise.
- Deadline evidence uses level A (trusted central snapshots) as the primary mechanism; per-push audit events are not available on the target plan and are not used.
- Deadline lock-down is promoted into version 1 to reinforce snapshot evidence.
- All GitHub Pages output is public; private per-user state (students and lecturers) is fetched at runtime with the requesting user's own token rather than pre-generated into public files. The administrative dashboard is therefore a single public Pages app spanning organizations.
- PXL Classroom supports many organizations: one GitHub App installed per org, one shared workflow codebase (no forks), a per-org control repository, and one cross-org public Pages dashboard. Forking per org is an opt-in for hard isolation only.
- Assignment templates use an explicit authoritative reference per assignment, plus a configurable discovery prefix (default `pxl-template-`) for the picker.
- Self-service acceptance uses a public broker repository with the `watch: started` star event as the selected trigger, subject to the mandatory acceptance-event spike; pre-provisioning is the fallback.
- Because the broker repository is public, students need not be organization members to accept; they may be outside collaborators granted administrator access on their own assignment repository.
- Multiple lecturers may administer a classroom; authorization derives from GitHub organization ownership.
- Version 1 performs no institutional identity verification; students self-associate their GitHub login with a roster entry and lecturers reconcile. Microsoft 365 / Microsoft Forms verification is a planned future enhancement and an explicit exception to the GitHub-only constraint.
- Group assignments are deferred to version 2.
- Storage uses a single private control repository.
- Raw observations and generated reports are retained for the current and previous academic year, then archived.
- Spike 1 (provisioning) passed: a per-org GitHub App installation token creates a private repo from a private template, grants the student admin (an invitation for outside collaborators), records the immutable repo ID, and is idempotent (a re-run reuses the existing repo). Minimal App permissions for provisioning confirmed: Administration RW, Contents RW, Metadata R.
- Spike 3 (acceptance) passed: an API-created star fires `watch: started`, the workflow receives the starring actor (login and immutable `sender.id`), retains repository secret access, and is not suppressed by org Actions policy. A non-member account (`tomccargo`) starring a public broker triggered it with `actor=tomccargo` — confirming students need no prior org membership. Unstar→restar re-fires, so provisioning must be idempotent. The device-flow user token stars the broker (HTTP 204) once the App is granted Account/Starring. Remaining: burst concurrency (~250).
- Spike 4 (deadline lock-down) passed: at the deadline the App demotes the student admin→read; the student becomes read-only and cannot self-restore (the org-level App installation out-ranks repo admin). Snapshots record repo id/ref/SHA; residual uncertainty is the deadline→workflow-execution gap (22s in the test).
- Spike 5 (preservation) passed: a selected SHA is pushed from the student repo into a private instructor-controlled archive repo, the preserved hash is verified, and it survives a force-push / history rewrite of the source (object remains independently fetchable). Confirms recording a SHA alone is insufficient — the reachable object must be copied out of student control.
- Spike 6 (Pages privacy) passed: published Pages output carries only public assignment metadata; a privacy scanner (`scan.mjs`) blocks publishing if roster fields, emails, tokens, or keys appear. Private state is fetched at runtime with the requesting user's own token. Resolves the Pages-visibility open decision.
- Archive representation finalized (Spike 5): the preserved commit is stored as a branch (or tag) in a private instructor-controlled archive repository.
- GitHub App permissions finalized: Repository Administration RW, Contents RW, Metadata R, plus Account Starring RW (user) with Device Flow enabled. All spikes ran within this set; nothing more was needed.
- Class-wide acceptance burst (~250) is handled by design — workflow concurrency, controlled fan-out, and secondary-rate-limit backoff — rather than by a per-event guarantee; not separately spiked (would require ~250 accounts).
- Spike 2 (auth) passed for identity: GitHub device flow identifies the user with no PAT and no browser secret, yielding an 8h expiring user-to-server token with a refresh token and no broad scopes. Device flow is the **selected** browser-auth flow: with the App's Account/Starring permission, the device-flow user token stars the broker (HTTP 204, Spike 3), proving the full chain end-to-end.

## Open decisions

All version 1 open decisions are resolved — see *Resolved decisions*. The mandatory technical spikes are complete.

## Deferred features

The following are deferred unless promoted into a later requirements revision:

- group assignments (planned for version 2);
- template updates after provisioning;
- assignment starter-code synchronization;
- automatic feedback;
- autograding;
- LMS integration;
- multi-institution hosting;
- multiple destination organizations;
- anonymous grading;
- rubric management.

## References

The implementation shall be validated against current official GitHub documentation, including:

- GitHub Actions workflow trigger events:
  https://docs.github.com/actions/using-workflows/events-that-trigger-workflows
- GitHub App user access tokens:
  https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app
- GitHub App best practices:
  https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app
- OAuth application authorization:
  https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps
- Repository REST API:
  https://docs.github.com/rest/repos/repos
- Starring REST API:
  https://docs.github.com/rest/activity/starring
- GitHub Actions authentication:
  https://docs.github.com/actions/reference/authentication-in-a-workflow
