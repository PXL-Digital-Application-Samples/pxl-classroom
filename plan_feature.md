# Plan: pre-provisioned repositories for a live exam

**Status: exploring. Nothing built.** Written 2026-09-07.

**This file is temporary.** [CLAUDE.md](CLAUDE.md) says not to add top-level planning documents — the project stopped using them, and `OPEN-ITEMS.md` is the one exception. This one exists because it was asked for, and it should be **deleted** when the feature is built or the idea is dropped. If it is still here in a month, that is the answer.

---

## The problem, as posed

Tomorrow's PE is a live exam. Thirty to forty students in a room, all clicking **Accept** within the same minute, deadline two hours later. The fear is that provisioning forty repositories at once is slow or fragile, and that the first fifteen minutes of the exam are spent watching spinners.

The proposed fix: create a pool of repositories the night before, and hand each student a free slot when they accept — a rename plus a permission grant instead of a fresh copy of the template.

---

## What the measurement says

A real acceptance on the testbed today, end to end, with the timings from the run:

```
job total                                        25s
  set up job                          2s
  checkout hub                        1s
  npm ci --omit=dev                   2s
  mint App installation token         0s
  checkout control repo               2s
  validate dispatch / look up id      1s
  run acceptance                      2s
  run provisioning                    6s   <-- everything the pool would replace
  write repository record, push       2s
  trigger dashboard regeneration      1s
  post-job cleanup                    ~5s
```

**Provisioning is 6 of 25 seconds, and `POST /generate` is 2–3 of those.** The rest of the job is scaffolding: two checkouts, an `npm ci`, token minting, a control-repo commit.

So a repository pool removes **roughly a tenth** of the pipeline. It is attacking the wrong part.

Two more facts that matter:

- **Students do not queue behind each other.** `acceptance-handler.yml`'s concurrency group is keyed per `(org, assignment, team-or-login)`, so forty students are forty parallel jobs, not a queue.
- **The hub organization is on GitHub Team**, so the ceiling is 60 concurrent jobs. Forty fits under it with room. The hub repository is public, so this costs no Actions minutes on any plan.

Forty students accepting at once should therefore finish in **well under two minutes**, most of them in about thirty seconds, and none of that time is `generate`.

---

## Where the real risk is

Not repository creation. Three other places:

1. **Forty concurrent pushes to one control repository.** Every acceptance writes `acceptances/<id>/<login>.json` and `repositories/<id>/<login>.json` and pushes. `scripts/git-push-with-retry.sh` rebases and retries **five** times with a 2–6 second jittered sleep. Five attempts is comfortable for a handful of writers and is the number to check before trusting it for forty. This is the most likely thing to fail in the scenario as described, and **a repository pool does not help it at all** — the record is still written per student.

2. **The runner ceiling.** Sixty concurrent jobs org-wide, shared with everything else the hub runs. A cohort of forty is fine; two cohorts examining simultaneously is not obviously fine.

3. **Secondary rate limits** on content-creating requests (~80/min). Forty generates plus forty grants plus forty pushes sits near that line. Pre-provisioning genuinely does help here, by moving the generates to the night before — but only if the limit is what actually bites, and nothing has measured that.

---

## What pre-provisioning would cost, honestly

If it were built anyway, this is the shape and the sharp edges — several of which are worse than the problem.

**The exam sits in the organization before the exam.** A pool repository generated from the exam template contains the exam. It exists for hours before the students do. Whether anyone can read it depends entirely on `default_repository_permission`, which is exactly the setting `baseRepositoryPermissionFinding` in `lib/audit.mjs` exists to watch because it drifts. Today the repository is created *at* acceptance, so the window is zero. This trade — a leak window in exchange for three seconds — is the strongest argument against the whole idea.

**Rename is not free of consequences.** GitHub redirects the old name to the new, so every pool name keeps resolving to a student's exam repository afterwards. And `lib/assignment-collision.mjs` decides collisions by asking what repositories exist: sixty pool repositories named for a pattern would either look like collisions or need excluding, which is a rule with an exception in it.

**It fits individual assignments only, or needs a second design.** A group assignment provisions per team, and teams are formed *during* acceptance. A pool cannot know how many teams there will be.

