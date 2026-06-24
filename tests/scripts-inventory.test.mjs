import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

function findFiles(dir, filter) {
  let res = [];
  try {
    const items = readdirSync(dir);
    for (const item of items) {
      if (item === "node_modules" || item === ".git") continue;
      const fullPath = join(dir, item);
      if (statSync(fullPath).isDirectory()) {
        res = res.concat(findFiles(fullPath, filter));
      } else if (filter(fullPath, item)) {
        res.push(fullPath);
      }
    }
  } catch (e) {}
  return res;
}

test("every script in scripts/*.mjs is referenced somewhere", () => {
  const scriptsDir = join(root, "scripts");
  const scriptsFullPath = findFiles(scriptsDir, (fp, item) => item.endsWith(".mjs"));
  
  // List of script names relative to scripts dir, e.g. "find-finalizable.mjs" or "lib/encoding.mjs"
  const scriptsToFind = scriptsFullPath.map(fp => fp.slice(scriptsDir.length + 1).replace(/\\/g, '/'));

  // Files to look in
  const workflows = findFiles(join(root, ".github", "workflows"), (fp, item) => item.endsWith(".yml"));
  const actionFiles = findFiles(root, (fp, item) => item === "action.yml");
  const packageJson = [join(root, "package.json")];
  // all other .mjs scripts in the repo, including the ones in scripts (they might import each other)
  const allMjs = findFiles(root, (fp, item) => item.endsWith(".mjs") && !fp.includes("node_modules"));

  const allFilesToCheck = [...workflows, ...actionFiles, ...packageJson, ...allMjs];
  
  const orphaned = [];
  for (const scriptPathRel of scriptsToFind) {
    const scriptBaseName = scriptPathRel.split('/').pop();
    let found = false;
    for (const f of allFilesToCheck) {
      // Don't count the script itself as referencing itself, unless it actually does,
      // but to be safe, we just skip checking the file against itself if we want to be strict.
      // But it's fine, if a script only contains its own name inside a console.log, we'd rather not count it.
      if (f === join(scriptsDir, scriptPathRel)) continue;

      try {
        const content = readFileSync(f, "utf8");
        // A simple string include is fine, e.g. "update-json-field.mjs" or "encoding.mjs"
        if (content.includes(scriptBaseName)) {
          found = true;
          break;
        }
      } catch (e) {}
    }
    if (!found) {
      orphaned.push(scriptPathRel);
    }
  }
  
  assert.deepEqual(orphaned, [], `Orphaned scripts found: \${orphaned.join(", ")}`);
});
