#!/usr/bin/env node
// PXL Classroom — privacy guard for published GitHub Pages output.
//
// On GitHub Team, every Pages site is PUBLIC. This scanner enforces that the
// generated/published files contain only public assignment metadata — no
// roster, no per-student private data, no tokens. Run it in CI on the Pages
// output before publishing; non-zero exit blocks the deploy.
//
// Adapted from spikes/06-pages-privacy/scan.mjs (Spike 6 — PASS).
//
// Usage:
//   node scan.mjs              # scans SCAN_DIR env var (default: "public")
//   node scan.mjs <dir>        # scans the given directory
//
// No npm deps (Node 18+).

import { readFile, readdir, stat } from "node:fs/promises";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";

const RULES = [
  // Character class matches the format used by classic tokens AND the new
  // stateless installation token format that may include `_` in the body
  // (GitHub Changelog, 2025-Q4 rollout). No upper length bound — new ghs_
  // tokens can be ~520 chars and still match.
  { name: "github-token", re: /\bgh[posu]_[A-Za-z0-9_]{20,}\b/g },
  { name: "github-fine-grained-pat", re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { name: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { name: "email-address", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, allow: /@users\.noreply\.github\.com$/ },
  // Match both legacy (v1) and current (v2) roster field names. The scanner is a
  // publish gate — keeping both keeps it defensive against any leftover legacy
  // data in archived control repos.
  { name: "institutional-id-field", re: /"(student_id|student_number)"\s*:/g },
  { name: "claim-token-field", re: /"claim_token"\s*:/g },
  { name: "roster-field", re: /"(display_name|full_name|class_group|institutional_id)"\s*:/g },
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

async function main() {
  const scanDir = process.argv[2] || process.env.SCAN_DIR || "public";

  let findings = 0;
  let filesScanned = 0;

  for await (const file of walk(scanDir)) {
    filesScanned++;
    const text = await readFile(file, "utf8").catch(() => "");
    for (const rule of RULES) {
      for (const m of text.matchAll(rule.re)) {
        if (rule.allow && rule.allow.test(m[0])) continue;
        findings++;
        const snippet =
          m[0].length > 40 ? m[0].slice(0, 37) + "..." : m[0];
        console.log(`LEAK  ${file}  [${rule.name}]  ${snippet}`);
      }
    }
  }

  if (findings) {
    console.error(
      `\n${findings} privacy violation(s) in ${filesScanned} file(s) — publishing BLOCKED.`
    );
    await setOutput("scan_result", "blocked");
    process.exit(1);
  }

  console.log(
    `clean — ${filesScanned} file(s) scanned, no private data found; safe to publish.`
  );
  await setOutput("scan_result", "clean");
}

main().catch((e) => {
  console.error(`[FAIL] ${e.message}`);
  process.exit(1);
});
