# EMAIL_PLAN

Plan for using the `members: read` + `members: write` App permissions to gate
acceptance on organization membership, so a list of student **emails** can
admit students whose GitHub logins are unknown.

## Spot tests (verified live, 2026-08-25)

Read-only, against `PXL-Systems-Expert`:

| Probe | Result |
|---|---|
| `GET /orgs/{org}/memberships/octocat` (non-member) | `404` |
| `GET /orgs/{org}/memberships/tomcoolpxl` | `{"state":"active","role":"admin"}` |
| `GET /orgs/{org}/members/octocat` | `404` |
| `GET /orgs/{org}/failed_invitations` | `200`, array |

Full write cycle against `PXL-Automation-II`, invitation sent to a
plus-addressed variant of the operator's own mailbox and cancelled immediately.
Org restored to its prior state (0 pending, 0 failed, 2 members):

| Probe | Result |
|---|---|
| `POST /orgs/{org}/invitations {email, role}` | `201`, **`"login": null`** |
| pending list | shows it; `failed_at: null`, `failed_reason: null`, `team_count: 0`, `invitation_source: "member"` |
| **re-invite the same email** | **idempotent** — returns the same `id` and `created_at`, no error, no duplicate |
| invite an address already belonging to a **member** | **`422`** — `"A user with this email address is already a part of this organization"` |
| `DELETE /orgs/{org}/invitations/{id}` | `204` |
| **delete the same invitation again** | **`204`**, not `404` — idempotent |
| does a cancelled invitation land in `failed_invitations`? | no |

Second write cycle against `PXL-Automation-II`, inviting an address that DOES
belong to an existing GitHub account (`tomccargo@gmail.com` -> `tomccargo`, a
second account belonging to the operator). Also cancelled; org restored:

| Probe | Invited, not yet accepted | Never invited |
|---|---|---|
| `GET /orgs/{org}/memberships/{login}` | **`state: "pending"`, `role: "member"`** | `404` |
| `GET /orgs/{org}/members/{login}` | **`404`** | `404` |

**This is the endpoint decision proven rather than assumed:** `/members/` cannot
distinguish "invited, waiting on them" from "not enrolled". `/memberships/` can.

Two further traps, both verified:

- The invitation object carries **`login: null` even when GitHub has resolved
  the address to an account internally** - `memberships/tomccargo` reported
  `pending` while the pending list still showed `login: null`. So the
  invitations list **cannot be joined to logins**, which is what keeps
  reconciliation (Phase D) genuinely unavailable rather than merely awkward.
- Inviting by `invitee_id` while an email invitation for the same person is
  already pending created a **second, separate invitation** (`78989151`
  alongside `78989140`). Only the **email** form is idempotent. Never mix the
  two forms, or a re-run double-invites.
- A pending direct invitation reports `direct_membership: false`. Gate on
  `state`, never on that field.

### Still unverified

- **App installation token behaviour.** Every probe above used an org owner's
  user token. An installation token with `members: read` may differ, and that
  class of difference has burned this repo before (`/orgs/{org}/installations`
  returning an object, not an array).
- Whether re-inviting an already-pending address **re-sends** the email.

### The finding that changes the design

When the invited address belongs to no GitHub account, `login` stays `null` and
no membership record exists at all - so `GET /orgs/{org}/memberships/{login}`
answers **`404`, identical to "never invited"**. A student invited at
`@stud.pxl.be` who signed up with a personal address is indistinguishable from
an outsider.

So `roster_mode: org_member` carries a hard precondition: **students must have
their PXL address verified on their GitHub account.** That is the rule already
in force ("register with GitHub using your student email"), so the design
matches practice - but the `404` copy must name both causes rather than assert
one, or it is the waiting-screen bug of CLAUDE.md over again: a page guessing
why it is stuck.

## Plan

**Gate on `GET /orgs/{org}/memberships/{username}`, not `/members/{username}`.**

`/members/` answers only 204/404 — it cannot tell "invited, hasn't clicked the email yet" from "never invited". `/memberships/` returns `{state, role}`, where `state` is `active` or `pending`. That distinction *is* the student-facing UX: "check your @stud.pxl.be inbox for the GitHub invitation" versus "you're not enrolled in this course". Getting that wrong is the waiting-screen bug in CLAUDE.md all over again — a page guessing why it's stuck.

**Gate rule — `state === "active"` passes. Nothing else does, and errors are failures, not rejections:**

| Condition | Outcome | Why |
|---|---|---|
| `state: active` | accept | |
| `state: pending` | `rejected:membership-pending` | exit 0 — student action needed, not a system fault |
| `404` | `rejected:not-org-member` | exit 0 |
| `403` / `5xx` / rate-limit | `fail:*` | exit 1 — an API error is **not** an outcome. A missing `members: read` must not silently admit or silently reject a whole cohort |

Follows the existing `reject()`/`fail()` split in `accept.mjs`, and fails closed on unrecognised `roster_mode` exactly as today.

### Phase A — the gate
- `schemas/assignment.schema.json`: `roster_mode` enum gains `org_member`
- `acceptance/accept.mjs`: new branch; no roster file required; `max_acceptances` **not** mandatory (unlike `open`, membership is itself a real limit)
- `pages/generate.mjs`: publish the mode (it already normalises `open`/`enforced` — must not collapse `org_member` to `enforced`)
- `AssignmentView` / `GroupAcceptanceCard`: student-facing copy for both rejection reasons
- `AdminView`: mode selector + honest hint text

