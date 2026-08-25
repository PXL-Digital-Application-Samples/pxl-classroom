# CLAIM_PLAN

Binding a GitHub account to a roster entry, when the lecturer has student
**email addresses** and not their GitHub usernames.

Supersedes the organization-membership plan that previously occupied this file.
That approach shipped (`roster_mode: org_member`, 2026-08-25) and is being
withdrawn unused - see [What to remove](#what-to-remove-and-what-it-costs).
Delete this file once `claim` has run on a real cohort, folding anything durable
into ARCHITECTURE.md and RUNBOOK.md - the lifecycle `UX_PLAN.md` follows.

---

## 1. Why the previous approach was abandoned

`roster_mode: org_member` gates on organization membership: the lecturer invites
email addresses to the org, GitHub performs the email-to-account binding, and
acceptance asks `GET /orgs/{org}/memberships/{login}`. It works, and it is
tested. It was withdrawn for four reasons, in order of weight:

1. **It gates but does not identify.** After a student accepts, the system still
   holds a bare `github_login`. Which student that is remains unknown - the same
   problem that forced `roster promote` into existence. Membership answers "may
   they?" and never "who are they?", because GitHub reports members as logins
   with no email and invitations as emails with no login, with no join between
   them (measured 2026-08-25).
2. **A precondition no code can enforce.** The student must have the invited
   address *verified on their GitHub account*, or the invitation carries
   `login: null`, no membership record exists, and they are indistinguishable
   from an outsider.
3. **Per-org friction multiplies.** Membership is per organization. A student
   taking courses in five orgs needs five invitations and five acceptances
   before touching an assignment.
4. **Seats are consumed before acceptance.** Inviting a cohort up front puts
   every invited student in the org whether or not they ever accept, in every
   org they are invited to.

## 2. Prior art: how GitHub Classroom does it

Verified against GitHub's documentation and issue tracker, 2026-08-25.

- A Classroom roster is "a list of identifiers for the students who participate
  in your course" - free-form strings: student numbers, emails, names. It can be
  synced from Canvas/Moodle/D2L.
- The lecturer shares an assignment URL. "When you first share the URL for an
  assignment with a student, the student must sign into GitHub with a personal
  account to link the personal account to an identifier for the classroom."
- On first acceptance the student **picks their own entry from a displayed
  list**. The roster then exports as `identifier, github_username, github_id,
  name`.
- **No email invitations and no organization membership anywhere in it.**

### What went wrong for them, and what we take from it

[education/classroom#2542](https://github.com/education/classroom/issues/2542)
and the surrounding discussions report mislinking as a routine failure:

- "a single click is enough" to link to the wrong identifier;
- "once they link to the wrong identifier, they can't unlink";
- "I do not know how to find them in the roster and unlink them".

Two design consequences, and they are the reason this plan differs from a
straight copy:

- **The student TYPES their address; they do not pick from a list.** A typo then
  *cannot* mislink - it fails to match and is rejected. The only route to a
  wrong binding is deliberately typing a classmate's address. (We also cannot
  publish the list: `pages/scan.mjs` blocks roster fields from public output,
  and students cannot read the private control repo.)
- **Unlink exists on day one**, with the binding visible to the lecturer.
  Shipping the bind without the unbind is the mistake above.

## 3. End state

A fourth `roster_mode`. `enforced` stays - it is the correct mode for a roster
that already carries usernames, and `claim` is simply "enforced, with a way in".

| Mode | Who may accept |
|---|---|
| `enforced` | login already in `students/roster.yml` |
| **`claim`** | login already bound, **or** the student proves knowledge of a roster email address and is bound on the spot |
| `open` | anybody inside the window and under the cap |
| ~~`org_member`~~ | withdrawn |

### One claim, three behaviours

The claim is not roster machinery - it is a single payload the student presents,
and the mode decides what the hub does with it:

| Mode | What the hub does with the claim |
|---|---|
| `enforced` | nothing - the login is already bound |
| `claim` | the digest must **match a roster entry** -> binds to that student |
| `open` | the domain must be **allowed**, the digest must be **unused** -> binds pseudonymously |

The student's experience is identical in all three: type your PXL address.

**This makes `open` strictly better than it is today.** Today `open` admits any
GitHub account on earth and yields a bare login, which is the whole reason
`roster promote` had to exist. With a claim it gains:

- **a weak gate** - the account must present an address in an allowed domain;
- **uniqueness** - one address, one repository. Today `max_acceptances` is the
  only limit and one person can burn several slots;
- **retroactive identity** - the hub stores digests, so a roster imported later
  can be digested with the same key and matched **backwards**.

### Allowed domains

`claim_domains` on the **assignment** - an optional list, resolved against a
central default that ships **empty**, mirroring `limits.yml`'s documented
resolution order (per-assignment > global default; a per-org tier could slot
into `participating-orgs.yml`'s existing `overrides` later, if anyone ever wants
one).

- **Empty or absent means no domain restriction** - any address is accepted.
  That is the default, deliberately, and most assignments will never set it.
- The domain travels in **plaintext** alongside the digest. It is identical for
  every student in a cohort, so it is not personal data and is safe on the
  public broker - and it is the only reason `open` can be checked at all, since
  there is no roster to match a digest against.
- Checked **server-side**. A browser-side shape check is UX; this is the control.

**The security model is GitHub Classroom's, deliberately.** An open assignment
is an accepted risk: the invitation link, the `opens_at..deadline_at` window and
`max_acceptances` are the real guardrails, and the address is self-declared. A
non-PXL address in the cohort list is obvious on inspection, and the lecturer
asks that person what they are doing. Configurable rather than hard-coded
because other institutions have other domains.

### The flow

1. Lecturer imports a roster CSV carrying `email` (plus `student_number`,
   `full_name`). `github_login` is **not** required - that is the point.
2. Publishes; hands out the signed invitation link. **Unchanged** (§4.3.2).
3. Student opens the link, signs in with GitHub. If no binding exists for their
   account, the page asks for their PXL email address.
4. The browser sends `HMAC-SHA256(key = invite_token, msg = normalized_email)`.
   **The address itself never leaves the browser.**
5. The hub computes the same digest over every roster email and looks for a
   match, then writes the binding.

### Why a digest and not the address

The broker repository is **public**. Student input reaches the hub through the
acceptance issue **body** - a JSON payload the hub reads and validates, never
the broker (`lib/team-payload.mjs`, ARCHITECTURE §4.3.1). The hub deletes the
issue once read, but there is a window in which the body is world-readable, and
a class list of `firstname.lastname@stud.pxl.be` is both personal data and
trivially enumerable.

The invite token is the natural key: the student already holds it in their URL,
the hub holds it in the assignment YAML, and nobody else has either.

**Residual, accepted:** somebody holding both the token and the digest could
test it against a guessed list of addresses. They would already be a student
holding the link, and the digest lives only in an issue that is deleted. Not
worth further hardening.

### Where the binding is written

`students/claims/<github_id>.json` in the control repo, one file per student:

```json
{
  "schema_version": 1,
  "github_login": "alice-pxl",
  "github_id": 12345678,
  "student_number": "0123456",
  "claimed_at": "2026-09-01T10:00:00.000Z",
  "claimed_via": "net-advanced-guts-2627"
}
```

Three decisions inside that, each load-bearing:

- **One file per student, not an edit to `roster.yml`.** Acceptance is
  concurrent and serialized only per student, so two claims at once would
  collide on a single roster write. Every existing acceptance artefact is
  one-file-per-student for the same reason.
- **Keyed by `github_id`, never by the digest.** `regenerate_invite` rotates the
  token, which changes every digest - claims keyed by digest would become
  unfindable the moment a lecturer repaired a leaked link. `github_id` is
  immutable and survives a username change.
- **It records `student_number`**, the roster's stable key - not the email. The
  roster remains the only place an address is stored.

`org`-scoped, not per-assignment: a student claims once and every later
assignment in that org recognises them.

## 4. Edge cases

### Matching

| Case | Behaviour |
|---|---|
| Case / whitespace differences | Normalize: trim + lowercase. Nothing cleverer - no dot or plus folding; a PXL address is not a Gmail address |
| Typo in the address | No match -> `rejected:no-claim-match`. **Cannot mislink** |
| Student types a personal address | Same - no match |
| Roster entry has no `email` | That student can never claim. Surfaced at import and by a Tier 3 diagnostic, not discovered by the student |
| Two roster entries share an email | Ambiguous. Refused at **import**, so it cannot be discovered at acceptance time |
| Roster unreadable / unparseable | `fail:*`, never a rejection - same rule as `enforced` |
| No claim payload supplied | `rejected:no-claim`, with copy asking for the address |
| `claim_domains` empty or absent | **No restriction** - any address accepted. The default |
| Address outside `claim_domains` | `rejected:claim-domain`, naming the domains that are accepted |
| Domain differs only in case | Normalized - domains are case-insensitive |
| Under `open`, the digest is already used | `rejected:claim-taken`. One address, one repository |
| Under `open`, no roster exists at all | Fine - the digest binds pseudonymously and a roster imported later matches backwards |

### Conflicts

| Case | Behaviour |
|---|---|
| Same student accepts twice | Existing claim matches their `github_id` - idempotent, no re-prompt |
| A different account claims an already-claimed entry | `rejected:claim-taken`. **First-come wins.** This is the detection mechanism: the real student is refused and complains |
| One account claims a second, different entry | Refused - one account binds to exactly one roster entry |
| Student renames their GitHub account | Bound on `github_id`; `github_login` is display only and is refreshed on next acceptance |
| Student deletes and recreates their account | New `github_id` -> lecturer must **unlink** the old claim |

### Lifecycle

| Case | Behaviour |
|---|---|
| `regenerate_invite` rotates the token | Existing claims unaffected (keyed by id, not digest). New claimers use the new token; the hub always computes with the assignment's current one |
| Student uses a retired link | Rejected at invite verification, before the claim step is reached |
| Roster CSV re-imported | `roster.yml` is replaced wholesale; claims are separate files and **survive** |
| A claimed student is removed from the roster | Claim is orphaned - reported, not silently deleted |
| Second assignment in the same org | No re-prompt; the claim is org-scoped |
| Group assignment | Claim and team payload share the issue-body JSON |

### Lecturer operations - the Classroom lesson

| Need | Surface |
|---|---|
| See who is bound to what | Roster tab column + `pxl-classroom roster list` |
| **Unlink** a wrong binding | `pxl-classroom roster unlink --login X` + Roster tab action. **Ships with the feature, not after it** |
| Find an unclaimed student | Diagnostic: roster entries with neither `github_login` nor a claim |
| Fold claims into the roster | `roster promote`, repurposed (§6) |

### Security and privacy

- The address is never written to the public broker, an Actions log, a step
  summary, or a workflow output.
- `students/claims/` lives in the private control repo and must never reach
  Pages. The claim record deliberately stores `student_number`, not the address,
  so even a leaked claim file carries no contact detail.
- **`pages/scan.mjs` does not currently match `"email"`.** It blocks
  `student_number`/`student_id`, `full_name`/`display_name`, `class_group`,
  `institutional_id`, App keys and JWTs - but not an email field. Nothing
  publishes one today, so this is a pre-existing gap rather than one `claim`
  introduces; it should be closed before a feature starts handling addresses
  routinely. Check first that no generated artefact legitimately contains
  `"email":` (`budget_owner_email` lives in `participating-orgs.yml`, which is
  not public output) or the publish gate will start failing on good data.
- The scanner carries a `claim-token-field` pattern for `"claim_token"`, which
  appears **nowhere else in the repository** - a vestigial guard against a field
  from an earlier design that nothing writes any more. Harmless, and the word is
  therefore free to reuse. Worth deciding whether the pattern should now guard
  this feature's records instead of a field that no longer exists.
- Web Crypto is required for the digest; Pages is HTTPS so `crypto.subtle` is
  available. The page must say so plainly if it is not, rather than failing
  silently.

## 5. Rate limiting and abuse protection

The claim step is a **guessing oracle**. Whoever holds the invitation link holds
the HMAC key, so they can compute a digest for any address they care to guess -
and PXL addresses are `firstname.lastname@stud.pxl.be`, which is enumerable from
a class list or a lucky guess. Unbounded, a student with the link could iterate
plausible addresses until one matched and claim a classmate's entry.

Two costs, and the second bites first:

- **Identity** - a successful guess binds somebody else's roster entry.
- **Minutes** - every attempt is an acceptance issue and a hub workflow run, on
  a system whose design goal is billing zero minutes when idle. A bored student
  with a loop is a bigger bill than a security incident.

### The limit

`students/claim-attempts/<github_id>.json`, one file per account:

```json
{
  "schema_version": 1,
  "github_id": 12345678,
  "github_login": "alice-pxl",
  "failures": 3,
  "first_at": "2026-09-01T10:00:00.000Z",
  "last_at": "2026-09-01T10:04:00.000Z"
}
```

- Every failed claim increments it. At `MAX_CLAIM_ATTEMPTS` (**5**) the answer
  becomes `rejected:claim-blocked`, telling the student to contact their
  lecturer - not how many attempts remain.
- A successful claim **deletes** the counter, so a student who eventually gets
  their own address right is not left one typo from being locked out next term.
- **Serialized for free**: the acceptance concurrency group is already keyed per
  login (`accept-${org}-${id}-${team_hint || github_login}`), so a student
  cannot race their own counter by firing several acceptances at once.
- Cleared by the lecturer through the same surface as unlink.

Five is chosen to be generous for a genuine typo and useless for enumeration: a
cohort of 200 addresses is not reachable in five guesses, and the worst case
cost is 5 x cohort short-lived runs.

### Ordering is where the cost is actually saved

The claim check belongs exactly where the roster gate sits today - step 4.5,
after the state, window and cap checks and **before** any repository work. A
rejected claim must never reach provisioning, never create a repository and
never mint a second token. The cheapest rejection is the one that happens
earliest, and the guardrails above it are all free.

### What already protects this, unchanged

- the **signed invitation** (§4.3.2) - an outsider cannot ring the bell at all,
  so this threat model is a student with a legitimate link, not the internet;
- `INVITE_NONCE` - retires leaked links wholesale;
- the `opens_at..deadline_at` window and `max_acceptances`;
- per-login concurrency - one acceptance at a time per student.

### Deliberately not done

- **`no-claim-match` and `claim-taken` stay distinguishable**, even though that
  reveals which addresses exist. The real student being told "already claimed"
  *is* the impersonation detector, and the attempt cap makes enumeration
  impractical. Revisit only if five proves too loose.
- **No client-side-only limit.** The SPA should check the address *shape* before
  sending - it costs nothing and saves wasted runs - but shape checking in a
  browser is UX, never a control. The counter is server-side or it is not a
  limit.
- **No global per-assignment attempt cap.** `max_acceptances` already bounds
  successes, and a global failure cap would let one abuser lock out a cohort.

## 6. What to turn off

None of this has touched a cohort; all of it is reversible.

- `roster_mode: org_member`: schema enum value, the `accept.mjs` branch,
  the AdminView option and hint, the `AssignmentView` cause line,
  `tests/org-member-gate.test.mjs`, `tests/e2e/42-org-member-mode.spec.mjs`.
- The `github-token` input threaded into `acceptance/action.yml` and
  `acceptance-handler.yml` - added solely for the membership call.
- `lib/org-members.mjs` (uncommitted; Phase B never went further).

## 7. What to remove, and what it costs

| Remove | Consequence |
|---|---|
| The `org_member` gate | **None.** Never used on a cohort. `accept.mjs` returns to three modes plus `claim` |
| The `members` App permission | **None functionally** - nothing else reads it. But it is approved on 11 orgs, and relinquishing means another approval round. **Leave it granted, remove the code**: cheap to keep, expensive to re-acquire. An unused *write* permission is surface area, so revisit if `claim` proves itself |
| Base-permission diagnostic | **Keep.** Rationale rewritten: the lock-down-floor argument weakens once students are never org members, but a base permission above `none` still exposes the private control repo - roster, reports - to every non-owner member, and org membership remains how staff are added |

## 8. Keep deliberately - pre-provisioned repositories

A future feature: create N repositories up front and assign them to the students
who turn up. It is blocked today because `repository_name_pattern` is
`{github_login}` - a repository cannot be named before its owner is known.

**`claim` is the missing half.** Once a student binds to a stable identifier,
repositories can be created as `exam-2627-01..20` ahead of time and *assigned*
on claim instead of created. Therefore keep, in this shape:

- **`student_number` on the roster** - the natural pre-provision key, and what
  `claim` binds to. It must not become optional.
- **`provision.mjs`'s create-from-template and add-collaborator steps** -
  pre-provisioning reuses the second and skips the first.
- **`max_acceptances`** - becomes the pre-provision count.
- **`lib/seed-teams.mjs`** - already "assign an existing thing to a student".
- **`roster promote`** - **repurposed, not scrapped**: it becomes the tool that
  folds `students/claims/*.json` into `roster.yml`, and remains the only path
  for `open` mode.
- **`lib/roster-mode.mjs`**, and the `!== "open"` -> `=== "enforced"` guard
  corrections - right regardless of which modes exist.

## 9. Build order

1. `lib/claim.mjs` - isomorphic normalize + digest (`globalThis.crypto.subtle`,
   available in Node 24 and the browser), plus the pure matcher.
2. `schemas/claim.schema.json`; `roster_mode: claim` and the optional
   `claim_domains` list in the assignment schema; the central default, shipped
   empty.
3. `accept.mjs`: the claim branch, four reject reasons (`no-claim`,
   `no-claim-match`, `claim-taken`, `claim-blocked`), fail-closed, positioned at
   step 4.5 so a rejection never reaches provisioning.
4. The attempt counter (§5) - it ships **with** the gate, not after it; an
   unbounded guessing oracle is not a thing to leave open for a follow-up.
5. Issue-body payload: extend the validated team-payload channel.
6. SPA: the address prompt on `AssignmentView`, a client-side shape check, and
   the copy for each rejection.
7. Lecturer surfaces: Roster tab binding column + **unlink**; CLI `roster
   unlink`; the unclaimed-students diagnostic.
8. Withdraw `org_member` (§6).
9. Docs: ARCHITECTURE §15, RUNBOOK §12.4, CLAUDE.md.

## 10. Decided, and still open

**Decided (2026-08-25):**

- **`claim_domains` is per assignment**, over a central default that ships
  **empty**. Empty means no restriction, and most assignments will never set it.
- **The claim is one mechanism across all three modes**, not roster machinery.
- **The security model is GitHub Classroom's** and the risk of an open
  assignment is accepted deliberately - guarded by the invitation link, the
  window and the cap, with the cohort list eyeballed afterwards.
- **`enforced` survives** alongside `claim`; it is the right mode for a roster
  that already carries usernames.

**Still open:**

- **Does the roster schema require `email` under `claim`?** It cannot be
  enforced in the assignment schema (different file), so it belongs in a
  diagnostic and at import time.
- **Should a claim be revocable by the student?** Classroom says no. An unlink
  the lecturer controls is probably right; a student-facing one invites the
  mislinking-by-accident problem back in.
- **Does `claim` want a cap?** The roster is itself a limit. Probably optional,
  as with `enforced`.
- **Cross-assignment digests.** The key is the assignment's invite token, so the
  same student produces unrelated digests in two assignments - retroactive
  matching works per assignment, but the same person cannot be deduped across
  them. An org-level salt would fix it, but the SPA cannot read one (students
  cannot read the control repo) and publishing it makes it not a salt. Left
  unsolved; revisit only if it actually hurts.