**Cleanup is a new lifecycle.** Unused pool repositories must be deleted, by something, on some trigger — and this system has one nightly cron it is proud of and a rule against adding polling. Deleting them is also a destructive operation aimed at a name pattern, which is the kind of thing that wants to be very sure.

**The starter code freezes early.** Pre-generating means a template fix made that morning does not reach students. For an exam that is arguably correct — but it must be a stated property, not a surprise, and it interacts with the `repository_id` pin added today.

Rough size: a new pool concept in the assignment schema, a workflow to fill it, a claim path in `accept.mjs` that takes a slot instead of provisioning, cleanup, collision-checker changes, and group assignments left out. **Days, not hours**, in the part of the system where a mistake ruins an exam rather than a page render.

---

## What I would do instead

**Measure the actual thing first.** Everything above is arithmetic on one 25-second run. The honest experiment is a burst: dispatch thirty or forty acceptances at the testbed within a few seconds and record wall-clock to the last completion, how many pushes retried, and whether any secondary rate limit appeared. That is an afternoon, it costs nothing, and it either dissolves the problem or points at the real bottleneck — which the reasoning above says is the control-repo push, not `generate`.

If the burst shows a problem, the cheap fixes are aimed at what it shows, not at repository creation:

- Raise `MAX_RETRIES` in the push helper, or widen the jitter.
- Batch the two per-student records into one commit (`commitFiles` already exists and is used elsewhere).
- Stagger the room: two rows at a time, thirty seconds apart. Free, and no code.

**And the fifteen-minute shave is probably unnecessary.** If forty acceptances complete in under two minutes, the answer to the original worry is "have them accept while you read out the instructions". The scary part may simply not be scary; nobody has looked.

---

## Decision: dropped, 2026-09-07

Pre-provisioning is not being built. The measurement says it removes a tenth of the pipeline, and it would buy that by leaving the exam sitting in the organization for hours beforehand. The lecturer will allow ten minutes at the start of the exam and run a rehearsal with fake students, which measures the real thing better than any of this arithmetic.

The burst test was **not run**: staging forty acceptances needs forty real GitHub accounts, because `accept.mjs` resolves each login to a numeric id and provisioning then sends that account a repository invitation. Three test accounts exist. A rehearsal by the lecturer covers it honestly; a synthetic one would not have.

## What the exploration actually found

Asking "will a two-hour deadline work if the assignment is published a week early, or that morning?" turned up a real gap, and it is nothing to do with provisioning.

**The sentinel was enabled at publish but never armed.** `deadline-sentinel.yml` arms from a 4-hourly cron (00/04/08/12/16/20 UTC) for any deadline within 4.5h, then sleeps to the instant and locks. A cron cannot see an assignment that did not exist when it last fired:

```
exam 10:00-12:00 local, published the night before  -> 10:00 firing sees it   ARMED
exam 10:00-12:00 local, published at 09:45          -> 10:00 firing sees it   ARMED
exam 10:00-12:00 local, published at 10:15          -> next firing is 14:00   MISSED
```

A missed sentinel falls through to the nightly at 00:00 UTC — up to fourteen hours late. Marks are unaffected (late is decided by the commit's own timestamp, and preservation reconstructs with `?until=`), but the repositories stay writable for the rest of the day, which is the wrong way round for an exam.

The same gap opens without any publish at all: an assignment whose deadline was next week, **edited** to this afternoon, was armed by nothing.

Both now arm the sentinel themselves — `publish-assignment.yml` dispatches it, and `saveAssignment` does when the saved document leaves an imminent deadline. `deadlineIsImminent` in `lib/sentinel-window.mjs` is the shared judge, so the 4.5h window is not spelled twice. Duplicates were already safe: the sentinel's concurrency group is `(org, deadline instant)`, so one armed by the cron and one armed by a publish cannot both lock.

**Publish to a working link is ~3 minutes**, measured: publish 33s, dashboard regeneration 45s, frontend deploy 62s, plus CDN. Prepare in the morning if you must; do not share the link in the same breath.

## Still to do

Delete this file. It has served its purpose: the feature it proposed is not being built, the real defect it uncovered is fixed, and the timing facts belong in [RUNBOOK.md](RUNBOOK.md) beside the deadline material rather than in a plan document.
