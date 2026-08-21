# PXL Classroom — Design System & Visual Guidelines

This document outlines the core UI/UX design principles and tokens for **PXL Classroom**. It ensures the interface maintains a human-crafted, high-density developer aesthetic (inspired by GitHub Primer) and avoids generic "AI-generated template" defaults.

---

## 1. Core Visual Principles

1. **Avoid the "1px Box Prison":**
   * Do not wrap every nested container in a 1px solid border.
   * Separate sections using **tonal surface shifts** (`--bg-canvas` vs `--bg-surface`) and purposeful whitespace (16–24px padding).
   * Reserve borders for structural dividers (such as sticky headers, navigation borders, or data table rows).

2. **Strict 1-Primary-Button Rule:**
   * **Only ONE** solid primary button (`.btn-primary`) per view or major screen section (e.g., `+ New assignment` on Dashboard, `Copy invitation link` on Detail view).
   * Standard toolbar actions (`Refresh`, `Export`, `Sync`) must use neutral secondary styling (`.btn-secondary`).
   * Destructive actions (`Close acceptance`, `Freeze`) belong in a `··· More` overflow dropdown or use subtle danger outlines until confirmed in a modal dialog.

3. **Status Dots over Bulky Pill Capsules:**
   * In data tables, student cards, and metric rows, prefer `.status-indicator` with a glowing `.status-dot` and clean mixed-case text (`● On-time`, `● Provisioned`, `● Accepting`).
   * Avoid uppercase heavy 9999px pill badges (`[ NO-SUBMISSION ]`) which add visual noise when repeated hundreds of times.

4. **GitHub Primer Navigation:**
   * Use underline tabs (`.primer-tabs` / `.primer-tab`) with an active bottom border for section switching (e.g., `Assignments | Roster`).
   * Avoid floating pill toggle bubbles for top-level navigation.

---

## 2. Design Tokens

Every token is declared once in `frontend/src/style.css` as `light-dark(<light>, <dark>)`.
**`:root` is the only place in the codebase where a colour literal may appear** — see §5.

### Surfaces & Layers
The light ramp is **inverted** relative to dark: canvas is the grey and cards are white, so
`--bg-surface` reads as raised above `--bg-canvas` in *both* themes and principle §1.1 holds
without re-adding borders.

| Token | Light | Dark | Usage |
| :--- | :--- | :--- | :--- |
| `--bg-canvas` | `#f6f8fa` | `#0d1117` | Base application background |
| `--bg-surface` | `#ffffff` | `#161b22` | Cards, panels, sticky header, table headers |
| `--bg-surface-elevated` | `#ffffff` | `#1c2128` | Dropdown menus, modal sheets (light separates by shadow, not tone) |
| `--bg-surface-hover` | `#f3f4f6` | `#21262d` | Button faces, table row hover, list item hover |
| `--bg-inset` | `#f6f8fa` | `#0d1117` | `<pre>` blocks, recessed wells |

### Borders
| Token | Light | Dark | Usage |
| :--- | :--- | :--- | :--- |
| `--border-default` | `#d1d9e0` | `#30363d` | Prominent dividers, input borders, active controls |
| `--border-muted` | `#d1d9e0b3` | `#21262d` | Table row dividers, card subtle outlines, tab borders |
| `--border-subtle` | `rgba(31,35,40,.08)` | `rgba(240,246,252,.1)` | Button inner borders |
| `--border-strong` | `#8c959f` | `#484f58` | Emphasised outlines |

### Tints
Status washes. Five hues × three steps — `subtle` (background), `muted` (filled chip),
`emphasis` (borders, rings, dot glows), as `--tint-{success,attention,danger,accent,neutral}-{step}`.
Dark is an alpha wash over the dark canvas; **light uses Primer's solid muted colours** —
a 10% wash tuned for `#0d1117` reads as nothing on white. Never hand-roll an `rgba()` status tint.

### Shadows
`light-dark()` returns a `<color>`, so it **cannot** wrap a whole `box-shadow`. Only the colour is
themed (`--shadow-color-{sm,md,lg,modal}`); geometry is shared via `--shadow-{sm,md,lg,modal}`
and `--ring-focus`. Writing `box-shadow: light-dark(0 4px 12px …, …)` is invalid CSS.

### Typography & Radii
* **Font Family:** `Inter`, system-ui, -apple-system, sans-serif
* **Monospace:** `ui-monospace`, `Cascadia Code`, `Fira Code`, `Consolas`, monospace (for SHAs, repo slugs, timestamps)
* **Corner Radii:**
  * Inputs & Buttons: `6px` (`--radius-sm`)
  * Cards & Modals: `8px`–`10px` (`--radius-md` / `--radius-lg`)
  * Full circular: strictly for user avatars and status dots (`50%`)

---

## 3. Button Hierarchy Reference

