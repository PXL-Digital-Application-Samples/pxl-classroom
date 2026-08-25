# CLAIM_PLAN

Two changes to acceptance, discovered together and best built together:

1. **Take the invitation token out of the public event stream.** It is there
   today, world-readable, on a published assignment. Verified, not theorised.
2. **Bind a GitHub account to a student identity**, for the lecturer who has
   student **email addresses** and not their GitHub usernames.

Supersedes the organization-membership plan that previously occupied this file
(`roster_mode: org_member`, shipped 2026-08-25, withdrawn unused). Delete this
file once both have run on a real cohort, folding anything durable into
ARCHITECTURE.md and RUNBOOK.md - the lifecycle `UX_PLAN.md` follows.

---

## 1. The token exposure - verified, and live

Every acceptance opens an issue on the **public** broker whose title is
`pxl-accept:<token>`. GitHub emits an `IssuesEvent` for that, and the event
payload carries the **title and body**. ARCHITECTURE §4.3.3 answers this with
three defences - the broker redacts the title, the hub deletes the issue,
System Health sweeps for leftovers - and **all three are after the fact.**

Measured 2026-08-25 against `PXL-Systems-Expert/broker-2526-sysex-ek2-test2`:

```
$ curl -s https://api.github.com/repos/PXL-Systems-Expert/broker-2526-sysex-ek2-test2/events
unauthenticated HTTP 200
pxl-accept:AQFQu79dno7AjwhnJix7...
```

- **No authentication of any kind.** Not a token, not an account.
- The issue had already been deleted. **The event kept the title.**
- The assignment is `state: published`, `roster_mode: open`, cap 50, deadline
  2026-09-09, and the broker's `INVITE_NONCE` still matches the assignment's -
  so the token was **not retired**. Anyone reading that feed could claim a free
  repository.

Two tiers of harvest, both easy:

| | |
|---|---|
| Live window | one unauthenticated `GET /repos/{org}/{broker}/events`; ~90 days, and it **survives issue deletion** |
| Permanently | GH Archive mirrors the global firehose into a public BigQuery dataset. `WHERE payload LIKE '%pxl-accept:%'` returns every token ever emitted. A well-known research dataset, not an obscure trick |

**The irony worth recording:** v1 triggered acceptance with a **star**, which
carries no payload and leaks nothing. §4.3.2 introduced the signed token to stop
outsiders triggering work - and in doing so made the trigger credential itself
world-readable. The fix created this.

### Why this is not a "make the token secret" problem

The token is a **bearer credential**: possession is sufficient. Hiding it is not
available - every student-initiated trigger on a public repository emits a public
event, and title and body are both in it. There is no private transport without
self-hosting, which is a settled no.

So the fix is to make **what lands in the event insufficient on its own.**

---

## 2. Signed acceptance - flipping who signs

The machinery already exists (`lib/invite-token.mjs`, `acceptance/invite-keys.json`,
`INVITE_KID` rotation). It is pointed the wrong way.

| | Today | Proposed |
|---|---|---|
| The link carries | the signed token (**bearer**) | a **private key** |
| Who signs | the hub, once, statically | the **student**, freshly, per acceptance |
| The title carries | the token itself | a **signature** over `{subject, github_id, issued_at}` |
| Broker verifies with | the hub's published key | the assignment's public key, in broker variable `INVITE_PUBKEY` |
| A public event reveals | **a reusable credential** | a signature naming *that student's own* account |

A harvester pulling that event out of GH Archive gets a signature asserting
*"github_id 123 accepted assignment X"*. Reusing it requires **being** account
123. Forging one for their own account requires the private key, which never
appears in any event.

### What stays exactly as it is

- The title keeps the `pxl-accept:` prefix, so the broker's **job-level `if`
  still runs before a runner is allocated** - the whole reason the marker is in
  the title (§4.3.2).
- The broker still **never reads the issue body**.
- The hub still cross-checks the signed `github_id` against the issue author.
- `regenerate_invite` still retires every link, now by minting a new keypair.

### Algorithm: ECDSA P-256, not Ed25519

