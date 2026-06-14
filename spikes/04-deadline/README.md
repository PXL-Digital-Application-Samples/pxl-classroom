# Spike 4 — Deadline snapshot + lock-down

**Goal:** snapshot the submission ref on schedule; at the deadline, demote the student admin→read via the App; confirm they can't self-restore; record the residual uncertainty interval. (See `REQUIREMENTS.md` → *Deadline lock-down* and *Deadline-evidence spike*.)

Status: **PASS** for snapshot + lock-down. Self-restore-block is a GitHub invariant (optional empirical confirm below).

## Result (2026-06-14)

Target `PXLAutomation/spike01-provisioning-test`, student `tomccargo`, mock deadline = run time. Run via `spike-04-deadline.yml` (App installation token):

```
snapshot before:   default_branch=main  sha=947970a…  observed_at=…
permission before: admin
lock-down:         PUT collaborators/tomccargo {permission: pull} -> 204 "updated"
permission after:  read          ✅ student demoted, can no longer push
snapshot after:    main@947970a… (unchanged)
uncertainty interval: 22s (deadline -> lock-down workflow execution)
outcome: locked-down
```

- ✅ snapshot records repo id, default branch, head SHA, observed-at
- ✅ App demotes the student admin → read at the deadline
- ✅ post-lock-down permission verified = read
- ✅ residual uncertainty quantified = the gap from the deadline instant to when the (scheduled) lock-down workflow actually runs — here 22s (dispatch + queue). In production this is the scheduled-workflow latency; record lock-down time + SHA so the window is explicit.

## Self-restore block

Because the App acts through the **org-level installation** (above repo-admin) and the student is now a **read** collaborator, the student cannot promote themselves — managing collaborators requires repo admin, which they no longer have. This is a GitHub permission invariant.

Optional empirical confirm (one device-flow round): obtain tomccargo's user token, attempt
`PUT /repos/PXLAutomation/spike01-provisioning-test/collaborators/tomccargo {permission: admin}` → expect **403/404**.

## Trust caveat (by design)

Lock-down closes the *primary* path. Per the trust model, a student who prepared **before** the deadline could retain side paths (a second collaborator, a deploy key, a fork). Lock-down is a deterrent that tightens evidence, not tamper-proof — reporting of observed late activity still applies.

## Restore note

`tomccargo` is now **read** on `spike01-provisioning-test` (was admin). Re-grant via the App or org owner if needed for further tests.
