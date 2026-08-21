// PXL Classroom - theme runtime (dark default / light / system).
//
// The palette itself lives entirely in style.css as light-dark() tokens; this
// module only decides which of the two columns is showing. It does that by
// writing `data-theme` on <html>, which flips `color-scheme` (DESIGN.md §5)
// and re-resolves every token at once - no per-token work, no second palette.
//
// IMPORTANT: the inline boot script in index.html duplicates STORAGE_KEY and
// THEME_MODES because it has to run before the module graph loads (otherwise a
// light-mode user flashes dark on every navigation). tests/theme-tokens.test.mjs
// asserts the two stay in sync - update both or the test fails.

import { computed, ref } from 'vue'

export const STORAGE_KEY = 'pxl_theme'
export const THEME_MODES = ['dark', 'light', 'system']

// Follow the OS by default: a first-time visitor gets whichever theme their
// machine is set to. An explicit 'dark' or 'light' pins it regardless.
export const DEFAULT_MODE = 'system'

const mode = ref(DEFAULT_MODE)
const systemPrefersLight = ref(false)

// See initTheme() - held at module scope so the listener cannot be GC'd away.
let systemQuery = null
let systemListenerBound = false

/** The user's choice: 'dark' | 'light' | 'system'. */
export const themeMode = computed(() => mode.value)

/** What is actually on screen right now: 'dark' | 'light'. */
export const resolvedTheme = computed(() =>
  mode.value === 'system' ? (systemPrefersLight.value ? 'light' : 'dark') : mode.value
)

function isValidMode(value) {
  return THEME_MODES.includes(value)
}

function readStoredMode() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    return isValidMode(stored) ? stored : null
  } catch {
    // Safari private mode / storage disabled - fall back to the default rather
    // than breaking boot.
    return null
  }
}

function persistMode(value) {
  try {
    localStorage.setItem(STORAGE_KEY, value)
  } catch { /* ignore */ }
}

/**
 * Escape hatch: `?theme=light` forces and persists a mode. Useful for reviewing
 * a screen in the other theme, and for sharing a link that opens that way.
 */
function readQueryMode() {
  try {
    const requested = new URLSearchParams(window.location.search).get('theme')
    return isValidMode(requested) ? requested : null
  } catch {
    return null
  }
}

/**
 * Write the attribute style.css keys off. Set explicitly rather than omitting
 * it for dark: the CSS default already covers an absent attribute (the no-JS
 * guarantee), and an explicit value is what the toggle reports to assistive tech.
 */
function applyMode(value) {
  document.documentElement.dataset.theme = value
}

export function setThemeMode(value) {
  if (!isValidMode(value)) return
  mode.value = value
  persistMode(value)
  applyMode(value)
}

/** Toggle order: dark -> light -> system -> dark. */
export function cycleThemeMode() {
  const next = THEME_MODES[(THEME_MODES.indexOf(mode.value) + 1) % THEME_MODES.length]
  setThemeMode(next)
  return next
}

export function initTheme() {
  const query = readQueryMode()
  const initial = query ?? readStoredMode() ?? DEFAULT_MODE

  mode.value = initial
  applyMode(initial)
  // Only a URL override writes back; a plain visit must not manufacture a
  // stored preference the user never expressed.
  if (query) persistMode(query)

  if (typeof window.matchMedia !== 'function') return

  // Module-scope, not function-local: a MediaQueryList whose only tie to the
  // page is its listener can be garbage collected in some engines, after which
  // the listener silently stops firing. Holding the reference costs nothing.
  systemQuery ??= window.matchMedia('(prefers-color-scheme: light)')
  systemPrefersLight.value = systemQuery.matches

  if (systemListenerBound) return
  systemListenerBound = true
  // Kept live regardless of mode; `resolvedTheme` ignores it unless mode is
  // 'system', so there is no state to re-sync when the user switches into it.
  systemQuery.addEventListener('change', (event) => {
    systemPrefersLight.value = event.matches
  })
}
