import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";

// Icon.vue resolves an unknown name to an empty string:
//
//   const paths = computed(() => ICONS[props.name] || '')
//
// so a typo - or an icon nobody ever drew - renders a correctly sized, entirely
// blank <svg>. No error, no console warning: the same silent-failure shape as an
// undefined CSS custom property (DESIGN.md §5), and it had left 14 names blank
// across the Admin Panel, the dashboard, the sandbox and the group cards.
//
// Both halves of this suite exist because of near misses in the first version:
//
//   * The ICONS map must be read as an object literal, not "everything after
//     `const ICONS`". Scanning to end-of-file swept up the scoped <style>
//     block, so `flex-shrink: 0` registered as a defined icon called
//     "flex-shrink" - and any component asking for one of those CSS property
//     names would have been waved through.
//   * Half the call sites bind `:name` to a ternary. A typo inside
//     `:name="ok ? 'chek-circle' : 'x-circle'"` is exactly as blank as a static
//     one and was not being checked at all.

const FRONTEND_SRC = join(process.cwd(), "frontend", "src");
const ICON_COMPONENT = join(FRONTEND_SRC, "components", "Icon.vue");

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

/** Keys of the ICONS object literal - and nothing that follows it. */
function definedIconNames(src) {
  const start = src.indexOf("const ICONS");
  assert.notEqual(start, -1, "Icon.vue no longer declares an ICONS map");
  const open = src.indexOf("{", start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  assert.notEqual(end, -1, "could not find the end of Icon.vue's ICONS object");
  const body = src.slice(open, end);
  return new Set([...body.matchAll(/^\s{2}'?([a-z0-9-]+)'?:/gm)].map((m) => m[1]));
}

/**
 * Icon names a `:name="…"` expression can produce.
 *
 * Comparison operands are stripped first: in
 * `rosterStatus === 'enrolled' ? 'check-circle' : 'x-circle'` only the two
 * branches are icon names, and flagging 'enrolled' would be noise that trains
 * people to ignore this test. An expression with no literals left (a helper
 * call, a lookup table) is not statically checkable and is skipped.
 */
function literalsFromBinding(expr) {
  const withoutComparisons = expr
    .replace(/(?:===|!==|==|!=)\s*'[^']*'/g, "")
    .replace(/'[^']*'\s*(?:===|!==|==|!=)/g, "");
  return [...withoutComparisons.matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]);
}

test('Icons: every <Icon name="…"> resolves to a drawn icon', async () => {
  const defined = definedIconNames(await readFile(ICON_COMPONENT, "utf8"));

  const offenders = [];
  for (const file of await getVueFiles()) {
    if (basename(file) === "Icon.vue") continue;
    const rel = relative(process.cwd(), file);
    const src = await readFile(file, "utf8");

    for (const m of src.matchAll(/<Icon[^>]*\sname="([a-z0-9-]+)"/g)) {
      if (!defined.has(m[1])) offenders.push(`${rel} uses <Icon name="${m[1]}">`);
    }

    for (const m of src.matchAll(/<Icon[^>]*\s:name="([^"]+)"/g)) {
      for (const name of literalsFromBinding(m[1])) {
        if (!defined.has(name)) offenders.push(`${rel} can render <Icon :name="… '${name}' …">`);
      }
    }
  }

  assert.deepEqual(
    [...new Set(offenders)].sort(),
    [],
    "These names are not in Icon.vue's ICONS map, so they render a blank svg. " +
      "Add the Lucide path to frontend/src/components/Icon.vue.",
  );
});

test("Icons: the ICONS map is read as an object, not as the rest of the file", async () => {
  const defined = definedIconNames(await readFile(ICON_COMPONENT, "utf8"));

  // Property names from the scoped <style> block. If any of these are in the
  // set, the parser has run past the object literal and the suite above is
  // silently accepting whatever CSS happens to be declared below it.
  for (const cssProperty of ["display", "flex-shrink", "vertical-align"]) {
    assert.equal(
      defined.has(cssProperty),
      false,
      `"${cssProperty}" is a CSS property in Icon.vue's <style> block, not an icon`,
    );
  }

  assert.ok(defined.has("users"), "sanity: the ICONS map should still parse");
});
