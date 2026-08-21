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
      if (item === "node_modules" || item === ".git" || item === "dist") continue;
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

test("every .vue file under frontend/src has useRoute imported when referencing route variable", () => {
  const viewsDir = join(root, "frontend", "src");
  const vueFiles = findFiles(viewsDir, (fp, item) => item.endsWith(".vue"));

  const errors = [];

  for (const file of vueFiles) {
    const content = readFileSync(file, "utf8");
    
    // We check if the file references 'route.' or 'route ' or 'route,' or similar route usage
    // but excludes files that do not mention route at all.
    // Also, if the file uses 'route' as a local/reactive variable, it MUST import useRoute.
    const hasRouteUsage = /\broute\b/.test(content);
    const importsUseRoute = /import\s+{[^}]*useRoute[^}]*}\s+from\s+['"]vue-router['"]/.test(content) ||
                          /import\s+useRoute\s+from\s+['"]vue-router['"]/.test(content);
    const definesRoute = /const\s+route\s+=\s+useRoute\(\)/.test(content);

    // If it references 'route' but doesn't define/import it, and it doesn't get it from props or setup params
    // Vue template allows 'route' if using router-link or other elements, but inside setup scripts, using 'route' requires defining it.
    // Let's check specifically for script setup blocks using route without definition.
    const scriptSetupMatch = content.match(/<script setup>([\s\S]*?)<\/script>/);
    if (scriptSetupMatch) {
      const scriptContent = scriptSetupMatch[1]
        .replace(/\/\/.*$/gm, "") // remove single line comments
        .replace(/\/\*[\s\S]*?\*\//g, ""); // remove block comments

      const scriptUsesRoute = /\broute\b/.test(scriptContent);
      const scriptDefinesRoute = /\bconst\s+route\s*=/.test(scriptContent) || /\blet\s+route\s*=/.test(scriptContent);
      
      if (scriptUsesRoute && !scriptDefinesRoute) {
        errors.push(`${file.slice(root.length + 1)} uses 'route' in script setup but does not define it.`);
      }
      
      if (scriptDefinesRoute && !importsUseRoute) {
        errors.push(`${file.slice(root.length + 1)} defines 'route' but does not import 'useRoute' from 'vue-router'.`);
      }
    }
  }

  assert.deepEqual(errors, [], `Found routing variable mismatches:\n${errors.join("\n")}`);
});

// Vue resolves an unknown template handler to undefined and only warns at
// RUNTIME, on render - so a dead @event binding ships silently. AdminView
// gained `@logout="handleLogout"` when it adopted AppHeader but never defined
// the handler, leaving a Sign out button that did nothing.
test("every @event handler referenced in a template is defined in the component", () => {
  const vueFiles = findFiles(join(root, "frontend", "src"), (p) => p.endsWith(".vue"));
  const offenders = [];

  for (const file of vueFiles) {
    const src = readFileSync(file, "utf8");
    const styleAt = src.search(/<style\b/);
    const scriptAt = src.search(/<script\b/);
    if (scriptAt === -1) continue;

    const template = src.slice(0, scriptAt);
    const script = src.slice(scriptAt, styleAt === -1 ? undefined : styleAt);
    const rel = file.slice(root.length + 1).split("\\").join("/");

    // Only bare identifiers: `@click="doThing"`. Inline expressions
    // (`@click="x = 1"`, `foo()`, `$emit(...)`) are the compiler's problem.
    for (const m of template.matchAll(/(?:@|v-on:)[\w.:-]+="([A-Za-z_$][\w$]*)"/g)) {
      const handler = m[1];
      const declared = new RegExp(
        "(?:function\\s+" + handler + "\\b" +
        "|(?:const|let|var)\\s+" + handler + "\\b" +
        "|\\b" + handler + "\\s*,?\\s*\\}?\\s*from\\s+['\"]" +
        "|import\\s+" + handler + "\\b" +
        "|[{,]\\s*" + handler + "\\s*[,}])",
      );
      if (!declared.test(script)) offenders.push(`${rel}  @event="${handler}"`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    "These templates bind an event to an identifier the script never defines. " +
      "Vue resolves it to undefined and warns only when the component renders, " +
      "so the control silently does nothing.",
  );
});
