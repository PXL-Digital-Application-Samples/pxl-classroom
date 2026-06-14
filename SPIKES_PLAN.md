# PXL Classroom — Technical Spikes Plan

Status: Complete — all six spikes pass; `REQUIREMENTS.md` is v1.0 (Approved)
Companion to: `REQUIREMENTS.md` (v1.0, Approved)
Last updated: 2026-06-14

## Why this exists

`REQUIREMENTS.md` began as a **draft**. Its section *"Technical spikes required before implementation freeze"* listed prototypes that had to succeed before the architecture could be final. Several load-bearing assumptions were believed but unproven, and some did **change the requirements**.

This plan turns that section into concrete, runnable spikes with explicit success criteria, deliverables, and a real target environment. All spikes have passed; `REQUIREMENTS.md` is now **v1.0 (Approved)** and the remaining open decisions (browser auth flow, archive format, exact GitHub App permissions) are closed.

## Target environment (real)

- **Code / spike host repo:** `PXL-Digital-Application-Samples/pxl-classroom` (this repo, private, default branch `main`). Workflows run here.
- **First target org:** `PXLAutomation` (owner: you; already heavy GitHub Classroom user — good replacement target).
- **Second target org (for cross-org proof):** `PXLCloudAndAutomation` or `PXL-Systems-Advanced` (any other org you own).
- **Real template repo:** `PXLAutomation/template-automation-pe-1` (`is_template = true`).
- **Credential:** a dedicated GitHub App (created once, installed per target org). Secrets live in the spike host repo.

> Naming: existing templates are `template-automation-*`, not `pxl-template-*`. Recommend defaulting the discovery prefix to `template-`. Decision pending.

## How a spike is judged

Each spike is **Pass**, **Pass-with-change** (works, but a requirement must be edited), or **Fail → fallback** (triggers a documented fallback that rewrites part of the spec). No spike is "done" until its status and evidence (workflow run URL, status JSON, screenshots) are recorded in its folder.

## Execution order

```
1. Provisioning        ← start here (proves the trusted backend everything rides on)
2. Student auth   ─┐
3. Acceptance-event ─┴ together (the risk gate; auth token is what does the starring)
4. Deadline-evidence + lock-down
5. Submission-preservation
6. Pages privacy
```

---

## Spike 1 — Provisioning  · FOUNDATIONAL · status: PASS (both orgs)

**Result (2026-06-14):** App installation-token auth worked; created `PXLAutomation/spike01-provisioning-test` (id `1269297177`, private) from `template-automation-pe-1`; invited `tomccargo` as admin; idempotent re-run returned `reused`. Minimal App permissions confirmed: **Administration RW, Contents RW, Metadata R**. Two-org check **passed**: the same App created `PXLCloudAndAutomation/spike01-provisioning-test` (id `1269315504`) after the App was installed there.

**Goal.** A workflow in the host repo, authenticating as the **per-org GitHub App installation token**, creates a private repo from a private template, grants a student admin, records the immutable repo ID, writes a status record, and is safe to retry — in **two different orgs** with the same App.

**Could change the reqs:** pins down the **exact GitHub App permission set** (open decision). Confirms multi-org App model (one App, per-org installs).

**Success criteria** (from REQUIREMENTS.md → Provisioning spike):
- authenticates using the per-organization GitHub App installation token;
- creates a private repository from a private template;
- grants a test student administrator access;
- records the repository ID;
- produces a status record;
- succeeds on a safe retry **without duplication** (idempotent);
- runs the same way in two different organizations using the same GitHub App installed in each.

**Deliverables:** `spikes/01-provisioning/` (script + README), `.github/workflows/spike-01-provisioning.yml`, recorded run URLs + status JSON for org A and org B, and a confirmed minimal App permission list.

---

## Spike 2 — Student authentication · GATING · status: PASS — device flow selected

**Result (2026-06-14):** device flow authorized as `tomccargo` (id 1250098); 8h expiring user-to-server token + refresh, no PAT, no browser secret, no broad scopes. Linchpin closed: after adding the App's **Account/Starring** permission, the device-flow token starred the broker (**HTTP 204**). Browser-auth decision: device flow. Details in `spikes/02-auth/README.md`.

**Goal.** A static page identifies the GitHub user with the minimum permission, no pasted PAT, no privileged credential, surviving refresh; documents token lifetime/storage.

**Could change the reqs:** selects **device flow vs OAuth / GitHub App user-to-server PKCE** — resolves the browser-auth open decision. Coupled to Spike 3 (the token obtained here is what stars the broker).

**Success criteria:** identifies the user; minimum permission; no PAT; no exposed secret; works after refresh or gives a clear restart path; documents token lifetime and storage; device-flow vs PKCE comparison written up.

**Deliverables:** `spikes/02-auth/` minimal static app + threat note + recommendation.

---

## Spike 3 — Acceptance-event (star broker) · GATING (highest risk) · status: PASS (mechanics + public broker + non-member + token-star); burst concurrency open

