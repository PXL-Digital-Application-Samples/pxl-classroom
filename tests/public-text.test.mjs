// An assignment's title and description are published on a public page, so
// pages/scan.mjs blocks a publish that carries an email address in one. It does
// its job. The problem was everything after the block:
//
//   the scanner runs over GENERATED output, so the message named
//   public/i/<64 hex>.json and a rule id
//   the `pages` action exited 1, which failed the org's whole dashboard
//   regeneration, and deploy-pages (if: always()) redeployed stale data
//   the Admin Panel had accepted the sentence without a word
//
// "Questions? Mail me at <address>" is an ordinary thing for a lecturer to
// type. It is now refused where it can be fixed, and both later surfaces name
// the assignment and the field.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import { findPublicTextViolation, publicTextMessage, PUBLIC_TEXT_RULES } from "../lib/public-text.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

// --- What it catches --------------------------------------------------------

test("an email address in a description is caught", () => {
  const v = findPublicTextViolation("Questions? Mail tom.cool@pxl.be or open an issue.");
  assert.ok(v, "the sentence that started this");
  assert.equal(v.name, "email-address");
  assert.equal(v.match, "tom.cool@pxl.be");
});

test("credentials and invitation tokens are caught too", () => {
  const cases = [
    ["ghp_" + "a".repeat(36), "github-token"],
    ["github_pat_" + "b".repeat(30), "github-fine-grained-pat"],
    ["-----BEGIN RSA PRIVATE KEY-----", "private-key"],
    [`${"A".repeat(35)}.${"B".repeat(86)}`, "invitation-token"],
  ];
  for (const [text, expected] of cases) {
    const v = findPublicTextViolation(`see ${text} here`);
    assert.ok(v, `expected a violation for ${expected}`);
    assert.equal(v.name, expected);
  }
});

test("a noreply address is allowed, because it is already public", () => {
  assert.equal(findPublicTextViolation("bot@users.noreply.github.com committed this"), null);
});

// --- What it must NOT catch -------------------------------------------------

test("ordinary lecturer prose passes", () => {
  const fine = [
    "Implement a process scheduler. Deadline is strict.",
    "Zie Toledo voor de opgave. Vragen? Stel ze in het forum.",
    "Use `git push origin main` and tag v1.0.0 when done.",
    "Score: 20/20. Weight 1.5. See chapter 3.2.",
    "Repo naming: linux-processes-{github_login}",
    "Read https://docs.github.com/en/actions for details.",
    "",
  ];
  for (const text of fine) {
    assert.equal(findPublicTextViolation(text), null, `false positive on: ${text}`);
  }
});

test("non-strings and empty values are not violations", () => {
  for (const input of [null, undefined, 0, {}, [], false, ""]) {
    assert.equal(findPublicTextViolation(input), null, `${JSON.stringify(input)}`);
  }
});

// --- Statefulness: the /g trap ---------------------------------------------

test("repeated calls give the same answer", () => {
  // The rule regexes carry /g, so a lastIndex left over from a previous call
  // would make the next one skip the start of the string - the check would
  // "sometimes" catch it, which is worse than not catching it.
  const text = "mail tom.cool@pxl.be";
  for (let i = 0; i < 5; i++) {
    const v = findPublicTextViolation(text);
    assert.ok(v, `call ${i + 1} must still catch it`);
    assert.equal(v.match, "tom.cool@pxl.be");
  }
});

test("the first violation is reported, deterministically", () => {
  const v1 = findPublicTextViolation("a@b.com and ghp_" + "c".repeat(36));
  const v2 = findPublicTextViolation("a@b.com and ghp_" + "c".repeat(36));
  assert.deepEqual(v1, v2);
});

// --- The message is something a lecturer can act on -------------------------

test("the message names the field, what was found, and what to do", () => {
  const v = findPublicTextViolation("mail tom.cool@pxl.be");
  const msg = publicTextMessage("description", v);
  assert.match(msg, /description/, "names the field");
  assert.match(msg, /tom\.cool@pxl\.be/, "quotes what it found");
  assert.match(msg, /public/, "says why");
  assert.match(msg, /Toledo|Canvas|issue tracker/, "offers an alternative");
});

