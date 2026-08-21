import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

// Guards DESIGN.md §5. The SPA is dual-theme via light-dark(); the token block
// in style.css is the ONLY place a colour literal may appear. See DESIGN.md §2.
//
// All four rules are live. Rules 1 and 2 became enforceable once the literal
// sweep landed; the codebase now holds zero colour literals outside :root.

const FRONTEND_SRC = join(process.cwd(), "frontend", "src");
const STYLE_CSS = join(FRONTEND_SRC, "style.css");

// Tokens deliberately identical in both themes (DESIGN.md §5 rule 4 exemption).
const THEME_INVARIANT_TOKENS = new Set(["--text-on-emphasis", "--border-on-emphasis"]);

const COLOUR_LITERAL = /#[0-9a-fA-F]{3,8}\b|rgba?\(\s*\d/;

async function getSourceFiles(dir = FRONTEND_SRC) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await getSourceFiles(full)));
    else if (entry.name.endsWith(".vue") || entry.name === "style.css") files.push(full);
  }
  return files;
}

/** The `:root { … }` palette block plus the `[data-theme]` switch rules. */
async function readTokenBlock() {
  const css = await readFile(STYLE_CSS, "utf8");
  const start = css.indexOf(":root {");
  assert.ok(start !== -1, "style.css must declare a :root token block");
  const end = css.indexOf("\nhtml {", start);
  assert.ok(end !== -1, "style.css must declare html {} after the token block");
  return { css, block: css.slice(start, end) };
}

/** Strip the token block so the rest of style.css can be scanned like a component. */
async function readStyleCssBody() {
  const { css, block } = await readTokenBlock();
  return css.replace(block, "");
}

/**
 * Blank out comments. The rule governs what is STYLED, not what is written
 * about styling - documentation legitimately quotes hex values, and a comment
 * cannot colour anything. Newlines are preserved so line numbers stay true.
 */
