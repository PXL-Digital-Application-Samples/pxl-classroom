# PXL Classroom — Design System & Visual Guidelines

This document outlines the core UI/UX design principles and tokens for **PXL Classroom**. It ensures the interface maintains a human-crafted, high-density developer aesthetic (inspired by GitHub Primer) and avoids generic "AI-generated template" defaults.

---

## 1. Core Visual Principles

1. **Avoid the "1px Box Prison":**  *(a box is a border on all four sides; a single-side border is a divider and is fine)*
   * Do not wrap every nested container in a 1px solid border.
   * Separate sections using **tonal surface shifts** (`--bg-canvas` vs `--bg-surface`) and purposeful whitespace (16–24px padding).
   * Reserve borders for structural dividers (such as sticky headers, navigation borders, or data table rows).
   * Concretely: **never nest three boxes**. A modal that outlines its own edge, its cards, and a control inside those cards is the prison. Give the inner levels a tonal step instead.
   * Check the tone actually differs in **both** themes before removing a border. `--bg-surface` and `--bg-surface-elevated` are both `#ffffff` in light (§2), so an "elevated" panel on a white modal has a contrast ratio of exactly 1.000. `--bg-inset` is the recessed step that differs in both.

2. **Strict 1-Primary-Button Rule:** *(enforced by `tests/e2e/22-design-conformity.spec.mjs`)*
   * **Only ONE** solid primary button (`.btn-primary`) per view or major screen section (e.g., `+ New assignment` on Dashboard, the `Invite link` popover trigger on Detail view).
   * Standard toolbar actions (`Refresh`, `Export`, `Sync`) must use neutral secondary styling (`.btn-secondary`).
   * Destructive actions (`Close acceptance`, `Freeze`) belong in a `··· More` overflow dropdown or use subtle danger outlines until confirmed in a modal dialog.
   * A **modal counts as its own view**. An action repeated per row or per card is never primary - one card per assignment meant one primary button per assignment before this was caught.
   * **A form does not repeat its actions.** `AdminView`'s editor rendered `Cancel / Save as draft / Save & publish` in its header bar *and* again below the fieldsets - two solid buttons on screen at once, which is why the conformity test was scoped away from that view for two workstreams. The header bar is the form's action bar; there is no second row.
   * **A pane-level CTA yields to the pane that has focus.** `New assignment` is solid while nothing is being edited and plain once an assignment is open, so the count is exactly one in both states rather than one per pane.

3. **Status Dots over Bulky Pill Capsules:** *(enforced by `tests/e2e/22-design-conformity.spec.mjs`)*
   * In data tables, student cards, and metric rows, prefer `.status-indicator` with a glowing `.status-dot` and clean mixed-case text (`● On-time`, `● Provisioned`, `● Accepting`).
   * Avoid uppercase heavy 9999px pill badges (`[ NO-SUBMISSION ]`) which add visual noise when repeated hundreds of times.

4. **GitHub Primer Navigation:**
   * Use underline tabs (`.primer-tabs` / `.primer-tab`) with an active bottom border for section switching (e.g., `Assignments | Roster`).
   * Avoid floating pill toggle bubbles for top-level navigation.