// --- One rule set, three surfaces -------------------------------------------

test("the scanner, the generator and the editor share one rule set", () => {
  const scan = readFileSync(join(root, "pages", "scan.mjs"), "utf8");
  const generate = readFileSync(join(root, "pages", "generate.mjs"), "utf8");
  const admin = readFileSync(join(root, "frontend", "src", "views", "AdminView.vue"), "utf8");

  assert.match(scan, /PUBLIC_TEXT_RULES/, "scan.mjs must use the shared rules");
  assert.match(generate, /findPublicTextViolation/, "generate.mjs must check before it writes");
  assert.match(admin, /findPublicTextViolation/, "the editor must refuse it at authoring time");

  // And the scanner must not have grown a private copy back.
  assert.ok(
    !/name: "email-address"/.test(scan),
    "scan.mjs must not redeclare a free-text rule it imports"
  );
});

test("the scanner still blocks what it always blocked", () => {
  // The refactor moved rules; it must not have dropped any.
  const names = new Set(PUBLIC_TEXT_RULES.map((r) => r.name));
  for (const required of ["email-address", "invitation-token", "github-token", "private-key"]) {
    assert.ok(names.has(required), `${required} must still be a rule`);
  }

  const dir = mkdtempSync(join(tmpdir(), "pxl-scan-"));
  writeFileSync(join(dir, "card.json"), JSON.stringify({ description: "mail me at a@b.be" }));
  assert.throws(
    () => execFileSync(process.execPath, [join(root, "pages", "scan.mjs"), dir], { stdio: "pipe" }),
    "the scanner must exit non-zero"
  );

  const clean = mkdtempSync(join(tmpdir(), "pxl-scan-ok-"));
  writeFileSync(join(clean, "card.json"), JSON.stringify({ description: "See Toledo." }));
  execFileSync(process.execPath, [join(root, "pages", "scan.mjs"), clean], { stdio: "pipe" });
});

// --- The generator names the assignment, not a digest ----------------------

test("the generator fails with the assignment and the field, before writing a card", () => {
  const dir = mkdtempSync(join(tmpdir(), "pxl-gen-"));
  mkdirSync(join(dir, "assignments"), { recursive: true });
  writeFileSync(
    join(dir, "assignments", "linux-2026.yml"),
    [
      "schema_version: 1",
      "id: linux-2026",
      "title: Linux Processes",
      "description: Questions? Mail tom.cool@pxl.be",
      "state: published",
      "organization: PXLAutomation",
    ].join("\n") + "\n"
  );

  let stderr = "";
  assert.throws(() => {
    try {
      execFileSync(process.execPath, [join(root, "pages", "generate.mjs")], {
        env: { ...process.env, DATA_DIR: dir, OUTPUT_DIR: join(dir, "public") },
        stdio: "pipe",
      });
    } catch (e) {
      stderr = String(e.stderr || "") + String(e.stdout || "");
      throw e;
    }
  });

  assert.match(stderr, /linux-2026\.yml/, "it must name the assignment file");
  assert.match(stderr, /description/, "and the field");
  assert.match(stderr, /tom\.cool@pxl\.be/, "and what it found");
  assert.ok(
    !/[0-9a-f]{64}\.json/.test(stderr),
    "and must not report a digest-named file the lecturer has never seen"
  );
});

test("a clean assignment still generates", () => {
  const dir = mkdtempSync(join(tmpdir(), "pxl-gen-ok-"));
  mkdirSync(join(dir, "assignments"), { recursive: true });
  writeFileSync(
    join(dir, "assignments", "linux-2026.yml"),
    [
      "schema_version: 1",
      "id: linux-2026",
      "title: Linux Processes",
      "description: See Toledo for the assignment brief.",
      "state: published",
      "organization: PXLAutomation",
    ].join("\n") + "\n"
  );
  execFileSync(process.execPath, [join(root, "pages", "generate.mjs")], {
    env: { ...process.env, DATA_DIR: dir, OUTPUT_DIR: join(dir, "public") },
    stdio: "pipe",
  });
  const out = JSON.parse(readFileSync(join(dir, "public", "assignments.json"), "utf8"));
  assert.ok(out.assignments["linux-2026"], "the assignment must be published");
});
