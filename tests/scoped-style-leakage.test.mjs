import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";

// Vue <style scoped> does NOT leak. A class used by several components but
// declared in only one of their scoped blocks silently renders unstyled
// everywhere else - no build error, no console warning.
//
// This shipped four times:
//   .center-card       used by 7 views, defined in 5  -> /usage sign-in, loading
//                      and empty states rendered full-bleed and left-aligned
//   .dashboard-header  used by 3 views, defined in 1  -> two Usage headers had
//                      no background, no border, not sticky
//   .sandbox-header    used by 1 view,  defined in 0
//   .auth-error        used by HomeView, defined in 7 other views
//
// Shared vocabulary belongs in style.css. Anything a component passes into a
// <slot> is compiled in the PARENT's scope, so it must be global too.

const FRONTEND_SRC = join(process.cwd(), "frontend", "src");

// Utility and third-party classes that are intentionally global or come from
// elsewhere; matching them here would only produce noise.
const IGNORED = new Set([
  "container", "card", "btn", "modal", "spinner", "fade-in", "mono", "icon",
  "flex", "flex-col", "items-center", "justify-between", "sr-only", "badge",
]);

async function getVueFiles(dir = FRONTEND_SRC) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await getVueFiles(full)));
    else if (entry.name.endsWith(".vue")) files.push(full);
  }
  return files;
}

function splitBlocks(src) {
  const styleStart = src.search(/<style\b/);
  return styleStart === -1
    ? { markup: src, style: "" }
    : { markup: src.slice(0, styleStart), style: src.slice(styleStart) };
}

/** Class names appearing in static class="..." attributes. */
function classesUsed(markup) {
  const found = new Set();
  for (const m of markup.matchAll(/\bclass="([^"{}]*)"/g)) {
    for (const name of m[1].split(/\s+/)) if (name) found.add(name);
  }
  return found;
}

/** Class names declared by a rule in this file's <style> block. */
function classesDeclared(style) {
  const found = new Set();
  for (const m of style.matchAll(/\.([a-zA-Z][\w-]*)(?=[^{]*\{)/g)) found.add(m[1]);
  return found;
}

// The shared vocabulary this refactor moved into style.css. These are the ones
// that actually shipped broken, so they get a hard regression guard.
const MUST_BE_GLOBAL = [
  "center-card", "auth-error", "spinner-sm", "btn-icon",
  "app-header", "app-header-left", "app-header-right", "app-header-title",
  "app-header-heading", "app-header-crumbs", "app-header-sep", "app-header-logo-link",
];

test("Scoped styles: shared layout vocabulary is declared globally", async () => {
  const globalCss = await readFile(join(FRONTEND_SRC, "style.css"), "utf8");
  const globalClasses = classesDeclared(globalCss);

  const missing = MUST_BE_GLOBAL.filter((c) => !globalClasses.has(c));
  assert.deepEqual(
    missing,
    [],
    "These classes are used across multiple views, and .app-header-* are used " +
      "inside <slot> content (which compiles in the PARENT's scope). They must " +
      "live in frontend/src/style.css or they render unstyled.",
  );

  // AppHeader must not regain a scoped block - its slot content could never see it.
  const appHeader = await readFile(join(FRONTEND_SRC, "components", "AppHeader.vue"), "utf8");
  assert.ok(
    !/<style[^>]*\bscoped\b/.test(appHeader),
    "AppHeader.vue must not use <style scoped>: the breadcrumbs and actions that " +
      "views pass into its slots are compiled in the parent's scope, so scoped " +
      "rules here would silently not apply.",
  );
});

test("Scoped styles: no class is used by a component that cannot see its definition",
  { todo: true }, async () => {
  const globalCss = await readFile(join(FRONTEND_SRC, "style.css"), "utf8");
  const globalClasses = classesDeclared(globalCss);

  const files = await getVueFiles();
  const parsed = files.map((file) => {
    const rel = relative(process.cwd(), file);
    return { file, rel, name: basename(file) };
  });

  for (const entry of parsed) {
    const src = await readFile(entry.file, "utf8");
    const { markup, style } = splitBlocks(src);
    entry.used = classesUsed(markup);
    entry.declared = classesDeclared(style);
    entry.scoped = /<style[^>]*\bscoped\b/.test(src);
  }

  // A class is "locally owned" if some component declares it in a scoped block.
  const scopedOwners = new Map();
  for (const e of parsed) {
    if (!e.scoped) continue;
    for (const c of e.declared) {
      if (!scopedOwners.has(c)) scopedOwners.set(c, []);
      scopedOwners.get(c).push(e.name);
    }
  }

  const offenders = [];
  for (const e of parsed) {
    for (const c of e.used) {
      if (IGNORED.has(c) || globalClasses.has(c)) continue;
      if (e.declared.has(c)) continue;
      const owners = scopedOwners.get(c);
      if (!owners) continue; // not styled anywhere; not this test's concern
      offenders.push(
        `${e.rel} uses .${c} but never declares it; it is scoped inside ${owners.join(", ")}`,
      );
    }
  }

  assert.deepEqual(
    offenders,
    [],
    "Vue scoped styles do not leak, so each of these renders UNSTYLED. Move the " +
      "class into frontend/src/style.css (if it is shared vocabulary) or declare " +
      "it in the component that uses it.",
  );
});
