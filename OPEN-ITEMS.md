# Open items

Known gaps in the deployed system that are **not** defects and have no home in a procedure: infrastructure that works today and would fail in a way nobody would be told about, plus one designed control that is deliberately weaker than it could be.

This is a standing register, not a plan: nothing here is scheduled, and an entry earns its place by being something a reader of [RUNBOOK.md](RUNBOOK.md), [INSTALL.md](INSTALL.md) or [ADMIN.md](ADMIN.md) would otherwise have to rediscover. Every entry says how to tell whether it is still open, so it can be closed from evidence rather than from memory.

---

## 1. The SPA shares a Pages origin with another site

**Status: open.** Verified 2026-08-31.

The SPA holds a lecturer's GitHub access token in `sessionStorage`. Browser storage is scoped to an **origin**, and `pxl-digital-application-samples.github.io` is one origin shared by every Pages site the organization publishes. An XSS in any of them runs same-origin with the SPA and can read that token, which reads the private control repo: roster names, student numbers, institutional email addresses.

The organization currently publishes two Pages sites:

```
pxl-classroom            public
security-flag-validator  private repo, Pages published
```

Given its name, the second is exactly the class of application where an injection is plausible.

**Two ways out, in increasing order of effort:**

- **Policy** — nothing else publishes Pages from this organization. Free and immediate, and holds only as long as somebody remembers it, which is why it is written down here rather than agreed in a meeting.
- **A custom domain**, which removes the problem instead of managing it. Settings → Pages → Custom domain on `pxl-classroom`, CNAME to `pxl-digital-application-samples.github.io`, enable **Enforce HTTPS**. The SPA then has an origin no sibling repository can reach. Update `ALLOWED_ORIGINS` in [`cors-worker/worker.js`](cors-worker/worker.js) and redeploy the Worker **before** switching, or sign-in breaks at the cutover — the Worker refuses an origin it does not know, which is the control working.

**How to tell it is closed:** either the SPA is on its own domain, or

```bash
gh api "orgs/PXL-Digital-Application-Samples/repos?per_page=100" \
  --jq '.[] | select(.has_pages==true) | .name'
```

returns `pxl-classroom` alone.

---

## 2. The sign-in Worker is on a personal Cloudflare account

**Status: open.** Verified 2026-08-31.

`pxl-cors.tom-cool-38e.workers.dev` is the **primary** device-flow proxy (`device_flow_proxy` in [`deployment.yml`](deployment.yml)), so it sits on the critical path of every sign-in. It lives in a single-owner Cloudflare account.

If that account is lost, sign-in does not break — it fails over to the third-party secondary and keeps working. That is the problem: the system carries on with a third party seeing every access token, which is the state the ordering exists to prevent, and nobody would be told. System Health warns when the primary does not answer, but not when it answers from an account nobody at PXL can administer.

**Moving it:**

1. Create a Cloudflare account under a PXL address with more than one owner.
2. `cd cors-worker && npx wrangler@latest login && npx wrangler@latest deploy` from that account. Deploy from the repository rather than the dashboard editor — the Worker carries a security allowlist and a pasted copy drifts from the reviewed one.
3. Verify with the probes in [`cors-worker/README.md`](cors-worker/README.md): a browser-origin POST returns a device code, `OPTIONS` answers 204, both allowlists refuse by exact match.
4. Update `device_flow_proxy` in `deployment.yml` and deploy the frontend.
5. Keep the old Worker running for a week — cached bundles still point at it — then delete it.

**How to tell it is closed:** `device_flow_proxy` in `deployment.yml` names a Worker on a shared PXL account.

---

## 3. Lock-down is per repository, and a student can delete their own ruleset

**Status: open — unblocked, unbuilt.** Verified 2026-08-31.

At a deadline under *late work does not count*, `lib/submission-lock.mjs` creates one repository ruleset named `pxl-classroom-deadline` on **each** student's repository, blocking `update`, `non_fast_forward` and `deletion` on the submission ref, with the Provisioner App in `bypass_actors` so the system can still write.

That has two consequences:

- **The ruleset lives in the student's own repository and they are its admin**, so they can delete it. Preservation has already pushed a copy to the archive they cannot touch, and disabling deadline enforcement on your own repository is a deliberate, visible act in a way *"I committed at 22:31"* is not. That is why [ARCHITECTURE §11.2.1](ARCHITECTURE.md) argues the repository ruleset is enough. It is still a hole.
- **It is one API call per student**, against a ~80 writes/min secondary limit. That is why lock-down stops the whole cohort first and records afterwards: done per student, the last of a 200-person cohort would be frozen minutes after the first.

