#!/usr/bin/env node
// PXL Classroom - find CSS classes the markup uses and nothing declares.
//
// Vue `<style scoped>` does not leak, and an undeclared class fails exactly the
// way an undefined custom property does (DESIGN.md §5 rule 3): silently. The
// element renders with no styling, no build error, no console warning.
//
// tests/scoped-style-leakage.test.mjs catches "used here, scoped over there".
// It deliberately skips the other half - `if (!owners) continue` - so a class
// declared NOWHERE passed. That is how `.btn-warning` shipped in seven places
// across two components, rendering as a plain `.btn`, with a test asserting the
// class was present in the template (it was).
//
// Run: node scripts/lint-undeclared-classes.mjs [--json]

import { readdir, readFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";

const FRONTEND_SRC = join(process.cwd(), "frontend", "src");
const IDENT = /^[a-zA-Z][\w-]*$/;

export async function vueFiles(dir = FRONTEND_SRC) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await vueFiles(full)));
    else if (entry.name.endsWith(".vue")) out.push(full);
  }
  return out;
}

export function splitBlocks(src) {
  const styleStart = src.search(/<style\b/);
  return styleStart === -1
    ? { markup: src, style: "" }
    : { markup: src.slice(0, styleStart), style: src.slice(styleStart) };
}

/**
 * Every class the markup can put on an element.
 *
 * Static `class="a b"` only - `:class` and `v-bind:class` hold expressions, so
 * a naive `\bclass="` match reads `:class="['btn', x ? 'a' : 'b']"` as classes
 * named `['btn',` and `?`. Those are read separately, as quoted literals and
 * object keys.
 */
export function classesUsed(markup) {
  const found = new Set();
  const add = (name) => { if (IDENT.test(name)) found.add(name); };

  for (const m of markup.matchAll(/(?<![:\w-])class="([^"]*)"/g)) {
    for (const name of m[1].split(/\s+/)) add(name);
  }
  for (const m of markup.matchAll(/(?::|v-bind:)class="([^"]*)"/g)) {
    // A quoted literal inside :class is only a class name when it is in class
    // POSITION. `:class="{ active: filter === 'on-time' }"` compares against a
    // filter value; reading 'on-time' as a class reported four components as
    // using a class nobody ever intended to style.
    const expr = m[1]
      .replace(/[=!]==?\s*'[^']*'/g, "")   // filter === 'on-time'
      .replace(/'[^']*'\s*[=!]==?/g, "")   // 'on-time' === filter
      .replace(/\.includes\('[^']*'\)/g, "")
      .replace(/\.startsWith\('[^']*'\)/g, "");
    for (const lit of expr.matchAll(/'([^']*)'/g)) {
      for (const name of lit[1].split(/\s+/)) add(name);
    }
    for (const key of expr.matchAll(/(?:^|[{,]\s*)([a-zA-Z][\w-]*)\s*:(?!=)/g)) add(key[1]);
  }
  return found;
}

/** Class names a rule in this stylesheet targets. */
export function classesDeclared(style) {
  const found = new Set();
  for (const m of style.matchAll(/\.([a-zA-Z][\w-]*)(?=[^{}]*\{)/g)) found.add(m[1]);
  return found;
}

/**
 * Classes used in markup and declared in no stylesheet at all.
 *
 * @returns Map<className, Set<componentName>>
 */
export async function findUndeclaredClasses() {
  const globalClasses = classesDeclared(await readFile(join(FRONTEND_SRC, "style.css"), "utf8"));

  const files = [];
  for (const file of await vueFiles()) {
    const src = await readFile(file, "utf8");
    const { markup, style } = splitBlocks(src);
    files.push({
      name: basename(file),
      rel: relative(process.cwd(), file),
      used: classesUsed(markup),
      declared: classesDeclared(style),
    });
  }

  const declaredSomewhere = new Set(globalClasses);
  for (const f of files) for (const c of f.declared) declaredSomewhere.add(c);

  const undeclared = new Map();
  for (const f of files) {
    for (const c of f.used) {
      if (declaredSomewhere.has(c)) continue;
      if (!undeclared.has(c)) undeclared.set(c, new Set());
      undeclared.get(c).add(f.name);
    }
  }
  return undeclared;
}

/**
 * Split the undeclared classes by whether the ELEMENT carrying them is styled.
 *
 * The list on its own reads like a 60-item defect backlog, and it is not: most
 * of these sit on an element that already carries `card`, `flex`, `btn`,
 * `alert-info` or `fade-in`, and the undeclared word beside them is a name, not
 * a look. Telling those apart is the difference between a register somebody can
 * act on and one they misread - DESIGN.md §7 had to say "left, and that is the
 * answer" in prose because nothing computed it.
 *
 * `styledBySiblings` is a POSITIVE proof: another class on the same element is
 * declared, so the element is styled whatever this name does. `alone` is NOT
 * the negative - an element's look can also come from its tag or an ancestor
 * (`.field label` styles a `<label>` that carries no declared class of its
 * own), and only a browser knows. So `alone` means "needs a reason written
 * down", not "broken".
 *
 * @returns {Promise<{styledBySiblings: Record<string,string[]>, alone: Record<string,string[]>}>}
 */
export async function classifyUndeclared() {
  const undeclared = await findUndeclaredClasses();
  const globalClasses = classesDeclared(await readFile(join(FRONTEND_SRC, "style.css"), "utf8"));
  const declaredSomewhere = new Set(globalClasses);
  const parsed = [];
  for (const file of await vueFiles()) {
    const { markup, style } = splitBlocks(await readFile(file, "utf8"));
    const declared = classesDeclared(style);
    for (const c of declared) declaredSomewhere.add(c);
    parsed.push({ name: basename(file), markup });
  }

  const styledBySiblings = {};
  const alone = {};
  for (const [cls, owners] of undeclared) {
    // Every static class attribute that carries this class, in every owner.
    let everyElementStyled = true;
    for (const owner of owners) {
      const markup = parsed.find((p) => p.name === owner)?.markup ?? "";
      for (const m of markup.matchAll(/(?<![:\w-])class="([^"]*)"/g)) {
        const names = m[1].split(/\s+/).filter(Boolean);
        if (!names.includes(cls)) continue;
        if (!names.some((n) => n !== cls && declaredSomewhere.has(n))) everyElementStyled = false;
      }
    }
    (everyElementStyled ? styledBySiblings : alone)[cls] = [...owners];
  }
  return { styledBySiblings, alone };
}

if (process.argv[1] && process.argv[1].endsWith("lint-undeclared-classes.mjs")) {
  const undeclared = await findUndeclaredClasses();
  const rows = [...undeclared].sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]));
  if (process.argv.includes("--split")) {
    const { styledBySiblings, alone } = await classifyUndeclared();
    console.log(`${Object.keys(styledBySiblings).length} on an element another declared class already styles:`);
    for (const [c, w] of Object.entries(styledBySiblings)) console.log(`  .${c}  <- ${w.join(", ")}`);
    console.log(`\n${Object.keys(alone).length} whose element carries no declared class at all:`);
    for (const [c, w] of Object.entries(alone)) console.log(`  .${c}  <- ${w.join(", ")}`);
  } else if (process.argv.includes("--json")) {
    console.log(JSON.stringify(Object.fromEntries(rows.map(([c, w]) => [c, [...w]])), null, 2));
  } else {
    console.log(`${rows.length} class(es) used in markup and declared nowhere:\n`);
    for (const [cls, where] of rows) console.log(`  .${cls}  <- ${[...where].join(", ")}`);
  }
}
