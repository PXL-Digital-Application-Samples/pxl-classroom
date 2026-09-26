// scripts/link-claims.mjs, run rather than described.
//
// The nightly folds GitHub-verified claims into the roster so a lecturer has no
// step to find. Everything about that is only safe because of what it REFUSES
// to touch, so this drives the real script against a real directory and checks
// the refusals - a plan function returning the right shape is not the same as a
// script writing the right file.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { parse as yamlParse } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "..", "scripts", "link-claims.mjs");

const claim = (login, id, email, over = {}) => ({
  schema_version: 1,
  github_login: login,
  github_id: id,
  email,
  domain_allowed: true,
  claim_verified: true,
  student_number: null,
  claimed_at: "2026-09-01T10:00:00.000Z",
  ...over,
});

/** A control-repo checkout with a roster and some claims. */
function control({ students, claims = [] }) {
  const dir = mkdtempSync(join(tmpdir(), "pxl-link-claims-"));
  mkdirSync(join(dir, "students", "claims"), { recursive: true });
  writeFileSync(
    join(dir, "students", "roster.yml"),
    `schema_version: 2\nstudents:\n` +
      students
        .map((s) =>
          `  - email: ${s.email}\n    full_name: ${s.full_name}\n    active: true\n` +
          (s.github_login ? `    github_login: ${s.github_login}\n` : ""))
        .join(""),
  );
  for (const c of claims) {
    writeFileSync(join(dir, "students", "claims", `${c.github_id}.json`), JSON.stringify(c));
  }
  return dir;
}

function run(dir, ...extra) {
  const res = spawnSync(process.execPath, [script, "--data-dir", dir, ...extra], { encoding: "utf8" });
  assert.equal(res.status, 0, `the script must never fail the nightly:\n${res.stderr}`);
  return res.stdout;
}

const rosterOf = (dir) => yamlParse(readFileSync(join(dir, "students", "roster.yml"), "utf8"));

test("a GitHub-verified claim is folded into the roster", () => {
  const dir = control({
    students: [{ email: "alice@student.pxl.be", full_name: "Alice" }],
    claims: [claim("alice-pxl", 111, "alice@student.pxl.be")],
  });

  const out = run(dir);
  assert.match(out, /changed 1 roster row/);

  const [alice] = rosterOf(dir).students;
  assert.equal(alice.github_login, "alice-pxl");
  assert.equal(alice.github_id, 111);
  assert.equal(alice.full_name, "Alice", "the columns the lecturer imported survive");
});

test("a TYPED address is held, and the roster is left alone", () => {
  // The whole reason this is safe to run unattended. claim_verified is false
  // when the student typed an address rather than confirming one GitHub had
  // verified, and lib/claim.mjs says what that is worth: "Someone with a shared
  // link and a made-up address is always false."
  const dir = control({
    students: [{ email: "bram@student.pxl.be", full_name: "Bram" }],
    claims: [claim("mallory", 222, "bram@student.pxl.be", { claim_verified: false })],
  });

  const out = run(dir);
  assert.doesNotMatch(out, /changed \d+ roster row/);
  assert.match(out, /typed by the student/, "and it says why, and where to act");
  assert.equal(rosterOf(dir).students[0].github_login ?? null, null);
});

test("a claim naming a different account than the roster holds is left alone", () => {
  const dir = control({
    students: [{ email: "cara@student.pxl.be", full_name: "Cara", github_login: "cara-old" }],
    claims: [claim("cara-new", 333, "cara@student.pxl.be")],
  });

  run(dir);
  assert.equal(
    rosterOf(dir).students[0].github_login,
    "cara-old",
    "resolving a conflict is a decision, and there is nobody here to make it",
  );
});

test("an address two accounts claim is left alone", () => {
  const dir = control({
    students: [{ email: "dup@student.pxl.be", full_name: "Dup" }],
    claims: [claim("one", 1, "dup@student.pxl.be"), claim("two", 2, "dup@student.pxl.be")],
  });

  run(dir);
  assert.equal(rosterOf(dir).students[0].github_login ?? null, null, "picking a winner silently is the bug");
});

test("--dry-run writes nothing at all", () => {
  // CLAUDE.md: dry-run is sacred. Byte-identical, not merely "looks the same".
  const dir = control({
    students: [{ email: "alice@student.pxl.be", full_name: "Alice" }],
    claims: [claim("alice-pxl", 111, "alice@student.pxl.be")],
  });
  const before = readFileSync(join(dir, "students", "roster.yml"), "utf8");

  const out = run(dir, "--dry-run");
  assert.match(out, /would change 1 roster row/, "and it still reports what it would do");
  assert.equal(readFileSync(join(dir, "students", "roster.yml"), "utf8"), before);
});

