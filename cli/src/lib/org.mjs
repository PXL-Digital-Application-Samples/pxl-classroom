// PXL Classroom CLI — resolveOrg helper.

import { loadConfig, saveConfig } from "./config.mjs";

export function resolveOrg(flag) {
  const org = flag || loadConfig().last_org;
  if (!org) {
    throw new Error(
      "no --org and no last-used org in config. Pass `--org <login>` (the value is remembered).",
    );
  }
  if (flag) {
    saveConfig({ last_org: flag });
  } else {
    process.stderr.write(`org: ${org} (last used — pass --org to override)\n`);
  }
  return org;
}
