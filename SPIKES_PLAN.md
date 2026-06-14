# PXL Classroom — Technical Spikes Plan

Status: Active
Companion to: `REQUIREMENTS.md` (Draft v0.2)
Last updated: 2026-06-14

## Why this exists

`REQUIREMENTS.md` is a **draft**. Its section *"Technical spikes required before implementation freeze"* lists prototypes that must succeed before the architecture is final. Until they run, several load-bearing assumptions are believed but unproven, and two of them can still **change the requirements**.

This plan turns that section into concrete, runnable spikes with explicit success criteria, deliverables, and a real target environment. When all spikes pass (or their fallbacks are accepted), `REQUIREMENTS.md` graduates **Draft v0.2 → frozen v1.0** and the three remaining open decisions (browser auth flow, archive format, exact GitHub App permissions) close.

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

## Spike 2 — Student authentication · GATING (open decision) · status: PASS for identity (device flow); token star-capability pending

**Result (2026-06-14):** device flow authorized as `tomccargo` (id 1250098); 8h expiring user-to-server token + refresh, no PAT, no browser secret, no broad scopes. Device flow recommended; linchpin left = confirm this token can star the broker. Details in `spikes/02-auth/README.md`.

**Goal.** A static page identifies the GitHub user with the minimum permission, no pasted PAT, no privileged credential, surviving refresh; documents token lifetime/storage.

**Could change the reqs:** selects **device flow vs OAuth / GitHub App user-to-server PKCE** — resolves the browser-auth open decision. Coupled to Spike 3 (the token obtained here is what stars the broker).

**Success criteria:** identifies the user; minimum permission; no PAT; no exposed secret; works after refresh or gives a clear restart path; documents token lifetime and storage; device-flow vs PKCE comparison written up.

**Deliverables:** `spikes/02-auth/` minimal static app + threat note + recommendation.

---

## Spike 3 — Acceptance-event (star broker) · GATING (highest risk) · status: PASS core mechanics; public-exposure / burst / token-scope open

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

## Spike 4 — Deadline-evidence + lock-down · status: TODO

**Goal.** Trusted automation snapshots a repo's submission ref on schedule, and at a mock deadline **demotes a test student admin → read via the App**, proving the student cannot restore access; capture a final snapshot and quantify the residual uncertainty interval.

**Could change the reqs:** confirms Evidence level A (snapshots) + lock-down are sufficient; sizes the uncertainty window.

**Success criteria:** scheduled snapshots recorded (obs time, repo ID, ref, SHA); lock-down demotes the student; student cannot self-restore; final snapshot captured; uncertainty interval measured.

**Deliverables:** `spikes/04-deadline/` collector + lock-down workflow + measured interval.

---

## Spike 5 — Submission-preservation · CONFIRMATORY · status: TODO

**Goal.** Trusted automation fetches a selected SHA from a private student repo, preserves it in an instructor-controlled repo, verifies the preserved hash, and confirms it survives a force-push of the source branch.

**Success criteria:** fetch by SHA; preserve; verify hash; survive force-push; no secrets/logs in the archive.

**Deliverables:** `spikes/05-preservation/` preservation workflow + verification log.

---

## Spike 6 — Pages privacy · CONFIRMATORY · status: TODO

**Goal.** Confirm the runtime-fetch model leaks nothing: pre-generated public Pages data contains only public assignment metadata; roster and private repo data are reachable only at runtime with the user's own token.

**Success criteria:** no institutional IDs / names / private repo URLs / tokens in published static files; private data only via runtime fetch with the user's own token.

**Deliverables:** `spikes/06-pages-privacy/` published sample + audit of emitted files.

---

## Definition of done → v1.0 freeze

- [x] Spike 1 Pass single-org + minimal App permissions recorded (Administration RW, Contents RW, Metadata R)
- [x] Spike 1 two-org proof (PXLCloudAndAutomation, same App)
- [x] Spike 2 device flow works (identity, minimal token); selected pending token star-capability check
- [x] Spike 3 core mechanics pass (API star fires watch:started; actor + secret + org policy OK)
- [ ] Spike 3 remaining: public broker (no-membership star), burst concurrency (~250), browser token scope
- [ ] Spike 4 Pass + uncertainty interval recorded
- [ ] Spike 5 Pass
- [ ] Spike 6 Pass
- [ ] `REQUIREMENTS.md` open decisions resolved; star-trigger confirmed or replaced
- [ ] Version bumped Draft v0.2 → v1.0