test("running it twice changes nothing the second time", () => {
  // It runs every night. A second pass that keeps rewriting the file would
  // commit noise for ever.
  const dir = control({
    students: [{ email: "alice@student.pxl.be", full_name: "Alice" }],
    claims: [claim("alice-pxl", 111, "alice@student.pxl.be")],
  });

  run(dir);
  const afterFirst = readFileSync(join(dir, "students", "roster.yml"), "utf8");
  const out = run(dir);
  assert.equal(readFileSync(join(dir, "students", "roster.yml"), "utf8"), afterFirst);
  assert.doesNotMatch(out, /changed \d+ roster row/);
  assert.match(out, /nothing to link/, "the negative above is not vacuous: this is what it says instead");
});

// --- rows that gain an ADDRESS, and rows that follow a re-confirmation --------

/** A roster whose rows carry a login and whatever address fields are given. */
function controlRaw({ rosterYaml, claims = [] }) {
  const dir = mkdtempSync(join(tmpdir(), "pxl-link-claims-"));
  mkdirSync(join(dir, "students", "claims"), { recursive: true });
  writeFileSync(join(dir, "students", "roster.yml"), rosterYaml);
  for (const c of claims) writeFileSync(join(dir, "students", "claims", `${c.github_id}.json`), JSON.stringify(c));
  return dir;
}

test("THE LATENT ONE: a row with a login and no address GAINS it - the nightly used to compute it and write nothing", () => {
  const dir = controlRaw({
    rosterYaml: "schema_version: 2\nstudents:\n  - github_login: kim-pxl\n    github_id: 77\n    active: true\n",
    claims: [claim("kim-pxl", 77, "kim.peeters@student.pxl.be")],
  });
  const out = run(dir);
  assert.match(out, /changed 1 roster row/);
  assert.equal(rosterOf(dir).students[0].email, "kim.peeters@student.pxl.be");
});

test("RE-CONFIRMED: a row whose address came from the OLD confirmation follows the student to the new one", () => {
  const dir = controlRaw({
    rosterYaml: "schema_version: 2\nstudents:\n  - github_login: kim-pxl\n    github_id: 77\n    email: 12345678@student.pxl.be\n    email_source: claim\n    active: true\n",
    claims: [claim("kim-pxl", 77, "kim.peeters@student.pxl.be", {
      replaces: { email: "12345678@student.pxl.be", claimed_at: "2026-09-10T08:00:00.000Z" },
    })],
  });
  const out = run(dir);
  assert.match(out, /12345678@student\.pxl\.be -> kim\.peeters@student\.pxl\.be \(confirmed again\)/);
  const [row] = rosterOf(dir).students;
  assert.equal(row.email, "kim.peeters@student.pxl.be");
  assert.equal(row.email_source, "claim");
  assert.equal("previous_email" in row, false, "the report's field never reaches the roster");
});

test("RE-CONFIRMED, but a PERSON set the old address: held, never overwritten", () => {
  const dir = controlRaw({
    rosterYaml: "schema_version: 2\nstudents:\n  - github_login: kim-pxl\n    github_id: 77\n    email: 12345678@student.pxl.be\n    active: true\n",
    claims: [claim("kim-pxl", 77, "kim.peeters@student.pxl.be", {
      replaces: { email: "12345678@student.pxl.be", claimed_at: "2026-09-10T08:00:00.000Z" },
    })],
  });
  const out = run(dir);
  assert.match(out, /kept the old one: 12345678@student\.pxl\.be -> kim\.peeters@student\.pxl\.be \(the current address was set by a person/);
  assert.equal(rosterOf(dir).students[0].email, "12345678@student.pxl.be");
});

test("RE-CONFIRMED, but the new address was only TYPED: the unattended nightly holds it", () => {
  const dir = controlRaw({
    rosterYaml: "schema_version: 2\nstudents:\n  - github_login: kim-pxl\n    github_id: 77\n    email: 12345678@student.pxl.be\n    email_source: claim\n    active: true\n",
    claims: [claim("kim-pxl", 77, "kim.peeters@student.pxl.be", {
      claim_verified: false,
      replaces: { email: "12345678@student.pxl.be", claimed_at: "2026-09-10T08:00:00.000Z" },
    })],
  });
  const out = run(dir);
  assert.match(out, /typed, not verified by GitHub/);
  assert.equal(rosterOf(dir).students[0].email, "12345678@student.pxl.be");
});

test("no roster, no claims, and an unreadable claim are all survivable", () => {
  // This runs inside the nightly, whose job is collection and reporting. None
  // of that may go red because one JSON file is broken.
  const empty = mkdtempSync(join(tmpdir(), "pxl-link-claims-empty-"));
  assert.match(run(empty), /no roster/);

  const noClaims = control({ students: [{ email: "a@b.c", full_name: "A" }] });
  assert.match(run(noClaims), /no claims recorded/);

  const broken = control({
    students: [{ email: "alice@student.pxl.be", full_name: "Alice" }],
    claims: [claim("alice-pxl", 111, "alice@student.pxl.be")],
  });
  writeFileSync(join(broken, "students", "claims", "999.json"), "{ not json");
  const out = run(broken);
  assert.match(out, /could not be read/, "it says which file, rather than going quiet");
  assert.equal(rosterOf(broken).students[0].github_login, "alice-pxl", "and the others are still linked");
});
