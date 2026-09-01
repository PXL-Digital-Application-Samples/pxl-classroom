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
 * THE SYNCHRONOUS PATH GOES FIRST, and that ordering is load-bearing.
 *
 * It used to await the async API first and fall back to `execCommand`. That
 * fallback could never run. Both engines stop attributing a clipboard call to
 * the click handler once an `await` has intervened, so in the ONE situation the
 * fallback exists for - the async write was refused - the synchronous retry is
 * refused too. MDN says it outright: after an await "the function call is then
 * not anymore assigned to a click handler"; Firefox tracks it as bug 1605928,
 * "writeText() does not work in asynchronous environments". A fallback that
 * cannot run is the `.catch()`-on-a-resolving-promise shape one level up.
 *
 * `execCommand` is deprecated but SYNCHRONOUS, which is exactly why it leads
 * here: it finishes inside the gesture, its answer is known without yielding,
 * and it cannot lose the focus race against a `window.open` the caller may want
 * to make on the same click. If an engine ever drops it, this degrades to the
 * async API rather than breaking.
 *
 * @param {string} text
 * @param {{navigator?: Navigator, document?: Document}} [deps] injectable for tests
 * @returns {Promise<boolean>}
 */
export async function copyText(text, deps = {}) {
  const doc = deps.document ?? globalThis.document
  if (typeof text !== 'string' || text.length === 0) return false

  if (copyWithExecCommand(text, doc)) return true

  return copyTextAsync(text, deps)
}

/**
 * The async Clipboard API on its own, resolving to whether the write landed.
 *
 * Exported separately because the CALLER has to be able to choose. This one
 * yields, and yielding is what costs you the user activation - so a handler
 * that also needs to open a window on the same click must know which path it
 * is on rather than having the decision hidden inside `copyText`.
 *
 * @param {string} text
 * @param {{navigator?: Navigator}} [deps] injectable for tests
 * @returns {Promise<boolean>}
 */
export async function copyTextAsync(text, deps = {}) {
  const nav = deps.navigator ?? globalThis.navigator
  if (typeof text !== 'string' || text.length === 0) return false
  if (typeof nav?.clipboard?.writeText !== 'function') return false

  try {
    await nav.clipboard.writeText(text)
    return true
  } catch {
    // Blocked, insecure origin, or the document lost focus. Report the failure
    // - do not swallow it into a resolved promise.
    return false
  }
}
