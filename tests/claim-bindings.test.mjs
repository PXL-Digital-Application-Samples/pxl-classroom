// Who is bound to whom.
//
// The join between a claim and a roster entry is the EMAIL ADDRESS, and it is
// about to be read on four surfaces (Roster tab column, `roster list`, the
// unclaimed diagnostic, `roster promote`). Four readers of one rule is the
// shape that forked `diffRosters` into two implementations disagreeing on key
// order, and the deadline rule into three disagreeing on which extension wins.
//
// The guard at the bottom fails if any consumer joins claims to roster entries
// itself instead of importing lib/claim-bindings.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BINDING_STATES,
  indexClaims,
  rosterBindings,
  orphanClaims,
  claimSummary,
  describeBinding,
} from "../lib/claim-bindings.mjs";
import { buildClaimRecord, rosterEntryForEmail } from "../lib/claim.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const claim = (login, id, email, verified = true) =>
  buildClaimRecord({
    githubLogin: login,
    githubId: id,
    email,
    claimVerified: verified,
    assignmentId: "hw-1",
    now: "2026-09-01T10:00:00.000Z",
  });

const roster = (...students) => ({ schema_version: 1, students });

// --- the join ----------------------------------------------------------------

test("a claim binds the roster entry carrying the same address", () => {
  const r = roster({ student_number: "0123456", full_name: "Alice", email: "alice@student.pxl.be" });
  const rows = rosterBindings(r, [claim("alice-pxl", 111, "alice@student.pxl.be")]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].binding.state, BINDING_STATES.CLAIMED);
  assert.equal(rows[0].binding.login, "alice-pxl");
  assert.equal(rows[0].binding.verified, true);
});

test("the address match is case-insensitive, exactly as the claim gate is", () => {
  // accept.mjs matches with normalizeEmail in the other direction. If these two
  // ever disagree, a student claims successfully and then shows as unclaimed.
  const r = roster({ email: "Alice.Example@Student.PXL.be" });
  const rows = rosterBindings(r, [claim("alice-pxl", 111, "alice.example@student.pxl.be")]);
  assert.equal(rows[0].binding.state, BINDING_STATES.CLAIMED);

  // And the inverse direction, through the module that writes claims.
  assert.ok(rosterEntryForEmail(r, "ALICE.EXAMPLE@student.pxl.be"));
});

test("an unverified claim still binds, and says so", () => {
  // A typed address is a real binding - ARCHITECTURE §15 records nobody is locked
  // out - but the distinction is the whole point of the flag.
  const r = roster({ email: "bob@student.pxl.be" });
  const rows = rosterBindings(r, [claim("bob-pxl", 222, "bob@student.pxl.be", false)]);
  assert.equal(rows[0].binding.state, BINDING_STATES.CLAIMED);
  assert.equal(rows[0].binding.verified, false);
  assert.match(describeBinding(rows[0].binding), /unverified/);
});

// --- the states a lecturer acts on -------------------------------------------

test("a pre-linked roster entry is bound without a claim", () => {
  // Under `enforced` this IS the binding; under `claim` it is a lecturer who
  // filled the column in. Both can accept, so neither is "unclaimed".
  const rows = rosterBindings(roster({ email: "c@student.pxl.be", github_login: "carol" }), []);
  assert.equal(rows[0].binding.state, BINDING_STATES.ROSTER);
  assert.equal(rows[0].binding.login, "carol");
});

test("no email means the entry can NEVER be claimed, which is not the same as waiting", () => {
  // rosterEntryForEmail matches on email and nothing else, so this student
  // cannot bind however long they wait. The fix is a re-import, not patience -
  // and a column that called this "not claimed" would hide that.
  const rows = rosterBindings(roster({ student_number: "0999999", full_name: "Dave" }), []);
  assert.equal(rows[0].binding.state, BINDING_STATES.UNCLAIMABLE);
  assert.equal(describeBinding(rows[0].binding), "no email on roster");
});

test("an address nobody has claimed is unclaimed", () => {
  const rows = rosterBindings(roster({ email: "erin@student.pxl.be" }), []);
  assert.equal(rows[0].binding.state, BINDING_STATES.UNCLAIMED);
  assert.equal(describeBinding(rows[0].binding), "not claimed");
});

test("a claim disagreeing with the roster's own login is a CONFLICT, not a binding", () => {
  // First-come-wins makes this reachable: two students share a mailbox, or an
  // address is typed wrong. The claim governs acceptance, so it is reported as
  // the binding - but flagged, because this is the case `unlink` exists for and
  // silently showing "@bob-pxl" beside Alice's name is how it goes unnoticed.
  const r = roster({ full_name: "Alice", email: "alice@student.pxl.be", github_login: "alice-pxl" });
  const rows = rosterBindings(r, [claim("bob-pxl", 222, "alice@student.pxl.be")]);

  assert.equal(rows[0].binding.state, BINDING_STATES.CONFLICT);
  assert.equal(rows[0].binding.login, "bob-pxl", "the claim is what governs acceptance");
  assert.equal(rows[0].binding.rosterLogin, "alice-pxl", "and the roster's own answer is kept for the message");
  assert.match(describeBinding(rows[0].binding), /bob-pxl.*alice-pxl/);
});

test("a claim agreeing with the roster login is not a conflict, whatever the casing", () => {
  const r = roster({ email: "alice@student.pxl.be", github_login: "Alice-PXL" });
  const rows = rosterBindings(r, [claim("alice-pxl", 111, "alice@student.pxl.be")]);
  assert.equal(rows[0].binding.state, BINDING_STATES.CLAIMED);
});

