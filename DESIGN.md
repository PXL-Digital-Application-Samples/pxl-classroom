# PXL Classroom — Design System & Visual Guidelines

This document outlines the core UI/UX design principles and tokens for **PXL Classroom**. It ensures the interface maintains a human-crafted, high-density developer aesthetic (inspired by GitHub Primer) and avoids generic "AI-generated template" defaults.

---

## 1. Core Visual Principles

1. **Avoid the "1px Box Prison":**
   * Do not wrap every nested container in a 1px solid border.
   * Separate sections using **tonal surface shifts** (Canvas `#0d1117` vs Surface `#161b22`) and purposeful whitespace (16–24px padding).
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

### Surfaces & Layers
| Token | Hex / Value | Usage |
| :--- | :--- | :--- |
| `--bg-canvas` | `#0d1117` | Base application background |
| `--bg-surface` | `#161b22` | Cards, panels, sticky header, table headers |
| `--bg-surface-elevated` | `#1c2128` | Dropdown menus, modal sheets |
| `--bg-surface-hover` | `#21262d` | Button backgrounds, table row hover, list item hover |

### Borders
| Token | Hex / Value | Usage |
| :--- | :--- | :--- |
| `--border-default` | `#30363d` | Prominent dividers, input borders, active controls |
| `--border-muted` | `#21262d` | Table row dividers, card subtle outlines, tab borders |
| `--border-subtle` | `rgba(240, 246, 252, 0.1)` | Button inner borders |

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

## 5. Visual Sandbox & Interactive Testing

An offline interactive workbench is available at the route **`/sandbox`**. It allows developers to:
- Inspect all tonal surface swatches, border contrast, and typography scales.
- Interact with button hierarchies, sizes, and spinner states.
- Test `.status-indicator` + `.status-dot` variants in data tables.
- Launch `StarterSyncModal`, `SystemHealthModal`, and `TeamsTable` with realistic, deterministic mock data fixtures without requiring live GitHub API credentials.
