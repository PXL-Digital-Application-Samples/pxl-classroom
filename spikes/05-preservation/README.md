# Spike 5 — Submission preservation

**Goal:** trusted automation fetches a selected SHA from a private student repo, preserves it in an instructor-controlled archive repo, verifies the preserved hash, and confirms it survives a force-push of the source. (See `REQUIREMENTS.md` → *Submission preservation*.)

Status: **PASS**.

## Result (2026-06-14)

Source `PXLAutomation/spike01-provisioning-test` (id `1269297177`, `refs/heads/main`) → archive `PXLAutomation/spike05-archive` (private):

```
preserve_sha = 947970a282c3554621ce6a0c9c22f3d63037f819
→ archive refs/heads/preserved/spike01-tomccargo
verify_match = yes                       # archive ref SHA == source SHA

# rewrite source: orphan commit, force-push main
source head now = 5314c0c…  (original 947970a orphaned in source)

archive after rewrite = 947970a…         # unchanged
survives_force_push = yes
object_fetchable = yes (type=commit)     # clone archive, cat-file the SHA
```

- ✅ records source repo id, source ref, selected SHA
- ✅ object fetched and preserved into an instructor-controlled repo students cannot administer
- ✅ preserved hash verified equal to the source SHA
- ✅ reachable history pushed (full commit object)
- ✅ survives a force-push / history rewrite of the source — the archived commit is independent
- ✅ preserved object independently fetchable from the archive

## Notes / production

- `preserve.sh` is the prototype. In production this runs in a **trusted workflow as the GitHub App installation token** (here it used `gh auth setup-git`). Same git mechanics.
- Archive should not contain secrets, Actions logs, environment secrets, or runner credentials (it preserves Git history only).
- Alternative representations (git bundle, tag instead of branch) also work; a branch in a private archive repo is the simplest verifiable form.

## Cleanup

`PXLAutomation/spike05-archive` is a throwaway. Note: this spike **rewrote `spike01-provisioning-test`'s `main`** (orphan force-push) — expected, it's a test repo.
