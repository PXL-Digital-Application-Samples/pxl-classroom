# Spike 1 — Provisioning

**Goal:** authenticate as a per-org **GitHub App** installation token, create a private repo from a private template, grant a test student admin, record the immutable repo ID, write a status record, and prove a safe (idempotent) retry — in **two** orgs with the same App.

Status: **IN PROGRESS** · see `REQUIREMENTS.md` → *Provisioning spike* for the source criteria.

## Target values (real)

| Thing | Value |
|---|---|
| Spike host repo | `PXL-Digital-Application-Samples/pxl-classroom` (this repo) |
| Target org A | `PXLAutomation` |
| Target org B | another org you own (e.g. `PXLCloudAndAutomation`) — for the cross-org proof |
| Template | `PXLAutomation/template-automation-pe-1` (`is_template = true`) |
| Test student | a GitHub login that is **not** an org owner (see "Test student" below) |

## Test student

The "grant student admin" step sends a **collaborator invitation** to a username. You only ever share a **login** — never a password or token — and that account accepts the invite in the browser.

- Best: your **private personal GitHub account** (a real second account → proves the outside-collaborator path).
- Do **not** use an org owner as the test student: owners already have admin, so it doesn't exercise the invite flow.

## Part A — local read-only validation (no App, no writes)

Proves the script + template + idempotency logic against real data without creating anything.

```bash
cd /home/tomc/github/pxl-classroom
GITHUB_TOKEN="$(gh auth token)" \
ORG=PXLAutomation \
TEMPLATE_OWNER=PXLAutomation \
TEMPLATE_REPO=template-automation-pe-1 \
TARGET_REPO=spike01-provisioning-test \
STUDENT_LOGIN=<any-placeholder> \
DRY_RUN=1 \
node spikes/01-provisioning/provision.mjs
```

`DRY_RUN=1` performs only GET requests (identity, template check, existence check) and skips the create + grant. A PAT is fine here because nothing is written.

## Part B — real run via GitHub Actions (the actual spike)

### 1. Create the GitHub App (once)

Org → Settings → Developer settings → GitHub Apps → New GitHub App.

- **Permissions (starting hypothesis — the spike confirms the minimal set):**
  - Repository → **Administration**: Read & write (create repo, manage collaborators)
  - Repository → **Contents**: Read & write (template generate / read)
  - Repository → **Metadata**: Read (mandatory)
  - Organization → **Members**: Read (optional; roster/eligibility checks later)
- **Where can this App be installed:** Any account (so it can be installed in multiple orgs).
- Generate a **private key** (.pem).

### 2. Install the App in the target org(s)

Install in `PXLAutomation` (and later org B). Grant it "All repositories" or at least the template + the repos it will create.

### 3. Add secrets to this repo

`PXL-Digital-Application-Samples/pxl-classroom` → Settings → Secrets and variables → Actions:

- `SPIKE_APP_ID` — the App's numeric ID
- `SPIKE_APP_PRIVATE_KEY` — the full .pem contents

### 4. Run

Actions → **Spike 01 - Provisioning** → Run workflow → set `org`, `target_repo`, `student_login`. Then **run it again** unchanged to prove idempotency (outcome should be `reused`, not a duplicate). Repeat for org B.

## Success criteria (check off with evidence)

- [ ] authenticates using the per-organization GitHub App installation token
- [ ] creates a private repository from a private template
- [ ] grants the test student administrator access (invitation sent / accepted)
- [ ] records the immutable repository ID (see `out/status-*.json`)
- [ ] produces a status record
- [ ] safe retry without duplication (second run → `reused`)
- [ ] same flow works in a second organization with the same App
- [ ] minimal App permission set recorded here:

## Results

_(fill in: run URLs, repo IDs, the confirmed minimal permission set, anything that forced a requirements change)_
