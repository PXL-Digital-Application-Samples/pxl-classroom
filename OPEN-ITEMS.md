# Open items

Known gaps that are **not** defects and have no home in a procedure: infrastructure that works today and would fail in a way nobody would be told about, controls deliberately weaker than they could be, paths that have never been exercised, and questions about how the app is arranged that it has not answered.

Counting them here was itself a thing that drifted — this sentence said "one designed control" while listing two — so it describes the kinds and leaves the count to the headings.

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

**Status: open — BUILT, never run on a cohort.** Verified 2026-08-31, built 2026-09-08.

**What changed.** `org_scoped_lock: true` on an assignment now covers the whole cohort with one organization ruleset targeted by `repository_id` (ARCHITECTURE §11.2.1), with the matching inverse in `lib/repo-unlock.mjs`, cleanup on delete, and `scripts/migrate-org-lock.mjs` to move an existing cohort. The API limits it rests on were measured against a live Team organization rather than assumed — the `repository_ids` cap, `PUT` replacing rather than merging, and the create-refuses/update-accepts asymmetry for a deleted repository.

**What is still open is the part code cannot settle.** No cohort has ever been locked this way. The ruleset path *itself* has run in production exactly once — `PXL-2TIN-CloudEssentials-2627/test-groepsopdracht-2`, two repositories — and every real exam so far used `late_policy: report` with a demotion, which is a different mechanism with a different inverse. Until an assignment runs `late_policy: block` + `org_scoped_lock: true` through a real deadline and a real reopen, this is unexercised code, and OPEN-ITEMS §5 is the standing reminder of what unexercised code is worth.

The paragraphs below are what the entry said before the work, kept because they are still the argument for whether to *use* it.

At a deadline under *late work does not count*, `lib/submission-lock.mjs` creates one repository ruleset named `pxl-classroom-deadline` on **each** student's repository, blocking `update`, `non_fast_forward` and `deletion` on the submission ref, with the Provisioner App in `bypass_actors` so the system can still write.

That has two consequences:

- **The ruleset lives in the student's own repository and they are its admin**, so they can delete it. Preservation has already pushed a copy to the archive they cannot touch, and disabling deadline enforcement on your own repository is a deliberate, visible act in a way *"I committed at 22:31"* is not. That is why [ARCHITECTURE §11.2.1](ARCHITECTURE.md) argues the repository ruleset is enough. It is still a hole.
- **It is one API call per student**, against a ~80 writes/min secondary limit. That is why lock-down stops the whole cohort first and records afterwards: done per student, the last of a 200-person cohort would be frozen minutes after the first.

An **organization** ruleset closes both. Measured live: one org ruleset with `conditions.repository_name.include: ["<pattern>-*"]` locks a whole cohort and leaves other repositories alone; `PUT /orgs/{org}/rulesets/{id}` flips all of them in **one** call regardless of cohort size; and each student's repository lists it as `source_type: "Organization"` — visible to them, manageable only by an org owner, so being repository admin does not help.

**It is not blocked.** It needs `organization_administration: write`, which the App declares and every participating org has already approved:

```bash
gh api apps/pxl-classroom-provisioner --jq .permissions
```

The awkward half was the **inverse**, and it turned out smaller than feared. An organization ruleset cannot be flipped for one student, so reopening one repository ([ARCHITECTURE §11.2.4](ARCHITECTURE.md)) is removing one entry from an object covering everybody else. It targets `repository_id` rather than a name pattern, so that entry is an integer read off the lockdown row, and `PUT` replaces conditions rather than merging them (measured). Two lecturers reopening two students inside the same read-modify-write window would lose one exclusion; on cohorts of six that is vanishingly rare, the ruleset is re-read immediately before the write, and the student notices at once.

**Whether to USE it is a judgement, not a defect.** The position on record is that the repository ruleset suffices *for the way these courses run today* — every real exam demotes rather than blocking, and a demoted student cannot restore themselves, so the hole this closes is not open on them. It becomes worth using the moment an exam moves to `late_policy: block` with the demotion off, which is the configuration that keeps a student their Actions and secrets: they then keep admin by design, and a repository ruleset is one click in their own settings.

**How to tell it is closed:** a student's repository shows `pxl-classroom-deadline-<assignment-id>` with `source_type: "Organization"` after a cohort is locked, and a reopen has been done through the Admin Panel against that lock.

```bash
gh api "repos/<org>/<student-repo>/rulesets" --jq '.[] | select(.source_type=="Organization") | .name'
```

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

## 5. Lecturer-defined checks have never been used on a live assignment

**Status: open.** Verified 2026-09-04, re-measured 2026-09-08.

