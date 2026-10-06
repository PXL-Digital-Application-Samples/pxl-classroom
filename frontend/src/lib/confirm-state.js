// The rules of the in-page confirmation, without Vue (lib/confirm.js holds the
// reactive copy the page renders). Pure, so `npm test` - which installs the
// hub's packages and not the SPA's - can import and run it: a test that
// imported confirm.js passed locally and failed CI on `Cannot find package
// 'vue'`.
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

const asText = (v) => (typeof v === 'string' ? v : '')
const asLines = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x) : [])

/**
 * The confirmation service over one holder of "the question on screen".
 *
 * @param {{value: object|null}} pending a Vue ref in the app, a plain object in a test
 */
export function createConfirmService(pending) {
  let seq = 0

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
  function askConfirm(q) {
    const previous = pending.value
    return new Promise((resolve) => {
      pending.value = {
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
  function askText(q) {
    const previous = pending.value
    return new Promise((resolve) => {
      const input = { label: asText(q?.inputLabel) || 'Answer', value: asText(q?.value) }
      pending.value = {
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
  function answerConfirm(yes) {
    const open = pending.value
    if (!open) return
    pending.value = null
    open.resolve(yes === true)
  }

  /** Answer any open question "no" - the page that asked it is gone. */
  function dismissConfirm() {
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
  function askDiscard(sentence) {
    return askConfirm({
      title: 'Discard unsaved changes?',
      paragraphs: [sentence],
      confirmLabel: 'Discard changes',
      destructive: true,
    })
  }

  return { askConfirm, askText, answerConfirm, dismissConfirm, askDiscard }
}