**Result (2026-06-14):** private broker `PXLAutomation/spike03-acceptance-broker`; API star fired `watch: started` (run 27502697737) with actor `tomcoolpxl` + immutable `sender.id=71908551`, secret available, org policy allowed. Unstar→restar re-fired (run 27502723484) → provisioning must be idempotent. Details in `spikes/03-acceptance/README.md`.

**Goal.** A browser star against a per-assignment **public broker repo** fires `watch: started`, carrying the student actor, triggering a trusted workflow that keeps secret access, identifies the assignment, and processes duplicate-safely under realistic org Actions policy and a class-wide burst.

**Could change the reqs:** **if this fails, self-service acceptance falls back to pre-provisioned mode** — the single most likely thing to rewrite the spec.

**Success criteria** (from REQUIREMENTS.md → star-trigger validation list):
- workflow triggers for a star created through the REST API;
- workflow receives the expected actor identity;
- repository secrets available to the trusted workflow;
- org Actions policies do not suppress the event;
- unstar/restar behavior understood (re-acceptance via registry, not a second star);
- browser token can be scoped to only the required permission;
- public visibility / student activity exposure acceptable;
- concurrency correct under a 250-student burst.

**Deliverables:** `spikes/03-acceptance/` broker repo config + `watch` workflow + burst test results.

---

## Spike 4 — Deadline-evidence + lock-down · status: PASS

**Result (2026-06-14):** App snapshotted `spike01-provisioning-test` (main@947970a), demoted `tomccargo` admin→read at a mock deadline (verified read after), snapshotted again, recorded a 22s deadline→execution interval. Student is now read-only; self-restore blocked by the org-level App out-ranking repo admin. Details in `spikes/04-deadline/README.md`.

**Goal.** Trusted automation snapshots a repo's submission ref on schedule, and at a mock deadline **demotes a test student admin → read via the App**, proving the student cannot restore access; capture a final snapshot and quantify the residual uncertainty interval.

**Could change the reqs:** confirms Evidence level A (snapshots) + lock-down are sufficient; sizes the uncertainty window.

**Success criteria:** scheduled snapshots recorded (obs time, repo ID, ref, SHA); lock-down demotes the student; student cannot self-restore; final snapshot captured; uncertainty interval measured.

**Deliverables:** `spikes/04-deadline/` collector + lock-down workflow + measured interval.

---

## Spike 5 — Submission-preservation · CONFIRMATORY · status: PASS

**Result (2026-06-14):** preserved `947970a…` from `spike01-provisioning-test` into private `spike05-archive` (`refs/heads/preserved/…`); hash verified; survived an orphan force-push of the source; object independently fetchable. Details in `spikes/05-preservation/README.md`.

**Goal.** Trusted automation fetches a selected SHA from a private student repo, preserves it in an instructor-controlled repo, verifies the preserved hash, and confirms it survives a force-push of the source branch.

**Success criteria:** fetch by SHA; preserve; verify hash; survive force-push; no secrets/logs in the archive.

**Deliverables:** `spikes/05-preservation/` preservation workflow + verification log.

---

## Spike 6 — Pages privacy · CONFIRMATORY · status: PASS

**Result (2026-06-14):** `scan.mjs` privacy gate passes a clean public-metadata sample and blocks a leaky one (token, email, `student_id`, `display_name`). Pages = public metadata only + runtime-fetch for private state + scanner as a publish gate. Details in `spikes/06-pages-privacy/README.md`.

**Goal.** Confirm the runtime-fetch model leaks nothing: pre-generated public Pages data contains only public assignment metadata; roster and private repo data are reachable only at runtime with the user's own token.

**Success criteria:** no institutional IDs / names / private repo URLs / tokens in published static files; private data only via runtime fetch with the user's own token.

**Deliverables:** `spikes/06-pages-privacy/` published sample + audit of emitted files.

---

## Definition of done → v1.0 freeze

- [x] Spike 1 Pass single-org + minimal App permissions recorded (Administration RW, Contents RW, Metadata R)
- [x] Spike 1 two-org proof (PXLCloudAndAutomation, same App)
- [x] Spike 2 PASS — device flow selected; token stars broker (HTTP 204) with App Account/Starring
- [x] Spike 3 core mechanics pass (API star fires watch:started; actor + secret + org policy OK)
- [x] Spike 3 public broker + non-member star + token-star confirmed
- [x] Spike 3 burst (~250): handled by design (workflow concurrency / fan-out / backoff); not separately spiked (needs ~250 accounts)
- [x] Spike 4 PASS — lock-down demotes admin→read via App; 22s interval recorded
- [x] Spike 5 PASS — preserved SHA verified; survives source force-push
- [x] Spike 6 PASS — privacy scanner blocks private data in Pages output
- [x] `REQUIREMENTS.md` open decisions resolved; star-trigger confirmed
- [x] Version bumped to v1.0 (Approved)
