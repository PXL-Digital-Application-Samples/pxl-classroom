# Spike 3 — Acceptance-event (star broker)

**Goal:** confirm a browser/API star against a per-assignment broker repo fires `watch: started`, carries the student actor, keeps secret access, and runs under org Actions policy. (See `REQUIREMENTS.md` → *Acceptance trigger* and *Acceptance-event spike*.)

Status: **PASS (core mechanics)** — gating questions answered. Public-exposure, burst, and token-scope criteria still open.

## What was set up

- Broker repo: `PXLAutomation/spike03-acceptance-broker` (**private** for this test).
- Secret: `BROKER_TEST_SECRET` (to check secret availability).
- Workflow on the default branch: `.github/workflows/acceptance.yml`, `on: watch: types: [started]`.

## Test 1 — does an API star trigger it? (2026-06-14)

Starred via REST: `gh api -X PUT /user/starred/PXLAutomation/spike03-acceptance-broker`.

Run `27502697737` (event = `watch`) fired and logged:

```
event_action=started
github.actor=tomcoolpxl
sender.login=tomcoolpxl
sender.id=71908551          # immutable user id — good for roster matching
repository=PXLAutomation/spike03-acceptance-broker
secret_available=yes (length=12)
```

✅ API star fires `watch: started`
✅ actor identity present (login **and** immutable `sender.id`)
✅ repository secrets available to the trusted workflow
✅ org Actions policy did not suppress the event

## Test 2 — unstar then restar (2026-06-14)

`DELETE` then `PUT` of the star produced a **second** run (`27502723484`).

⚠️ Finding: unstar→restar **does** re-fire `watch: started`. (A plain repeated star while already starred is a no-op — no event.) Consequence: provisioning must be **idempotent** against repeated `watch: started` events, keyed on control-repo registry state. This refines `REQUIREMENTS.md`, which previously assumed restar would not re-fire.

## Still open (not yet tested)

- [x] Public broker (`PXLAutomation/spike03-acceptance-broker-public`): star fires `watch: started` with secret access on a public repo. **Non-member confirmed** — `tomccargo` (not an org member) starred it; the workflow fired with `actor=tomccargo`, `secret_available=yes` (run `27502970140`).
- [x] Token can star: **confirmed HTTP 204** after granting the App the **Account → Starring** permission (first attempt 403 without it). The device-flow user token can perform the acceptance action.
- [ ] Browser token scoped to only the star permission (couples with Spike 2 auth).
- [ ] Concurrency under a class-wide burst (~250 stars).

## Cleanup

`PXLAutomation/spike03-acceptance-broker` is a throwaway test repo (currently starred by `tomcoolpxl`). Safe to delete when done — the local token lacks `delete_repo`, so delete it from the GitHub UI.