function stripComments(src) {
  const blank = (m) => m.replace(/[^\r\n]/g, " ");
  return src
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/(^|[^:'"\\])\/\/[^\r\n]*/g, (m, prefix) => prefix + blank(m.slice(prefix.length)));
}

test("Theme: style.css declares the light-dark() token block and the theme switch", async () => {
  const { block } = await readTokenBlock();

  assert.ok(
    /:root\s*{[^}]*color-scheme:\s*dark/s.test(block),
    "':root' must set 'color-scheme: dark' — dark is the default theme, so an absent " +
      "data-theme attribute keeps the appearance the app has always had",
  );

  for (const [attr, scheme] of [["light", "light"], ["dark", "dark"], ["system", "light dark"]]) {
    assert.match(
      block,
      new RegExp(`:root\\[data-theme="${attr}"\\]\\s*{\\s*color-scheme:\\s*${scheme};`),
      `style.css must map [data-theme="${attr}"] to 'color-scheme: ${scheme}'`,
    );
  }
});

test("Theme rule 4: every colour token uses light-dark()", async () => {
  const { block } = await readTokenBlock();
  const unthemed = [];

  for (const m of block.matchAll(/^\s*(--[a-zA-Z0-9-]+)\s*:\s*([^;]+);/gm)) {
    const [, name, rawValue] = m;
    if (THEME_INVARIANT_TOKENS.has(name)) continue;
    const value = rawValue.trim();
    if (COLOUR_LITERAL.test(value) && !value.includes("light-dark(")) {
      unthemed.push(`${name}: ${value}`);
    }
  }

  assert.deepEqual(
    unthemed,
    [],
    "These tokens carry a colour literal but are not themed. Declare them as " +
      "light-dark(<light>, <dark>), or add them to THEME_INVARIANT_TOKENS if they " +
      "are deliberately identical in both themes (DESIGN.md §5 rule 4).",
  );
});

test("Theme rule 3: every var(--token) reference resolves to a defined token", async () => {
  const { css } = await readTokenBlock();
  const defined = new Set([...css.matchAll(/^\s*(--[a-zA-Z0-9-]+)\s*:/gm)].map((m) => m[1]));

  const dangling = new Map();
  for (const file of await getSourceFiles()) {
    const src = await readFile(file, "utf8");
    src.split("\n").forEach((line, i) => {
      for (const m of line.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g)) {
        if (defined.has(m[1])) continue;
        if (!dangling.has(m[1])) dangling.set(m[1], []);
        dangling.get(m[1]).push(`${relative(process.cwd(), file)}:${i + 1}`);
      }
    });
  }

  assert.deepEqual(
    [...dangling].map(([token, sites]) => `${token} <- ${sites.join(", ")}`),
    [],
    "Undefined CSS custom properties fail SILENTLY at computed-value time: the " +
      "declaration is dropped and the property falls back to its initial value " +
      "(border-color -> currentColor, background -> transparent, box-shadow -> none). " +
      "'--border-color', '--accent-amber', '--color-border', '--shadow-glow', '--bg-hover', " +
      "'--bg-active' and '--accent-primary' all shipped broken this way. Define the token " +
      "in :root or point the reference at an existing one (DESIGN.md §5 rule 3).",
  );
});

test("Theme runtime: index.html boots the theme before first paint", async () => {
  const html = await readFile(join(process.cwd(), "frontend", "index.html"), "utf8");

  assert.match(
    html,
    /<meta name="color-scheme" content="dark light"\s*\/?>/,
    "index.html must declare <meta name=\"color-scheme\" content=\"dark light\"> so the " +
      "browser's first canvas fill matches the default theme before style.css lands",
  );

  const bootIndex = html.indexOf("html.dataset.theme");
  const shimIndex = html.indexOf("spa-github-pages");
  const appIndex = html.indexOf("/src/main.js");

  assert.ok(bootIndex !== -1, "index.html must inline a theme boot script setting dataset.theme");
  assert.ok(
    shimIndex !== -1 && bootIndex > shimIndex,
    "the theme boot script must run AFTER the SPA shim, so a deep link redirected " +
      "through 404.html has its ?theme= restored before the boot script reads it",
  );
  assert.ok(
    bootIndex < appIndex,
    "the theme boot script must run BEFORE the app module, or a light-mode user " +
      "flashes dark on every load",
  );
});

test("Theme runtime: the inline boot script and lib/theme.js agree", async () => {
  const html = await readFile(join(process.cwd(), "frontend", "index.html"), "utf8");
  const themeJs = await readFile(join(FRONTEND_SRC, "lib", "theme.js"), "utf8");

  const storageKey = themeJs.match(/export const STORAGE_KEY = '([^']+)'/)?.[1];
  assert.ok(storageKey, "lib/theme.js must export STORAGE_KEY");
  assert.ok(
    html.includes(`'${storageKey}'`),
    `The inline boot script must read/write the same storage key as lib/theme.js ` +
      `('${storageKey}'). They are duplicated on purpose - the boot script runs ` +
      `before the module graph - so they must be updated together.`,
  );

  const modes = themeJs
    .match(/export const THEME_MODES = \[([^\]]+)\]/)?.[1]
    .match(/'([a-z]+)'/g)
    ?.map((m) => m.replaceAll("'", ""));
  assert.deepEqual(
    modes,
    ["dark", "light", "system"],
    "lib/theme.js must export THEME_MODES as ['dark', 'light', 'system']",
  );

  const bootModes = html
    .match(/var VALID = \[([^\]]+)\]/)?.[1]
    .match(/'([a-z]+)'/g)
    ?.map((m) => m.replaceAll("'", ""));
  assert.deepEqual(
    bootModes,
    modes,
    "The inline boot script's VALID list must match THEME_MODES in lib/theme.js",
  );

  assert.match(
    themeJs,
    /export const DEFAULT_MODE = 'dark'/,
    "DEFAULT_MODE must be 'dark' - dark is the default theme, and the boot script " +
      "falls back to 'dark' when storage is unreadable",
  );
  assert.ok(
    /=== -1 \? stored : 'dark'|: 'dark'\)/.test(html) && html.includes("dataset.theme = 'dark'"),
    "The inline boot script must fall back to 'dark' both for an invalid stored " +
      "value and when localStorage throws",
  );
});

test("Theme rule 1: no colour literals outside the :root token block", async () => {
  const offenders = [];
  const styleCssBody = await readStyleCssBody();

  for (const file of await getSourceFiles()) {
    const rel = relative(process.cwd(), file);
    const raw = file === STYLE_CSS ? styleCssBody : await readFile(file, "utf8");
    stripComments(raw).split("\n").forEach((line, i) => {
      // var(--x, #fallback) is rule 2's problem, not rule 1's — strip it first.
      const stripped = line.replace(
        /var\(--[a-zA-Z0-9-]+,\s*(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\))/g,
        "var(X)",
      );
      if (COLOUR_LITERAL.test(stripped)) offenders.push(`${rel}:${i + 1}`);
    });
  }

  assert.deepEqual(offenders, [], `${offenders.length} colour literals still outside :root`);
});

test("Theme rule 2: no var(--token, <literal>) colour fallbacks", async () => {
  const offenders = [];
  const styleCssBody = await readStyleCssBody();

  for (const file of await getSourceFiles()) {
    const rel = relative(process.cwd(), file);
    const raw = file === STYLE_CSS ? styleCssBody : await readFile(file, "utf8");
    stripComments(raw).split("\n").forEach((line, i) => {
      const hits = line.match(
        /var\(--[a-zA-Z0-9-]+,\s*(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\))/g,
      );
      if (hits) offenders.push(`${rel}:${i + 1} (${hits.length})`);
    });
  }

  assert.deepEqual(offenders, [], `${offenders.length} lines still carry colour fallbacks`);
});
