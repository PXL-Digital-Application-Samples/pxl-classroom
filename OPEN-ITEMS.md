# Open items

Known gaps in the deployed system that are **not** defects and have no home in a procedure: infrastructure that works today and would fail in a way nobody would be told about, one designed control that is deliberately weaker than it could be, and one question about how the app is arranged that it has not answered.

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

## 5. Lecturer-defined checks have never been used on a live assignment

**Status: open.** Verified 2026-09-04.

Autograding has two shapes (ARCHITECTURE §11.6). One reads the score a workflow that came with the template produced; the other has the lecturer describe checks in the Admin Panel, from which the system either writes a workflow into every student repository or grades locally with `pxl-classroom grade --runner docker`.

Every live assignment uses the **first**. Across seven participating organizations and seventeen assignments, not one carries an `autograde` block. Both lecturers doing autograding — `d-ries` on `proef-pe1`, `dhoubrechts` on `python-hacking-intro` — ship a GitHub Classroom `classroom.yml` in their template, which is where these courses come from.

That is not a defect, and the path is not dead code: it is the only way to keep checks **out** of the student's repository, and the only one that produces a score per check rather than one total. But it is unexercised, and unexercised code is wrong in ways tests do not catch. It shipped for months handing every generated workflow a `timeout` in **minutes** where the schema field is seconds — a 30-second test capped at 30 minutes, on the side that bills an organization's Actions minutes — and nothing noticed, because nothing ran one.

The modal now opens on the template branch for that reason, so nobody meets the unproven path by default.

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

## Closed

Kept briefly so they are not reopened from memory. Each was verified against the live system on 2026-08-31, not against a changelog.

| Item | Closed by | Evidence |
|---|---|---|
| **Brokers held the provisioning App's private key** | The broker App, plus republishing every live assignment | `gh secret list --repo <org>/broker-<id>` shows `PXL_BROKER_CLIENT_ID` and `PXL_BROKER_PRIVATE_KEY` only. Checked on `PXLAutomation/broker-finalize-drill`; a broker in an org you do not administer returns 403, so confirm the rest as an owner of that org. |
| **`PXL_APP_PRIVATE_KEY` needed rotating after that sweep** | Rotated | The `provisioning` environment secret's `updated_at` is `2026-08-31T13:43:28Z`, after the broker App was created (12:59) and the brokers were migrated (13:13). |
| **Ad-hoc branch creation on the hub was unrestricted** | Ruleset `Block ad-hoc branch creation` | `gh api repos/PXL-Digital-Application-Samples/pxl-classroom/rulesets` returns it `active`, target `branch`, rule `creation`, `~ALL` excluding `refs/heads/participating-orgs`, bypass for OrganizationAdmin and the repository role — exactly as specified. |

---

## Asked for, not yet designed

Three requests made on 2026-09-06, recorded **verbatim** so nothing is lost between sessions. They are not part of the register above and carry no verification command: the entries above are gaps in a system that works, these are work that has not started. Each is closed by being done, or by being declined here with the reason.

They are transcribed speech, kept as spoken rather than tidied, because the hesitations carry the reasoning - "I still don't know what to do with the slug" is the actual state of that decision.

### 1. A free organization, without Team for Education — ANSWERED 2026-09-07