// --- orphans and duplicates --------------------------------------------------

test("a claim matching no roster entry is an orphan, and is never deleted here", () => {
  // A student removed from the roster, or an address corrected in the CSV.
  // ARCHITECTURE §17: reported, never silently deleted.
  const r = roster({ email: "alice@student.pxl.be" });
  const orphans = orphanClaims(r, [
    claim("alice-pxl", 111, "alice@student.pxl.be"),
    claim("zoe-pxl", 999, "zoe@student.pxl.be"),
  ]);
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0].github_login, "zoe-pxl");
});

test("a claim with no address at all is an orphan rather than silently dropped", () => {
  assert.equal(orphanClaims(roster({ email: "a@student.pxl.be" }), [{ github_login: "x", github_id: 1 }]).length, 1);
});

test("two claims on one address are both kept and reported", () => {
  // accept.mjs refuses to create this (rejected:claim-taken), so it means a
  // hand-edited or restored file. Keeping whichever was read last would hide a
  // real fault behind a plausible answer.
  const dup = indexClaims([
    claim("alice-pxl", 111, "shared@student.pxl.be"),
    claim("bob-pxl", 222, "shared@student.pxl.be"),
  ]);
  assert.equal(dup.duplicates.length, 1);
  assert.equal(dup.duplicates[0].claims.length, 2);
  assert.equal(dup.byEmail.get("shared@student.pxl.be").github_login, "alice-pxl", "first wins, as acceptance does");
});

// --- summary -----------------------------------------------------------------

test("the summary counts a conflict as bound AND as a conflict", () => {
  // Bound, because that student can accept. Counted separately too, because
  // folding it into a healthy number is how a wrong binding stops being chased.
  const r = roster(
    { email: "a@student.pxl.be" },                              // unclaimed
    { email: "b@student.pxl.be", github_login: "bee" },         // pre-linked
    { email: "c@student.pxl.be", github_login: "cee" },         // conflict
    { full_name: "No Address" },                                // unclaimable
  );
  const s = claimSummary(r, [claim("someone-else", 333, "c@student.pxl.be")]);

  assert.equal(s.students, 4);
  assert.equal(s.claimed, 0);
  assert.equal(s.conflicts, 1);
  assert.equal(s.pre_linked, 1);
  assert.equal(s.unclaimed, 1);
  assert.equal(s.unclaimable, 1);
  assert.equal(s.bound, 2, "the conflict can still accept, so it counts as bound");
});

test("an empty roster and no claims is zeros, not a crash", () => {
  const s = claimSummary(null, null);
  assert.equal(s.students, 0);
  assert.equal(s.bound, 0);
  assert.equal(s.orphans, 0);
  assert.deepEqual(rosterBindings(undefined, undefined), []);
  assert.deepEqual(orphanClaims(undefined, undefined), []);
});

test("an array-shaped roster reads as empty rather than throwing", () => {
  // A hand-edited roster.yml that is a bare list parses fine and lets nobody
  // accept - accept.mjs reads `roster?.students || []`. The diagnostic reports
  // it; this module must not be the thing that crashes on it.
  assert.deepEqual(rosterBindings([{ email: "a@student.pxl.be" }], []), []);
});

// --- the rule may not fork ---------------------------------------------------

const walk = (dir, out = []) => {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".git" || entry === ".tools" || entry === ".claude") continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(mjs|js|vue)$/.test(entry)) out.push(p);
  }
  return out;
};

// Comments are stripped: the ones this change added quote the old shape by
// name, so a scan including them fails against its own explanation.
const codeOf = (p) =>
  readFileSync(p, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^\s*\/\/.*$/gm, "");

test("nothing joins claims to roster entries by hand", () => {
  // The tell is reaching into a claim's email to line it up with a roster.
  // accept.mjs is the one exemption: it does the join in the OTHER direction,
  // one student at a time, through rosterEntryForEmail - which is the writer's
  // own copy of the rule and the reason this module reuses normalizeEmail.
  const allowed = new Set([
    join(root, "lib", "claim-bindings.mjs"),
    join(root, "lib", "claim.mjs"),
    join(root, "acceptance", "accept.mjs"),
  ]);

  const offenders = walk(root)
    .filter((p) => !allowed.has(p) && !p.startsWith(join(root, "tests")))
    .filter((p) => {
      const src = codeOf(p);
      // The tell is reading the claim STORE - the directory or its path
      // helper - not merely mentioning a claim field. `cli/src/lib/control-repo.mjs`
      // fetches claims and fetches the roster and joins neither (transport),
      // and `report/report.mjs` reads `claim_verified` off an acceptance
      // record already keyed by login, which is not a join at all. Allowlisting
      // either would have been the start of a list that grows until the guard
      // means nothing; narrowing the tell keeps it sharp, because anything that
      // really does match claim records to roster entries has to enumerate the
      // store to get them.
      const readsClaims = /claimPath\(|students\/claims/.test(src);
      const readsRoster = /\.students\b|roster\.yml/.test(src);
      const joinsOnAddress = /\.email\b|normalizeEmail\(/.test(src);
      const imports = /claim-bindings/.test(src);
      return readsClaims && readsRoster && joinsOnAddress && !imports;
    })
    .map((p) => relative(root, p));

  assert.deepEqual(
    offenders,
    [],
    `these read claims and roster entries together without lib/claim-bindings.mjs:\n  ${offenders.join("\n  ")}`
  );
});