5. **The UI must not describe behaviour the system does not have.**
   * A control that cannot do what its label says, a status line reporting a state nothing computes, a message promising a background process that was deleted - each is worse than the missing feature, because it sends someone to wait for or rely on something that will not happen.
   * This is the most expensive class of bug this project has shipped, and it recurs in three shapes. **A dead field:** `late_policy: block` and `lock_down_enabled` were both offered in the form while no code read either. **A dead promise:** `rejected:cap-reached` ended *"Acceptance queued for lecturer review"* after the queue had been deleted, leaving a lecturer waiting instead of raising the cap. **A control that breaks what it claims to relax:** *Remove limit* offered to delete the only thing gating an `open` cohort, which stops every acceptance rather than opening enrolment up.
   * The remedy is one of two things, never a reword: give the system the behaviour, or take the control away and say why. An absent button explains nothing, so where the reason matters it replaces the control rather than simply vanishing.
   * It applies equally to a status line that cannot evaluate its own condition. `InvitationShare` could never report "Cap reached", because two of its three callers never passed the count - so it announced *"Live"* over a full cohort. An absent input is now **unknown**, and the copy hedges rather than asserting.
   * **A status line may also answer a narrower question than the screen is asking.** The assignment form read *"Automatic grading: Off · submissions are not scored automatically"* beside a filled-in hand-in commit message. "Off" was true of checks configured *here*; the sentence beside it was a claim about the student's repository the form has no way to check, and false for exactly the assignment that field exists for. Rewording it would not have helped: checks defined here and a workflow shipped with the template are two answers to **one** question, held as two unrelated controls. One question, asked once, in one place - and where two states are genuinely the same document, the line says the less specific thing rather than guessing which one it is.
   * A page may not guess *why* it is stuck, either: the provisioning wait screen offered a repository-invitation link on a timer, with no evidence and to students who had never been sent one.
   * **The inverse costs as much: a control that renders only once its feature is already in use is invisible.** The **Class groups** picker required a `class_group` on the roster before it would appear, and measured on 2026-09-05 not one student in any live organization had one — so the control had never rendered anywhere, and a lecturer asking how to split their classes across assignments had nothing on screen to find. Two fixes were available and only one of them was real. Showing the empty field with a message about the missing column makes the feature discoverable but still asks the lecturer to go and prepare data before the control does anything. The **question was the wrong shape**: the assignment was made to hold a *rule over groups* when what a lecturer wanted was to *choose students*. Replacing it with a roster picker whose group chips are only filters removed the precondition entirely — nothing has to exist before the control works, and the groups became what they were always described as. Prefer the change that removes the precondition over the message that explains it.

6. **The UI never points a user at this repository's documentation.** *(enforced by `tests/doc-refs.test.mjs`)*
   * `RUNBOOK.md`, `ADMIN.md` and `INSTALL.md` are written for whoever *operates* a deployment. A student who cannot sign in and a lecturer whose dashboard will not load are not that person — they cannot act on a section number, and often the procedure behind it is not theirs to run. "Run ADMIN.md §5.5 recovery" told a lecturer to `git reset --hard` a repository they may not be able to write to.
   * The worst instance was on the **sign-in card**, which is the one sign-in surface and therefore the one a *student* meets: a misconfigured deployment answered them by naming a build-time secret and an ARCHITECTURE section.
   * A message says **what happened and who can fix it.** If the reader genuinely needs the procedure, give the steps — the `/setup` page lists them inline, because the person reading it is the operator.
   * Section numbers are a maintainer's index and they move; three documents' worth were renumbered in one afternoon, silently breaking four links the UI had composed by hand.
   * **Developer comments are exempt, deliberately.** `// ARCHITECTURE §4.3.2` beside the code it constrains is how the reasoning stays attached to the code, and the guard strips comments before it looks.

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
| `--bg-canvas` | `#eaeef2` | `#0d1117` | Base application background |
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

**Tints are fills, not overlays.** Because the light values are opaque, painting
one *over* content covers it — a `--tint-accent-subtle` hero glow washed the
landing-page title out completely. Use `--glow-accent` for anything drawn on top.

### Shadows
In light mode the overlay tokens are the *only* separation an overlay gets:
`--bg-surface` and `--bg-surface-elevated` are both `#ffffff`, so a menu on a
card has a tonal contrast of exactly **1.000** and the shadow does all the work.
Light shadows are therefore deliberately strong (`rgba(140,149,159,.30–.40)`),
not the faint values a dark-first palette suggests.

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

### Page gutter

`--gutter: clamp(12px, 1.6vw, var(--space-lg))` is the space between the viewport
edge and page content. **`.container` and `.app-header-bare` are its only
consumers** - they share it so the app bar's brand lines up with the content
below it. Do not hard-code a horizontal page padding beside them.

