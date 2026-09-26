#!/usr/bin/env node
// Record whether the deadline sentinel's STOP held, on the timelines it wrote.
//
// scripts/deadline-sentinel.mjs writes its timelines before the "Stop writes"
// step runs, with `stop: "pending"`, and the step can fail or be skipped (the
// pull before it failed). A timeline that only said "fired" was read as
// "writes stopped at the instant" either way, and lockdown credited that
// instant for writes nobody stopped (third review, 2026-09-26). This sets
// `done` or `failed` on the timelines THIS run wrote - matched by its own run
// URL, never every pending one, so an older run's timeline is not relabelled.
//
//   DATA_DIR=control RESULT=done|failed node scripts/mark-sentinel-stop.mjs
//
// Exits 0 whatever it finds: the commit step after it must still run.

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const env = (k, d = "") => process.env[k] ?? d;
const dataDir = env("DATA_DIR", "control");
const result = env("RESULT");
// Spelled exactly as scripts/deadline-sentinel.mjs spells `observer_run`.
const runUrl = `${env("GITHUB_SERVER_URL", "https://github.com")}/${env("GITHUB_REPOSITORY", "_")}` +
  `/actions/runs/${env("GITHUB_RUN_ID", "0")}`;

async function main() {
  if (result !== "done" && result !== "failed") {
    console.log(`mark-sentinel-stop: RESULT must be done or failed, got "${result}" - nothing marked`);
    return;
  }
  const root = join(dataDir, "lockdowns");
  const ids = await readdir(root).catch(() => []);
  let marked = 0;
  for (const id of ids) {
    const names = await readdir(join(root, id)).catch(() => []);
    for (const name of names.filter((n) => /^sentinel-.*\.json$/.test(n))) {
      const path = join(root, id, name);
      let doc;
      try {
        doc = JSON.parse(await readFile(path, "utf8"));
      } catch {
        continue;
      }
      if (doc?.stop !== "pending" || doc?.observer_run !== runUrl) continue;
      doc.stop = result;
      await writeFile(path, JSON.stringify(doc, null, 2) + "\n");
      marked++;
      console.log(`mark-sentinel-stop: ${id}/${name} -> ${result}`);
    }
  }
  if (!marked) console.log("mark-sentinel-stop: no pending timeline from this run");
}

main().catch((e) => {
  console.log(`mark-sentinel-stop: skipped (${e.message})`);
});
