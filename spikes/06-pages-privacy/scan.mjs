#!/usr/bin/env node
// PXL Classroom — Spike 6: privacy guard for published GitHub Pages output.
//
// On GitHub Team, every Pages site is PUBLIC. This scanner enforces that the
// generated/published files contain only public assignment metadata — no
// roster, no per-student private data, no tokens. Run it in CI on the Pages
// output before publishing; non-zero exit blocks the deploy.
//
//   node scan.mjs <file-or-dir> [...]
//
// No npm deps (Node 18+).

import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

const RULES = [
  { name: "github-token", re: /\bgh[posu]_[A-Za-z0-9]{20,}\b/g },
  { name: "github-fine-grained-pat", re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { name: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { name: "email-address", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { name: "institutional-id-field", re: /"student_id"\s*:/g },
  { name: "claim-token-field", re: /"claim_token"\s*:/g },
  { name: "roster-field", re: /"(display_name|class_group|institutional_id)"\s*:/g },
];

async function* walk(p) {
  const s = await stat(p);
  if (s.isDirectory()) { for (const e of await readdir(p)) yield* walk(join(p, e)); }
  else yield p;
}

let findings = 0;
for (const arg of process.argv.slice(2)) {
  for await (const file of walk(arg)) {
    const text = await readFile(file, "utf8").catch(() => "");
    for (const rule of RULES) {
      for (const m of text.matchAll(rule.re)) {
        findings++;
        const snippet = m[0].length > 40 ? m[0].slice(0, 37) + "..." : m[0];
        console.log(`LEAK  ${file}  [${rule.name}]  ${snippet}`);
      }
    }
  }
}

if (findings) { console.error(`\n${findings} privacy violation(s) — publishing BLOCKED.`); process.exit(1); }
console.log("clean — no private data found; safe to publish.");