Verified 2026-08-25: Ed25519 reached WebCrypto in Firefox 130, Safari 17 and
**Chrome 137 (May 2026)** - about **79% of users**. One student in five would
simply fail. P-256 is universal in browsers and in Node's `crypto.subtle`, so
one isomorphic module serves both sides. Ed25519 stays where it already is, on
the Node-only paths.

### Sizes - verified, and comfortable

GitHub's issue title limit is **256 characters** (body 65,536).

```
pxl-accept:  <kid>  .  <payload>  .  <signature>
    11         8           ~40          86          ~147 total
```

The link grows (it now carries a 32-byte private key, ~43 base64url chars plus
subject and kid). **A long URL is acceptable** - it is copied, not typed.

### Canonical encoding is mandatory

A 32-byte key and a 64-byte signature do not divide into 6-bit groups, so the
last base64url character carries discardable bits and one key has several
spellings. `lib/invite-token.mjs` already learned this the hard way; the same
check must apply here or a link will verify sometimes and not others.

### What this fixes, and what it does not

- **Fixes:** the link no longer leaks to the entire internet through a public
  archive. That vector closes completely.
- **Does not fix:** whoever a student *shares the link with* can still accept.
  That is ARCHITECTURE §15's already-accepted "not secret against sharing",
  bounded by the cap and the window.

It turns a **world-readable** credential back into a **shared-by-students**
credential - which is what the design always assumed it was.

---

## 3. Prior art: how GitHub Classroom binds students

Verified against GitHub's documentation and issue tracker, 2026-08-25.

- A Classroom roster is "a list of identifiers for the students who participate
  in your course" - free-form strings, optionally synced from an LMS.
- "When you first share the URL for an assignment with a student, the student
  must sign into GitHub with a personal account to link the personal account to
  an identifier for the classroom." On first acceptance the student **picks
  their own entry from a displayed list**.
- **No email invitations and no organization membership anywhere in it.**

### What went wrong for them