```html
<!-- 1. Primary CTA (1 per screen) -->
<button class="btn btn-primary btn-with-icon">
  <Icon name="plus" :size="14" />
  <span>New assignment</span>
</button>

<!-- 2. Neutral Secondary (Toolbar & Standard Actions) -->
<button class="btn btn-secondary btn-sm btn-with-icon">
  <Icon name="download" :size="13" />
  <span>Export</span>
</button>

<!-- 3. Ghost / Icon Button (Utilities) -->
<button class="btn btn-ghost btn-icon" title="System health">
  <Icon name="activity" :size="16" />
</button>

<!-- 4. Danger Outline (Destructive in toolbars) -->
<button class="btn btn-danger-outline btn-sm btn-with-icon">
  <Icon name="lock" :size="13" />
  <span>Close acceptance</span>
</button>
```

---

## 4. Status Indicator Reference

```html
<!-- Active / Success -->
<span class="status-indicator">
  <span class="status-dot dot-success"></span>
  <span>On-time</span>
</span>

<!-- Warning / Pending -->
<span class="status-indicator">
  <span class="status-dot dot-warning"></span>
  <span>Late</span>
</span>

<!-- Neutral / Unstarted -->
<span class="status-indicator">
  <span class="status-dot dot-neutral"></span>
  <span>No submission</span>
</span>
```

---

## 5. Theming (dark default / light / system)

The SPA is dual-theme. Both themes come from **one** token block in `frontend/src/style.css`;
there is no second palette to keep in sync.

```css
:root {
  color-scheme: dark;                              /* dark is the DEFAULT */
  --bg-canvas: light-dark(#f6f8fa, #0d1117);
}
:root[data-theme="light"]  { color-scheme: light; }
:root[data-theme="dark"]   { color-scheme: dark; }
:root[data-theme="system"] { color-scheme: light dark; }   /* opt-in, never default */
```

`light-dark()` resolves against the **computed `color-scheme`**, so flipping that single property
re-resolves every token — and themes native scrollbars, form controls and autofill for free.
An absent `data-theme` attribute means dark, which is why a first-time visitor keeps the
appearance the app has always had and why a missing theme script cannot cause a light flash.

### Runtime

`frontend/src/lib/theme.js` owns the mode; `main.js` calls `initTheme()` at boot.

| Export | |
| :--- | :--- |
| `themeMode` | the user's choice — `'dark' \| 'light' \| 'system'` |
| `resolvedTheme` | what is actually on screen — `'dark' \| 'light'` |
| `setThemeMode(m)` | validate, persist, apply (invalid input is ignored) |
| `cycleThemeMode()` | `dark → light → system → dark` |

Preference is stored in `localStorage` under **`pxl_theme`**, wrapped in `try`/`catch`
(Safari private mode and blocked storage must not break boot). A plain visit never writes a
preference — only an explicit choice or a `?theme=` override does.

**`?theme=dark|light|system`** forces and persists a mode. Useful for reviewing a screen in
the other theme, and for sharing a link that opens that way.

**The inline boot script in `index.html` duplicates the storage key and mode list on purpose** —
it must run before the module graph loads, or a light-mode user flashes dark on every load. It
sits *after* the SPA shim so a deep link redirected through `404.html` has its `?theme=` restored
before the script reads it. `tests/theme-tokens.test.mjs` asserts the two copies stay in sync.

There is deliberately **no global colour `transition`** on the theme swap — it janks the
data-dense tables. `<meta name="color-scheme" content="dark light">` covers the browser's
first canvas fill before `style.css` lands.

**Rules — non-negotiable, enforced by `tests/theme-tokens.test.mjs`:**

1. **No colour literal outside `:root`.** No hex, no `rgb()`/`rgba()`, no named colours in any
   component `<style>` block or inline `style=` attribute. `transparent` / `currentColor` are fine.
2. **No `var(--token, #fallback)` fallbacks.** A fallback is a hardcoded colour that silently
   pins one theme, and it hides the typo in rule 3.
3. **Every `var(--token)` must resolve** to a token defined in `:root`. Undefined tokens fail
   *silently* in CSS — `--border-color` and `--accent-amber` shipped broken for exactly this reason.
4. **Every colour token must use `light-dark()`.** Theme-invariant tokens (`--text-on-emphasis`)
   live in the marked invariant block and are the only exemption.

## 6. Visual Sandbox & Interactive Testing

An offline interactive workbench is available at the route **`/sandbox`**. It allows developers to:
- Inspect all tonal surface swatches, border contrast, and typography scales.
- Interact with button hierarchies, sizes, and spinner states.
- Test `.status-indicator` + `.status-dot` variants in data tables.
- Launch `StarterSyncModal`, `SystemHealthModal`, and `TeamsTable` with realistic, deterministic mock data fixtures without requiring live GitHub API credentials.
