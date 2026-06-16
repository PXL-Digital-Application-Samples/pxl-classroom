import { readFileSync } from "node:fs";
import { parse } from "yaml";

const orgLogin = process.argv[2];
if (!orgLogin) {
  console.error("Usage: node get-budget-owner.mjs <org-login>");
  process.exit(2);
}

function readText(path) {
  const buf = readFileSync(path);
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.toString("utf16le").replace(/^﻿/, "");
  if (buf[0] === 0xfe && buf[1] === 0xff) return buf.swap16().toString("utf16le").replace(/^﻿/, "");
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString("utf8");
  return buf.toString("utf8");
}

try {
  const o = parse(readText("participating-orgs.yml"));
  const entry = (o.orgs || []).find(x => x.login === orgLogin);
  process.stdout.write(entry?.budget_owner_login || "");
} catch {
  process.stdout.write("");
}