### Phase B — invitations from the roster
Your roster CSV **already has an `email` column** — so this reuses data you have.
- `lib/org-members.mjs` — pure planner (`seed-teams`/`promote-roster` precedent): roster emails + members + pending + failed → `{toInvite, alreadyMember, pending, bounced, skipped}`
- CLI: `pxl-classroom members invite|status|cancel` (`--dry-run` sacred; `cancel`/`remove` confirm on TTY or `--force`)
- SPA: RosterTab invite action + per-student membership status
- **Rate limiting is load-bearing**: 200 invitations is 200 writes against the ~80/min secondary limit → must go through `lib/rate-limit.mjs`

### Phase C — the safety precondition (non-negotiable)
`default_repository_permission !== "none"` must **fail** a diagnostic and block publish of an `org_member` assignment. GitHub grants the *highest* applicable permission, so membership becomes a floor under lockdown's collaborator demotion ([lockdown.mjs:222](lockdown/lockdown.mjs#L222)). At `write` it would defeat the freeze entirely. Covers all 11 orgs without chasing owners.

### Phase D — reconciliation
I will **not** pretend this is solved. Login→student stays unknown; per-student teams are the only deterministic route and I'll document the cost rather than build it unasked.

## Permission rollout

Both outstanding permission changes are **Organization permissions on the same
settings page**, so they go in one save and one approval round rather than two.

`https://github.com/organizations/PXL-Digital-Application-Samples/settings/apps/pxl-classroom-provisioner/permissions`

| Setting | Now | Set to | For |
|---|---|---|---|
| **Administration** (`organization_administration`) | Read-only | **Read and write** | §3.2.9 step 5 - org-level rulesets, the last open UX_PLAN item |
| **Members** (`members`) | No access | **Read and write** | the email gate in this plan |

`write` implies `read` on a GitHub App, so "Members: Read and write" supplies
both `members: read` and `members: write` from one dropdown.

**Bumping the declaration is safe to do before any code lands.**
`missingManifestPermissions` only checks that the App declares *at least* the
manifest, so permissions in excess of `MANIFEST_APP_PERMISSIONS` trip nothing.
`MANIFEST_APP_PERMISSIONS` must be bumped only **after** the orgs approve -
doing it first turns every org's System Health amber for a feature that does
not exist yet.

Verify the declaration:

```bash
gh api apps/pxl-classroom-provisioner --jq '.permissions | {organization_administration, members}'
# expect {"members":"write","organization_administration":"write"}
```

Then **every installed org must approve**, or its installation keeps the old
permission set (RUNBOOK §10.6). Owners get an email and a banner:
`https://github.com/organizations/<ORG>/settings/installations` ->
`pxl-classroom-provisioner` -> **Review request**.

| Owner | Orgs |
|---|---|
| `tomcoolpxl` (5) | PXL-Systems-Expert, PXL-Automation-II, PXLCloudAndAutomation, PXLAutomation, PXL-RP |
| `d-ries` (2) | PXL-2TIN-CloudEssentials-2627, PXL-2TIN-DevOps-2627 |
| `arnobarzan` (2) | PXL-CSMobile, PXL-2TIN-NetAdv-26-27 |
| `dhoubrechts` (2) | PXL-SNE-Security-Adv, PXL-SNE-AutomationAndScripting2627 |

Per-org approval cannot be verified with `gh` - its token is not authorized to
the App, so `/user/installations` answers 403. Use the App's own device flow:
`pxl-classroom audit --org <ORG>`, whose Tier 1 check separates "not yet
approved" from "never declared" (`upstream: true`).

## Two things I need from you

**1. One spot test needs your go-ahead** — the `pending` state is the single most important behaviour I cannot verify read-only, and confirming it requires actually creating an invitation. Safest version: invite `tom.cool+pxlclass@pxl.be` to `PXL-RP` (your org, no students), read `memberships/` and `invitations`, then cancel it. Self-inflicted, reversible, one email to your own inbox.

**2. Tell me when the permission is live** so I can re-run the probes with an App token — an installation token may behave differently from my owner token, and that difference is exactly the kind of thing that has burned this repo before.

## Test inventory

Roughly 45 cases across three files. Gate (`tests/org-member-gate.test.mjs`): active, pending, 404, 403, 500, rate-limit-then-success, owner-role, unrecognised mode falls back to `enforced`, no roster file, no cap, login case-mismatch, removed between invite and accept, outside-collaborator-not-member, group assignment. Planner (`tests/org-members.test.mjs`): no email, already active, already pending, bounced, duplicate emails, case-different emails, empty roster, absent roster, array-shaped roster, 200-student pacing, seat-limit 422, invite-existing-member 422, cancel-after-accept 404, plus-addressed and unicode emails, dry-run writes nothing. E2E (`tests/e2e/41-org-member-gate.spec.mjs`): both rejection screens, mode selector, invite flow, status table, `default_repository_permission` diagnostic failing and passing.

Shall I start on Phase A + C now while you add the permission — and do you want me to run that invitation spot test?
