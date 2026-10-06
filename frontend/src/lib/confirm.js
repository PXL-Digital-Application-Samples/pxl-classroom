// Every confirmation the app asks, asked in the page (DESIGN.md §6, "A
// confirmation is asked in the page").
//
// `window.confirm()` cannot name its button - it says OK whatever is about to
// happen - and cannot be styled. The Teams tab moved off it first; this is the
// one service every confirmation goes through now, rendered by ONE host,
// `ConfirmHost.vue`, mounted beside the router view in App.vue.
//
// `askConfirm(question)` resolves `true` or `false`, so a caller reads as it
// did with confirm(): `if (!(await askConfirm({...}))) return`. A route guard
// returns the promise, which vue-router waits for.
//
// THE STATES A PAGE QUESTION CAN GET INTO THAT A BROWSER BOX COULD NOT, and
// what each does - the browser's box blocked the whole page, so none of these
// existed until the question moved into it:
//   * A second question while one is open answers the open one "no" and shows
//     the new one. Two at once would leave one unanswerable behind the other,
//     and the newer is the one the person just caused. The browser's Back
//     during a leave guard's question is exactly this: the router asks again
//     for the new navigation, and the one it abandoned is told "no".
//   * A navigation that COMPLETES answers any question still open "no"
//     (`dismissConfirm`, called on every route change by the host). A question
//     belongs to the page that asked it; answered "yes" after that page is
//     gone, it would act on state nobody is looking at.
//   * Answering twice, or answering with nothing open, does nothing.

import { ref } from 'vue'

/** The question on screen, or null. Read by ConfirmHost.vue. */
export const pendingConfirm = ref(null)

let seq = 0
const asText = (v) => (typeof v === 'string' ? v : '')
const asLines = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x) : [])

/**
 * Ask a question in the page.
 *
 * @param {object} q
 * @param {string} q.title          the question itself ("Remove Ann from the roster?")
 * @param {string} q.confirmLabel   what the button does ("Remove from roster"), never OK or Yes
 * @param {boolean} [q.destructive] red, and Cancel takes the focus
 * @param {string[]} [q.paragraphs] said first
 * @param {string[]} [q.list]       then a list (names, addresses)
 * @param {string[]} [q.after]      then said after the list
 * @returns {Promise<boolean>}
 */
export function askConfirm(q) {
  const previous = pendingConfirm.value
  return new Promise((resolve) => {
    pendingConfirm.value = {
      id: ++seq,
      title: asText(q?.title) || 'Are you sure?',
      confirmLabel: asText(q?.confirmLabel) || 'Continue',
      destructive: q?.destructive === true,
      paragraphs: asLines(q?.paragraphs),
      list: asLines(q?.list),
      after: asLines(q?.after),
      resolve,
    }
    previous?.resolve(false)
  })
}

/**
 * Ask for one line of text in the page, in place of `window.prompt()`.
 * Resolves the text, trimmed, or `null` for Cancel - and `null` for an empty
 * answer too, so "nothing typed" and "cancelled" both mean do nothing.
 *
 * @param {object} q            as askConfirm, plus:
 * @param {string} q.inputLabel what to type ("Their GitHub username")
 * @param {string} [q.value]    filled in to start with
 * @returns {Promise<string|null>}
 */
export function askText(q) {
  const previous = pendingConfirm.value
  return new Promise((resolve) => {
    const input = { label: asText(q?.inputLabel) || 'Answer', value: asText(q?.value) }
    pendingConfirm.value = {
      id: ++seq,
      title: asText(q?.title) || 'Are you sure?',
      confirmLabel: asText(q?.confirmLabel) || 'Continue',
      destructive: q?.destructive === true,
      paragraphs: asLines(q?.paragraphs),
      list: [],
      after: asLines(q?.after),
      input,
      // Read at the moment of answering: the host edits `input.value`.
      resolve: (yes) => {
        const text = String(input.value || '').trim()
        resolve(yes && text ? text : null)
      },
    }
    previous?.resolve(false)
  })
}

/** Answer the question on screen. Does nothing when none is. */
export function answerConfirm(yes) {
  const open = pendingConfirm.value
  if (!open) return
  pendingConfirm.value = null
  open.resolve(yes === true)
}

/** Answer any open question "no" - the page that asked it is gone. */
export function dismissConfirm() {
  answerConfirm(false)
}

/**
 * The one way the app asks about throwing unsaved work away. Three pages
 * asked it in their own words; one question, one button. "Discard changes",
 * not "Leave": Settings' own Cancel asks it too, and stays on the page.
 *
 * @param {string} sentence  what is unsaved, as a sentence
 *   ("Your changes to this assignment are not saved.")
 */
export function askDiscard(sentence) {
  return askConfirm({
    title: 'Discard unsaved changes?',
    paragraphs: [sentence],
    confirmLabel: 'Discard changes',
    destructive: true,
  })
}