Autograding has two shapes (ARCHITECTURE §11.6). One reads the score a workflow that came with the template produced; the other has the lecturer describe checks in the Admin Panel, from which the system either writes a workflow into every student repository or grades locally with `pxl-classroom grade --runner docker`.

Every live assignment uses the **first**. On 2026-09-08 the registry held **17** organizations, **14** with a control repository the sweep could read, **8** of those carrying assignments at all — **20** assignment YAMLs between them, and not one has an `autograde` block. Not one has a `submission_marker` either, so every assignment that grades is on the template's own schedule. Both lecturers doing autograding — `d-ries` on `proef-pe1`, `dhoubrechts` on `python-hacking-intro` — ship a GitHub Classroom `classroom.yml` in their template, which is where these courses come from.

Three organizations 404 for the sweep, which is unreadable rather than empty, so the count is a floor.

That is not a defect, and the path is not dead code: it is the only way to keep checks **out** of the student's repository, and the only one that produces a score per check rather than one total. But it is unexercised, and unexercised code is wrong in ways tests do not catch. It shipped for months handing every generated workflow a `timeout` in **minutes** where the schema field is seconds — a 30-second test capped at 30 minutes, on the side that bills an organization's Actions minutes — and nothing noticed, because nothing ran one.

The modal now opens on the template branch for that reason, so nobody meets the unproven path by default.

**It was exercised end to end on 2026-09-08, and it was broken in four places.** A drill assignment on `pxl-classroom-testbed` — three checks, ten points, a template with a deliberate bug — provisioned, graded and read back. What it found, in the order it was hit ([LESSONS.md](LESSONS.md), *"The unexercised path was broken in four places"*):

1. **The workflow injection races template population**, because `POST /generate` returns before the repository has content and `provision.mjs` writes immediately after it. Two students provisioned two minutes apart got two *different* broken repositories — one with the starter code and no workflow, one with the workflow and no starter code — and both runs logged `[ok] inject-autograding` and exited `created`. **Still open**; a retry against the populated repository repairs it.
2. **The reporter's environment variable was renamed by the generator**, so every hyphenated check id was invisible to it: all graders green, grading job red, no score. **Fixed** — the key is derived the way `autograding-grading-reporter@v1` derives it.
3. **Two tests asserted the broken spelling**, having been written from the generator's output rather than the reporter's rule. **Fixed** — both derive it now.
4. **`autograding-python-grader@v1` cannot build its Docker image** (`apt-get install jq` exits 100), and a Docker action that fails to build takes the whole job down before `Checkout code`. So **no `type: python` check can run on Actions today**, and it is upstream, not ours.

A fifth thing is a defect in the *reading* half rather than this path: a `failure` conclusion with no score annotation is recorded as a real zero, and item 2 above is one way to produce exactly that. See the register's sibling note in LESSONS.md; both callers guard "could not finish reading the annotations" and neither guards "read them all, no score in them".

**`visibility: private` has never been able to work at all.** It generates `uses: <org>/pxl-classroom-control/.github/workflows/grade.yml@main`, and nothing in this repository ever creates that file — ARCHITECTURE §3.1 says control repos contain no workflows, which is load-bearing. The Admin Panel's modal **defaults to it** (`props.config.visibility || 'private'`) and offers it as *"No — the checks stay in the control repository and run from there"*. That is a control describing behaviour the system does not have. Undecided: build it, or withdraw the option.

**How to tell it is closed:** an assignment in some organization carries an `autograde` block, and a student repository under it has a grading run that came from `provisioning/provision.mjs` rather than from the template. For the first half:

```bash
for org in $(gh api "repos/PXL-Digital-Application-Samples/pxl-classroom/contents/participating-orgs.yml?ref=participating-orgs" \
      -H "Accept: application/vnd.github.raw" | grep -oP '(?<=- login: ).*'); do
  for f in $(gh api "repos/$org/pxl-classroom-control/contents/assignments" --jq '.[].name' 2>/dev/null); do
    gh api "repos/$org/pxl-classroom-control/contents/assignments/$f" \
      -H "Accept: application/vnd.github.raw" 2>/dev/null | grep -q '^autograde:' && echo "$org/$f"
  done
done
```

printing nothing is this item still open. It reads only organizations whose control repository you can see, so run it as an owner of each.

---

## 6. The roster is organization-wide and lives inside one assignment's editor

**Status: open.** Raised 2026-09-06. Not a defect: everything works, and the Roster tab already says which organization it belongs to. It is a question about where things sit, which no procedure can answer.

Where the app puts things today:

| Route | What it is | Scope |
|---|---|---|
| `/dashboard/:org` | the organization's assignments | organization |
| `/dashboard/:org/:assignmentId` | one assignment, in detail | assignment |
| `/dashboard/:org/admin` | the assignment **editor**, with a list of assignments down the left | assignment |
| `/dashboard/:org/admin` → **Roster** tab | every student the organization teaches | **organization** |

The last row is the mismatch. The roster is org-wide, and it is reached by opening a view whose other tab edits a single assignment. Going from the dashboard to an assignment, then to Admin, gives you a second detailed view of that same assignment - which is fine, and **New assignment** on the dashboard reaching the same place is fine too. The roster arriving there as a tab is the part that does not follow.

Two arrangements were sketched when this was raised, and neither is chosen:

- **Two tabs at the organization.** The dashboard becomes the organization view proper and carries the org-wide things side by side: **Assignments** and **Roster**. The assignment editor stays where it is, reached from an assignment or from **New assignment**.
- **Three tabs, and you cycle through those for everything.** **Assignments** as the default, the editor as a second, and **Roster** as a third.

**What is unresolved, and is the reason this is a register entry rather than a change:**

- **The second tab has no good name.** It is called *Admin* today, which describes a mode rather than a thing, and reads as administration of the organization when it edits one assignment. A single word is wanted and none has been found.
- **Whether the editor belongs in that strip at all**, given it is per assignment and the other two are per organization. Three tabs where one changes scope is arguably the same mismatch rearranged.
- **What happens to `/dashboard/:org/admin`.** It is a bookmarkable URL, it carries `?edit=<id>`, and `tests/vue-route-safety.test.mjs` requires every route to be linked to from somewhere or not ship.

**How to tell it is closed:** the roster is no longer rendered by the assignment editor, so

```bash
grep -c "RosterTab" frontend/src/views/AdminView.vue
```

returns `0` - or the arrangement was considered and kept, and this entry says so instead.

---

## 7. Nothing grades automatically, and grading is one button for a whole cohort

**Status: open — designed, not built.** Raised 2026-09-08.

The nightly finalizes an assignment - collect, lockdown, preserve, report - and **never grades**. Reading a score back into the control repository is only ever a lecturer action: *Read scores from GitHub Actions* in the detail view, or `pxl-classroom grade`. `grep -rl "grading/" --include=*.mjs --include=*.vue` names three writers and none of them is a workflow.

That is a gap under the way these courses actually run. The common shape here is: block nothing, let students push, and grade **the last commit inside the deadline carrying the hand-in message** - which the system supports (`submission_marker`, `findMarkedCommit`, deadline-bounded, reporting a late hand-in as late rather than missing). Everything is in place except that somebody has to remember to press a button afterwards.

**Grading on the student's push is the obvious idea and it is not available.** The grading workflow already runs in the student's repository on every push; what is manual is reading the score *back*. For the hub to react to that push the student's repository would have to dispatch to the hub, which means a credential in a repository the student administers - the incident `close-acceptance.mjs` and the broker App exist to have ended. There is no other event the hub can see, and polling is what §6.4 exists to refuse.

**Finalize is where it belongs.** It already runs per assignment at the deadline, already has the control repository checked out, already commits, and by then the marked hand-in is decided. One Checks read per student, no new trigger, no new credential, no idle minutes.

**Three requirements that are part of the work, not extras:**

- **A lecturer must be able to re-run it.** A grade read at finalize is not the last word: a student's run may have been re-run, a marker corrected, a check fixed.
- **It gets its own button, not a corner of Refresh.** Re-grading a cohort is a big, slow, overwriting action and Refresh is a cheap read of commit state. Sharing a control would make one of them lie about what it costs.
- **And a per-student action, on the row.** Chasing one student is the ordinary case; re-grading forty to fix one is not an answer.

**How to tell it is closed:** an assignment's `grading/<id>/summary.json` has a `generated_at` later than its finalize, with nobody having pressed anything, and the detail view offers both a cohort-level re-grade and a per-row one.

```bash
grep -n "grading/" .github/workflows/daily-activity.yml
```

printing nothing is this item still open.

---

## 8. e2e specs stage report fixtures the report schema would refuse

**Status: open — bounded and guarded.** Measured 2026-09-07, narrowed the same day.

**What changed.** Every spec that both stages a report and asserts on a write to `reports/` is now clean, and `setupStandardMockRoutes` refuses a report fixture the schema would reject — at the moment it is staged, in the spec that staged it, naming the field. The remainder are listed by name in `REPORT_FIXTURE_EXEMPT`, so a **new** spec cannot join them without editing that list, and a spec that later gains a save is no longer excused by being on it. `tests/e2e/72-report-fixture-guard.spec.mjs` proves the guard fires and that a correct fixture still passes; `tests/fixture-options.test.mjs` fails if the list names a spec that no longer exists.

