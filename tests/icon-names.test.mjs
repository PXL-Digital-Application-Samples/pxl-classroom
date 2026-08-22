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

function definedIconNames(src) {
  const start = src.indexOf("const ICONS");
  assert.notEqual(start, -1, "Icon.vue no longer declares an ICONS map");
  const body = src.slice(start);
  return new Set([...body.matchAll(/^\s{2}'?([a-z0-9-]+)'?:/gm)].map((m) => m[1]));
}

test("Icons: every <Icon name=\"…\"> resolves to a drawn icon", async () => {
  const defined = definedIconNames(await readFile(ICON_COMPONENT, "utf8"));

  const offenders = [];
  for (const file of await getVueFiles()) {
    if (basename(file) === "Icon.vue") continue;
    const src = await readFile(file, "utf8");
    for (const m of src.matchAll(/<Icon[^>]*\sname="([a-z0-9-]+)"/g)) {
      if (!defined.has(m[1])) {
        offenders.push(`${relative(process.cwd(), file)} uses <Icon name="${m[1]}">`);
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