It is fluid rather than a breakpoint step on purpose: a window snapped to half a
desktop screen is still "desktop" to any max-width query, but the full 24px reads
as wasted space there. The ramp is ~24px full-screen, ~15px at a 960px
half-screen, 12px on a phone - and never 0, which is the bug it replaced.

> **Do not set `padding` (the shorthand) on a `main` that also carries
> `.container`.** Inside a `<style scoped>` block `main` is an *element* selector,
> so it carries the component's `[data-v-*]` attribute and out-specifies
> `.container` (0,1,1 vs 0,1,0) - `padding: X 0` silently wipes the gutter at
> every width. Use `padding-top` / `padding-bottom`. `tests/e2e/25-responsive-layout.spec.mjs`
> enforces both this and the ramp.

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

**The complete set**, because §1.2 forbids inventing a variant this section does not define — a rule that only works if the list is exhaustive:

| Class | What it is |
| :--- | :--- |
| `.btn-primary` | The single solid CTA per view (§1.2). |
| `.btn-secondary` | Neutral toolbar and standard actions. |
| `.btn-ghost` | Utility, no fill; pairs with `.btn-icon`. |
| `.btn-link` | Reads as a link, behaves as a button. **Never `.link-btn`** (§7). |
| `.btn-danger` / `.btn-danger-outline` | Destructive. Outline in a toolbar, solid where the destruction is the point of the view. |
| `.btn-success` | Solid green. One use — the student's accepted state — and it should stay that way: success is normally a status dot (§4), not a button. |
| `.btn-sm` / `.btn-xs` / `.btn-lg` | Size modifiers, combined with one of the above. `.btn-lg` is for a card's single decisive action, `.btn-xs` for controls inside a table row. |
| `.btn-icon` | Square icon-only box, so a header rail keeps its rhythm. |
| `.btn-with-icon` | Lays out an icon beside a label. Not a variant — it composes with any of them. |

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

**The complete set**, for the same reason §3 lists all of its variants:

| Dot | Meaning |
| :--- | :--- |
| `.dot-success` | On-time, provisioned, accepting — the state you wanted. |
| `.dot-warning` | Late, pending, below minimum team size — needs a look, not an alarm. |
| `.dot-danger` | Failed, refused, unfreezable — something did not happen. |
| `.dot-neutral` | Not started, no submission, unknown. **Not** an error: an empty population is not a failure. |
| `.dot-info` | Informational only. One use; prefer `.dot-neutral` unless the row genuinely reads as a notice. |

---

## 5. Theming (light / dark, seeded from the OS)

The SPA is dual-theme. Both themes come from **one** token block in `frontend/src/style.css`;
there is no second palette to keep in sync.

```css
:root {
  color-scheme: light dark;                        /* DEFAULT: follow the OS */
  --bg-canvas: light-dark(#f6f8fa, #0d1117);
}
:root[data-theme="light"]  { color-scheme: light; }
:root[data-theme="dark"]   { color-scheme: dark; }
:root[data-theme="system"] { color-scheme: light dark; }
```

`light-dark()` resolves against the **computed `color-scheme`**, so flipping that single property
re-resolves every token — and themes native scrollbars, form controls and autofill for free.

An absent `data-theme` attribute means **follow the OS**, which is both the default and the
no-JS behaviour: a first-time visitor gets whichever theme their machine is set to, and the
page is still correct if the boot script never runs. An explicit `light` or `dark` pins the
theme regardless of the OS.

### Runtime

`frontend/src/lib/theme.js` owns the mode; `main.js` calls `initTheme()` at boot.

| Export | |
| :--- | :--- |
| `resolvedTheme` | what is actually on screen — `'dark' \| 'light'` |
| `setThemeMode(m)` | validate, persist, apply (invalid input is ignored) |
| `toggleTheme()` | flips `resolvedTheme`; only ever produces `dark` or `light` |

The stored choice — which may be `'system'` — is deliberately **not** exported.
Every surface wants `resolvedTheme`: what is on screen is the only question a
toggle, an icon or a screenshot can act on, and a caller comparing against
`'system'` gets the wrong answer for the visitor who has never touched the
control. `STORABLE_MODES` documents what may legitimately be stored.

