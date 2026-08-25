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
      // `.claude` holds git worktrees - a full second checkout of this repo.
      if (item === "node_modules" || item === ".git" || item === "dist" || item === ".claude") continue;
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
    const importsUseRoute = /import\s+{[^}]*useRoute[^}]*}\s+from\s+['"]vue-router['"]/.test(content) ||
                          /import\s+useRoute\s+from\s+['"]vue-router['"]/.test(content);

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

// A route with no way to reach it is a page that exists only for whoever knows
// to type the URL. Three shipped that way (UX_PLAN §8): `/usage`, the only
// cross-org view in the app, had zero inbound links; `/setup` had zero; and
// `/sandbox` served fabricated cohort data from a public Pages site, also with
// zero. Nothing in the build says so - a route is reachable by construction,
// discoverable only by somebody linking to it.
//
// Two routes are exempt, and the list may not grow without a reason written
// here:
//
//   invitation  - entered from OUTSIDE the app, which is the whole design.
//                 The link is minted by publish-assignment.yml and handed to
//                 students on Canvas; InvitationShare renders it as an <a
//                 href> built from the token, never as a named route.
//   not-found   - the catch-all. Linking to it would be absurd.
//
// `sandbox` counts as reachable a different way: it is gated on
// import.meta.env.DEV, so it does not exist in the bundle a student could
// load. That is the other acceptable answer to "nothing links here".
test("every route is either linked to from somewhere, or does not ship", () => {
  const src = join(root, "frontend", "src");
  const routerFile = join(src, "router", "index.js");
  const routerSrc = readFileSync(routerFile, "utf8");

  const names = [...routerSrc.matchAll(/name:\s*'([a-z-]+)'/g)].map((m) => m[1]);
  assert.ok(names.length >= 8, `expected to find the route table, found ${names.length} names`);

  const ENTERED_FROM_OUTSIDE = new Set(["invitation", "not-found"]);
  assert.deepEqual(
    [...ENTERED_FROM_OUTSIDE].sort(),
    ["invitation", "not-found"],
    "The exemption list is deliberately two entries. Adding a third means " +
      "writing down why that route needs no way in.",
  );

  // Everything that can hold a link: the SPA, plus lib/ - the diagnostic
  // engine is shared with the CLI and is where the /setup pointer lives,
  // because "the App does not exist" is the moment anybody needs it.
  const linkSources = [
    ...findFiles(src, (p) => /\.(vue|js)$/.test(p) && p !== routerFile),
    ...findFiles(join(root, "lib"), (p) => p.endsWith(".mjs")),
  ].map((p) => readFileSync(p, "utf8"));
  const haystack = linkSources.join("\n");

  const devGated = new Set(
    [...routerSrc.matchAll(/import\.meta\.env\.DEV[\s\S]{0,200}?name:\s*'([a-z-]+)'/g)].map((m) => m[1]),
  );

  const orphans = [];
  for (const name of names) {
    if (ENTERED_FROM_OUTSIDE.has(name)) continue;
    if (devGated.has(name)) continue;
    // `:to="{ name: 'usage-overview' }"`, `router.push({ name: 'setup' })`,
    // or a diagnostic action carrying `name: "setup"`.
    if (new RegExp(`name:\\s*['"]${name}['"]`).test(haystack)) continue;
    // `home` is reached as `to="/"`, which carries no name anywhere.
    if (name === "home" && /\bto="\/"/.test(haystack)) continue;
    orphans.push(name);
  }

  assert.deepEqual(
    orphans,
    [],
    "These routes exist and nothing in the app links to them, so the only way " +
      "in is to know the URL:\n  " + orphans.join("\n  "),
  );

  // Spelled out rather than left implicit in `devGated`: /sandbox is the one
  // route allowed to have no way in, and only because it is not in the bundle
  // a student could load. Remove the gate and the assertion above catches it
  // as an orphan - but this says which answer it is taking.
  assert.ok(
    devGated.has("sandbox"),
    "/sandbox renders fabricated cohort data and must stay behind " +
      "import.meta.env.DEV, or it ships to a public Pages site again.",
  );
});