An **organization** ruleset closes both. Measured live: one org ruleset with `conditions.repository_name.include: ["<pattern>-*"]` locks a whole cohort and leaves other repositories alone; `PUT /orgs/{org}/rulesets/{id}` flips all of them in **one** call regardless of cohort size; and each student's repository lists it as `source_type: "Organization"` — visible to them, manageable only by an org owner, so being repository admin does not help.

**It is not blocked.** It needs `organization_administration: write`, which the App declares and every participating org has already approved:

```bash
gh api apps/pxl-classroom-provisioner --jq .permissions
```

What remains is code. `applySubmissionLock` in `lib/submission-lock.mjs` is the one function that would gain the new scope.

**Whether to build it is a judgement, not a defect.** The position on record is that the repository ruleset suffices. Build this if you want a lock a student cannot reach at all; a high-stakes exam is the case that would justify it.

**How to tell it is closed:** a student's repository shows `pxl-classroom-deadline` with `source_type: "Organization"` after a cohort is locked.

---

## 4. The least-privilege way to give a lecturer hub access has never been used

**Status: open.** Verified 2026-09-02.

[ADMIN.md](ADMIN.md) §1.4 tells an administrator to add lecturers as **Write collaborators** on the hub repo, because publishing an assignment and retrying an acceptance both `workflow_dispatch` on the hub with the lecturer's own token, and write is what that needs. It is the correct grant and the smallest one.

Nobody has ever done it. Measured today:

```
repos/…/pxl-classroom/collaborators?affiliation=outside   0
repos/…/pxl-classroom/collaborators?affiliation=direct    0
orgs/PXL-Digital-Application-Samples default_repository_permission   read
```

Everyone who publishes today is an **owner** of the central organization, which works for a reason unrelated to the documented path: GitHub grants owners admin on every repository. So the instruction in ADMIN.md is followed by no one, and the first administrator to follow it will be the first to find out whether it holds.

Two things make that worth writing down rather than assuming:

- **Organization membership alone does not work, and fails in a confusing way.** The hub org's base permission is `read`, so a plain member lands on read for `pxl-classroom` and every dispatch returns 403 — which reads as "I added the lecturer and it still fails" rather than as a permission level.
- **The owner workaround is not equivalent.** An owner of the central organization is also an owner of the **App** registered there, and can therefore generate a private key that mints installation tokens for every participating org ([ARCHITECTURE.md](ARCHITECTURE.md) §4.3). Handing that to each lecturer to avoid testing a collaborator grant is a real widening of the blast radius.

A lecturer without hub write can still create and edit assignments — those writes go to their own control repo — but **Publish** and **Retry acceptance** fail.

**Half of this is now closed.** System Health's `hub-dispatch` check reads the viewer's own `permissions.push` on the hub repo and warns before they reach the 403, naming the membership trap explicitly. What remains open is the part a check cannot settle: whether the collaborator grant actually works end to end, which only a real non-owner publishing an assignment will tell you.

A sibling of this was found and closed the same day: a **published assignment with no acceptance broker** was invisible everywhere except that one assignment's Admin panel, and two of them sat that way unnoticed. System Health's `published-brokers` check now sweeps every published assignment in the org, and an assignment it could not read blocks a green result rather than being counted as fine.

**How to tell it is closed:** a lecturer who is not an owner of the central organization has published an assignment successfully, and

```bash
gh api repos/PXL-Digital-Application-Samples/pxl-classroom/collaborators?affiliation=direct --jq 'length'
```

returns a non-zero count.

---

## Closed

Kept briefly so they are not reopened from memory. Each was verified against the live system on 2026-08-31, not against a changelog.

| Item | Closed by | Evidence |
|---|---|---|
| **Brokers held the provisioning App's private key** | The broker App, plus republishing every live assignment | `gh secret list --repo <org>/broker-<id>` shows `PXL_BROKER_CLIENT_ID` and `PXL_BROKER_PRIVATE_KEY` only. Checked on `PXLAutomation/broker-finalize-drill`; a broker in an org you do not administer returns 403, so confirm the rest as an owner of that org. |
| **`PXL_APP_PRIVATE_KEY` needed rotating after that sweep** | Rotated | The `provisioning` environment secret's `updated_at` is `2026-08-31T13:43:28Z`, after the broker App was created (12:59) and the brokers were migrated (13:13). |
| **Ad-hoc branch creation on the hub was unrestricted** | Ruleset `Block ad-hoc branch creation` | `gh api repos/PXL-Digital-Application-Samples/pxl-classroom/rulesets` returns it `active`, target `branch`, rule `creation`, `~ALL` excluding `refs/heads/participating-orgs`, bypass for OrganizationAdmin and the repository role — exactly as specified. |
