#!/usr/bin/env node
// PXL Classroom - privacy guard for published GitHub Pages output.
//
// On GitHub Team, every Pages site is PUBLIC. This scanner enforces that the
// generated/published files contain only public assignment metadata - no
// roster, no per-student private data, no tokens. Run it in CI on the Pages
// output before publishing; non-zero exit blocks the deploy.
//
// Usage:
//   node scan.mjs              # scans SCAN_DIR env var (default: "public")
//   node scan.mjs <dir>        # scans the given directory
//
// No npm deps (Node 18+).

import { readFile, readdir, stat } from "node:fs/promises";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";

import { PUBLIC_TEXT_RULES } from "../lib/public-text.mjs";

const RULES = [
  // Anything a lecturer can type into a field that gets published - an email
  // address, a credential, the invitation wire shape - comes from
  // lib/public-text.mjs, which AdminView and pages/generate.mjs use too. That
  // way a value this scanner would reject is refused where it can still be
  // fixed, instead of failing an org's whole Pages build three workflows later
  // with a message naming a digest.
  //
  // A signed invitation is a capability: anyone holding it can accept. It lives
  // in the PRIVATE control repo and reaches Pages only as a sha256 FILENAME, so
  // finding one in the body of a world-readable artifact means the generator
  // just handed every visitor a working link.
  ...PUBLIC_TEXT_RULES,

  // File-shaped rules. These match JSON field NAMES, so they only mean anything
  // against generated output - never against a free-text field.
  //
  // Both legacy (v1) and current (v2) roster field names: the scanner is a
  // publish gate, and keeping both keeps it defensive against leftover legacy
  // data in archived control repos.
  { name: "institutional-id-field", re: /"(student_id|student_number)"\s*:/g },
  // Repointed 2026-08-27. This guarded `"claim_token"`, a field name that
  // appeared nowhere else in the repository - vestigial from a design that was
  // never built, so it could never have fired. The claim feature that did ship
  // writes `students/claims/<github_id>.json` holding an `email` and a
  // `claim_verified` flag, and that record is PRIVATE: it must never reach
  // Pages. The address itself is already covered by the `email-address` rule in
  // PUBLIC_TEXT_RULES, which matches content rather than field names; this one
  // catches the record's own shape, so a whole claim file copied into a public
  // artefact fails the gate even if the address inside it somehow did not.
  { name: "claim-record-field", re: /"(claim_verified|claimed_via|claimed_at)"\s*:/g },
  { name: "roster-field", re: /"(display_name|full_name|class_group|institutional_id)"\s*:/g },
  // A student's REAL NAME, taken from the git author of their commits and
  // propagated into reports (report.mjs -> report.schema.json). It was guarded
  // by nothing.
  //
  // The `email-address` content rule in PUBLIC_TEXT_RULES catches an address
  // wherever it appears, so `author_email` and `claimed_email` VALUES were
  // already covered - but no content rule can recognise an arbitrary human
  // name, so `author_name` had neither a field guard nor a value guard. The
  // field names go here alongside it: a whole record copied into a public
  // artefact then fails the gate on its shape, even when the values inside it
  // happen to look innocuous.
  { name: "identity-field", re: /"(author_name|author_email|claimed_email|email)"\s*:/g },
  { name: "github-app-key", re: /\bv[0-9]+\.[0-9a-f]{40}\b/g },
  { name: "jwt-token", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./g },
];

async function* walk(p) {
  const s = await stat(p);
  if (s.isDirectory()) {
    for (const e of await readdir(p)) yield* walk(join(p, e));
  } else yield p;
}

async function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT)
    await appendFile(process.env.GITHUB_OUTPUT, `${name}=${value ?? ""}\n`);
}

/**
 * Scan a directory tree and report what it found - INCLUDING what it could not
 * read.
 *
 * Separated from main() and given an injectable `read` so the fail-closed path
 * has a test. Making a file genuinely unreadable is not portable (chmod is a
 * no-op on Windows and for root in CI), and the alternative - a test-only env
 * var inside the scanner - would put a backdoor in the one gate standing
 * between the private control repo and a world-readable site.
 *
 * @param {string} scanDir
 * @param {{ read?: (path: string) => Promise<string> }} [opts]
 * @returns {Promise<{findings: number, filesScanned: number, unreadable: string[]}>}
 */
export async function scanTree(scanDir, { read = (p) => readFile(p, "utf8") } = {}) {
  let findings = 0;
  let filesScanned = 0;
  const unreadable = [];

  for await (const file of walk(scanDir)) {
    filesScanned++;

    // AN UNREADABLE FILE IS NOT A CLEAN FILE.
    //
    // This was `readFile(...).catch(() => "")`, so a file the scanner could not
    // open contributed no findings, counted toward `filesScanned`, and the run
    // reported `clean - N file(s) scanned, no private data found; safe to
    // publish`. That is the one place in the system where failing open
    // publishes something: this gate is what stands between the private control
    // repo and a world-readable Pages site. Unreadable is not evidence.
    let text;
    try {
      text = await read(file);
    } catch (err) {
      unreadable.push(`${file}: ${err.message}`);
      continue;
    }

    for (const rule of RULES) {
      // Fresh regex per file. The rules are shared module-level literals
      // carrying /g, and `lastIndex` left behind by any `.test()` elsewhere in
      // the process would make matchAll start mid-string - a gate that "catches
      // it sometimes". lib/public-text.mjs documents the same hazard.
      const re = new RegExp(rule.re.source, rule.re.flags);
      for (const m of text.matchAll(re)) {
        if (rule.allow && rule.allow.test(m[0])) continue;
        findings++;
        const snippet =
          m[0].length > 40 ? m[0].slice(0, 37) + "..." : m[0];
        console.log(`LEAK  ${file}  [${rule.name}]  ${snippet}`);
      }
    }
  }

  return { findings, filesScanned, unreadable };
}

async function main() {
  const scanDir = process.argv[2] || process.env.SCAN_DIR || "public";
  const { findings, filesScanned, unreadable } = await scanTree(scanDir);

  if (unreadable.length) {
    for (const line of unreadable) console.log(`UNREADABLE  ${line}`);
    console.error(
      `\n${unreadable.length} file(s) in ${scanDir} could not be read, so nothing is known about them - publishing BLOCKED.`
    );
    await setOutput("scan_result", "blocked");
    process.exit(1);
  }

  if (findings) {
    console.error(
      `\n${findings} privacy violation(s) in ${filesScanned} file(s) - publishing BLOCKED.`
    );
    await setOutput("scan_result", "blocked");
    process.exit(1);
  }

  console.log(
    `clean - ${filesScanned} file(s) scanned, no private data found; safe to publish.`
  );
  await setOutput("scan_result", "clean");
}

// Only when run as the CLI the workflow invokes. Guarded so tests can import
// scanTree() without the module exiting the process on them - the same idiom
// scripts/lint-undeclared-classes.mjs uses.
if (process.argv[1] && process.argv[1].endsWith("scan.mjs")) {
  main().catch((e) => {
    console.error(`[FAIL] ${e.message}`);
    process.exit(1);
  });
}