**The toggle has two states, not three.** `system` is the *implicit* state of a
visitor who has never touched it — they get their OS theme and the control shows
whichever theme resolved. The first press stores an explicit `dark` or `light`,
and the app never returns to `system`: following the OS after someone has stated
a preference would silently override them. Hence two exported lists —
`THEME_MODES` (`dark`/`light`, what the toggle emits) and `STORABLE_MODES`
(plus `system`, what may be stored or arrive via `?theme=`).

**Every toggle persists.** `setThemeMode()` writes to `localStorage` under **`pxl_theme`**,
wrapped in `try`/`catch` (Safari private mode and blocked storage must not break boot), and
`toggleTheme()` routes through it. A plain visit never writes a preference — only an
explicit choice or a `?theme=` override does. That distinction matters: if a first load stored
the resolved theme, it would silently pin whatever the OS happened to be and `system` could
never follow a later OS change.

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

## 6. Application Chrome

### `AppHeader.vue` — the one app bar

Every route renders exactly one `<AppHeader>`. Two shapes:

* **Brand** (default slot content): logo + "PXL Classroom", both linking home.
* **Breadcrumb** (`#left` slot): `.app-header-crumbs` with a `.back-link`, `.app-header-sep`
  separators and an `.app-header-heading`. Intermediate segments that navigate are
  `.crumb-link` — the org name sat between two links as plain text, which reads as broken.
  A trail may end in an `.app-header-switch`: underline `.primer-tab`s (§1.4) for the *views
  of the thing the trail names*, which is how one assignment's Overview and Admin pages reach
  each other. It is a `nav` in `#left` rather than a button in `#actions` deliberately — it
  switches between views of the current page's subject, it does not act on it — and it takes
  its own row under 640px so the trail cannot push the page sideways.

Views add buttons via `#actions`; the rail then always appends `<ThemeToggle>` and, when a
`user` prop is passed, `<UserBadge>`. Props: `user`, `contained` (wrap in `.container`),
`sticky`.

> **`AppHeader.vue` has no `<style scoped>` block, and must not gain one.** Slot content is
> compiled in the *parent's* scope and carries the parent's `data-v-*` attribute, so a scoped
> rule here can never reach the breadcrumbs and actions views pass in. The `.app-header-*`
> vocabulary lives in `style.css`. `tests/scoped-style-leakage.test.mjs` enforces this.

### `AuthCard.vue` — the one sign-in surface

```html
<AuthCard v-if="!user" title="Sign in to view usage" @authenticated="onAuthenticated">
  Sign in with a GitHub account that owns <strong>{{ org }}</strong>.
</AuthCard>
```

AuthCard owns the whole device flow — button, spinner, `DeviceFlowCard`, cancellation, and
aborting the poll on unmount — and emits `authenticated(user)`. The view supplies only the
title, the description (default slot) and what to load afterwards:

```js
async function onAuthenticated(authedUser) {
  user.value = authedUser
  await loadReport()
}
```

Rules:
* Sign-in failures render **inside** the card (`.auth-error`), never as a page-level error state.
* Every authenticated view shows an AuthCard when there is no session — never a data-shaped
  empty state such as "No assignments yet".
* `.center-card`, `.auth-error` and `.spinner-sm` are **global**. They were previously
  redeclared in per-view scoped blocks, which left `/usage` and `/dashboard/:org/usage`
  rendering their sign-in, loading and empty states completely unstyled.

**Exception:** `HomeView`'s signed-out hero keeps a bespoke sign-in. It is a landing hero —
logo, product name, tagline — not a card, and forcing it into AuthCard would flatten that
design. It is the only remaining copy of the device-flow handler.

### A dialog is a component, and it owns its own state