Three of the exempted specs were found by the runtime guard and by nothing else — their fixtures are assembled by helpers, invisible to a source scan. That is the argument for checking where a fixture is staged rather than where it is typed, and it is why the count below is a floor rather than a total.

What is still open is the remainder itself: 21 specs whose report fixtures describe documents the backend would refuse, kept because they only render.

Report fixtures staged by e2e specs are hand-written objects, and many of them are not the shape the app writes. Root fields the schema does not declare (`org:` is the common one), row fields that do not exist, required fields absent. `report.schema.json` is `additionalProperties: false`, so the real writer would be refused.

**They stay green because they never reach a save.** A spec that only renders a report never validates it; the divergence surfaces only when a test drives a write. That is exactly how `tests/e2e/69-live-refresh-saves.spec.mjs` was written — the first draft staged an `org:` field, and the save it exists to guard failed against the schema rather than against the bug.

A careful scan finds ~113 real violations: 19 x `org` and 14 x `assignment_title` at the root, 4 missing `assignment_id` (required), and row fields the schema does not declare - `name` where a team has `team_name`, plus the autograding fields that belong on a grading summary. An earlier looser count said 185.

This is not a defect in the deployed system, and it is not urgent: the fixtures that matter — the ones behind a write — are already correct, and `tests/fixtures/e2e-fixtures.mjs` validates every control-repo write against the schema for its path. It is here because *"a mock that accepts anything tests nothing"* is a rule this repository already paid for, and a fixture that could not survive contact with the writer is a standing bet that it never will meet one.

**The decision taken 2026-09-07** was to fix the specs that could reach a save and guard the rest, rather than rewrite all of them. Touching 21 specs to correct fixtures risks changing what they assert, which is a worse trade than a divergence that cannot reach a writer — and the guard makes the set countable instead of a number somebody re-measures each time. What remains open is whether to spend the pass that empties the list.

**How to tell it is closed:** `REPORT_FIXTURE_EXEMPT` in `tests/fixtures/e2e-fixtures.mjs` is empty. It holds **21** specs today, and the guard in front of it means the number can only go down.

```bash
sed -n '/^const REPORT_FIXTURE_EXEMPT/,/^]);/p' tests/fixtures/e2e-fixtures.mjs | grep -c "\.spec\.mjs'"
```

---

## Closed

Kept briefly so they are not reopened from memory. Each was verified against the live system, not against a changelog — 2026-08-31 unless the row says otherwise.

| Item | Closed by | Evidence |
|---|---|---|
| **The two deadline controls read as one question and a footnote** (2026-09-08) — *filed as "they are one ladder", and that premise was wrong* | Asking them as two questions of the same shape, not merging them | `late_policy` decides what **counts** (lockdown.mjs passes `deadlineFor` to phase 2 only under `block`); `lock_down_enabled` decides **access**. All four combinations are distinct and *still counts* + read-only is what both 2026 exams ran on, so the three-way ladder this entry proposed would have made a live state unrepresentable. What was wrong was the wording: a grading verdict followed by a checkbox beginning "Also". DESIGN.md §1.9, `tests/e2e/29`. |
| **An organization that deletes its last assignment kept the card** (2026-09-08) | `pruneMissingAssignments` reads the listing rather than a set of ids, and takes the scaffold's `.gitkeep` as proof that an empty `assignments/` was really read | The signal the entry called "one candidate" was already there: `scripts/scaffold-control-repo.mjs` writes `SCAFFOLD_KEEPFILE` into every scaffold directory, and all 14 readable control repos carry it. `tests/dashboard-prune.test.mjs` covers both directions — present-and-empty prunes, empty-with-no-marker does not. |
| **Brokers held the provisioning App's private key** | The broker App, plus republishing every live assignment | `gh secret list --repo <org>/broker-<id>` shows `PXL_BROKER_CLIENT_ID` and `PXL_BROKER_PRIVATE_KEY` only. Checked on `PXLAutomation/broker-finalize-drill`; a broker in an org you do not administer returns 403, so confirm the rest as an owner of that org. |
| **`PXL_APP_PRIVATE_KEY` needed rotating after that sweep** | Rotated | The `provisioning` environment secret's `updated_at` is `2026-08-31T13:43:28Z`, after the broker App was created (12:59) and the brokers were migrated (13:13). |
| **Ad-hoc branch creation on the hub was unrestricted** | Ruleset `Block ad-hoc branch creation` | `gh api repos/PXL-Digital-Application-Samples/pxl-classroom/rulesets` returns it `active`, target `branch`, rule `creation`, `~ALL` excluding `refs/heads/participating-orgs`, bypass for OrganizationAdmin and the repository role — exactly as specified. |

---