**Answer: [ADMIN.md §1.1.1](ADMIN.md#111-check-the-organization-is-on-github-team). Not insurmountable — nothing fails, two things degrade at a deadline.** Rulesets and protected branches are Team-and-above on *private* repositories, and student repositories are private: the deadline freeze falls back to demotion (which also removes Actions, secrets and environments) and the Feedback PR baseline is left unprotected. Minutes are 2,000/month rather than 3,000. Everything else — every endpoint, group assignments, acceptance — works, and the upgrade is free for verified educators.

Four of the twelve readable participating organizations are on `free`, and so is `pxl-classroom-testbed`. Nothing said so before: `plan.name` was never read anywhere. It is now a System Health warning (`org-plan`), riding the `GET /orgs/{org}` response the base-permission check already fetches.

> When you're finished with this, I have a question. It's the question my colleagues will be asking me. What if I have an organization, and I forgot to upgrade it to Teams educational status or something. So it's a free organization. What will work and what will not work? where will I get an issue? And is it insurmountable? Meaning, it's okay if I get some error messages once in a while if it's not a big... or or or... things that maybe don't work as expected, but all the rest keeps on working. That's maybe fine. Right? So Check online. Um, check deeply so you... I I have an answer to this question. And, I mean, so the the central hub is still my organization, but their their organization is their teaching organization, and they forgot to upgrade it. This is not a huge problem. I mean, we can always upgrade organizations, but not... I know many of them have free organizations. So... yeah. What is the situation? And if it's a real problem, what can we do to rectify it? So analyze deep, check online, think deep.

### 2. Relayout of the new-assignment page

> Then after the previous task about three org, I have another task that you only need to start answering after the whole three org thing, free org. And that's a a a kind of... not redesign, but a kind of relayout of the new assignment page. And here's the thing. Some of it can be... some of it is very wide. So the basics block and the templates block are very, very wide. So I wonder if they're space enough. Maybe you can put them next to each other. But then more importantly, the most important thing of that whole page, if you wanna work quickly, is The template repository selection, that should be at the top. But right under that should be the title. And once you select the template, that title is is kind of prefilled in for you. Right? So that's very, very nice. And then below the title should be the repository name pattern. And the slug URL identifier I now realize is is the slug... is that... if that's a slug that's only used within PXL classroom, then this slug should not be editable by the user. I mean, you don't care. Right? Ah, no. Because it's... you share it in the link and stuff, I guess. I don't know about that. But that slug seems to me like something you would never change. And it's hard to imagine. So, yeah, what it's used for. So we have... let's let's go over it again. We have first template repository, then below that the title because that will be prefilled in, and I don't know what to do with the slug. Then there's a description. Sure. And then there's other stuff from the template, like the repository name pattern. That's actually not template stuff. That's title stuff. That should be below the title. So first template repository, then title, then repository name pattern because that's what the students see. That's the that's the important stuff. Right? I still don't know what to do with the slug, and I don't know the basics in the template. Maybe that needs to... that distinction needs to go away, and it's it's one thing. And it's... Yeah. The the normal assignment stuff. I don't know what the good title for this merge thing would be. But you see, if if I want to fill this in quickly with the few clicks possible, and first I select a template repository, then all the rest will be prefilled in, and then I can immediately divert my attention to assignment type, which is individual as standard, so that's good. Then the schedule, that's good. Then who may accept, and the default is open, so that's also good. And, yeah, all the rest is is is is fine. So I hope these changes are not dangerous because everything we need to talk about is there there is a potential thing about the slug. And then there's another thing I hope that very quickly is checked if there are no collisions of names of any of those things. I hope that's in the check somewhere.

### 3. Class groups on the Roster tab, and the Number column

> Then I have another thing to talk about. It's it's smaller, but still... so this is in the roster thing, in the roster overview. Uh, this is all... only to be discussed after the previous task, which was the whole thing about redesigning new assignment. So this thing is about groups in the roster. It's extremely slow and annoying to assign a number of a number of students in that roster to a group. I mean, I have to click the group each time, fill it in. It takes a significant time for it to write. This is not useful. So I want something where, like, this is a little bit easier. Also, I cannot sort on group, I think. Right? So this is this is a little bit bad. But I realize this can get complex very quickly, so I want a simple solution that is still easier than this. Uh, then, uh, on the same page, I have a comment about number. If no one has a number, do not display this column, please.

**The last sentence reverses a decision taken the same day.** Asked whether the Number column should be always present or hidden when unused, the answer was *"Always present, never required"*, and that is what shipped in `9066a22`. The later request supersedes it. It is written down here rather than applied quietly, because a choice changed for a reason worth remembering: with the number no longer required anywhere, a column nobody fills is a column that only asks a question.