`AssignmentDetailView` and `AdminView` held four dialogs inline — their markup,
their form state, their focus handling and their scoped styles spread through
views of 3,800 and 3,200 lines. They are components now:
`StudentActionsModal`, `FeedbackPrModal`, `FreezeConfirmModal`,
`RepublishBrokerModal`, alongside the `AutogradeResultsModal` that ended a
70-line duplication between `AssignmentDetailView` and `TeamsTable`.

Three rules came out of doing it:

* **A form that exists only while a dialog is open is the dialog's state.**
  `actionExt` and `regenerateInvite` were refs on the views, so they outlived
  every close and had to be reset by hand on every open. With `v-if` on the
  parent the component is created fresh, and there is nothing to reset.
* **Focus is not view logic.** `composables/useFocusTrap.js` owns the ref, the
  Tab cycling and giving focus back to the trigger. It was three pieces of one
  behaviour, 1,800 lines apart, in exactly one of the app's dialogs.
* **Scoped styles do not cross a component boundary, so they move with the
  markup.** Extracting a dialog and leaving its rules in the parent renders it
  completely unstyled — `tests/scoped-style-leakage.test.mjs` caught 12 of them
  in one go. A rule that two components then need goes to `style.css` (§7).

**Decisions stay with the thing that owns the rule.** `FreezeConfirmModal` takes
the archive repository *name* as a prop rather than composing it, because
`lib/archive-repo.mjs` is the only thing allowed to decide where a preservation
goes; `StudentActionsModal` collects the extension but does not validate it,
because `lib/effective-deadline.mjs` decides what "later than the current
deadline" means. A dialog that re-derived either would be the second
implementation those modules exist to prevent.

## 7. Shared Component Vocabulary

Vue `<style scoped>` **does not leak**. A class declared in one component's scoped
block and used by another renders completely unstyled there — no build error, no
console warning. That shipped 86 times before it was swept, and separately broke
`.center-card`, `.dashboard-header`, `.sandbox-header` and `.auth-error`.

**Rule: if more than one component uses a class, it belongs in `style.css`.**
Anything passed into a `<slot>` counts, because slot content is compiled in the
*parent's* scope (§6). `tests/scoped-style-leakage.test.mjs` enforces this.

### A class declared nowhere is the same bug

`tests/scoped-style-leakage.test.mjs` catches "used here, scoped over there". It
deliberately skips the other half — `if (!owners) continue; // not styled
anywhere` — and that gap is how two things shipped:

* **`.btn-warning`**, used seven times across `AdminView` and
  `StudentDiagnosticsModal`, declared in neither `style.css` nor any scoped
  block. Every one rendered with the plain `.btn` face. It is not a §3 variant
  either; those buttons are now `.btn-secondary`, or `.btn-danger` where the
  action is destructive.
* **`.font-semibold`**, written in **ten** components and declared in none of
  them, so every heading meant to be semibold rendered at the body weight. Same
  for `.font-medium`, `.font-bold`, `.uppercase`, `.text-xl`, `.text-left` and
  `.list-disc`. They now sit in `style.css` beside `.text-sm` / `.text-xs`.

This is exactly §5 rule 3 (“every `var(--token)` must resolve”) applied to class
names: **an undeclared class fails silently**, with no build error and no console
warning, and a test that reads the *template* will happily confirm the class is
there.

`scripts/lint-undeclared-classes.mjs` lists them; `tests/undeclared-classes.test.mjs`
pins the remainder in `tests/fixtures/undeclared-classes.backlog.json`. Nothing
new may join that list, and a class that gets declared must be removed from it.

The 2026-09-01 pass took it from 98 to 60 by triaging it, because the entries
were never one thing:

| Group | Then | What it is | What happened |
| :--- | ---: | :--- | :--- |
| Inline-styled | 17 | The element carried a `style="…"` saying what the class meant | Moved into a stylesheet. **No visual change** — the values are unchanged. |
| Conditional | 6 | Applied by a `:class` to make a state visible, and declared nowhere | **Defects.** Declared, from existing tokens. |
| Shared | 14 | Used by two or more components, so a scoped block could never reach both | Declared in this file's stylesheet. Now **zero**. |
| Hooks | ~60 | Page roots and e2e selectors (`.admin-view`, `.sandbox-page`) never meant to carry a look | Left, and that is the answer. |

