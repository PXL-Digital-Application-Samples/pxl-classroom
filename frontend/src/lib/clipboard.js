// PXL Classroom - putting text on the clipboard, and saying truthfully whether
// it worked.
//
// THE BUG THIS EXISTS FOR STOPPED PEOPLE SIGNING IN.
//
// The device-flow card shows a user code that has to be pasted into GitHub.
// Its button did this:
//
//     let ok = copySync(code)
//     if (!ok && navigator.clipboard?.writeText) {
//       navigator.clipboard.writeText(code).then(() => {...}, () => {})
//       ok = true                       // <- claims success, before knowing
//     }
//     copied.value = ok                 // <- button says "Copied"
//     window.open(verificationUrl, ...) // <- takes focus away
//
// `writeText` is rejected on an unfocused document ("Document is not focused",
// reproduced 2026-09-01), and `window.open` removes focus microseconds later -
// so the write loses that race, the rejection is swallowed by `() => {}`, and
// the button reports success over an empty clipboard. The student has no code
// to paste and cannot sign in. It is DESIGN.md §1.5 in its most expensive
// form: the UI describing behaviour the system does not have.
//
// So: ONE implementation, it RETURNS A REAL ANSWER, and nothing calls
// `window.open` while a write is in flight. There were ten copy
// implementations across eight files when this was written and two of them
// reported success on failure - the same shape LESSONS.md already records for
// the invitation link, which was consolidated while the other eight were not.
//
// Dependency-injected so the behaviour can actually be tested. The old guard
// grepped the source for an `else toast...` branch, and passed - the branch was
// there, and unreachable.

/**
 * The synchronous fallback, for contexts where the async API is unavailable or
 * blocked (an insecure origin, a permissions policy, an older browser).
 *
 * `execCommand` is deprecated but SYNCHRONOUS, so it finishes inside the click
 * handler while the document is certainly focused.
 *
 * The element is positioned ON SCREEN and made transparent rather than moved
 * off-canvas with `opacity: 0`: an element outside the layout cannot reliably
 * be selected, and a failed selection makes the copy return false for a reason
 * nobody can see. 2em at the top-left, transparent and borderless, is the
 * long-standing recipe.
 */
export function copyWithExecCommand(text, doc = globalThis.document) {
  if (!doc || typeof doc.execCommand !== 'function') return false
  const active = doc.activeElement
  const ta = doc.createElement('textarea')
  try {
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.setAttribute('aria-hidden', 'true')
    ta.style.cssText =
      'position:fixed;top:0;left:0;width:2em;height:2em;padding:0;border:none;' +
      'outline:none;box-shadow:none;background:transparent;color:transparent;'
    doc.body.appendChild(ta)
    ta.select()
    ta.setSelectionRange(0, text.length)
    return doc.execCommand('copy') === true
  } catch {
    return false
  } finally {
    ta.remove()
    // Give focus back to whatever had it, or the button the user just pressed
    // loses its ring and a keyboard user is dropped at the top of the document.
    try { active?.focus?.() } catch { /* the trigger may already be gone */ }
  }
}

/**
 * Copy `text`, and resolve to whether it is actually on the clipboard.
 *
 * NEVER resolves true speculatively. A caller may say "Copied" only when this
 * resolved true; on false it has to tell the user to copy manually, because the
 * text they need is not where they will look for it.
 *
 * The async API is tried FIRST and AWAITED - it is the supported one, and
 * awaiting is the only way to get a real answer out of it. `execCommand` is the
 * fallback for where it is blocked.
 *
 * @param {string} text
 * @param {{navigator?: Navigator, document?: Document}} [deps] injectable for tests
 * @returns {Promise<boolean>}
 */
export async function copyText(text, deps = {}) {
  const nav = deps.navigator ?? globalThis.navigator
  const doc = deps.document ?? globalThis.document
  if (typeof text !== 'string' || text.length === 0) return false

  if (typeof nav?.clipboard?.writeText === 'function') {
    try {
      await nav.clipboard.writeText(text)
      return true
    } catch {
      // Blocked, insecure, or the document lost focus. Fall through - do not
      // report success, and do not swallow this into a resolved promise.
    }
  }

  return copyWithExecCommand(text, doc)
}
