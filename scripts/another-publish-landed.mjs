#!/usr/bin/env node
// Exit 0 when the assignment stored at FETCH_HEAD of the control checkout is
// another publish's work - published, with an invitation - and 1 otherwise.
//
// publish-assignment.yml asks it when its own save conflicted: two publishes
// at once that both minted an invitation conflict on its lines, either one is
// a working link (the broker is set to what landed afterwards,
// scripts/match-broker-invite.mjs), and the losing run went red over nothing.
// It then takes what landed. Anything else stays a failure.
//
//   node scripts/another-publish-landed.mjs <control-dir> <assignment-id>

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { assignmentPathsRead } from "../lib/control-layout.mjs";
import { anotherPublishLanded } from "./match-broker-invite.mjs";

export function main([dir, id] = process.argv.slice(2)) {
  if (!dir || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(id ?? "")) {
    console.log("usage: another-publish-landed.mjs <control-dir> <assignment-id>");
    return 1;
  }
  for (const path of assignmentPathsRead(id)) {
    const r = spawnSync("git", ["-C", dir, "show", `FETCH_HEAD:${path}`], { encoding: "utf8" });
    if (r.status === 0) return anotherPublishLanded(r.stdout, path) ? 0 : 1;
  }
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