The six conditional ones are why this stopped being tidy-up.
`banner-success`/`banner-warning` meant a **passing and a failing autograding
run rendered identically**; `is-complete` meant a finished onboarding step
looked unfinished; `spin-anim` meant the refresh icon never span; `clean` /
`conflict` / `skipped` meant the three outcomes of a pre-flight scan were three
identical cards. A class applied conditionally exists *to* make a state visible,
so declaring nothing is the bug — the same shape as §5 rule 3.

`text-error` was **deleted rather than declared**: `.text-danger` already exists,
and a synonym is the `.link-btn` mistake again.

What remains is the honest half of the register — vocabulary whose intended
appearance is recorded nowhere, which needs a design decision rather than a
guess. **A multi-component entry is not that**, and a test now refuses one: a
scoped block cannot reach another component, so leaving it renders unstyled in
both.

#### The remainder is two groups, and the split is computed

"Left, and that is the answer" was the right call and it was only a claim — a
flat list of sixty invites the next reader to restyle sixty elements that were
never broken. `classifyUndeclared()` in `scripts/lint-undeclared-classes.mjs`
now separates them, and `tests/undeclared-classes.test.mjs` holds both halves:

* **38 sit on an element that carries another *declared* class** — `card`,
  `flex`, `btn`, `alert-info`, `fade-in`. That is a positive proof: the element
  is styled whatever the undeclared word does, so the word is a name and there
  is nothing to decide.
* **21 sit on an element with no declared class at all.** That is *not* the
  negative — an element's look can come from its tag or an ancestor, which only
  a browser knows — so each one carries a written reason, and the test refuses
  an entry without one or a reason that outlived its entry.

Those 21 were checked rather than assumed, with a Playwright probe that asked
the browser which rules actually matched each element (the universal reset
excluded, or everything looks styled). What it found:

| Why it needs no rule | Examples |
| :--- | :--- |
| A scoped rule styles the **tag** | `.advanced` on `<details>`, `.col-ci`/`.col-score` on `<th>`/`<td>` |
| The **element default** is the intent | `.team-name` on `<strong>`, `.file-path` on `<code>` |
| A **sibling** does the work | `.org-item-text` — `.org-dropdown-item` is flex and `.check-icon` carries `margin-left: auto` |
| An **ancestor** sets it | `.deadline` inherits size and colour from `.assignment-list .meta` |
| It carries an **inline style** | `.template-preflight-badge`, `.diff-patch-view-container` |
| **Page root**, no look intended | `.not-found-page`, `.usage-page`, `.student-dashboard` |

`.field-label` came off the list rather than onto it: the `<label>` sits inside
`<div class="field">`, and `.field label` already styles it, so the name was a
synonym for a rule that exists. **A static scan cannot see that** — it is why
the browser had to be asked, and why "the element has no declared class" is
worded as *needs a reason*, not *is broken*.

The app declares **no `code` or `pre` rule anywhere**, so every `<code>` renders
at the browser default. That is consistent rather than accidental, and changing
it is a decision about type in §2 — not about `.file-path`.

Global vocabulary now includes:

| Group | Classes |
| :--- | :--- |
| Layout | `.center-card`, `.empty-state`, `.loading-state`, `.app-header-*` |
| Forms | `.field` (+ `label`, `small`), `.form-control`, `.form-hint`, `.req` |
| Status text | `.status-icon` (+ `-success`, `-warn`, `-error`, `-pulse`), `.status-text` |
| Stat colours | `.stat-green`, `.stat-yellow`, `.stat-red`, `.stat-blue` |
| Utilities | `.text-center`, `.text-green`, `.text-yellow`, `.text-blue`, `.spinner-sm`, `.btn-icon` |
| Components | `.repo-link`, `.repo-link-card`, `.progress-bar` (+ `-fill`), `.diag-banner` |

### Contextual help