[education/classroom#2542](https://github.com/education/classroom/issues/2542)
reports mislinking as routine: "a single click is enough"; "once they link to
the wrong identifier, they can't unlink"; "I do not know how to find them in the
roster and unlink them."

Two consequences, and they are why this plan is not a straight copy:

- **The student never picks from a list of other people.** They confirm one of
  **their own** addresses, or type theirs. A typo then *cannot* mislink - it
  fails to match. (We also cannot publish the list: `pages/scan.mjs` blocks
  roster fields from public output, and students cannot read the control repo.)
- **Unlink ships with the feature, not after it.**

---

## 4. The claim

### 4.1 One mechanism, three modes

`enforced` survives - it is the right mode for a roster that already carries
usernames, and `claim` is simply "enforced, with a way in".

| Mode | What the hub does with the claim |
|---|---|
| `enforced` | nothing - the login is already bound |
| **`claim`** | the address must **match a roster entry** -> binds to that student |
| `open` | the domain must be **allowed**, the address must be **unused** -> binds pseudonymously |
| ~~`org_member`~~ | withdrawn |

### 4.2 Encrypted, not hashed

The address is **encrypted to a hub-held public key** (ECDH P-256 + HKDF +
AES-GCM), so the public event archives inert ciphertext.

Hashing was the first design and is worse on the axis that matters: with an
HMAC the hub *never learns the address* under `open` - it only ever matches
against a roster it does not have. Encryption gives the lecturer a readable
address, which is what was actually asked for.

| | Hash | Encrypt |
|---|---|---|
| Address in the public archive | inert | inert |
| **Hub learns the address** | `claim` only, by matching - **never under `open`** | **always** |
| Readable in reports / can contact the student | no | **yes** |
| Cross-assignment comparison | no | trivial |
| Uniqueness | per assignment | global |

CLAUDE.md rejects encryption for the *invite token* - "the broker cannot hold a
decryption key" - and that reasoning does not transfer: decryption happens at
the **hub**, which already holds secrets. The broker never sees plaintext.

**Bind the payload to the claimant.** Encrypt
`{email, github_id, assignment_id, nonce}` and reject at the hub if `github_id`
does not match the issue author, or a copied ciphertext is replayable straight
out of the archive.

### 4.3 The front end: confirm, don't type

Students verify their address with GitHub at sign-up. The App can read that
(`GET /user/emails`, account permission "Email addresses: Read"), so the page
shows **their own GitHub-verified addresses matching the domain** and asks them
to confirm one. Typing is the fallback.

- no email sent by anyone - no infrastructure, no seats, no second step;
- **no typos**, because they are picking their own real addresses;
- **no mislinking**, because the list is only ever their own addresses;
- verification GitHub already performed, for free.

**It is client-side, so it is not a control.** The hub cannot check it - an
installation token cannot read a user's email addresses, the same wall that
killed `org_member`. Record **`claim_verified: true|false`** and treat it as
evidence, not enforcement:

| Who | Recorded as |
|---|---|
| student with their PXL address on GitHub | `verified: true` |
| student who never added it, types it | `verified: false`, still works |
| someone with a shared link and a made-up address | **always** `verified: false` |

That is a far sharper cohort review than "does this address look like one of my
students".

### 4.4 Where the binding is written

`students/claims/<github_id>.json`, one file per student:

```json
{
  "schema_version": 1,
  "github_login": "alice-pxl",
  "github_id": 12345678,
  "email": "alice.example@stud.pxl.be",
  "claim_verified": true,
  "student_number": "0123456",
  "claimed_at": "2026-09-01T10:00:00.000Z",
  "claimed_via": "net-advanced-guts-2627"
}
```

- **One file per student, not an edit to `roster.yml`.** Acceptance is
  concurrent and serialized only per student, so two claims at once would
  collide on a single roster write. Every existing acceptance artefact is
  one-file-per-student for the same reason.
- **Keyed by `github_id`** - immutable, survives a username change.
- **Org-scoped, not per-assignment**: claim once, and every later assignment in
  that org recognises you.
- `students/claims/` is private and must never reach Pages.

### 4.5 Allowed domains

`claim_domains` on the **assignment**, resolved over a central default,
mirroring `limits.yml`'s documented resolution order.

- **This deployment ships the default as `["stud.pxl.be", "pxl.be"]`**,
  documented as the single line another institution edits on a fork. Simpler
  than inventing a per-deployment mechanism.
- **Empty means no restriction.** An assignment can opt out deliberately.
- Checked **server-side**, case-insensitively. A browser-side shape check is UX.

**Be honest about what this buys.** Under `open` there is no roster, so nothing
checks that the address *exists* - `jan.jansen@stud.pxl.be` passes, and so does
`asdf@stud.pxl.be`. The domain check gives **detection and accounting**, not
prevention:

- an intruder appears carrying a fabricated address and `verified: false`,
  rather than as a bare login indistinguishable from a student who has not
  linked yet;
- one address, one repository - they cannot quietly take ten slots.

**Under `open`, the only real controls remain the cap, the window, and the token
not leaking.** If a shared link getting a repository is unacceptable for a given
assignment, the answer is not a better domain rule - it is `claim` with a
roster, where a fabricated address matches nothing.

---

## 5. Edge cases

### Signed acceptance

| Case | Behaviour |
|---|---|
| Signature does not verify | Broker rejects before dispatch. No runner cost beyond the `if` |
| `kid` unknown to the broker | Reject - a rotated-away key must not verify |
| `INVITE_PUBKEY` variable absent | **Fail closed**, named as a deployment fault - the `no-nonce` precedent, where an absent value once accepted every token ever issued |
| Signed `github_id` != issue author | Reject. This is the anti-replay check; broker rejects early, hub re-checks |
| Non-canonical base64url in key or signature | Reject - one key must have one spelling |
| Clock skew on the student's machine | **`issued_at` is advisory, not enforced.** A signature is already bound to one account, so a stale one is only that student accepting again, which is idempotent. Rejecting on time would add a failure mode with no security gain |
| WebCrypto unavailable | The page says so plainly instead of failing silently |
| Old-style token link after the change | Rejected. Migration is a republish, which mints new links (§9) |

### Claim matching

| Case | Behaviour |
|---|---|
| Case / whitespace differences | Normalize: trim + lowercase. Nothing cleverer - a PXL address is not a Gmail address |
| Typo in a typed address | Under `claim`: no match -> rejected, **cannot mislink**. Under `open`: accepted if the domain matches, recorded `verified: false` |
| Roster entry has no `email` | That student can never claim. Surfaced at import and by a diagnostic, never discovered by the student |
| Two roster entries share an email | Ambiguous - refused at **import**, so it cannot surface at acceptance |
| Roster unreadable | `fail:*`, never a rejection |
| No claim payload supplied | `rejected:no-claim`, with copy asking for the address |
| Ciphertext will not decrypt | `rejected:no-claim`, and it counts against the attempt limit |
| `claim_domains` empty | No restriction. The opt-out |
| Address outside `claim_domains` | `rejected:claim-domain`, naming the accepted domains |

### Conflicts

| Case | Behaviour |
|---|---|
| Same student accepts twice | Existing claim matches their `github_id` - idempotent, no re-prompt |
| A different account claims a taken address | `rejected:claim-taken`. **First-come wins**, and the real student complaining is the detector |
| One account claims a second address | Refused - one account, one roster entry |
| Student renames on GitHub | Bound on `github_id`; login is display only, refreshed on next acceptance |
| Student deletes and recreates their account | New `github_id` -> lecturer must **unlink** |
| Two students share one mailbox | Second is refused as taken. Rare, real, and the lecturer resolves it by unlinking |

### Lifecycle

| Case | Behaviour |
|---|---|
| `regenerate_invite` | New keypair **and** new nonce. Existing claims unaffected - they are keyed by `github_id` |
| Roster CSV re-imported | `roster.yml` replaced wholesale; claims are separate files and **survive** |
| A claimed student is removed from the roster | Claim orphaned - reported, never silently deleted |
| Second assignment in the same org | No re-prompt; claims are org-scoped |
| Group assignment | Claim and team payload share the hub-validated issue-body JSON |
| Assignment closed mid-claim | Window check precedes the claim, as today |

### Lecturer operations - the Classroom lesson

| Need | Surface |
|---|---|
| See who is bound to what, and whether verified | Roster tab column + `pxl-classroom roster list` |
| **Unlink** a wrong binding | `pxl-classroom roster unlink --login X` + Roster tab action. **Ships with the feature** |
| Find an unclaimed student | Diagnostic: roster entries with neither `github_login` nor a claim |
| Fold claims into the roster | `roster promote`, repurposed (§8) |

### Privacy

- The address is never written to the public broker, an Actions log, a step
  summary, or a workflow output. Only ciphertext travels.
- `students/claims/` is private and must never reach Pages.
- **`pages/scan.mjs` does not currently match an `"email"` field at all.**
  Nothing publishes one today, so this is pre-existing - but it must be closed
  before a feature starts handling addresses routinely. Check first that no
  generated artefact legitimately contains `"email":`, or the publish gate will
  start failing on good data.
- The scanner's `claim-token-field` pattern guards `"claim_token"`, which
  appears **nowhere else in the repository** - vestigial from an earlier design.
  Repoint it at this feature's records or drop it.

---

## 6. Rate limiting and abuse protection

Under `claim`, the claim step is a **guessing oracle**: whoever holds the link
can submit addresses, and `firstname.lastname@stud.pxl.be` is enumerable.
Unbounded, somebody could iterate until one matched a roster entry.

Two costs, and the second bites first:

- **Identity** - a successful guess binds somebody else's roster entry.
- **Minutes** - every attempt is an issue and a hub workflow run, on a system
  whose design goal is billing zero when idle. A bored student with a loop is a
  bigger bill than a security incident.

### The limit

`students/claim-attempts/<github_id>.json`, one file per account, holding
`failures`, `first_at`, `last_at`.

- Every failed claim increments it. At `MAX_CLAIM_ATTEMPTS` (**5**) the answer
  becomes `rejected:claim-blocked`, telling the student to contact their
  lecturer - not how many attempts remain.
- A successful claim **deletes** the counter.
- **Serialized for free**: the acceptance concurrency group is already keyed per
  login, so a student cannot race their own counter.
- Cleared by the lecturer through the unlink surface.

Five is generous for a typo and useless for enumeration.

### Ordering is where the cost is saved

The claim check sits exactly where the roster gate sits today - after state,
window and cap, **before** any repository work. A rejected claim must never
reach provisioning. The cheapest rejection is the earliest one.

### Deliberately not done

- **`no-claim-match` and `claim-taken` stay distinguishable.** The real student
  being told "already claimed" *is* the impersonation detector, and the attempt
  cap makes enumeration impractical.
- **No client-side-only limit.** Shape checking in a browser is UX.
- **No global per-assignment failure cap** - one abuser could lock out a cohort.

---

## 7. What to turn off, and what to remove

None of this has touched a cohort; all of it is reversible.

**Turn off:** `roster_mode: org_member` end to end - schema value, the
`accept.mjs` branch, the AdminView option and hint, the `AssignmentView` cause
line, `tests/org-member-gate.test.mjs`, `tests/e2e/42-org-member-mode.spec.mjs`,
and the `github-token` input threaded into `acceptance/action.yml` and
`acceptance-handler.yml` for the membership call.

| Remove | Consequence |
|---|---|
| The `org_member` gate | **None.** Never used on a cohort |
| The `members` App permission | **None functionally.** But it is approved on 11 orgs and relinquishing means another approval round. **Leave it granted, remove the code** - cheap to keep, expensive to re-acquire |
| Base-permission diagnostic | **Keep.** Rationale rewritten: the lock-down-floor argument weakens once students are never org members, but a base permission above `none` still exposes the private control repo - roster, reports - to every non-owner member, and membership remains how staff are added |

---

## 8. Keep deliberately - pre-provisioned repositories

A future feature: create N repositories up front and assign them to whoever
turns up. Blocked today because `repository_name_pattern` is `{github_login}` -
a repository cannot be named before its owner is known.

**`claim` is the missing half.** Once a student binds to a stable identifier,
repositories can be created as `exam-2627-01..20` ahead of time and *assigned*
on claim. So keep:

- **`student_number` on the roster** - the natural pre-provision key, and what
  `claim` binds to. It must not become optional.
- **`provision.mjs`'s create-from-template and add-collaborator steps** -
  pre-provisioning reuses the second and skips the first.
- **`max_acceptances`** - becomes the pre-provision count.
- **`lib/seed-teams.mjs`** - already "assign an existing thing to a student".
- **`roster promote`** - **repurposed**: folds `students/claims/*.json` into
  `roster.yml`, and remains the only path for `open` mode.
- **`lib/roster-mode.mjs`** and the `!== "open"` -> `=== "enforced"` guard
  corrections - right regardless of which modes exist.

---

## 9. Test plan

Unit tests drive the real modules; e2e drives the real SPA against mocked
GitHub. Every rule below gets a mutation check - put the bug back, watch it go
red - because several tests this month passed against nothing until that was
done.

### Unit - `tests/acceptance-signature.test.mjs`

Canonical encoding (one key, one spelling); sign/verify round trip; tampered
payload; tampered signature; wrong `kid`; unknown `kid`; absent `INVITE_PUBKEY`
fails closed; signed `github_id` mismatch; `issued_at` advisory and never
rejected; a signature from a rotated-away keypair; P-256 interop between
`crypto.subtle` in Node and a browser-shaped fixture.

### Unit - `tests/claim.test.mjs`

Encrypt/decrypt round trip; ciphertext bound to `github_id`; replay with a
foreign `github_id` refused; corrupt ciphertext; wrong `kid`; normalization
(case, whitespace); domain allow / deny / empty; roster match; no match;
duplicate roster emails refused at import; roster with no email; array-shaped
roster refused; claim-taken; one account one entry; attempt counter increments,
blocks at five, and is deleted on success.

### Unit - `tests/accept.test.mjs` additions

Each reject reason and its exit code (0 for `rejected:*`, 1 for `fail:*`); the
claim check runs after window and cap and before provisioning; `enforced`
unchanged; unrecognised `roster_mode` still falls back to `enforced`.

### E2E - `tests/e2e/43-signed-acceptance.spec.mjs`

The title never contains the private key; it does contain the `pxl-accept:`
prefix; a tampered title is rejected; the page reports a WebCrypto failure
plainly; an old-format link is refused with migration copy.

### E2E - `tests/e2e/44-claim-student.spec.mjs`

Verified addresses are offered and only those matching the domain; confirming
one records `verified: true`; no verified address falls back to typing and
records `verified: false`; the typed field rejects a wrong domain before
sending; every rejection reason renders its own copy (`no-claim`,
`no-claim-match`, `claim-taken`, `claim-domain`, `claim-blocked`); the blocked
copy does not reveal the remaining count; a group assignment carries both team
and claim payloads.

### E2E - `tests/e2e/45-claim-lecturer.spec.mjs`

The Roster tab shows the binding and the verified flag; **unlink** removes it
and the student can claim again; the unclaimed-students diagnostic lists exactly
the right entries; a CSV re-import preserves claims; an orphaned claim is
reported; `roster promote` folds claims into the roster.

### E2E - `tests/e2e/46-claim-edges.spec.mjs`

Two accounts racing one address; a renamed GitHub account; a re-import that
removes a claimed student; an assignment whose deadline passes mid-flow;
`claim_domains` empty meaning no restriction; `open` with no roster at all.

---

## 10. Phases

Each phase is independently shippable and independently valuable.

| Phase | Contents | Why this order |
|---|---|---|
| **A. Signed acceptance** | `lib/acceptance-signature.mjs`; publish mints a keypair and sets `INVITE_PUBKEY`; broker verifies; SPA signs; migration | **A live exposure on a published assignment.** Independent of everything below, and the only item with a clock on it |
| **B. Withdraw `org_member`** | §7 | Small, and it clears the ground so the claim branch is written once |
| **C. Claim core** | `lib/claim.mjs`; `roster_mode: claim`; `claim_domains` + central default; encrypted payload; the attempt counter; reject reasons | The counter ships **with** the gate - an unbounded guessing oracle is not a follow-up |
| **D. Student front end** | Confirm-your-verified-address, typed fallback, `claim_verified`, rejection copy | Needs the App's "Email addresses: Read" account permission |
| **E. Lecturer surfaces** | Binding column, **unlink**, unclaimed diagnostic, `roster promote` repurposed | Unlink is not optional - it is the mistake Classroom made |
| **F. `open` + claim** | Domain gate and uniqueness under `open` | Depends on C; decide separately whether it is wanted |
| **G. Docs** | ARCHITECTURE §4.3.2/§4.3.3/§15, RUNBOOK §12.4, CLAUDE.md; delete this file | Same commit as the behaviour, per the Memory Rule |

**Immediately, before any of it:** rotate the exposed token on
`2526-sysex-ek2-test2`, or close the assignment.

---

## 11. Decided, and still open

**Decided (2026-08-25):**

- Encrypt the address; do not hash it. The lecturer needs a readable address.
- `claim_domains` per assignment over a central default, shipping
  `["stud.pxl.be", "pxl.be"]` **here** and documented as the fork point.
- The claim is one mechanism across all modes, not roster machinery.
- `enforced` survives alongside `claim`.
- ECDSA P-256 for anything a browser signs.
- A long invitation URL is acceptable.
- `open` remains genuinely open; its guardrails are the cap, the window and the
  token not leaking. The domain check is detection, not prevention.

**Still open:**

- **Does the roster schema require `email` under `claim`?** It cannot be
  enforced from the assignment schema, so it belongs in a diagnostic and at
  import.
- **Should a claim be revocable by the student?** Classroom says no; a
  lecturer-controlled unlink is probably right.
- **Is the "Email addresses: Read" account permission really user-consented**
  rather than org-approved? Expected, not verified - it decides whether Phase D
  costs another approval round.
- **What happens to `students/claims/` when a course ends?** Retention is a
  policy question, not a technical one.