A control whose meaning is not obvious from its label carries a `<HelpButton>` —
a small `?` beside the label, never in place of one. It opens the help drawer on
one topic from `MANUAL.md`; it is not a tooltip and it does not explain itself in
passing.

Three rules, and they are what keep it from turning into decoration:

- **The drawer renders once, in `App.vue`, beside `<router-view>`.** It is
  `position: fixed`, so any ancestor carrying `transform`, `filter`,
  `perspective`, `will-change` or `contain` becomes its containing block and puts
  it off-screen — the failure `tests/e2e/47` exists for. Putting it inside a view
  reintroduces that.
- **A help button carries a topic id and nothing else.** No prose in the markup.
  The topic lives in `MANUAL.md`, and `tests/manual-topics.test.mjs` fails if the
  id does not exist.
- **Use it for a setting a lecturer asks about, not for every field.** A `?` on
  everything is a `?` on nothing. `title=` stays the right answer for naming an
  icon; a drawer is for a decision with consequences.

A topic that only needs one line does not need a drawer — say it in the field's
own `small`, which is already the vocabulary for that.

Where several components had **diverged** on a class, the global rule is the
shared base and each owner keeps its scoped override — which still wins on the
`[data-v-*]` specificity, so no existing view shifted.

**Use `.btn-link`, never `.link-btn`.** The latter was a scoped re-implementation
of the §3 text-button in three components; it is gone.

### A `<summary>` with `display: flex` loses its triangle

Same family of silent failure. Setting any `display` other than `list-item` on a
`<summary>` removes the native disclosure marker, with no warning — the control
still toggles, it just stops looking like one, and a heading nobody thinks to
click is worse than no disclosure at all. `AdminView`'s *Edit settings* summary
needs flex to place its field-error count, so it carries its own
`chevron-down` `Icon` and rotates it `-90deg` while closed.

The other half of that control: **a disclosure is not a box.** `.settings-disclosure`
overrides the scoped `details { border: … }` rule to a single `border-top`,
because the editor pane already draws a border and every fieldset inside draws
another — three, which is §1.1's prison.

### A grid track is `minmax(0, 1fr)`, never a bare `1fr`

A `1fr` track's automatic minimum is its content's **min-content** size, and for
anything with `white-space: nowrap` min-content equals max-content. The admin
editor's `.invitation-link` is a nowrap 122-character URL, so the track grew to
fit the whole thing and the page scrolled 208px sideways on a 375px phone —
invisible at desktop width. `min-width: 0` on the flex item does **not** fix it:
that bounds the flex minimum, not the grid track's intrinsic minimum. The floor
goes on the track, and the child then does what it was already styled to do
(ellipsise).

`tests/e2e/25-responsive-layout.spec.mjs` measures this. Its route sweep had
visited `/dashboard/:org/admin` with **nothing open**, where the editor pane is
a two-line empty state — so the pane holding the entire assignment form was
never measured at any width. It now opens an assignment, collapsed and
expanded, at all seven widths.

## 8. Visual Sandbox & Interactive Testing

> **`/sandbox` is a development-only route.** It is registered behind
> `import.meta.env.DEV` in `frontend/src/router/index.js`, so the branch and its
> dynamic import are dropped from a production build and the catch-all renders
> 404 instead. It renders fabricated cohort data — invented student logins,
> teams and reports — and it shipped to a public Pages site for months with no
> link to it from anywhere. Nothing found it, which is not the same as nothing
> being able to. `tests/vue-route-safety.test.mjs` fails if the gate is removed.

An offline interactive workbench is available at the route **`/sandbox`**. It allows developers to:
- Inspect all tonal surface swatches, border contrast, and typography scales.
- Interact with button hierarchies, sizes, and spinner states.
- Test `.status-indicator` + `.status-dot` variants in data tables.
- Launch `StarterSyncModal`, `SystemHealthModal`, `SeedTeamsModal`, and `TeamsTable` with realistic, deterministic mock data fixtures without requiring live GitHub API credentials.
